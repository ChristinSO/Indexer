"""Create an isolated sample library sharing the downloaded model read-only."""
import os
import sqlite3
from pathlib import Path

root = Path(__file__).resolve().parent.parent
production = Path(os.environ['LOCALAPPDATA']) / 'IndexerAlpha' / 'library.sqlite3'
with sqlite3.connect(production) as conn:
    settings = dict(conn.execute("SELECT key,value FROM settings WHERE key IN ('snapshot','model_revision')"))
os.environ['INDEXER_DATA_DIR'] = str(root / '.local' / 'qa-data')
from server import config, database
config.prepare()
database.initialize()
for key, value in settings.items():
    database.set_setting(key, value)
print('Isolated QA library initialized.')
