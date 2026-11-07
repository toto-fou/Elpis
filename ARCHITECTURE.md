# Architecture

Elpis code map: the processes, the packages, where everything lives and the
invariants that hold it together. This document stays short and follows the code;
the detail (API, schemas, sequences, subsystems) is in
[docs/architecture.md](docs/architecture.md); where they differ, this file and
the code are authoritative. The history of the core rules (agent loop, chat
flow) is in the git history.

## Overview

Elpis is a self-hosted **multi-process** application: the TypeScript core
(Node, Fastify) serves the interface and orchestrates the LLM, a tool host
runs the MCP tools, each user has their own Docker container, and satellite
services (RAG, browser, screen control, voice) are optional
and linked by HTTP.

| Process | Port | Entry | Role |
|---|---|---|---|
| **main** | 8001 | `apps/core/dist/main.mjs` (Node, `APP_MODE=main`) | chat, editor, sandbox, routines, static files; one process |
| **admin** | 8002 | `apps/core/dist/main.mjs` (Node, `APP_MODE=admin`) | admin console and `/api/admin/*`; one process |
| **toolhost** | 8765 | `apps/toolhost/dist/main.mjs` (Node) | MCP tool host (streamable HTTP `/mcp[/<family>]`, SSE), sandbox and terminal API; its own database `user_db/toolhost.db`; serves its tool families itself, including Office (Python worker `office/`) |
| **rag_app** | 8000 (loopback) | `rag_app/start.sh` | RAG extractor (FastAPI, stateless): text, pages, localization, OCR; the RAG itself (collections, permissions, indexing, search) is in the core, with Qdrant :6333 |
| **browser-service** | 3000 | `browser-service/server.js` | driven browser (Node + Playwright) — optional |
| **desktop-agent** | 8765 (on the controlled machine) | `desktop-agent/` | Windows (pywinauto) / Linux (AT-SPI) screen control — optional |
| **llama-server** | 8080 | llama.cpp, outside the repository | local inference; or any OpenAI-compatible engine, or a remote provider |
| **Caddy** | 443 / 8443 | `deploy/caddy/` | HTTPS front end — optional |

`./elpis start` launches qdrant, rag, toolhost, main, admin
and browser;
`sudo ./elpis service install` turns them into systemd services (`elpis.target`).

## The path of a message

A chat turn, from the request to the last event:

1. **Entry.** The interface sends `POST /api/chat-saved-stream3`
   (`apps/core/src/familles/chat.ts`). Admission (`apps/core/src/tour/ouverture.ts`,
   `admission.ts`) authenticates, then refuses if a compaction or a
   generation is already running on this conversation (409) or if the account has too
   many runs in progress (429). Preparation (`tour/preparation.ts`) then decides
   the whole turn: target, tools, history, compaction, title.
2. **Target.** `apps/core/src/llm/cible.ts` resolves the engine: the built-in
   `llama-server` by default, or a connector (enabled, readable key, allowed
   provider). MCP server addresses are resolved on the server side,
   never taken from the client.
3. **Lock and stream.** An in-memory presence lock per conversation
   (main is a single process, `tour/etat.ts`); the route takes it, the turn
   claims it. The response is an NDJSON stream (`tour/execution.ts`) pumped by
   `tour/evenements.ts`, tokens batched every 25 ms. The order of
   events and the stream invariants are written in
   [apps/core/src/tour/README.md](apps/core/src/tour/README.md).
4. **Scheduling.** For a llama.cpp target, `apps/core/src/llm/ordonnanceur/`
   applies model exclusivity, slots and the circuit breaker.
5. **Loop.** A single path, with tools: the orchestrator
   (`apps/core/src/boucle/orchestrateur.ts`) collects the tools from the MCP
   pool and assembles the system head, then, at each iteration, an LLM turn
   (`boucle/tour-llm.ts`): compaction gate, periodic pruning,
   fitting to the context, model call (native Anthropic or OpenAI-compatible).
   Then the execution of the batch of tool calls, the same for native calls
   and calls written in text (`boucle/dispatch-outils.ts`,
   `execution-outils.ts`): mutating tools one by one, the others in
   bounded parallel, results returned in order; traits of each tool in
   `apps/core/src/outils/traits.ts`. The final answer, the synthesis on limit and
   the error exit are in `boucle/sortie.ts`.
6. **Tools.** The MCP pool (`apps/core/src/outils/mcp/clients.ts`) reaches the
   **tool host** (`apps/toolhost`, :8765, a required service: the core never
   launches it itself); the account's identity travels in `_meta`. The
   account-bound families (memory, tasks, skills, charts) are served
   in-process by main (`outils/mcp/en-processus.ts`).
