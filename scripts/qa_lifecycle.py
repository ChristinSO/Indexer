"""Exercise the real worker across idle release, restart, and CPU mode."""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import time
import httpx

root = Path(__file__).resolve().parent.parent
client = httpx.Client(base_url='http://127.0.0.1:8766', timeout=210)

def connect():
    for _ in range(80):
        try:
            client.headers['x-indexer-token'] = client.get('/api/session').json()['token']
            return
        except httpx.TransportError:
            time.sleep(0.25)
    raise RuntimeError('QA server did not start')

def fingerprints():
    with sqlite3.connect(root / '.local/qa-data/library.sqlite3') as conn:
        return [(row[0], row[1], hashlib.sha256(row[2]).hexdigest()) for row in conn.execute('SELECT id,attempts,vector FROM photos JOIN embeddings ON id=photo_id ORDER BY id')]

def start():
    env = {**os.environ, 'INDEXER_DATA_DIR': str(root / '.local/qa-data'), 'INDEXER_IDLE_SECONDS': '5', 'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1'}
    process = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'server.main:app', '--host', '127.0.0.1', '--port', '8766', '--no-access-log'], env=env, cwd=root, creationflags=subprocess.CREATE_NO_WINDOW, stdout=log, stderr=log)
    connect()
    return process

def stop(process=None):
    client.post('/api/shutdown').raise_for_status()
    if process:
        process.wait(timeout=15)
    else:
        time.sleep(1)

def query(text):
    began = time.perf_counter()
    response = client.post('/api/search', json={'query': text})
    response.raise_for_status()
    return response.json(), (time.perf_counter() - began)*1000

connect()
baseline = fingerprints()
stop()
report = {}
with (root / '.local/lifecycle.log').open('w') as log:
    process = start()
    try:
        assert len(baseline) == 20 and fingerprints() == baseline
        result, cold = query('a cat')
        report['cold_gpu_search_ms'] = cold
        report['gpu'] = client.get('/api/status').json()
        report['vectors_unchanged_after_restart'] = fingerprints() == baseline
        first_hit = result['hits'][0]['id']
        time.sleep(6)
        report['after_idle'] = client.get('/api/status').json()
        assert report['after_idle']['model'] == 'sleeping'
        assert 'rss' not in report['after_idle']['metrics']
        client.post('/api/device', json={'mode': 'cpu'}).raise_for_status()
        result, cold_cpu = query('a cat')
        report['cold_cpu_search_ms'] = cold_cpu
        report['cpu'] = client.get('/api/status').json()
        assert report['cpu']['device'] == 'cpu'
        assert report['cpu']['dtype'] == 'torch.float32'
        assert result['hits'][0]['id'] == first_hit
        client.post('/api/device', json={'mode': 'auto'}).raise_for_status()
    finally:
        stop(process)
    process = start()
    try:
        assert fingerprints() == baseline
        report['second_restart_preserves_vectors'] = True
    finally:
        stop(process)
Path('.local/lifecycle-qa.json').write_text(json.dumps(report, indent=2))
print(json.dumps(report, indent=2))
