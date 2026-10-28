"""Durable indexing, bounded query scheduling, and idle model release."""
import asyncio
import multiprocessing
import time
from pathlib import Path
import numpy as np
from . import database as db
from .config import DATA, MANIFEST, PIPELINE, IDLE_SECONDS
from .inference import worker


class Runtime:
    def __init__(self):
        self.process = None
        self.connection = None
        self.task = None
        self.download_task = None
        self.queries = asyncio.Queue(maxsize=4)
        self.image_lock = asyncio.Lock()
        self.upload_slots = asyncio.Semaphore(2)
        self.busy = False
        self.model_state = "not_downloaded"
        self.model_error = None
        self.mode = db.setting("device", "auto")
        self.paused = db.setting("paused", "false") == "true"
        self.metrics = {}
        self.device = None
        self.dtype = None
        self.snapshot = db.setting("snapshot")
        if self.snapshot and Path(self.snapshot).is_dir() and db.setting("model_revision") == MANIFEST["revision"]:
            self.model_state = "sleeping"
        else:
            self.snapshot = None
        self.last_used = time.monotonic()

    async def start(self):
        self.task = asyncio.create_task(self.loop())

    def release(self):
        if self.process:
            if self.process.is_alive():
                self.process.terminate()
            self.process.join(timeout=5)
            self.process.close()
        if self.connection:
            self.connection.close()
        self.process = self.connection = None
        self.metrics = {}
        if self.snapshot and self.model_state != "error":
            self.model_state = "sleeping"

    async def close(self):
        if self.task:
            self.task.cancel()
        self.release()
        if self.task:
            await asyncio.gather(self.task, return_exceptions=True)

    def exchange(self, request=None):
        if request:
            self.connection.send(request)
        if not self.connection.poll(180):
            raise RuntimeError("The model worker timed out. Retry or choose CPU mode in Settings.")
        return self.connection.recv()

    async def infer(self, kind, value):
        if not self.snapshot:
            raise RuntimeError("Download the search model in Settings first.")
        if not self.process or not self.process.is_alive():
            self.release()
            self.model_state = "loading"
            parent, child = multiprocessing.get_context("spawn").Pipe()
            self.connection = parent
            self.process = multiprocessing.get_context("spawn").Process(target=worker, args=(child, self.snapshot, self.mode), daemon=True)
            self.process.start()
            child.close()
            result = await asyncio.to_thread(self.exchange)
            if not result["ok"]:
                raise RuntimeError(result["error"])
            self.device, self.dtype = result["device"], result["dtype"]
            self.model_state = "ready"
        result = await asyncio.to_thread(self.exchange, {"kind": kind, "value": value})
        if not result["ok"]:
            if result.get("oom"):
                self.release()
            raise RuntimeError(result["error"])
        self.metrics = {k: v for k, v in result.items() if k not in ("vector", "ok")}
        self.last_used = time.monotonic()
        return result

    async def loop(self):
        while True:
            future = None
            photo = None
            try:
                if not self.queries.empty():
                    query, future = self.queries.get_nowait()
                    if future.cancelled():
                        continue
                    if self.model_state == "error":
                        raise RuntimeError(self.model_error or "The search model needs attention.")
                    self.busy = True
                    result = await self.infer("text", query)
                    if not future.done():
                        future.set_result(result)
                elif self.snapshot and not self.paused and self.model_state != "error":
                    with db.connect() as conn:
                        row = conn.execute("SELECT id,original FROM photos WHERE status='queued' ORDER BY created LIMIT 1").fetchone()
                        photo = dict(row) if row else None
                        if photo:
                            conn.execute("UPDATE photos SET status='indexing',attempts=attempts+1 WHERE id=?", (photo["id"],))
                    if photo:
                        self.busy = True
                        async with self.image_lock:
                            result = await self.infer("image", str(DATA / "originals" / photo["original"]))
                        with db.connect() as conn:
                            if conn.execute("SELECT 1 FROM photos WHERE id=? AND status='indexing'", (photo["id"],)).fetchone():
                                conn.execute("INSERT OR REPLACE INTO embeddings VALUES (?,?,?)", (photo["id"], PIPELINE, result["vector"]))
                                conn.execute("UPDATE photos SET status='ready',error=NULL WHERE id=?", (photo["id"],))
                if not future and not photo:
                    if self.process and time.monotonic()-self.last_used > IDLE_SECONDS:
                        self.release()
                    await asyncio.sleep(0.25)
            except asyncio.CancelledError:
                raise
            except Exception as error:
                message = str(error) or "The model worker stopped unexpectedly."
                if future and not future.done():
                    future.set_exception(RuntimeError(message))
                if photo:
                    with db.connect() as conn:
                        conn.execute("UPDATE photos SET status='failed',error=? WHERE id=?", (message, photo["id"]))
                self.release()
                self.model_state, self.model_error = "error", message
                await asyncio.sleep(0.25)
            finally:
                self.busy = False

    async def search(self, query, scope="photos"):
        with db.connect() as conn:
            available = conn.execute("""SELECT COUNT(*) FROM photos JOIN embeddings ON id=photo_id
                WHERE status='ready' AND pipeline=? AND (?='photos' OR favorite=1)""", (PIPELINE, scope)).fetchone()[0]
        if not available:
            if scope == "favorites":
                return {"hits": [], "milliseconds": 0, "searched": 0, "scope": scope}
            raise ValueError("No photos are searchable yet. Add photos and let indexing finish.")
        future = asyncio.get_running_loop().create_future()
        self.queries.put_nowait((query, future))
        try:
            result = await asyncio.wait_for(future, timeout=200)
        except BaseException:
            future.cancel()
            raise
        vector = np.frombuffer(result["vector"], dtype=np.float32)
        with db.connect() as conn:
            rows = conn.execute("""SELECT photo_id,vector FROM embeddings JOIN photos ON id=photo_id
                WHERE pipeline=? AND status='ready' AND (?='photos' OR favorite=1)""", (PIPELINE, scope)).fetchall()
        hits = [{"id": row["photo_id"], "score": float(np.dot(vector, np.frombuffer(row["vector"], dtype=np.float32)))} for row in rows]
        hits.sort(key=lambda hit: hit["score"], reverse=True)
        return {"hits": hits, "milliseconds": result["milliseconds"], "searched": len(hits), "scope": scope}

    async def download(self):
        self.model_state, self.model_error = "downloading", None
        try:
            from huggingface_hub import snapshot_download
            path = await asyncio.to_thread(snapshot_download, repo_id=MANIFEST["model_id"], revision=MANIFEST["revision"],
                                           cache_dir=str(DATA / "model-cache"), max_workers=2,
                                           allow_patterns=["*.json", "*.safetensors", "*.model", "*.jinja", "README.md"])
            self.snapshot = path
            db.set_setting("snapshot", path)
            db.set_setting("model_revision", MANIFEST["revision"])
            self.model_state = "sleeping"
        except Exception as error:
            self.model_state, self.model_error = "error", str(error)
