# Indexer Alpha validation

## Favorites search scope

The production build, all 12 backend tests, and four search-helper tests passed. Added backend coverage verifies that Favorites excludes a higher-scoring nonfavorite before ranking, returns scope-specific counts, excludes unindexed favorites, respects favorite changes during inference, and returns empty results without loading the model when there are no searchable favorites. Invalid scopes are rejected; requests without a scope preserve full-library behavior.

The real-model browser check favorited only the dog and bookshelf in the isolated 20-image corpus. Searching for “a cat” on Favorites returned only those two images and kept Favorites active; Filtered at 60% retained only the dog. Unfavoriting removed images from results and closed a viewer whose image left the scope. Empty favorites stayed empty. Running the same query on Photos returned all 20 images with the nonfavorited cat first. A delayed search response was ignored after navigation to Favorites. No page errors occurred. Evidence: `.local/favorites-search-qa.json` and `.local/favorites-search.png`; reproduction: `scripts/qa_favorites_search.mjs`. The test restores the sample library's original favorite flags.

## Search modes update

The header revision passed browser checks at 1440, 820, 390, and 320 pixels: modes remain to the right of the search field, mobile labels become icons, tooltips explain both modes on hover/focus and close with Escape, and there is no horizontal overflow. Recently added and the gallery shield footer are absent; Photos, Favorites, and sidebar Settings remain available. Filtering still uses a single inference response. The production build passed.

Ranked mode retains every result; Filtered mode filters by an inclusive, adjustable cutoff with a 70% default. The UI uses absolute cosine similarity percentages, clamped to 0–100 and rounded to one decimal. These are not probabilities or calibrated relevance thresholds.

Four focused tests passed for order preservation, inclusive cutoff/rounding boundaries, 0% and 100% cutoff behavior, and absolute score conversion (`npm run test:search`). The TypeScript/Vite build passed.

The real-model browser check searched the isolated 20-photo library for “a cat”: Ranked displayed all 20 scores; Filtered at 70% showed only the cat at 71.7%. 80% and 100% produced the expected empty state, 0% showed all photos, and returning to Ranked restored all results. One inference request served every mode/cutoff change. Badges were verified at each tile's top right without overlapping favorites, and disappear when search is cleared. The mobile layout had no horizontal overflow or page errors.

The “Private by design” badge and top-bar settings icon are removed. Sidebar and mobile-navigation Settings remain functional. Evidence: `.local/search-modes-qa.json`, `.local/search-sorted.png`, `.local/search-definitive.png`, `.local/search-definitive-mobile.png`. Reproduce with `scripts/qa_search_modes.mjs` against the isolated server on port 8766.

Run on October 28, 2026, on Windows with an Intel i7-11800H, approximately 31.7 GiB RAM, and an RTX 3080 Laptop GPU with 16 GiB VRAM.

## Real-model retrieval

An isolated library under `.local/qa-data` contains 20 public sample photographs. The main library is empty and ready for the user's photos. Samples have numbered filenames, with no semantic filenames or tags supplied to the model. Source URLs are recorded in `.local/qa-photos/sources.json`; `scripts/qa_photos.py` reproduces the corpus. Images cover animals, landscapes, food, a vehicle, a bicycle, books, and a landmark, with some overlapping outdoor scenes.

The samples were visually inspected and ten expected results were specified before running the retrieval check. All ten appeared at rank one:

| Description | Expected image | Rank |
| --- | --- | --- |
| A black and white cat | 04.jpg | 1 |
| A dog against a yellow background | 03.jpg | 1 |
| Cups of coffee held in hands | 05.jpg | 1 |
| The Eiffel Tower in Paris | 06.jpg | 1 |
| A car driving on a road | 08.jpg | 1 |
| A forest full of tall trees | 09.jpg | 1 |
| Yellow flowers under a blue sky | 11.jpg | 1 |
| Pizza on a wooden table | 13.jpg | 1 |
| A bicycle against a wall | 16.jpg | 1 |
| A bookshelf filled with books | 17.jpg | 1 |

This is a small, easy implementation check, not a general accuracy benchmark. No tuning was applied. Retrieval on the user's own photos, difficult near-duplicates, negation, and fine visual details still needs evaluation.

## Latency and backend memory

The CUDA worker used BF16 with the audio encoder disabled and 280 image soft tokens. Query embeddings used `SearchQuery`. All 20 image vectors were finite, normalized, 768-dimensional, and persisted in SQLite.

