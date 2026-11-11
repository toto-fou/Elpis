# Testing

The development test kit lives on the `devs/main` branch. `main` and the
releases ship without it.

| Path | Runner |
|---|---|
| `apps/*/test/`, `packages/*/test/` | Vitest, project `core` (Node) |
| `frontend/test/` | Vitest, project `web` (happy-dom), `frontend/vitest.config.mts` |
| `browser-service/test/` | `node --test` |
| `tests/` | pytest (`pytest.ini`): deployment scripts, sandbox and desktop agents, Office worker, RAG app, legacy frontend JS units |
| `tests/goldens/`, `migration-kit/` | stream goldens, route inventory and frozen-vector notes read by the tests |
| `tests/perf/`, `tests/load/`, `tests/frontend/*-verify.mjs` | benchmarks and Playwright harnesses, run by hand |

`npm run typecheck` and `npm run lint` cover the test files too.
`tests/README.md` (French) has the conventions of the kit.

## Environment

Run every suite with a throwaway security journal and vault key, never the
machine's own:

```bash
export ELPIS_AUDIT_DIR=$(mktemp -d) ELPIS_AUDIT_KEY_PATH=/nonexistent
export ELPIS_VAULT_KEY_PATH=$(mktemp)
head -c 32 /dev/urandom | base64 > "$ELPIS_VAULT_KEY_PATH"
```

- `ELPIS_PYTHON`: the repository venv (`venv/bin/python`, used when present)
  with `requirements-dev.txt` and `office/requirements.txt`. Tests run the
  real sandbox agent with it, and the ruff and python-docx cases need it.
- `ELPIS_OFFICE_PYTHON`: interpreter of the real Office worker test
  (defaults to `ELPIS_PYTHON`); skipped without its packages.
- PostgreSQL tests run only with `ELPIS_TEST_PG`:

  ```bash
  docker run -d --name elpis-test-pg -e POSTGRES_USER=elpis -e POSTGRES_PASSWORD=elpis \
    -e POSTGRES_DB=elpis -p 55491:5432 postgres:17-alpine
  export ELPIS_TEST_PG=postgres://elpis:elpis@127.0.0.1:55491/elpis
  ```

  The Python installer tests that use it also need the core bundle
  (`npm run build -w @elpis/core`).

- Tests that need the sandbox Docker image, a real LLM or Chromium skip
  themselves when it is missing.

## Vitest

```bash
npx vitest run                                    # both projects
npx vitest run --project core apps/core/test      # core
npx vitest run --project core apps/toolhost/test  # tool host
npx vitest run --project core packages            # shared packages
npx vitest run --project web                      # frontend
```

`vitest.config.mts` declares the projects; `vitest.mise-en-place.mts` points
the MCP directory, temporary files and journal of a run to a temporary
folder; `vitest.garde-travail.mts` fails any test where host code touches a
sandbox `/work`.

## Browser service

```bash
cd browser-service
node --test 'test/**/*.test.js'
```

The `*.integration.test.js` files drive the Chromium headless shell
(`npx playwright install chromium-headless-shell`, or
`PLAYWRIGHT_BROWSERS_PATH`). Three cases that reach public test sites run only
with `BROWSER_SERVICE_LIVE=1`.

## Python

```bash
venv/bin/pip install -r requirements-dev.txt -r office/requirements.txt
venv/bin/pytest            # parallel (-n auto, pytest-xdist)
venv/bin/pytest -n0 tests/deploy
```

`tests/conftest.py` points the configuration, data and LLM engine of a run
to temporary values. Use the venv's `pytest`: `-n auto` needs
`pytest-xdist`.
