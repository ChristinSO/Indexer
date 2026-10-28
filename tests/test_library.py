import asyncio
import errno
import io
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image
from server import config, database as db, main, runtime as runtime_module


@pytest.fixture
def client(tmp_path, monkeypatch):
    for module in (config, db, main, runtime_module):
        monkeypatch.setattr(module, 'DATA', tmp_path)
    with TestClient(main.app) as client:
        client.headers['x-indexer-token'] = client.get('/api/session').json()['token']
        yield client


def upload(client, name='photo.jpg', orientation=None):
    image = Image.new('RGB', (80, 40), 'blue')
    exif = image.getexif()
    if orientation:
        exif[274] = orientation
    data = io.BytesIO()
    image.save(data, format='JPEG', exif=exif)
    image.close()
    return client.post('/api/photos', files={'file': (name, data.getvalue(), 'image/jpeg')})


def test_import_preview_favorite_delete_and_cascade(client):
    response = upload(client, '../unsafe.jpg', orientation=6)
    assert response.status_code == 201
    photo_id = response.json()['id']
    photo = client.get('/api/photos').json()[0]
    assert (photo['name'], photo['width'], photo['height'], photo['status']) == ('unsafe.jpg', 40, 80, 'queued')
    preview = client.get(f'/api/photos/{photo_id}/preview')
    assert preview.status_code == 200
    assert 'immutable' in preview.headers['cache-control']
    assert client.get('/api/photos').headers['cache-control'] == 'no-store'
    assert Image.open(io.BytesIO(preview.content)).size == (40, 80)
    assert client.post(f'/api/photos/{photo_id}/favorite').status_code == 200
    assert client.get('/api/photos').json()[0]['favorite'] == 1
    with db.connect() as conn:
        conn.execute('INSERT INTO embeddings VALUES(?,?,?)', (photo_id, config.PIPELINE, np.zeros(768, np.float32).tobytes()))
    assert client.delete(f'/api/photos/{photo_id}').status_code == 200
    assert client.get('/api/photos').json() == []
    with db.connect() as conn:
        assert conn.execute('SELECT COUNT(*) FROM embeddings').fetchone()[0] == 0
    assert all(not list((config.DATA / folder).iterdir()) for folder in ('originals', 'thumbnails', 'previews', 'tmp'))


def test_bad_images_and_byte_limit_leave_no_files(client, monkeypatch):
    assert client.post('/api/photos', files={'file': ('bad.jpg', b'not an image')}).status_code == 400
    monkeypatch.setattr(main, 'MAX_BYTES', 10)
    assert upload(client).status_code == 400
    assert client.get('/api/photos').json() == []
    assert not list((config.DATA / 'tmp').iterdir())


def test_disk_full_is_actionable_and_atomic(client, monkeypatch):
    def no_space(*args):
        raise OSError(errno.ENOSPC, 'Disk full')
    monkeypatch.setattr(main, 'prepare_photo', no_space)
    result = upload(client)
    assert result.status_code == 507
    assert 'disk is full' in result.json()['detail']
    assert not db.photos()
    assert not list((config.DATA / 'tmp').iterdir())


def test_origin_host_session_and_path_checks(client):
    assert client.post('/api/indexing/pause', headers={'x-indexer-token': ''}).status_code == 403
    assert client.get('/api/photos', headers={'origin': 'https://evil.example'}).status_code == 403
    assert client.get('/api/photos', headers={'host': 'evil.example'}).status_code == 403
    assert client.get('/api/photos/unknown/preview').status_code == 404
    assert client.get('/api/photos/unknown/original').status_code == 404
    assert client.post('/api/search', json={'query': '  '}).status_code == 400
    assert client.post('/api/search', json={'query': 'cat'}).status_code == 503


def test_restart_requeues_interrupted_and_stale_vectors(client):
    photo_id = upload(client).json()['id']
    with db.connect() as conn:
        conn.execute("UPDATE photos SET status='indexing'")
    db.initialize()
    assert db.photos()[0]['status'] == 'queued'
    with db.connect() as conn:
        conn.execute("UPDATE photos SET status='ready'")
        conn.execute('INSERT INTO embeddings VALUES(?,?,?)', (photo_id, 'old-pipeline', b'old'))
    db.initialize()
    assert db.photos()[0]['status'] == 'queued'
    (config.DATA / 'originals' / photo_id).unlink()
    db.initialize()
    assert db.photos()[0]['status'] == 'failed'


def test_crash_orphans_cleaned_within_managed_storage(client):
    photo_id = upload(client).json()['id']
    orphan = config.DATA / 'originals' / ('f' * 32)
    orphan.write_bytes(b'abandoned import')
    unrelated = config.DATA / 'originals' / 'keep-me.txt'
    unrelated.write_text('not a managed filename')
    db.clean_orphans()
    assert not orphan.exists()
    assert unrelated.exists()
    assert (config.DATA / 'originals' / photo_id).exists()


def test_pause_persists_and_device_cannot_interrupt_inference(client):
    assert client.post('/api/indexing/pause').json()['paused']
    assert db.setting('paused') == 'true'
    main.runtime.busy = True
    assert client.post('/api/device', json={'mode': 'cpu'}).status_code == 409
    main.runtime.busy = False
    assert client.post('/api/device', json={'mode': 'cpu'}).status_code == 200
    assert db.setting('device') == 'cpu'
    assert not client.post('/api/indexing/resume').json()['paused']


