# Contributing

## Tests

| What | How |
|:--|:--|
| Server tests | `docker build --target test -t snild-test . && docker run --rm snild-test` |
| Client tests | `python3 scripts/fetch_vendor.py`, then `node --test "tests/client/**/*.test.js"` (Node 22 or newer, nothing to install) |
| Browser tests | `node --test --test-concurrency=1 "tests/browser/*.test.js"` against a disposable instance (below); needs Chrome or Edge, named by `SNILD_CHROME` if it is not on the path |
| Smoke test | `python3 scripts/smoke_test.py` against a disposable instance (below) |

### A disposable instance

The browser and smoke tests add accounts and reset passwords on the snild they test, so they refuse to run unless `SNILD_TEST_INSTANCE=1` says it is disposable. Run it from a separate worktree, so the instance does not read your own `.env` or `config/`, in a shell without your own `SNILD_*` variables, and give it its own Compose project, port and volume. A worktree holds a committed revision: commit what you want to test first.

```bash
git worktree add ../snild-test HEAD && cd ../snild-test
export COMPOSE_PROJECT_NAME=snild-test SNILD_PUBLISH_PORT=8081 SNILD_ENABLE_EMULATOR=1
export SNILD_TEST_INSTANCE=1 SNILD_URL=http://127.0.0.1:8081
docker compose up -d --build --wait
node --test --test-concurrency=1 "tests/browser/*.test.js"   # first, on a fresh instance: it also tests setup
python3 scripts/smoke_test.py
docker compose down -v    # removes the instance and its data
cd - && git worktree remove ../snild-test
```

The test files run one at a time (`--test-concurrency=1`): they share accounts, and one of them restarts snild.

The browser tests drive Chrome through its DevTools protocol with Node's built-in WebSocket, so they need no packages. They start Chrome with `--no-sandbox`: they test pages, not process isolation.

## Dependencies

Python packages are pinned with hashes in `requirements.txt` and `requirements-dev.txt`, generated from `pyproject.toml` with `uv pip compile --generate-hashes`. The browser libraries (DuckDB-WASM and its Excel extension, Arrow, d3, linkedom) are pinned by version and SHA-256 in `vendor.json`; `scripts/fetch_vendor.py` fetches them into `web/vendor/` and checks their digests (the image does this itself, and the client tests use linkedom from there for a DOM in Node). The demo files in `web/demo/` are made by `scripts/make_demo.py` (standard library only) and committed.
