"""Loopback-only HTTP API and frontend for Indexer Alpha."""
import asyncio
import json
import os
import secrets
import signal
import uuid
import warnings
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit
from typing import Literal
import psutil
from fastapi import FastAPI, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps, UnidentifiedImageError
from pydantic import BaseModel, Field
from . import database as db
from .config import DATA, ROOT, MANIFEST, MAX_BYTES, MAX_PIXELS, prepare
from .runtime import Runtime

Image.MAX_IMAGE_PIXELS = MAX_PIXELS
warnings.simplefilter("error", Image.DecompressionBombWarning)
TOKEN = secrets.token_urlsafe(32)
MODEL_BYTES = 1_525_789_000
runtime = None


@asynccontextmanager
async def lifespan(app):
    global runtime
    prepare()
    db.initialize()
    db.clean_orphans()
    for path in (DATA / "tmp").glob("*"):
        path.unlink(missing_ok=True)
    runtime = Runtime()
    await runtime.start()
    yield
    await runtime.close()


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None)


@app.middleware("http")
async def local_only(request: Request, call_next):
    if request.url.hostname not in ("127.0.0.1", "localhost", "::1", "testserver"):
        return JSONResponse({"detail": "Only local access is allowed."}, status_code=403)
    origin = request.headers.get("origin")
    if origin:
        parsed = urlsplit(origin)
        if parsed.scheme not in ("http", "https") or parsed.netloc != request.headers.get("host"):
            return JSONResponse({"detail": "Cross-origin requests are not allowed."}, status_code=403)
    if request.method not in ("GET", "HEAD", "OPTIONS") and not secrets.compare_digest(request.headers.get("x-indexer-token", ""), TOKEN):
        return JSONResponse({"detail": "Refresh this page to reconnect to Indexer Alpha."}, status_code=403)
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "same-origin"
    if request.url.path.startswith("/api/") and "Cache-Control" not in response.headers:
        response.headers["Cache-Control"] = "no-store"
    return response


def state():
    items = db.photos()
    cache_bytes = sum(p.stat().st_size for p in (DATA / "model-cache").rglob("*") if p.is_file() and p.name != "model.safetensors") if runtime.model_state == "downloading" else MODEL_BYTES if runtime.snapshot else 0
    return {"model": runtime.model_state, "model_error": runtime.model_error, "device": runtime.device,
            "mode": runtime.mode, "dtype": runtime.dtype, "paused": runtime.paused,
            "total": len(items), "ready": sum(p["status"] == "ready" for p in items),
            "failed": sum(p["status"] == "failed" for p in items),
            "active": next((p["name"] for p in items if p["status"] == "indexing"), None),
            "download_bytes": min(cache_bytes, MODEL_BYTES), "model_bytes": MODEL_BYTES,
            "metrics": {"api_rss": psutil.Process().memory_info().rss, **runtime.metrics},
            "model_id": MANIFEST["model_id"]}


@app.get("/api/session")
def session():
    return {"token": TOKEN}


@app.post("/api/shutdown")
async def shutdown():
    async def finish():
        await asyncio.sleep(0.2)
        await runtime.close()
        os.kill(os.getpid(), signal.SIGTERM)
    asyncio.create_task(finish())
    return {"ok": True}


@app.get("/api/status")
def status():
    return state()


@app.get("/api/photos")
def list_photos():
    return db.photos()


@app.get("/api/events")
async def events(request: Request):
    async def stream():
        while not await request.is_disconnected():
            yield f"data: {json.dumps(state())}\n\n"
            await asyncio.sleep(1.5)
    return StreamingResponse(stream(), media_type="text/event-stream")


@app.post("/api/model/download")
async def download():
    if runtime.download_task and not runtime.download_task.done():
        return {"status": "downloading"}
    if runtime.snapshot:
        runtime.model_state, runtime.model_error = "sleeping", None
        return {"status": "cached"}
    runtime.download_task = asyncio.create_task(runtime.download())
    return {"status": "downloading"}


def prepare_photo(path, photo_id):
    with Image.open(path) as source:
        if source.format not in ("JPEG", "PNG", "WEBP") or getattr(source, "is_animated", False):
            raise ValueError("Use a still JPEG, PNG, or WebP photo.")
        if source.width * source.height > MAX_PIXELS:
            raise ValueError("This photo is larger than the 64-megapixel limit.")
        if source.width * source.height * 16 + 256 * 1024**2 > psutil.virtual_memory().available:
            raise ValueError("Not enough free memory to decode this photo safely. Try a smaller copy.")
        oriented = ImageOps.exif_transpose(source)
        image = oriented.convert("RGB")
        try:
            width, height = image.size
            image.thumbnail((1920, 1920), Image.Resampling.LANCZOS)
            image.save(DATA / "previews" / f"{photo_id}.jpg", quality=88, optimize=True)
            image.thumbnail((600, 600), Image.Resampling.LANCZOS)
            image.save(DATA / "thumbnails" / f"{photo_id}.jpg", quality=82, optimize=True)
        finally:
            image.close()
            if oriented is not source:
                oriented.close()
        return width, height


@app.post("/api/photos", status_code=201)
async def upload(file: UploadFile):
    async with runtime.upload_slots:
        return await import_photo(file)