7. **Execution.** Shell commands run in the user's container
   (`docker exec`, privileges lowered to UID 10001). File tools, the editor and Git
   go through that container's agent
   (`shared_infra/sandbox/agent/`, client `@elpis/fichiers`), under the same
   UID; network Git operations launched by Elpis go through the host's
   authenticating relay (`packages/fichiers/src/relais-git.ts`).
8. **End of turn.** The turn is recorded (`tour/persistance.ts` then
   `apps/core/src/chats/stockage.ts`, optimistic check on `updated_at`: a
   conflict is reported, nothing is overwritten), then the `kv_cache` and
   `final` events go out. Consumption goes into `usage_events`, tool calls
   into `tool_call_metrics`, counters into `metric_events`.
9. **Stop and resume.** `POST /api/chat/cancel`
   (`apps/core/src/familles/chat-controle.ts`) stops the turn through its
   AbortSignal. If the browser disconnects, the run continues detached
   (as soon as a tool has run, or if resume is enabled) or stops
   after recording the partial output; you rejoin it through `GET /api/chat/{id}/run/events`,
   even after a restart (`tour/journal-run.ts`).

## Code map

### `apps/core/` — the TypeScript core

- `src/main.ts` (process, signals), `composition.ts` (assembly),
  `familles/` (HTTP routes by family, mounted according to `APP_MODE`; list in
  `familles.ts`).
- **Chat**: `tour/` (admission, preparation, execution, NDJSON pump,
  persistence, a turn's history), `boucle/` (agent loop: tool
  dispatch, calls written in text, stream tags, result contract),
  `chats/` (storage, prompts, templates).
- **LLM**: `llm/` (providers, per-request target, parameters, health,
  capabilities, `ordonnanceur/`), `contexte/` (budget, pruning, assembly,
  compression).
- **Tools**: `outils/` (catalog, categories, MCP, OpenAPI, built-in
  tools), `relais/` (to the tool host), `memoire/`, `skills/`,
  `graphiques/`, `images/`, `rag/`, `voix/`.
- **Operations**: `admin/` and `administration/` (console), `ops/`
  (backups, database switchover, maintenance, restart), `observabilite/`,
  `evenements/`, `routines/`, `executions/`, `notifications/`, `interface/`
  (pages, static files).
- `packages/`: packages shared with the tool host (`contracts` for the stream
  events, `db` for the schema and engines, `http` for the Fastify
  base, `auth`, `securite`, `config`, `mcp`, `outils-mcp`, `navigateur`,
  `bureau`, `fichiers`, `images`, `skills`, `verrous`, `bac`, `commun`).
- `apps/toolhost/`: TS tool host (native families, including Office and its
  Python worker `mcp/office/`, sandbox, terminal).

### `office/` — the Office engine

- `elpis_office/`: standalone Python package (python-docx, python-pptx, lxml,
  Pillow, pydantic, markdown-it-py; no `shared_infra` import) that carries the seven Word and PowerPoint tools (`word.py`,
  `powerpoint.py`, `_docx/`, `_pptx/`, `_chart/`, ECharts rendering `echarts_ssr.cjs`).
  It sees the world only through the `Env` (`commun.py`) that the host plugs into it:
  file reading and writing, charts, PDF conversion.
- `canal.py` and `__main__.py`: the worker (`python -m elpis_office`), launched by
  `apps/toolhost/src/mcp/office/worker.ts`; JSON frames and binary body on
  stdin (calls) and descriptor 3 (responses), stdout and stderr to the log,
  several calls in parallel, callbacks to the host.
- `requirements.txt`: its dependencies, included by `requirements.txt`.

### `shared_infra/` — the remaining Python, organized by family

What the configuration wizard (`deploy/`) imports, plus the sandbox agent
(`sandbox/agent/`, standard library only). The HTTP routes are
all in the TypeScript core.

| Family | Content |
|---|---|
| `accounts` | accounts (`users.py`) |
| `db` | multi-engine persistence of the remaining Python (`_dialect.py`, historical migrations) |
| `llm` | model connectors |
| `memory` | upgrade of the old AX memory tables (`ax/`) |
| `observability` | `swallow()` |
| `runtime` | file locks between processes (`elpis.verrou.v1.1`) |
| `sandbox` | container agent (`agent/`) |
| `security` | Fernet encryption |
| `ops` | database generation published by the switchover |

