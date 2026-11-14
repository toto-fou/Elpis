# AGENTS.md

Instructions for coding agents (and humans) who modify Elpis:
commands, conventions, known pitfalls. For the code map, read
[ARCHITECTURE.md](ARCHITECTURE.md); for the interface,
[PRODUCT.md](PRODUCT.md) and [DESIGN.md](DESIGN.md).

## The project at a glance

**Self-hosted** LLM assistant: agentic chat (MCP tools, subagents,
memory, skills), code editor on a per-user Docker sandbox,
routines, built-in RAG (document collections), admin console. Core (main, admin) and tool
host in TypeScript (Node 24, Fastify); interface in TypeScript and Vue 3
(SFCs compiled by Vite). Still in Python: the RAG extractor (`rag_app/`),
the Office engine (`office/`, a tool host worker), `desktop-agent/`, the sandbox agent (`sandbox-agent/`) and
the installation (`deploy/configure.py`, `deploy/wizard.py`). Inference
`llama-server` (llama.cpp) or any OpenAI-compatible engine. Interface in
French, documentation in English. MIT license.

`docs/architecture.md` is detailed; when in doubt, the code is authoritative, then
ARCHITECTURE.md.

## Install and run

```bash
./install.sh                                  # Debian 12/13, Ubuntu 24.04: Node 24 in node/, venv in venv/
./elpis start | stop | restart | status       # all services
./elpis logs [qdrant|rag|toolhost|main|admin|browser] [-f]
./elpis doctor                                # diagnostics
./elpis db info | check TARGET | transfer --to TARGET | use sqlite|TARGET
```

Manual launch (from the root: the server reads `frontend/` relative
to the current directory):

```bash
npm ci && npm run build                                                    # core, tool host and frontend bundles (frontend/dist)
ELPIS_RACINE=$PWD node/bin/node apps/toolhost/dist/main.mjs              # MCP tool host :8765 (Office: Python worker)
ELPIS_RACINE=$PWD APP_MODE=main LOCAL_MCP_URL=http://127.0.0.1:8765/mcp \
  node/bin/node apps/core/dist/main.mjs                                  # chat :8001
ELPIS_RACINE=$PWD APP_MODE=admin LOCAL_MCP_URL=http://127.0.0.1:8765/mcp \
  node/bin/node apps/core/dist/main.mjs                                  # console :8002
```

Default ports: main 8001, admin 8002, MCP tools (`toolhost`) 8765,
RAG 8000, Qdrant 6333 (the browser has no port: it runs in each sandbox),
`llama-server` 8080. The instance configuration is `config.json` at the root
(not versioned; template: `config.example.json`). The `?v=` versions of
resources are rewritten to the process's `BUILD_ID`: restart the core to
invalidate caches.

## Verify a contribution

```bash
npm ci                 # Node ≥ 24 (.nvmrc); exact dependencies, a single package-lock.json
npm run typecheck      # tsc (core, tool host, packages) and vue-tsc (interface)
npm run lint           # ESLint
npm run build          # core, tool host and frontend bundles
npm run format         # applies Prettier (npm run format:check to verify)
```

The tests live in the maintainers' development repository, not in this
repository: they run the full suite (TypeScript, Python, real journeys in
Chromium) before merging a pull request. Describe in the pull request
what you tried by hand (screen, command, edge case).

Remaining Python (RAG, Office engine, `deploy/`): `venv/bin/ruff check .`
(rules in `pyproject.toml`, ruff is installed by `requirements.txt`).

## TypeScript

npm workspace at the root: applications in `apps/` (`apps/core`:
main and admin; `apps/toolhost`: tool host), shared packages in
`packages/` (`@elpis/auth`, `bac`, `commun`, `config`, `contracts`, `db`,
`fichiers`, `http`, `mcp`, `outils-mcp`, `securite`…), interface in
`frontend/` (workspace `@elpis/web`).

<!-- REUSE-IgnoreStart -->
- **Code**: header `// SPDX-License-Identifier: MIT` then `/** path — role */`;
  comments kept to a minimum: at most one line per function, in French,
  with no audit trail (the long why goes in the commit message or `docs/`);
  ESM, strict TypeScript, erasable syntax only (no `enum` or `namespace`),
  `import type` for types; no floating promises (lint).
<!-- REUSE-IgnoreEnd -->
- **Shared contracts**: `@elpis/contracts` (Zod schemas of the routes and the stream;
  `npm run generer -w @elpis/contracts` writes `.d.ts` and JSON schemas to `dist/`).
- **JSON**: `@elpis/commun` writes like Python's `json.dumps` (`pyJsonDumps`)
  where the on-disk or on-the-wire form is shared with the remaining
  Python; `JSON.stringify` neither writes nor sorts like Python.
