# Testing

The development test kit lives on the `devs/main` branch. `main` and the
releases ship without it.

| Path | Runner |
|---|---|
| `apps/*/test/`, `packages/*/test/` | Vitest, project `core` (Node) |
| `frontend/test/` | Vitest, project `web` (happy-dom), `frontend/vitest.config.mts` |
| `browser-service/test/` | `node --test` (TypeScript run by Node's type stripping) |
| `tests/` | pytest (`pytest.ini`): deployment scripts, sandbox and desktop agents, Office worker, RAG app, legacy frontend JS units |
| `tests/goldens/`, `migration-kit/` | stream goldens, route inventory and frozen-vector notes read by the tests |
| `tests/perf/`, `tests/load/`, `tests/frontend/*-verify.mjs` | benchmarks and Playwright harnesses, run by hand |
| `tests/frontend/clips/` | scenarios that record the clips of the user guide, run by hand ([Help clips](#help-clips)) |

`npm run typecheck` and `npm run lint` cover the test files too.
`tests/frontend/app-fluidity-verify.mjs` measures every gesture of both pages against the real core (latency to the painted answer, long tasks, slow frames, layout shifts, profile of the slowest); its header lists the options.
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
npm ci --prefix browser-service   # once: Express, Playwright
npm run build:browser             # the integration tests start dist/main.mjs
cd browser-service
node --test 'test/**/*.test.ts'
```

The tests are TypeScript run directly by Node 24 (type stripping, no build
step): they stay on `node:test`, the runner they were written for, rather
than Vitest. The unit tests import `src/*.ts`; the sources therefore import
each other with the `.ts` extension (`allowImportingTsExtensions` in
`browser-service/tsconfig.json`). `npm run typecheck` and `npm run lint`
cover them.

The `*.integration.test.ts` files start the built service
(`browser-service/dist/main.mjs`, rebuild it after a change) on a Unix
socket in a temporary folder, with a token, as the tool host does in a sandbox, and
drive the Chromium headless shell (`npx playwright install
chromium-headless-shell`, or `PLAYWRIGHT_BROWSERS_PATH`). Three cases that reach public test sites run only
with `BROWSER_SERVICE_LIVE=1`. The end-to-end run of the browser in a real
sandbox (`apps/toolhost/test/browser-bac-e2e.test.ts`: container, service, secret
relay, core) runs only with `ELPIS_TEST_SANDBOX_BROWSER=1` (Docker, image
`elpis/sandbox:1.8.0`, headless shell).

## Help clips

The clips of the user guide (`docs/media/aide/*.webm`, one per feature, shown by
the help window) are recorded, not edited by hand. Each one is a scenario of
`tests/frontend/clips/scenes/*.mjs` played by Playwright against a throwaway
instance of the real core with the scripted model (`tests/frontend/lib/core-reel.mjs`),
captured frame by frame and encoded by `ffmpeg` (VP9, 960×600, 12 fps, no audio).

```bash
ELPIS_NODE_MODULES=$PWD/browser-service/node_modules \
  node tests/frontend/clips/tourner.mjs [scene-or-clip-filter] [--dossier=/tmp/trial]
node tests/frontend/clips/planche.mjs clip.webm sheet.png 5   # contact sheet of a clip
```

The runner fails when a clip exceeds its budget: 5 s for one gesture (up to 12 s
for a scenario that declares a chain of actions through `max`), 120 KB per clip,
3 MB for the folder. It needs the core and the frontend built, the Chromium
headless shell and `ffmpeg`/`ffprobe` with `libvpx-vp9`. Re-record after a change
of the interface a clip shows; a clip is referenced from the guide by a paragraph
holding only its link, and `frontend/test/reglages/aide-rendu.test.ts` checks
that guide and folder agree.

## Python

```bash
venv/bin/pip install -r requirements-dev.txt -r office/requirements.txt
venv/bin/pytest            # parallel (-n auto, pytest-xdist)
venv/bin/pytest -n0 tests/deploy
```

`tests/conftest.py` points the configuration, data and LLM engine of a run
to temporary values. Use the venv's `pytest`: `-n auto` needs
`pytest-xdist`.