`config.py` resolves the configuration of the remaining Python (environment
variable > `config.json` > default).

### `frontend/` — the interface

- npm workspace `@elpis/web` (TypeScript, Vue 3.5, Vite): `npm run build:web`
  writes `frontend/dist/`; two entries `src/entries/main.ts` (application) and
  `admin.ts` (console), placed in `index.html` and `admin.html` by
  `<!-- @entree … -->` (manifest read by `apps/core/src/interface/pages.ts`).
- `src/platform/` (HTTP client, `ApiResult`, NDJSON reader),
  `src/features/<domain>/` (typed logic: auth, chat, editor, terminal,
  admin, reglages, routines, studio, images, voix, mascotte, skills, code),
  `src/components/<domain>/` (SFCs), `src/utils/`, `src/modeles/`; network
  contracts validated by `@elpis/contracts` (Zod). Console: registry
  `features/admin/registre.ts`, Ctrl+K index `features/admin/champs.gen.ts`
  (**generated** by `frontend/champs-admin.mts`).
- Roots `src/components/racine/{App,AppConsole}.vue` on `src/app/racine/`
  (shared state, session, module mounting, keyboard, notifications);
  `index.html` and `admin.html` are shells. The build embeds the Vue
  runtime without a template compiler; the pages carry a strict CSP
  (`security.csp`).
- `css/style.css` (tokens, components), `css/style.tailwind.css` (**generated**),
  `css/skins/` (bundled skins and their registry `skins.json`); `vendor/`:
  Phosphor and the generator's Tailwind compiler; the other libraries
  (Vue, Monaco, xterm, ECharts, Chart.js, Marked, highlight.js, Mermaid,
  DOMPurify, Zod) are npm packages at pinned versions.

### Services and deployment

- `apps/toolhost/`: tool host deployable on its own (MCP, sandbox, terminal;
  `deploy/toolhost/` for a remote machine), token
  `user_db/.local_mcp_token` + signed identity header.
- `rag_app/`: RAG extractor (no `shared_infra`), called by `apps/core/src/rag/`.
- `browser-service/`, `desktop-agent/`: see the process table.
- `deploy/`: Caddy, sandbox image (`docker/sandbox/`, `elpis/sandbox:1.7.0`),
  Qdrant, remote toolhost, voice (whisper.cpp :8090, Piper :8091),
  configuration wizard (`configure.py`, `wizard.py`, `tui.py`).
- `install.sh`, `elpis` (operations CLI), `make_release.sh` (offline
  package), `tools/generate_tailwind_css.mjs`.