- **Dependencies**: exact versions (`.npmrc`); permissive licenses (MIT,
  Apache-2.0, ISC, BSD) for everything shipped, MPL-2.0 or BlueOak allowed
  for non-distributed development tools only; the build rejects a
  shipped package outside the policy of `THIRD_PARTY_LICENSES/policy.json`. npm 11
  blocks unapproved install scripts: `npm install-scripts approve
  <package>` after review (`allowScripts` field). A runtime dependency
  is listed in `THIRD_PARTY_NOTICES.md` (`npm run licences` rewrites
  `THIRD_PARTY_LICENSES/npm-*.txt`).

## Generated files

- `frontend/css/style.tailwind.css`: after adding utility classes
  in an SFC, a TS module or a template (`.vue`, `.ts`, `.html`,
  `.js`), run `node tools/generate_tailwind_css.mjs` (Playwright required, resolved in
  `browser-service/node_modules` or `ELPIS_NODE_MODULES`). Never edit it by
  hand.
- `frontend/src/features/admin/champs.gen.ts` is generated from the console
  pages (`frontend/src/components/admin/Page*.vue`): after adding or
  renaming a setting (`data-field`), run `node frontend/champs-admin.mts`.
- `frontend/dist/`, `apps/core/dist/`, `apps/toolhost/dist/`: produced by
  `npm run build`, never versioned.

## Conventions

**Language and interface**

- Interface in **French**, formal "vous", labels of one or two words; the
  detail goes in `title`, the placeholder text or the documentation.
- **No emoji** in the interface (✓ ✗ ⚠ tolerated); Phosphor icons.
- System prompts (`system_prompts/*.md`) are in **English**, with no emoji,
  within their character budgets.

**Python code** (remaining: RAG, Office engine, desktop-agent, sandbox agent, deploy)

<!-- REUSE-IgnoreStart -->
- New source file: first line `# SPDX-License-Identifier: MIT`,
  then a one-line header docstring "path — role".
<!-- REUSE-IgnoreEnd -->
- Comments in French, in the present tense, at most one line per function: the
  rule, its reason. No audit trail in the code (date of finding, batch
  identifier, story of the old behavior): history goes in the commit
  message.
- `from __future__ import annotations`; logging via
  `logging.getLogger("uvicorn.error")`, messages prefixed `[domain]`.
- Errors: never a silent `except Exception: pass`; never swallow `BaseException`
  or `asyncio.CancelledError`; a deliberate broad `except` carries `# noqa: BLE001`.
- Setting of a Python service: read from its environment (set by `./elpis`),
  documented in `docs/configuration.md`.

**Database**

- **Portable** SQL for SQLite / PostgreSQL: go through
  `packages/db/src/dialecte.ts` for anything that differs.
- Schema: `packages/db/src/schema.ts` (tables in `schema.gen.ts`); a new
  table or column = a migration added to `MIGRATIONS_TS`
  (`packages/db/src/init.ts`); no DDL outside `packages/db` (only
  exception: the database transfer, `apps/core/src/ops/transfert.ts`).

**Organization**

- TS core: HTTP routes by family (`apps/core/src/familles/`, list in
  `apps/core/src/familles.ts`), mounted according to `APP_MODE`; a topic's logic
  lives in its folder in `apps/core/src/` or in a `packages/` package
  shared with the tool host.
- Admin routes: `admin-*` families in `apps/core/src/familles/`
  (admin process only); role checked by `exigerRole`
  (`packages/auth/src/garde.ts`). `is_admin` is 0, 1 (admin) or 2
  (moderator): always compare the value (`Number(is_admin) === 1`), never
  a plain truthiness test.
- Admin console: one page = one entry in the registry
  `frontend/src/features/admin/registre.ts` (title, `#page` link, loaders,
  registered blocks) and one SFC `frontend/src/components/admin/Page*.vue`; a
  `config.json` field carries `data-field="config:path"` and is sent by
  `PATCH /api/admin/config` with its page's save bar.

**Frontend**

- Vite build: `frontend/` is the `@elpis/web` workspace; `npm run build:web`
  writes `frontend/dist/` (rerun it after any change to
  `frontend/src`). Entries `src/entries/main.ts` (chat, editor, routines…) and
  `admin.ts` (console), preceded by `diagnostic.ts` (error window if nothing
  is mounted), placed by `<!-- @entree … -->`, which
  `apps/core/src/interface/pages.ts` replaces with the manifest's tags
  (hashed names, long cache).
- Layout of `frontend/src/`: `platform/` (HTTP client and `ApiResult`,
  NDJSON reader), `features/<domain>/` (logic and state in strict TS: auth,
  chat, editor, terminal, admin, reglages, routines, studio, images, voix,
  mascotte, skills, code), `components/<domain>/` (SFCs
  `<script setup lang="ts">`, checked by `vue-tsc`), `utils/` and `modeles/`
  (pure functions), `app/racine/` (root: shared state, session, module
  mounting, keyboard).
