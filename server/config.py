"""Paths and fixed limits for the local proof of concept."""
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.getenv("INDEXER_DATA_DIR", str(Path(os.environ.get("LOCALAPPDATA", str(ROOT / ".local"))) / "IndexerAlpha"))).resolve()
MANIFEST = json.loads((ROOT / "model-manifest.json").read_text(encoding="utf-8-sig"))
PIPELINE = f"{MANIFEST['revision']}:{MANIFEST['pipeline_version']}"
MAX_BYTES = 25 * 1024 * 1024
MAX_PIXELS = 64_000_000
IDLE_SECONDS = int(os.getenv("INDEXER_IDLE_SECONDS", "300"))


def prepare():
    for name in ("originals", "thumbnails", "previews", "tmp", "model-cache"):
        (DATA / name).mkdir(parents=True, exist_ok=True)
