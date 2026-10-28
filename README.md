# Indexer Alpha

Local photo search with EmbeddingGemma 2. Rank or filter results across all photos or just favorites.

Requires Windows, Node.js 22.12+, and [uv](https://docs.astral.sh/uv/).

```powershell
uv sync --locked --python 3.12
npm ci
npm run build
npm start
```

Open http://127.0.0.1:8765, download the model in Settings, then add photos. After setup, search works locally.

Model weights and photo data live in `%LOCALAPPDATA%\IndexerAlpha` and are excluded from Git. Source photos stay untouched.

Stop with `npm stop`. See [PROJECT_SPEC.md](PROJECT_SPEC.md) for details.
