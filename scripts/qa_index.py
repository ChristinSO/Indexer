"""Measure cold indexing of the isolated 20-image corpus, including process memory."""
import json
from pathlib import Path
import sqlite3
import time
import httpx
import psutil

client = httpx.Client(base_url='http://127.0.0.1:8766', timeout=210)
client.headers['x-indexer-token'] = client.get('/api/session').json()['token']
client.post('/api/device', json={'mode': 'auto'}).raise_for_status()
server_pid = next(c.pid for c in psutil.net_connections(kind='tcp') if c.laddr.port == 8766 and c.status == 'LISTEN')
server_process = psutil.Process(server_pid)
with sqlite3.connect('.local/qa-data/library.sqlite3') as conn:
    conn.execute('DELETE FROM embeddings')
    conn.execute("UPDATE photos SET status='queued',error=NULL")
started = time.perf_counter()
peak_private, peak_rss, peak_gpu = 0, 0, 0
while time.perf_counter() - started < 180:
    state = client.get('/api/status').json()
    if state['failed']:
        raise RuntimeError(state['model_error'])
    processes = [server_process, *server_process.children(recursive=True)]
    infos = [p.memory_info() for p in processes if p.is_running()]
    peak_private = max(peak_private, sum(info.private for info in infos))
    peak_rss = max(peak_rss, sum(info.rss for info in infos))
    peak_gpu = max(peak_gpu, state['metrics'].get('gpu_reserved', 0))
    if state['ready'] == 20:
        break
    time.sleep(0.25)
assert state['ready'] == 20
report = {'cold_index_20_seconds': time.perf_counter() - started, 'peak_backend_private': peak_private, 'peak_backend_rss': peak_rss, 'peak_gpu_reserved': peak_gpu, 'state': state}
Path('.local/index-qa.json').write_text(json.dumps(report, indent=2))
print(json.dumps(report, indent=2))