async def import_photo(file: UploadFile):
    if len(db.photos()) >= 100:
        raise HTTPException(409, "This proof of concept supports up to 100 imported photos.")
    photo_id = uuid.uuid4().hex
    temp = DATA / "tmp" / photo_id
    total = 0
    try:
        with temp.open("wb") as target:
            while chunk := await file.read(1024*1024):
                total += len(chunk)
                if total > MAX_BYTES:
                    raise ValueError("Photos must be 25 MB or smaller.")
                target.write(chunk)
        async with runtime.image_lock:
            width, height = await asyncio.to_thread(prepare_photo, temp, photo_id)
        temp.replace(DATA / "originals" / photo_id)
        name = (file.filename or "Untitled photo").replace("\\", "/").split("/")[-1][:240]
        with db.connect() as conn:
            conn.execute("INSERT INTO photos(id,name,original,width,height,size,created) VALUES(?,?,?,?,?,?,?)", (photo_id, name, photo_id, width, height, total, datetime.now(timezone.utc).isoformat()))
        return {"id": photo_id}
    except (ValueError, UnidentifiedImageError, Image.DecompressionBombError, Image.DecompressionBombWarning) as error:
        raise HTTPException(400, str(error)) from error
    except OSError as error:
        if error.errno == 28 or getattr(error, "winerror", None) == 112:
            raise HTTPException(507, "The disk is full. Free some space and import this photo again.") from error
        raise HTTPException(400, "This photo could not be read or saved. Check the file and available disk space.") from error
    finally:
        await file.close()
        temp.unlink(missing_ok=True)
        with db.connect() as conn:
            exists = conn.execute("SELECT 1 FROM photos WHERE id=?", (photo_id,)).fetchone()
        if not exists:
            for folder, name in (("originals", photo_id), ("thumbnails", f"{photo_id}.jpg"), ("previews", f"{photo_id}.jpg")):
                (DATA / folder / name).unlink(missing_ok=True)


@app.get("/api/photos/{photo_id}/{variant}")
def media(photo_id: str, variant: str):
    if variant not in ("thumbnail", "preview"):
        raise HTTPException(404)
    with db.connect() as conn:
        found = conn.execute("SELECT id FROM photos WHERE id=?", (photo_id,)).fetchone()
    if not found:
        raise HTTPException(404)
    path = DATA / ("thumbnails" if variant == "thumbnail" else "previews") / f"{found['id']}.jpg"
    if not path.is_file():
        raise HTTPException(404, "Preview is missing.")
    # UUID media URLs never change content. Reusing decoded previews avoids
    # repeated downloads and image-buffer churn while moving through the gallery.
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=31536000, immutable"})


class Query(BaseModel):
    query: str = Field(min_length=1, max_length=500)
    scope: Literal["photos", "favorites"] = "photos"


@app.post("/api/search")
async def search(body: Query):
    if not body.query.strip():
        raise HTTPException(400, "Describe a photo to search.")
    try:
        return await runtime.search(body.query.strip(), scope=body.scope)
    except asyncio.QueueFull:
        raise HTTPException(429, "Search is busy. Try again in a moment.")
    except (ValueError, RuntimeError, TimeoutError) as error:
        raise HTTPException(503, str(error)) from error


@app.post("/api/indexing/{action}")
def indexing(action: str):
    if action in ("pause", "resume"):
        runtime.paused = action == "pause"
        db.set_setting("paused", str(runtime.paused).lower())
    elif action == "retry":
        with db.connect() as conn:
            conn.execute("UPDATE photos SET status='queued',error=NULL WHERE status='failed'")
        runtime.model_error = None
        runtime.model_state = "sleeping" if runtime.snapshot else "not_downloaded"
    else:
        raise HTTPException(404)
    return state()


@app.post("/api/photos/{photo_id}/favorite")
def favorite(photo_id: str):
    with db.connect() as conn:
        conn.execute("UPDATE photos SET favorite=1-favorite WHERE id=?", (photo_id,))
    return {"ok": True}


@app.delete("/api/photos/{photo_id}")
async def remove(photo_id: str):
    async with runtime.image_lock:
        with db.connect() as conn:
            row = conn.execute("SELECT original FROM photos WHERE id=?", (photo_id,)).fetchone()
            if not row:
                raise HTTPException(404)
            conn.execute("DELETE FROM photos WHERE id=?", (photo_id,))
        for folder, name in (("originals", row["original"]), ("thumbnails", f"{photo_id}.jpg"), ("previews", f"{photo_id}.jpg")):
            (DATA / folder / name).unlink(missing_ok=True)
    return {"ok": True}


@app.post("/api/library/reset")
async def reset():
    for photo in db.photos():
        await remove(photo["id"])
    return {"ok": True}


class Device(BaseModel):
    mode: str


@app.post("/api/device")
async def device(body: Device):
    if body.mode not in ("auto", "cpu"):
        raise HTTPException(400, "Choose auto or cpu.")
    if runtime.busy or runtime.model_state == "loading" or not runtime.queries.empty() or any(p["status"] == "indexing" for p in db.photos()):
        raise HTTPException(409, "Pause indexing and wait for the current operation to finish first.")
    runtime.release()
    runtime.mode = body.mode
    runtime.model_error = None
    runtime.model_state = "sleeping" if runtime.snapshot else "not_downloaded"
    db.set_setting("device", body.mode)
    return state()


if (ROOT / "dist").is_dir():
    app.mount("/", StaticFiles(directory=ROOT / "dist", html=True), name="frontend")