| Measurement | Observed |
| --- | --- |
| Cold indexing of 20 existing imported samples, including worker load | 15.0 seconds |
| First GPU search after worker unload | 11.1 seconds |
| 100 warm searches, HTTP response median / p95 | 338 / 365 ms |
| Text inference alone, median / p95 | 78 / 99 ms |
| Worker resident memory at first / last warm search | 1.762 / 1.762 GiB |
| API resident memory during warm searches | 64 MiB |
| GPU reserved during warm searches | 880 MiB |
| Peak GPU reserved during image indexing | 976 MiB |
| Peak combined backend resident memory during indexing | 1.97 GiB |
| Peak combined Windows private committed memory during indexing | 4.86 GiB |
| CPU-only FP32 cold search | 10.9 seconds, including load |

The private committed-memory measurement exceeds the spec's 4 GiB target. Resident memory and Windows commitment measure different things; they must not be conflated. The application bounds concurrency and unloads the worker, but does not enforce a hard 4 GiB process limit. Further reduction of CUDA/PyTorch committed memory remains an optimization opportunity before expanding the library scope. These measurements use samples resized to a maximum width of 1100 pixels, not maximum-size 64-megapixel inputs.

The 100-query run showed no sustained increase in worker resident memory or GPU reservation. Idle unload was exercised using a five-second test timeout through the same code path as the production five-minute timeout. The worker exited and API resident memory returned to approximately 60 MiB. Windows WDDM did not expose per-process VRAM totals through `nvidia-smi`; GPU figures above are PyTorch allocation/reservation counters.

## Persistence, offline operation, and failures

- Two service restarts preserved all vector hashes and indexing attempt counts: no unnecessary re-embedding.
- Real GPU and CPU searches succeeded with Hugging Face and Transformers offline modes enabled. This verifies cached loading; an OS firewall disconnection test was not performed.
- CPU FP32 returned the same expected first result for the checked cat query. Full CPU image-index throughput was not benchmarked.
- Ten automated tests passed: import/orientation/preview/favorite/removal, embedding cascade deletion, invalid data and file-size rejection, disk-full response and cleanup, local origin/session/host checks, interrupted and stale indexing recovery, orphan cleanup, processing-mode concurrency protection, simulated OOM/worker exit, and removal before a late result.
- Disk-full and worker failures are injected tests. No real GPU OOM or filled system disk was induced.
- `npm stop` and `npm start` were exercised against the main service; its library remains empty and cached model setup survives restart.

## Browser and build

TypeScript and Vite production builds passed. Playwright exercised import of 20 files, search with the real backend, favorites, keyboard viewer navigation and focus restoration, settings, two tabs sharing one service, and a 390-pixel mobile layout with no horizontal overflow. The tests also use reduced-motion mode and report no page errors.

The UI removal confirmation and invalid-image error flow also passed, and the source image's SHA-256 remained unchanged after import/removal. Preview and thumbnail URLs now have private immutable caching; changing library metadata still uses uncached API responses.

After 700 open/close preview cycles, aggregate Chromium renderer private memory was 158.7 MiB, below the 300 MiB target. However, it rose from 106.7 MiB after 200 cycles and had not established a plateau. JavaScript heap rose from 5.10 to 5.43 MiB over those last 500 cycles. The stricter less-than-10% private-memory growth target is **not met** by this stress run. Longer-session browser/native allocation profiling remains necessary before expanding scope; the report does not claim leak-free operation.

One stress-test search timed out while a separate benchmark was clearing/rebuilding the test index. The same workflow passed when run against a ready index; the final harness explicitly waits for all 20 photos to be ready before asserting retrieval. There were no page errors in the final run.

Browser memory results are recorded in `.local/ui-qa.json`. Screenshots are available in `.local/ui-gallery.png`, `.local/ui-search.png`, `.local/ui-mobile.png`, and `.local/ui-ready-empty.png`. Sample-gallery screenshots show the separate QA library, not user photos.

## Reproduction

- `npm run build`
- `.venv\Scripts\python.exe -m pytest -q` (in a restricted workspace, pass a fresh `--basetemp=.local/pytest-run-N`)
- `scripts/qa_search.py`: ten relevance checks and 100 warm searches against an isolated server on port 8766.
- `scripts/qa_lifecycle.py`: restart, idle release, offline-cache loading, and CPU-mode checks; owns and stops the temporary QA server.
- `scripts/qa_index.py`: re-indexes only `.local/qa-data`, sampling process memory during the run.
- `scripts/qa_browser.mjs`, `scripts/qa_ui_final.mjs`: browser workflows and screenshots against port 8766.

Raw measurements are stored in `.local/search-qa.json`, `.local/index-qa.json`, `.local/lifecycle-qa.json`, and `.local/ui-qa.json`. QA data and model artifacts are excluded from source control.
