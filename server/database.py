"""SQLite owns library state and atomically committed image vectors."""
import sqlite3
import re
from contextlib import contextmanager
from .config import DATA, PIPELINE


@contextmanager
def connect():
    conn = sqlite3.connect(DATA / "library.sqlite3", timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        with conn:
            yield conn
    finally:
        conn.close()


def initialize():
    with connect() as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS photos (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, original TEXT NOT NULL,
                width INTEGER NOT NULL, height INTEGER NOT NULL, size INTEGER NOT NULL,
                created TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
                error TEXT, favorite INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS embeddings (
                photo_id TEXT PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE,
                pipeline TEXT NOT NULL, vector BLOB NOT NULL
            );
            CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        """)
        conn.execute("UPDATE photos SET status='queued',error=NULL WHERE status='indexing'")
        conn.execute("UPDATE photos SET status='queued' WHERE status='ready' AND id NOT IN (SELECT photo_id FROM embeddings WHERE pipeline=?)", (PIPELINE,))
        for row in conn.execute("SELECT id,original FROM photos").fetchall():
            if not (DATA / "originals" / row["original"]).is_file():
                conn.execute("UPDATE photos SET status='failed',error='The imported file is missing. Remove it and import it again.' WHERE id=?", (row["id"],))


def photos():
    with connect() as conn:
        return [dict(row) for row in conn.execute("SELECT id,name,width,height,size,created,status,error,favorite FROM photos ORDER BY created DESC,id")]


def clean_orphans():
    """Reconcile files left by an interrupted import/delete, only in managed folders."""
    with connect() as conn:
        ids = {row[0] for row in conn.execute("SELECT id FROM photos")}
    for folder in ("originals", "thumbnails", "previews"):
        for path in (DATA / folder).iterdir():
            photo_id = path.name if folder == "originals" else path.stem
            if path.is_file() and re.fullmatch(r"[0-9a-f]{32}", photo_id) and photo_id not in ids:
                path.unlink()


def setting(key, default=None):
    with connect() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        return row[0] if row else default


def set_setting(key, value):
    with connect() as conn:
        conn.execute("INSERT OR REPLACE INTO settings VALUES (?,?)", (key, value))