@pytest.mark.parametrize('message', ['Simulated GPU out of memory', 'Worker connection closed'])
def test_worker_failures_checkpoint_without_retry_loop(client, message):
    photo_id = upload(client).json()['id']

    async def exercise():
        rt = runtime_module.Runtime()
        rt.snapshot = 'test-snapshot'
        calls = 0
        async def failed_inference(*args):
            nonlocal calls
            calls += 1
            raise RuntimeError(message)
        rt.infer = failed_inference
        await rt.start()
        for _ in range(100):
            if rt.model_state == 'error':
                break
            await asyncio.sleep(0.01)
        assert rt.model_state == 'error'
        await asyncio.sleep(0.3)
        assert calls == 1
        await rt.close()

    asyncio.run(exercise())
    photo = next(p for p in db.photos() if p['id'] == photo_id)
    assert photo['status'] == 'failed'
    assert photo['error'] == message
    with db.connect() as conn:
        assert conn.execute('SELECT COUNT(*) FROM embeddings').fetchone()[0] == 0


def test_removed_photo_cannot_be_resurrected_by_late_result(client):
    photo_id = upload(client).json()['id']
    async def exercise():
        rt = runtime_module.Runtime()
        rt.snapshot = 'test-snapshot'
        async def deleted_during_inference(*args):
            with db.connect() as conn:
                conn.execute('DELETE FROM photos WHERE id=?', (photo_id,))
            return {'vector': np.zeros(768, np.float32).tobytes()}
        rt.infer = deleted_during_inference
        await rt.start()
        for _ in range(100):
            if not db.photos():
                break
            await asyncio.sleep(0.01)
        await rt.close()
    asyncio.run(exercise())
    assert not db.photos()
    with db.connect() as conn:
        assert conn.execute('SELECT COUNT(*) FROM embeddings').fetchone()[0] == 0


def test_search_scope_limits_ranking_and_counts_in_database(client, monkeypatch):
    ids = [upload(client, f'{i}.jpg').json()['id'] for i in range(4)]
    with db.connect() as conn:
        for photo_id, score, favorite in zip(ids[:3], [1., .8, .6], [0, 1, 1]):
            vector = np.zeros(768, np.float32)
            vector[:2] = [score, np.sqrt(1-score**2)]
            conn.execute("UPDATE photos SET status='ready',favorite=? WHERE id=?", (favorite, photo_id))
            conn.execute('INSERT INTO embeddings VALUES(?,?,?)', (photo_id, config.PIPELINE, vector.tobytes()))
        conn.execute('UPDATE photos SET favorite=1 WHERE id=?', (ids[3],))  # Not indexed yet.

    async def encode_query(*args):
        vector = np.zeros(768, np.float32)
        vector[0] = 1
        return {'vector': vector.tobytes(), 'milliseconds': 1}
    monkeypatch.setattr(main.runtime, 'infer', encode_query)
    favorites = client.post('/api/search', json={'query': 'cat', 'scope': 'favorites'})
    assert favorites.status_code == 200
    assert favorites.json()['scope'] == 'favorites'
    assert favorites.json()['searched'] == 2
    assert [hit['id'] for hit in favorites.json()['hits']] == ids[1:3]
    for body in ({'query': 'cat'}, {'query': 'cat', 'scope': 'photos'}):
        all_photos = client.post('/api/search', json=body).json()
        assert all_photos['scope'] == 'photos'
        assert all_photos['searched'] == 3
        assert [hit['id'] for hit in all_photos['hits']] == ids[:3]

    async def unfavorite_during_inference(*args):
        with db.connect() as conn:
            conn.execute('UPDATE photos SET favorite=0 WHERE id=?', (ids[1],))
        return await encode_query()
    monkeypatch.setattr(main.runtime, 'infer', unfavorite_during_inference)
    favorites = client.post('/api/search', json={'query': 'cat', 'scope': 'favorites'}).json()
    assert favorites['searched'] == 1
    assert [hit['id'] for hit in favorites['hits']] == [ids[2]]


def test_empty_favorites_never_fall_back_to_all_photos_or_load_model(client, monkeypatch):
    photo_id = upload(client).json()['id']
    with db.connect() as conn:
        conn.execute("UPDATE photos SET status='ready' WHERE id=?", (photo_id,))
        conn.execute('INSERT INTO embeddings VALUES(?,?,?)', (photo_id, config.PIPELINE, np.zeros(768, np.float32).tobytes()))
    async def unexpected_inference(*args):
        pytest.fail('Empty favorites must not run inference')
    monkeypatch.setattr(main.runtime, 'infer', unexpected_inference)
    response = client.post('/api/search', json={'query': 'cat', 'scope': 'favorites'})
    assert response.status_code == 200
    assert response.json() == {'hits': [], 'searched': 0, 'milliseconds': 0, 'scope': 'favorites'}
    assert main.runtime.queries.empty()
    assert main.runtime.process is None
    assert client.post('/api/search', json={'query': 'cat', 'scope': 'unknown'}).status_code == 422
