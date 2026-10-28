"""Real-model checks against 20 numbered, visually inspected sample photos."""
import json
import time
from pathlib import Path
import httpx
import numpy as np

cases = [
    ('a black and white cat', '04.jpg'),
    ('a dog against a yellow background', '03.jpg'),
    ('cups of coffee held in hands', '05.jpg'),
    ('the Eiffel Tower in Paris', '06.jpg'),
    ('a car driving on a road', '08.jpg'),
    ('a forest full of tall trees', '09.jpg'),
    ('yellow flowers under a blue sky', '11.jpg'),
    ('pizza on a wooden table', '13.jpg'),
    ('a bicycle against a wall', '16.jpg'),
    ('a bookshelf filled with books', '17.jpg'),
]
client = httpx.Client(base_url='http://127.0.0.1:8766', timeout=210)
client.headers['x-indexer-token'] = client.get('/api/session').json()['token']
names = {p['id']: p['name'] for p in client.get('/api/photos').json()}
quality, timings, inference, memory = [], [], [], []
for i in range(110):
    query, expected = cases[i % 10]
    start = time.perf_counter()
    response = client.post('/api/search', json={'query': query})
    response.raise_for_status()
    result = response.json()
    elapsed = (time.perf_counter() - start) * 1000
    metrics = client.get('/api/status').json()['metrics']
    if i < 10:
        top = [names[h['id']] for h in result['hits'][:3]]
        quality.append({'query': query, 'expected': expected, 'top3': top, 'hit': expected in top})
        print(json.dumps(quality[-1]), flush=True)
    else:
        timings.append(elapsed)
        inference.append(result['milliseconds'])
        memory.append(metrics)
report = {'quality': quality, 'top3_hits': sum(c['hit'] for c in quality),
          'warm_100_http_ms': {'median': float(np.median(timings)), 'p95': float(np.percentile(timings, 95))},
          'warm_100_inference_ms': {'median': float(np.median(inference)), 'p95': float(np.percentile(inference, 95))},
          'memory_first': memory[0], 'memory_last': memory[-1],
          'peak_worker_rss': max(m['rss'] for m in memory), 'peak_gpu_reserved': max(m['gpu_reserved'] for m in memory)}
Path('.local/search-qa.json').write_text(json.dumps(report, indent=2))
print(json.dumps(report, indent=2), flush=True)
assert report['top3_hits'] >= 8