- `system_prompts/` (prompts, in English), `skills/` (global skills;
  `learned/` = administrator's airlock).

### Runtime data (outside the repository)

`config.json` (root), `user_db/` (SQLite database, session secret, tokens,
database password, uploads), `user_sandboxes/` (one folder per
user, mounted on `/work`), `user_skills/`, `user_skins/` (imported
skins), `logs/`, and
`../mcp_custom_servers/` (next to the repository).

## Database

- Engines: **SQLite** (default, better-sqlite3) and **PostgreSQL** (pg),
  chosen by `database.backend` in `config.json` or `APP_DB_*`; the
  password comes from `APP_DB_PASSWORD` or `user_db/.db_password`, never from
  `config.json`.
- `packages/db/src/`: `ouvrir.ts` (opening according to the settings),
  `sqlite.ts` (serialized writes and transactions), `postgres.ts` (bounded
  pool, values and errors read back as in SQLite), `dialecte.ts` (SQL specific
  to each engine), `schema.ts` and `schema.gen.ts` (reference schema),
  `init.ts` (schema setup, migrations tracked in `schema_migrations`).
  Transfer between engines: `apps/core/src/ops/transfert.ts`. The remaining
  Python (configuration) goes through `shared_infra/db/`.
- Hot switchover: `apps/core/src/ops/bascule.ts` (maintenance mode, 503 on
  writes, incremented generation), driven by the console or
  `./elpis db`.

## Sandbox and execution

One Docker container **per user** (`elpis-sb-<user>`, `elpis.*`
labels), image `elpis/sandbox`,
the user's folder mounted on `/work`, network cut off except for an assigned
network profile, memory / CPU / process limits, only the necessary capabilities
(`CAPABILITIES`, without `NET_RAW` or `MKNOD`). The
container is the security boundary: every operation on `/work` runs
there, through its agent (below), under the container's UID, the only one to
write there (files 0644, folders 0755). The host neither reads nor writes `/work`
(exceptions: `du` for the quota, account deletion, creation of
`P/work`; see `docs/sandbox-gateway.md`). Git runs in the container, through the agent
(`packages/fichiers/src/git.ts`); its network operations go through the host's
authenticating relay (`packages/fichiers/src/relais-git.ts`): one ticket per operation,
only the operation's repository reachable, the connector's credential added
by the host, never in the sandbox.

In each container, an **agent** (`shared_infra/sandbox/agent/server.py`,
Python, standard library) executes the operations on `/work` that the host asks of it: HTTP on
`/run/elpis/agent.sock` (mounted folder `<user>/.elpis-agent`), code mounted
read-only from the application, started on demand under the container's
UID, relaunched if it does not have the application's version. The host reaches it
through `@elpis/fichiers` (`packages/fichiers/src/agent.ts`), which opens the socket
without following a link and treats every response as untrusted.

## External tools (MCP, OAuth, OpenAPI)

The sandbox tool families are served by the **tool host**
(`apps/toolhost`; Office by a Python worker), over MCP per family
(`/mcp/<family>`). External clients reach it through the app's origin:
the **relay** `apps/core/src/familles/pont-mcp.ts` (`/api/mcp-bridge[/<family>]`)
verifies the client's token — personal token (`packages/auth/src/jetons.ts`,
stored as a fingerprint) or OAuth token (`packages/auth/src/oauth.ts`,
`apps/core/src/familles/oauth.ts`: Elpis is its own authorization
server) — then presents the host with a signed delegation token
(`packages/mcp/src/delegation.ts`) that carries the account and its families: the
client's token never leaves the relay. The account-bound families
(memory, tasks, skills, charts) are served by main itself. The **OpenAPI facade** (`apps/core/src/outils/openapi.ts`)
exposes the same tools over plain HTTP. The **browser** (`browser-service/`)
goes through a local filtering relay (`proxy_guard.js`, `url_guard.js`).

## Invariants

- **Process separation.** The admin routes are **mounted**
  only in `APP_MODE=admin` (or `full`): absent from the main process, this
  is not a runtime check. The admin process runs under the same
  unprivileged account, never as root.
- **Byte-stable system head.** A single `role: system` message, in a fixed
  order (`apps/core/src/contexte/assemblage.ts`), for the engine's prefix cache;
  the set of tools does not vary from one message to the next; compaction
  summaries are never merged into the base.
- **A single counting authority**: `apps/core/src/contexte/tokens.ts`.
  No decision relies on a characters/token ratio.
- **Pruning** (`apps/core/src/contexte/elagage.ts`): never modifies the
  working messages, never separates a tool call from its result, does not
  truncate the last desktop perception, keeps the system messages and
  the most recent ones.
- **Tools**: executing a call never throws (error returned as JSON);
  the MCP pool never replays a call that may already have acted.
- **Configuration**: environment variable > `config.json` > default; a
  console-editable setting is reread live (`liveConfigValue()`,
  `configView()` of `packages/config/src/vivant.ts`, lint rule
  `elpis/reglages-vifs`), otherwise the console announces it as "Restart
  required"; never modify the dictionary returned by `configView()`.
- **State shared between processes** (main, admin, tool host):
  only the database or the internal channel. main is a single process: its running
  turns, presence locks and cancellations live in memory. A
  cancellation never goes through system events (leak of
  conversation identifiers).
- **Database**: portable SQL via `packages/db/src/dialecte.ts`; a new
  table or column is a `MIGRATIONS_TS` migration
  (`packages/db/src/init.ts`); on the Python side, every `db()` has its `close()`.
- **Scheduled tasks** (routines, maintenance, backups): in main, a
  single active scheduler across processes (`apps/core/src/routines/meneur.ts`),
  never in the admin process.
- **Sandbox**: the container is the barrier; every operation on `/work`
  goes through the container's agent (`@elpis/fichiers`), never through a host `open`,
  `readdir`, `chmod` or `rm` (exceptions, metadata only:
  `docs/sandbox-gateway.md`); no host-side `git` on a sandbox repository;
  every container goes through network profile resolution (a profile imposed
  by the administrator wins).

## Tests

The tests (Vitest for TypeScript, pytest for the remaining Python, real
journeys in Chromium) live in the maintainers' development repository,
which runs them before every merge. In this repository: `npm run typecheck`,
`npm run lint` and `npm run build` ([AGENTS.md](AGENTS.md),
[CONTRIBUTING.md](CONTRIBUTING.md)).