- Network: JSON received as `unknown` and validated at the boundaries by the Zod schemas
  of `@elpis/contracts`; `{"detail"}` errors and 422s decoded by `ApiResult`;
  chat stream typed by `EvenementFlux`, exhaustive reducer (an unknown event
  is logged, never applied). A cast is not a validation. A newly consumed
  route = its schema in `packages/contracts`.
- State: one domain per feature, passed by typed injection (`provide` /
  `inject` key, e.g. `features/chat/page/domaines.ts`,
  `features/editor/domaine.ts`), missing keys named at mount; no `$root`,
  no global store. Monaco, xterm and third-party objects in `shallowRef`/`markRaw`.
- Roots: `src/components/racine/App.vue` (chat) and `AppConsole.vue`
  (console), on `creerRacine()` (`src/app/racine/racine.ts`); they
  provide the injected domains. `index.html` and `admin.html` are just
  shells (`<div id="app">`): no template in the DOM, no classic
  script. The build embeds the Vue runtime without a template compiler
  (alias `vue.runtime.esm-bundler.js` in `vite.config.mts`) and the pages carry
  a strict CSP (`security.csp`): every template is a precompiled SFC.
- Vendor: npm packages at pinned versions, no CDN (offline production).
  Monaco (ESM and workers) and xterm are chunks loaded when the editor
  or terminal opens; Mermaid, ECharts, Chart.js and highlight.js are
  their distribution files, copied by Vite and loaded on demand
  (`frontend/vendor.config.mts`, `src/platform/vendor.ts`).
- Rendered HTML (Markdown, SVG, previews): always sanitized by DOMPurify; no
  `v-html` on unsanitized content.
- Never a Tailwind class name composed at runtime (the generator would not
  see it); never a color class on `<body>`; colors through
  tokens (DESIGN.md).
- Every named Vue transition is declared in CSS **and** in the
  `prefers-reduced-motion` block.

**Dependencies and licenses**

- No strong copyleft dependency (GPL, AGPL) in the core: optional
  only (`requirements-agpl-optional.txt`).
- Every package added to a `requirements*.txt` or shipped by npm is listed in
  `THIRD_PARTY_NOTICES.md`.

## Invariants not to break

The detail and the why are in [ARCHITECTURE.md](ARCHITECTURE.md). In
short, a change must never:

- mount a console route (`/api/admin/*`) in the main process: the
  separation is done at mount time, by `APP_MODE`;
- vary the system head between two iterations (a single `role: system`,
  fixed order, same set of tools): the engine's prefix cache depends on it;
- count tokens anywhere but in `apps/core/src/contexte/tokens.ts`
  (`/tokenize` or `/apply-template` request, `new URL("tokenize", base)`
  included), nor redefine the chars/token ratio (`@elpis/config`);
- separate a tool call from its result, nor modify the working messages
  during pruning;
- make a tool's execution throw (error returned as JSON), nor replay an MCP
  call that may have acted;
- keep in a module variable a state that must be shared between
  processes (main, admin, tool host): go through the database or
  the internal channel;
- route a cancellation through system events: a Stop goes through
  the turn's AbortSignal;
- read a console-editable setting into a constant frozen at
  import (`config` key reloaded by `packages/config/src/vivant.ts`,
  `liveConfigValue()`, `maxRecentChats()`…): lint rule
  `elpis/reglages-vifs`;
- reorganize the chat flow (`apps/core/src/familles/chat.ts` and
  `apps/core/src/tour/`) without rereading `apps/core/src/tour/README.md`: its
  invariants (lock, cancellation, recording) and the order of NDJSON
  events;
- touch the content of `/work` from the host: everything goes through the
  sandbox agent (`@elpis/bac`, `@elpis/fichiers`); a host `open`, `readdir`, `rm` or
  `chmod` on a path would follow links that the container can
  place at any time. The only exceptions (creation of `P/work`,
  usage, last activity, account deletion) go through the
  descriptor-based primitives of `@elpis/securite` (`confinement.ts`). See
  also [docs/sandbox-gateway.md](docs/sandbox-gateway.md).

## Git and pull requests

- One pull request = one topic; describe the before and after.
- Commit messages in French, subject `Domaine : résumé` (space before the
  colon: `Base :`, `Chat :`, `Sandbox :`, `Docs :`…), body in bullets.
- Never version: `venv/`, `node/`, `node_modules/`, `config.json*`,
  `.env`, `mcp.json`, `user_*/` (database, RAG store, session
  secrets, tokens, database password), `logs/`, `dist/`, archives.
- Offline release: `./make_release.sh [VERSION]` produces
  `dist/elpis-offline-<version>-<arch>/` (and its `.tar`), installed by
  `./install.sh --offline FOLDER`; the version comes from `pyproject.toml`.
