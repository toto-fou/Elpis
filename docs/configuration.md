# Elpis — Installation and configuration

> Internal architecture: [architecture.md](architecture.md).
> User guide: [user-guide.md](user-guide.md).

## Contents

- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Startup](#startup)
- [Configuration](#configuration)
  - [`config.json` file](#configjson-file)
  - [RAG](#rag-rag)
  - [Cloud providers for accounts](#cloud-providers-for-accounts-llmallowed_provider_types)
  - [Environment variables](#environment-variables)
  - [`context_config.json` — text injected into the LLM](#context_configjson--text-injected-into-the-llm)
  - [Resolution priority and hot reload](#resolution-priority-and-hot-reload)
- [Multi-process: main / admin split](#multi-process-main--admin-split)
- [Core processes](#core-processes)
- [HTTPS: Caddy front end](#https-caddy-front-end)
- [Tracing and multi-user debugging](#tracing-and-multi-user-debugging)

---

## Prerequisites

- **System**: Debian 12/13 or Ubuntu 24.04 (amd64).
- **Docker**: the per-user sandbox (shell tools, terminal, editor)
  runs in a container.
- **An inference engine**: `llama-server` (llama.cpp) or any
  OpenAI-compatible server (vLLM, TGI, Ollama, LM Studio), or a remote provider
  (OpenAI-compatible connectors, Anthropic).
- **System packages**: those listed in
  [deploy/prerequis-apt.txt](../deploy/prerequis-apt.txt) (a base set, plus one
  group per component), which `install.sh` installs with apt (sudo);
  `--no-apt` only checks them. apt commands:
  [operations.md](operations.md#system-prerequisites-apt-packages).
- `install.sh` installs the rest: the Python venv and its dependencies, Node.js
  24 without npm in `node/` (core and browser service) and the core bundle
  (`apps/core/dist`), Qdrant (RAG), Chromium, and the sandbox image.

### Inference engine

Built for `llama-server` in **router mode** (several models, several
slots), **vLLM** and **SGLang**: the type declared in `llama.engine` is
authoritative, and Elpis uses all of that engine's addresses and capabilities (see
[Declared inference engine](#declared-inference-engine-llamaengine)). Other
OpenAI-compatible engines (TGI, Ollama, LM Studio) work as `generic` —
see [Inference targets](architecture.md#inference-targets-and-providers).

> **Recommended minimum version**: a version that includes the GLM XML
> tool-call parser (look for `arg_key` / `arg_value` in `common/chat-auto-parser.h`).

> **Router and model loading.** Elpis loads a model only when a message is
> sent (or with the Load button). Its information reads
> (`/props`, `/slots`, `/metrics`) pass `autoload=false` and name only the
> loaded model. The KV gauge and the metrics require models started with
> `--metrics` (otherwise the server answers 501, and Elpis stops asking
> for 5 minutes).

> **`--jinja` is required for native tool calling.** Without this flag, the model
> cannot emit structured `tool_calls` and writes its calls as free-form
> text. Symptom: markup (`<tool_call>`, `<function=write_file>`) appears
> in the response bubble. The backend strips this markup at display time
> (`_strip_tool_call_markup`), so it no longer leaks visually, but tool calling
> **stays degraded**. Diagnosis: the log line `markup d'appel d'outil
> nettoyé du flux final` (tool-call markup stripped from the final stream) in the backend logs.

```bash
git clone https://github.com/ggml-org/llama.cpp && cd llama.cpp
cmake -B build                     # CPU
cmake -B build -DGGML_CUDA=ON      # CUDA
cmake --build build --config Release -j$(nproc)
```

### Office previews in the editor (optional)

docx and pptx files appear in the editor after conversion by LibreOffice
**on the host**, in a `bubblewrap` jail with no network and no host files.
PDFs need nothing, and xlsx files are streamed directly
(`apps/toolhost/src/office/xlsx.ts`): LibreOffice is used only for the
spreadsheet "Pages" view. A heavy document shows its first pages right
away, then the full document once the conversion finishes.

Install with `./install.sh --with-office`.

- Ubuntu 24.04 restricts unprivileged user namespaces
  (`kernel.apparmor_restrict_unprivileged_userns`): if `bwrap` is blocked,
  the installer adds the AppArmor profile `/etc/apparmor.d/elpis-bwrap`;
  otherwise the preview answers "Isolation unavailable".
- Settings: `config.json › office_preview` (`isolation` `auto`|`none`,
  `timeout_s`, `slots`, `max_mb`, `max_pages`, `xlsx_max_rows`, `cache_mb`…);
  admin switch "Office preview" (`features.office_preview`). Cache:
  `user_sandboxes/.office-cache` (pruned by maintenance).

### Git in a sandbox

The Git commands of the agent tools and of the editor's Git panel
run in the user's container, through the user's agent and under the user's UID:
whatever a repository makes run stays in the sandbox (hooks stay
disabled for these commands). The network operations Elpis starts
(`clone`, `fetch`, `pull`, `push`, `ls-remote`; `https` and `http`
only) go through the host relay, even with an isolated network profile:
one ticket per operation, only the operation's repository reachable,
the Git connector credential added by the host (never inside the sandbox),
the anti-SSRF guard redone on every request and, on an editor push, only the
refs that `git push` would update according to the repository configuration,
with no deletion, no unrequested forced update and no rewriting of an existing
tag (the assistant pushes only its own branch). A relay refusal is returned as a
409, with its reason; an upstream rejection (behind) as a 400. Credentials
entered: sent after an upstream 401 on discovery (`info/refs`); an
upstream that asks for them only on `POST` is not supported.

The relay listens on `user_sandboxes/.elpis-relay/<pid>.sock` (one socket per
app process), a folder mounted read-only in the containers: a connection
without a valid ticket is closed without relaying anything. During an
operation, any process in the sandbox can use the agent's local listener,
but only toward the ticket's repository, service and refs.

TLS certificates: the system store (`/etc/ssl`, `SSL_CERT_FILE`,
`SSL_CERT_DIR`), plus `GIT_SSL_CAINFO` / `GIT_SSL_CAPATH` if they are set
for the service. **No proxy**: the relay reaches the upstream directly
(`*_PROXY` variables are ignored). An upstream redirect is refused, with
the address to which to correct the remote URL. An `http://` remote goes
in clear text, connector credential included: prefer `https://`.

Upgrading from a version where Git ran on the host: the service account's
Git configuration (`http.sslCAInfo` of `/etc/gitconfig`, `http.proxy`,
`http.extraHeader`) no longer applies to Git network access. Declare an internal CA
in the system store or with `GIT_SSL_CAINFO` in the service
environment.

Ubuntu ≥ 23.10 reserves user namespaces for programs that have an AppArmor
profile. If `bwrap` is blocked, the installer (unless `--skip-system`) adds
`/etc/apparmor.d/elpis-bwrap`. Trade-off: this profile applies to every account
on the machine that runs `bwrap`, and so reopens for that account the kernel surface that
the restriction reduces. Removing it (`apparmor_parser -R`, then deleting the
file) disables the Office previews jail.

---

## Installation

```bash
git clone https://github.com/toto-fou/Elpis.git elpis && cd elpis    # 1
./install.sh                                   # 2: questions, installation, configuration, startup
```

`install.sh` is **guided**: it detects the system (Debian 12/13, Ubuntu
24.04), checks permissions BEFORE asking anything, opens the wizard page by page
(`deploy/wizard.py`, Python standard library only: it runs before the
venv), installs, configures with the wizard's answers, then starts
(systemd services or `./elpis start`). It is idempotent: running it again
redoes only what is missing, and the wizard then picks up the configuration in
place. Everything is logged in `logs/install.log`, except the wizard screens
and passwords (written to the terminal only).
`./install.sh --dry-run` prints the plan and does nothing.

**Permissions.** From a normal account: `sudo -v` at launch (a single
prompt), with the ticket kept alive for the whole installation. Without sudo: stop,
or continue without anything that needs root (Caddy, local database,
services). With `sudo ./install.sh`: the system
steps run as root, the application (venv, Chromium, configuration,
startup) runs under the account that ran sudo (`SUDO_USER`, or `ELPIS_USER`, or
the repository owner) — never as root.

**Wizard.** ↑↓ move, Space check or choose, Enter confirm and
advance, 1-9 direct choice, Tab / Shift+Tab change page, Esc quit without
changing anything. An answer disables the inputs it makes useless (with
the reason shown); a value that has become impossible falls back to the first
possible value (Caddy unchecked: HTTPS goes back to "Direct HTTP"). LLM and embeddings
addresses are probed (`GET /v1/models`) and you pick the model from the announced list.
Answers are stored in `user_db/run/install-answers.json`
(0600, secrets included), deleted at the end. `--plain` keeps the questions as
plain lines; without a terminal (or with `TERM=dumb`), they are plain lines too.

**Database.** Prepared (local server) and tested right after the venv,
before the long steps. On failure, `--yes` stops (nothing is configured against
an unreachable database); in interactive mode, you choose between retrying, changing the
settings (back to the Database page), switching to SQLite, or aborting.

| Question (option that answers it) | Default | Effect |
|---|---|---|
| Browser service (`--with-browser`, `--no-browser`) | yes | `npm ci` + Chromium (Playwright) |
| Sandbox image (`--sandbox build\|pull\|none`, `--pull IMAGE`) | build | `docker build` of `deploy/docker/sandbox/`, or `docker pull` + tag |
| Database (`--db sqlite\|postgres-local\|external`) | sqlite (first time; unchanged afterwards) | see [Database](#database) |
| LibreOffice (`--with-office`, `--no-office`) | yes if already installed | docx/xlsx/pptx previews (LibreOffice nogui + bubblewrap, installed with apt) |
| Caddy (`--with-caddy`, `--no-caddy`) | no | HTTPS front end (`caddy` package installed with apt, then configured by install.sh; see [HTTPS](#https-caddy-front-end)) |
| AGPL extras (`--with-agpl`, `--no-agpl`) | no | PyMuPDF and pdf2docx |
| Configuration (`--configure`, `--no-configure`) | yes (first time) | `./elpis configure` |
| Startup (`--service`, `--start`, `--no-start`) | service | `sudo ./elpis service install` or `./elpis start` |

`--yes` suppresses all questions (defaults + options); pass the options of
`./elpis configure` after `--` (in wizard mode, they pre-fill the pages):

```bash
ELPIS_CFG_ADMIN_PASSWORD='…' ./install.sh --yes --with-caddy --service -- \
    --llm-url http://gpu.example.lan:8080 --https local --embed-url http://gpu.example.lan:8081
```

Python dependencies: `requirements.txt` (core), `requirements-rag.txt`
(RAG extractor), `requirements-agpl-optional.txt` (optional, AGPL, no longer
used),
`requirements-dev.txt` (tests). Offline: `./install.sh --offline <dir>`
with the package produced by `make_release.sh` (see
[operations.md](operations.md#installing-an-offline-server)).

### `./elpis configure`

With no option, in a terminal: the same page-by-page wizard (without the
Components page), pre-filled with the configuration in place, then applied
without questions. With options (`--yes`, `--llm-url`…) or without a terminal:
`deploy/configure.py` directly, with line-by-line questions. Running `configure` again
regenerates no secret (`--force` starts over from `config.example.json`).
`--answers FILE` applies the wizard's answers; `--check-db` only tests
the connection to the selected database.

| Step | Questions | Written to |
|---|---|---|
| 1. LLM | type (llama.cpp, vLLM, SGLang, other OpenAI-compatible); address, whose port follows the type until an address is entered (8080, 8000, 30000); optional API key (the server's `--api-key`, masked input); probe `GET /v1/models` with the key as Bearer (401: "key rejected"), never `/props?model=`, which would load a model; model chosen from the announced list; recommended launch flags for vLLM and SGLang | `config.json › llama`: `engine`, `url` (server base), `api_key`, `model`; only changed values are rewritten |
| 2. Cloud | provider (Anthropic, OpenAI, Mistral, Groq, OpenRouter, DeepSeek, Moonshot), masked API key, model | **shared** connector in the database, key encrypted (Fernet) |
| 3. Access | HTTPS: no / local certificate (`install_caddy.sh`) / public domain with Let's Encrypt (`Caddyfile.acme.template`); without HTTPS, listening (`--listen local\|lan`: this server only or local network, see [Listening](#listening-securitylisten)); access host name; ports already in use are flagged | `security.https`, `security.listen`, `.env` (`MAIN_PUBLIC_URL`, `ADMIN_PUBLIC_URL`) |
| 4. RAG | activation, embeddings server (probed) and model, reranker, vision OCR | `config.json › rag` (`embed`, `reranker`, `ocr`), see [RAG](#rag-rag) |
| 5. Sandbox | Docker image (presence checked), memory per sandbox | `executors` |
| 6. Voice | activation, whisper-server and elpis-tts URLs (local if installed, token reused) | `voice` |
| 7. Database | engine (SQLite, PostgreSQL), host, port, database, user, password (masked), TLS; connection tested; copy of the data from an existing SQLite database to an empty one | `config.json › database`, `user_db/.db_password` (0600) |
| 8. Admin | name and password (masked, confirmed, 8 characters min.; empty = generated, to change at first sign-in); if accounts exist: password change offered | database `user_db/app.db` |

Generated secrets (0600 files): `app.session_secret`,
`user_db/.local_mcp_token` (tool host, referenced by `mcp.json`),
`user_db/.rag_service_token`, `user_db/.browser_service_token` (browser service). Each answer can be given as an option
(`./elpis configure --help`) or an `ELPIS_CFG_*` variable (`ELPIS_CFG_ENGINE`,
`ELPIS_CFG_LLM_URL`, `ELPIS_CFG_LLM_API_KEY`, `ELPIS_CFG_CLOUD_API_KEY`,
`ELPIS_CFG_ADMIN_PASSWORD`…); `--yes` asks no questions. Secrets
go through these variables (the wizard passes them this way): an option such as
`--llm-api-key` is visible in the process list. No key appears
in the summary, in the logs (`logs/install.log` masks them) or in `export-sh`.

An existing configuration stays valid as is: without `engine`
(llama.cpp), with `ip` and `port` only, or with a full
`…/v1/chat/completions` URL. `configure` rewrites only what changes; a
new address is written to the server's base (`url`).

### Database

SQLite (file `user_db/app.db`) remains the default and is enough for up to a few
dozen users. PostgreSQL is justified for an existing managed database,
point-in-time backups, replication, or BI on
the telemetry tables. Driver under a permissive license: `pg`
(node-postgres, MIT); the server comes from the OS repositories and is never shipped
with Elpis. MariaDB/MySQL is no longer supported (see
[operations](operations.md#upgrading) for moving off it).

| `install.sh` choice | What is done |
|---|---|
| `sqlite` | nothing to install |
| `postgres-local` | `postgresql` package, `elpis` role and database (UTF-8, `template0`), `unaccent` extension, random password in `user_db/.db_password` |
| `external` | `./elpis configure` questions: host, port, database, user, password, TLS of a PostgreSQL server |

Offline (`--offline`), no database server is in the package: only
`sqlite`, `external` or an already installed server are possible.

`database` section of `config.json` (each key can be forced by a
variable, which takes precedence):

| Key | Variable | Default |
|---|---|---|
| `backend` | `APP_DB_BACKEND` | `sqlite` (or `postgres`) |
| `host`, `port` | `APP_DB_HOST`, `APP_DB_PORT` | `127.0.0.1`, 5432 |
| `name`, `user` | `APP_DB_NAME`, `APP_DB_USER` | `elpis` |
| `tls` | `APP_DB_TLS` | `off` (`require`, `verify`) |
| `pool_max`, `timeout` | `APP_DB_POOL_MAX`, `APP_DB_TIMEOUT` | 8 connections per process, 60 s |
| — (password) | `APP_DB_PASSWORD` | file `user_db/.db_password` (0600), never in `config.json` |
| `generation` | — | written by the switch from the admin console |
| `pending` | — | target saved by "Save" without a switch (password in `user_db/.db_password.pending`); the active database is not changed by it, the switch applies it then clears it |

On first startup, an empty database receives the full schema; an existing
database receives its missing tables and columns, then its pending migrations. A PostgreSQL database is always created from this schema:
the migrations it contains are recorded there without being replayed. Only one process at a time lays down the schema (file lock), so
workers can start together.

Operations (`./elpis db …`, served by the core: `apps/core/dist/exploitation.mjs db …`):

```bash
./elpis db info                                   # engine, version, size, schema, pool
./elpis db check postgres://elpis@db.lan:5432/elpis
./elpis db transfer --to postgres://elpis@db.lan:5432/elpis --dry-run
./elpis db transfer --to postgres://elpis@db.lan:5432/elpis   # copy to an EMPTY database
./elpis db use sqlite                             # escape hatch if the server goes down
```

Password: `--password-env VARIABLE_NAME` or masked input. The
transfer copies the tables in foreign-key order, sets aside and counts
orphan rows, resets the identity sequences, checks counts and checksums, and
writes a JSON report. From the console, the **Data** page does the
same with "Migrate and switch" (writes suspended during the copy,
automatic restart) and offers "Back to SQLite".

Backup: outside SQLite, the "database" backup produces a SQLite snapshot
(restorable anywhere). `.db_password` (and `.db_password.pending`) is neither
backed up nor restored. To
restore a server-engine database: go back to SQLite, restore, then
migrate.

`configure` is, with the admin console toggle, the only writer of
`security.https`: it does so at installation, then configures Caddy right
after. If Elpis is already running, restart it afterwards (`./elpis restart` or
`sudo systemctl restart elpis.target`).

---

## Startup

### Manual mode

```bash
./elpis start      # starts all services
./elpis status     # status
./elpis logs       # logs
./elpis stop
./elpis doctor     # installation diagnostics
```

`start` runs in sequence: Qdrant (6333) → RAG (8000) → MCP tool
host (8765) → main (8001) → admin (8002) → browser service (3000);
the account's tools are served by main itself. Main and admin
listen according to [`security.listen`](#listening-securitylisten) (`127.0.0.1` behind
Caddy in every case); the RAG extractor and Qdrant listen locally only.

### Listening (`security.listen`)

Without HTTPS, the listening address of main (8001) and admin (8002):

| Situation | Listening |
|---|---|
| HTTPS active | `127.0.0.1` (Caddy is the front end; the setting has no effect) |
| `config.json` missing or unreadable | `127.0.0.1` |
| `"listen": "local"` (default of a new installation) | `127.0.0.1`: this server only |
| `"listen": "lan"` | `0.0.0.0`: ports open **in clear text** to the network |
| key missing from an existing config | `0.0.0.0` (installations that predate the setting, unchanged) |
| `BIND` variable | takes precedence (break-glass) |

Single rule: `apps/core/src/ecoute.ts` (core), read by
`./elpis › _bind_default` for its startup message. The RAG extractor
listens on `127.0.0.1` whatever this setting says (`RAG_HOST` for a core on
another machine). Writers: `./elpis configure` ("Access"
question on the Access page, `--listen local|lan`, `ELPIS_CFG_LISTEN`) and
Admin console › System › HTTPS access › Listening (restarts the application;
"local" is accepted there only from the machine itself, so you do not
cut off your own access). The raw editor does not rewrite it (`_OWNED_PATHS`).
Reinstallation: the value in place (or its absence) is kept.

### Content security policy (`security.csp`)

The application pages (`/` of the chat, `/` and `/admin` of the console)
carry a content security policy (CSP) header: scripts from the
origin only, no inline or evaluated scripts, no embedded objects, no
framing by another site (`apps/core/src/interface/pages.ts ›
POLITIQUE_CSP`). Fallback setting, re-read on every page (no restart needed):

| Value | Effect |
|---|---|
| `"enforce"` (default, key missing or unknown value) | `Content-Security-Policy`: the policy is enforced |
| `"report-only"` | `Content-Security-Policy-Report-Only`: violations are reported in the browser console, nothing is blocked |
| `"off"` | policy removed (emergency fallback if a browser extension or a proxy rewrites the pages); the header common to all responses, `frame-ancestors 'self'`, remains |

```json
{ "security": { "csp": "report-only" } }
```

The sandbox previews, the HTML preview of chat code blocks (`/apercu-code`) and
the OAuth consent screen keep their own policy, independent of this
setting.

### Security journal (`security.audit`)

The security journal (format and events: [audit-events.md](audit-events.md); setup, verification and
forwarding: [operations.md](operations.md#security-journal-and-log-forwarding)) has four settings,
read from disk on every use, with no restart. They are written by Admin console › System › Logging;
the raw editor does not write them, and `./elpis configure --force` keeps them.

| Key | Default | Description |
|---|---|---|
| `retention_days` | `365` | Days a daily file is kept, 180 to 1095 from the console. A value written by hand below 180 is raised to 180; above 1095 it is kept as written, and the console flags it. A value that cannot be read (text, list) suspends the purge |
| `hold` | `false` | `true` keeps every file, whatever the retention. Requires `hold_reason` |
| `hold_reason` | `""` | Reason for the hold (an incident, an investigation, an authority's request), 500 characters at most; emptied when `hold` is off |
| `forwarding_expected` | `false` | `true`: files are deleted only while the syslog agent (rsyslog or syslog-ng) is installed, active and has a rule reading the journal folder |

```json
{ "security": { "audit": { "retention_days": 365, "hold": false, "forwarding_expected": true } } }
```

The console also copies the retention, the expected forwarding and the hold to marker files in the
journal folder (`.settings`, `.hold`): the purge falls back on them if `config.json` no longer has
the section, and deletes nothing if `config.json` cannot be read.

Full backups include the journal unless `backup.include_audit` is `false`; a scheduled remote send
includes it only if `backup.remote.include_audit` is `true`.

### Production mode (systemd)

```bash
sudo ./elpis service install    # or: service remove ; ./elpis service print to see the units
```

- One unit per service (`elpis-qdrant`, `elpis-rag`, `elpis-toolhost`,
  `elpis-main`, `elpis-admin`, `elpis-browser`), grouped under
  `elpis.target`, started at boot, restarted on failure, logs in
  journald under the tag `elpis-<service>` (`./elpis logs main -f`).
  Rerun `sudo ./elpis service install` after an update that changes the units
  (`./elpis upgrade` does not rewrite them).
- Service user: the one who runs `sudo` (suggested, changeable;
  `ELPIS_USER=name` with no question). It must be able to read the repository; it is
  added to the `docker` group.
- `elpis.target` also pulls in Caddy when HTTPS is active, and the local
  voice services (`elpis-whisper`, `elpis-tts`) when they are installed.
- `.env` is read by each unit (`EnvironmentFile`); it overrides the
  units' default values.

### Minimal launch

```bash
export APP_SESSION_SECRET="$(cat user_db/.session_secret)"
ELPIS_RACINE=$PWD APP_MODE=main node/bin/node apps/core/dist/main.mjs
```

> **Session secret.** Order: `APP_SESSION_SECRET` > `config.json ›
> app.session_secret` > `user_db/.session_secret` (created with 0600 under an
> `fcntl` lock on first startup, and re-hardened to 0600 on every boot). The published
> placeholders (`mysecretsessiontomodify`, `changeme`, …) are **treated
> as absent** — otherwise the committed example would have served as the signing
> key. A weak or short secret (< 32 chars) triggers a
> `[CRITICAL]` warning at boot.

---

## Configuration

### `config.json` file

`config.json`, **at the repository root** (path overridable with
`APP_CONFIG_PATH`), is the instance configuration. It is **not versioned**:
the repository contains only an example.

> Elpis reads no other location. A `config.json` left in `shared_infra/` by a
> development version from before 0.0.1 must be moved to the root: a file that cannot
> be found is read as `{}` **without an error**, and the instance would restart with a
> new session secret (sessions invalidated), no TLS and no Qdrant key.

Sections:

| Section | Contents |
|---|---|
| `llama` | `engine`, `url` (server base) or `ip`/`port`, `api_key`, `model`, timeouts, retries, `max_concurrency`, `max_models`, `n_ctx`, `max_tool_iterations`, `tool_timeout_s`, `thinking_budget_tokens`, `max_tokens_chat`/`max_tokens_thinking`, `thinking_output_uncapped`, `think_resume_max`/`think_resume_total_tokens` |
| `mcp` | `tools_cache_ttl_sec`, `servers_dir`, `local_url`/`local_host`/`local_port`/`local_transport` |
| `app` | `db_path`, `session_secret`, `max_recent_chats`, `sandbox_dir`, `enable_model_selector`, `sandbox_quota_mb`, `max_upload_mb`, `system_prompts.*` paths |
| `llm` | `scheduling_mode`, `max_requests_per_user` (simultaneous engine requests per account: conversations, subagents, routines and `/compact` together; the surplus waits, interactive calls first; `0`, the default: no cap; re-read live; Admin console › Connections, engine card), `compression.*`, `compaction.*`, `prune.*`, `task.*` (subagents), `debug.*`, `allowed_provider_types`, `ctx_image_token_cost` |
| `agents` | Subagents (`task`), specific to the TS core, re-read live and written only by `POST /api/admin/agents` (Admin console › Sandbox › Subagents; the raw editor and field-by-field writes do not write it): `read_only.defaults.<type>` (read-only by default; `explore` and `web` true, the others false: a `web` agent keeps its whole browser, only writes to the sandbox are removed; the value written by the console, or set by the account for its agent, wins), `read_only.forced.<type>` (enforced: neither the account nor the main agent can lift it; false by default), `max_tasks_per_turn` (at most this many `task` launches per main-agent turn, 1 to 100, default 12; a resume by `task_id` does not count, and is limited to 3 per agent and per turn) and `max_child_tokens_per_turn` (cumulative input + output tokens of a turn's children at most, those still running counted at best from the usage already known, `0` or 10,000 to 50,000,000, default `0`: no cap) — beyond it, a new launch is refused before it starts (`task_budget_exhausted`, with `fix`), children already launched continue; applies to the chat (a routine has no subagents), re-read on every launch, never announced in the description of `task`. `thinking.defaults.<type>` (thinking: `off`, `on` or `inherit` = that of the main agent's turn; `implement` and `verify` `on`, `explore`, `web` and `pr` `off`, `custom` `inherit`), `thinking_budget_tokens` (thinking budget of a subagent, 512 to 131072, default `llama.thinking_budget_tokens`, see [Subagent thinking](#subagent-thinking-agentsthinking)). `background_timeout_s` (timeout of a background subagent, 300 to 21,600 s, default 3600: its `max_seconds` is bounded by it and the clean finish — soft deadline, report — is measured against it as for a synchronous launch, which `llm.task.child_timeout_s` bounds), `user_browser_session_allowed` (true by default; a value that is not a boolean closes it; false: no subagent receives the account's web session, even if set to "My web session" in the Agents page, Admin console › Sandbox › Subagents › Browser); a background launch counts toward `max_tasks_per_turn` and its tokens toward `max_child_tokens_per_turn` of the turn that launches it, as long as that turn runs. Types: `explore`, `implement`, `verify`, `web`, `pr` and `custom` (all personal agents). Effective read-only = enforced, OR requested by `task(read_only=true)`, OR the account's checkbox (if set, otherwise the default). An unreadable or out-of-range value falls back to its default |
| `memory` | `enabled`, `memory_char_limit`, `user_char_limit` |
| `skills` | `dir`, `user_dir`, `top_n`, `min_score`, `char_budget`, `index_max` |
| `executors` | `image` (third-party image only; without it, the one of the release), `limits.*`, `exec_user`, `force_user_docker`, `idle_kill_hours`, `runtime`, `extra_run_args`, `network_profiles[]`, `jobs.*` (background tasks), `disk.warn_pct` / `disk.refuse_pct` (sandbox disk space in %, 85 and 97 by default, re-read live: warning from the tools that write, then refusal of writes and of new tasks; Admin console › Sandbox › Limits & policy) |
| `security` | `password_policy.*`, `session.*` (cookie, `max_age_sec`, `same_site`, `https_only`, `global_min_ts`), `https.*` (`enabled`, ports, `ca_file`), `listen` (`local` \| `lan`, see [Listening](#listening-securitylisten)), `csp` (`enforce` \| `report-only` \| `off`, see [CSP](#content-security-policy-securitycsp)), `audit.*` (security journal: `retention_days`, `hold`, `hold_reason`, `forwarding_expected`, see [Security journal](#security-journal-securityaudit)) — ⚠ `https.*` + `listen` + `session.https_only` + `session.global_min_ts` + `audit.*` belong to their own endpoints, the raw editor does not write them |
| `vision` / `desktop` | Annotation endpoint, format, model, passes; desktop targets, scopes, budgets |
| `rag` | Extractor, store, Qdrant, embeddings, reranking, OCR, groups, quotas, indexing: see [RAG](#rag-rag) |
| `maintenance` | Retention, run time, daily digest |
| `backup` | `include_audit` (security journal in the full backups, `true` by default), `remote.*` (scheduled upload, Admin console › System › Data); `remote.include_audit` (`false` by default) adds the journal to that upload. See [Security journal](#security-journal-securityaudit) |
| `features` | Global flags (`opencode`, `office_preview`) |
| `welcome` / `app_info` / `login_page` | Branding (edited from the admin console); `app_info.name` is the name of the application and of the assistant, `app_info.logo_b64` is its logo and the assistant's avatar, for all accounts |
| `skins` | `dir` (folder of imported or created skins, default `user_skins`, overridable with `APP_SKINS_DIR`, read at startup), `enabled` (`{id: boolean}`, re-read live: a built-in that is absent takes its value from `frontend/css/skins/skins.json`, Kiki disabled; an imported skin that is absent is disabled; Ardoise and the default skin stay active), `default` (default `elpis`: skin of accounts with no choice or whose skin was disabled). Set from Admin console › System › Appearance; the folder is included in full backups |
| `voice` | Voice engine — `enabled`, then two independent sub-blocks: `stt.*` (address, `format` among `whisper.cpp`/`openai`/`llama-audio`, language, vocabulary, `logprob_min`, caps) and `tts.*` (address, `format`, voice, speed, caps). Coercion and bounds in `apps/core/src/voix/config.ts`, re-read on EVERY call |
| `image` | Image generation — `enabled`, `provider` (`sdcpp` \| `openai`), `url`, `model`, `verify`, `ca_pem`, `timeout_sec`, `max_concurrent`, `max_n`, `max_side`, `default_side`, `size_policy` (`free` \| `fixed`) + `sizes`, `edit_mode` (`init` \| `ref`), `keep_per_user`, `groups`, `tool_max_calls`, `enhance_enabled`. ⚠ `api_key_enc` belongs to `PUT /api/admin/image/key`: the raw editor does not write it. See [Image generation](#image-generation) |

### Publication by subagents

`git_submit` (push the branch and open the pull request, both visible outside the
machine) is never offered to a subagent: the `pr` agent prepares the branch and the
commit, then returns the exact `git_submit` call, which the assistant runs itself in the chat,
where you see the call. **This rule covers only Elpis's `git_submit` tool.** An
account agent to which you attach a third-party MCP server (`mcp_server_ids` of an entry
of `custom_agents`) that can publish (the GitHub server: `create_pull_request`,
`push_files`, `merge_pull_request`…) publishes on its own, as the assistant itself would:
Elpis does not know what a third-party tool does, and the shell of an agent that has it pushes as
far as the sandbox network profile allows. Attach to an agent only the servers you
accept it using on its own, or disable their write tools in the MCP panel.

### Subagent thinking (`agents.thinking`)

A subagent (`task` tool) is the best place to think: its thinking
stays in its isolated context and only its report comes back. Admin console › Sandbox ›
Subagents sets the mode per agent type, and the Agents page does it per
account agent.

- **Mode**: `off` (no thinking), `on`, or `inherit` ("Same as the conversation" in
  the interface: that of the main agent's turn, the "Thinking" checkbox of the chat or routine). Shipped
  defaults: `implement` and `verify` `on`, `explore`, `web` and `pr` `off`,
  `custom` (account agents) `inherit`.
- **Priority**: the account's choice for an agent (`thinking` of an entry of
  `custom_agents`, personal agent or override of a built-in), otherwise the
  administrator's default for its type.
- **Effective = wanted mode AND an engine that honors it.** The mode is computed once,
  when the child is launched (resume by `task_id` included): it never changes
  between two iterations of the same child, since the head of the prompt depends on it. It
  never loads a model and, at the slightest failure, thinking is turned off. A
  child that does not think receives none of the main agent's `reasoning_effort`,
  `thinking_budget_tokens` or `preserve_reasoning`.
  `think_tokens` of the final `task_step` step and of the run counts its thinking tokens,
  and the chat card shows "thinking" only if they are measured
  (> 0).
- **`thinking_budget_tokens`**: thinking budget of a child that thinks
  (512 to 131072, default `llama.thinking_budget_tokens` of the engine, 8192). Set
  in the child's sampling (`thinking_budget_tokens`), unless the main
  agent already imposes a lower one.

| | llama.cpp | vLLM | SGLang | generic, cloud |
|---|---|---|---|---|
| Switch | the template's `enable_thinking`, if the model's template declares thinking (`/props`) | `enable_thinking` always accepted (no effect on a model that does not reason) | same as vLLM | none: the child does not think |
| Budget | Elpis asks the engine to close the reasoning at this threshold | not applied (Elpis cannot close it) | not applied | — |
| Reasoning kept | no (thinking from tool turns is not sent back to the engine) | no | the chat's (off by default), effective if a `--reasoning-parser` is active | — |

"Reasoning kept" is never imposed on a subagent: it keeps the sampling
of the chat that launches it, where the option is off by default.
Turned on in the chat (SGLang), the thinking of each of the child's tool calls
goes back to the engine: its prefix grows from one turn to the next and RadixAttention
reuses it, but its window fills up that much faster. This thinking
is not recorded in the chat history, but the child's resume
record keeps it (`reasoning_content` of its assistant messages):
a resume by `task_id` sends the engine the same prefix. The description of the
`task` tool says nothing about the mode: it is part of the main agent's head
and does not change with these settings.

### RAG (`rag`)

Re-read on every call by the core (`packages/config/src/rag.ts`): a
change applies without a restart. Admin console › Models & services › RAG
writes it field by field; `./elpis configure` (RAG page) sets the address and
model of the embeddings, the reranking and the OCR. Without `embed.url`, RAG is
disabled (the RAG page says so, no indexing).

```json
"rag": {
  "service_url": "http://127.0.0.1:8000",
  "qdrant_url": "http://127.0.0.1:6333",
  "embed": { "url": "http://gpu.lan:8081", "model": "bge-m3", "api_key": "", "batch": 32, "timeout_s": 60 },
  "reranker": { "enabled": false, "url": "", "model": "bge-reranker-v2-m3" },
  "ocr": { "url": "", "model": "", "api_key": "", "timeout_s": 180, "max_side_px": 1280, "max_tokens": 8192 },
  "groups": [],
  "quotas": { "storage_mb": 2048, "collections": 10, "file_mb": 200, "docs_per_collection": 2000 },
  "indexation": { "concurrence": 2, "par_compte": 1 }
}
```

| Key | Role | Default |
|---|---|---|
| `service_url` | `rag_app` extractor (`RAG_SERVICE_URL` variable takes precedence) | `http://127.0.0.1:8000` |
| `service_token` | Extractor token; without it, `RAG_SERVICE_TOKEN` then `user_db/.rag_service_token` (written by `./elpis configure`, also read by the extractor) | — |
| `store_dir` | File store (`RAG_STORE_DIR` takes precedence): originals, extracts, rendered pages, per account and per collection; `./elpis` gives the same folder to the extractor | `<database folder>/rag` (`user_db/rag`) |
| `qdrant_url` | Qdrant, local and keyless (`./elpis` starts it on `127.0.0.1:6333`) | `http://127.0.0.1:6333` |
| `embed.*` | OpenAI-compatible embeddings server (`/v1/embeddings`), model, key, batch size (1 to 512), timeout (1 to 600 s). Changing the model reindexes all collections (console) | model `bge-m3` |
| `reranker.*` | Optional reranking (`/v1/rerank`) | disabled |
| `ocr.*` | OpenAI-compatible vision model that reads scanned pages ("grounding" format of the DeepSeek-OCR family); empty `url` = no OCR. The core sends these settings to the extractor on every extraction of a collection where OCR is enabled | disabled |
| `groups` | IDs of the groups that have the RAG permission; empty = all accounts; the admin always has it | `[]` |
| `quotas.*` | Per account: storage (MB), collections, file size (MB), documents per collection; a per-account override (Admin console › RAG › Per-account quotas, `settings_json.rag_quota`) replaces key by key | 2048, 10, 200, 2000 |
| `indexation.*` | Documents indexed at the same time on the instance (1 to 16) and per account (at most `concurrence`) | 2, 1 |

An unreadable or out-of-range value falls back to its default.

- **Permissions.** The account that creates a collection owns it and is the
  only one to modify it. It publishes it to the groups it belongs to; only an
  admin publishes to "All accounts". The accounts that read it (readers)
  search in it and see the passages; they open the original only if the
  owner allowed it. A publication keeps its value if its author leaves
  the group or loses the RAG permission, until their account is deleted. The admin
  sees the metadata of all collections and can delete one; the admin
  never reads the content of a collection that is not open to them.
- **Secrets.** `embed.api_key`, `ocr.api_key` and `service_token` are masked
  (`********`) in the console and the raw editor, and absent from the logs and from the
  accounts' configuration copies (`user_db/configs/`).
- **Extractor.** Its own settings (timeouts, memory, sizes, isolation
  `RAG_ISOLATION`) are environment variables:
  [`rag_app/README.md`](../rag_app/README.md). `RAG_EXTRACT_TIMEOUT_S` also sets
  the core's timeout. It listens on `127.0.0.1:8000` (`RAG_HOST` for a core on
  another machine, which must then see the same store).

### Declared inference engine (`llama.engine`)

The type written in `config.json` is authoritative: Elpis does not try to guess the
engine. It applies the profile of the declared type (a single table,
`apps/core/src/llm/profils.ts`): addresses, capabilities, metrics and recommended
launch options. An expected address that does not answer is flagged
(startup log, Admin console › Inference › Capabilities) without changing
behavior.

```json
"llama": {
  "engine": "vllm",
  "url": "http://gpu.lan:8000",
  "api_key": "",
  "model": "Qwen/Qwen3-8B"
}
```

- **`engine`**: `llamacpp` (aliases `llama.cpp`, `llama-cpp`, `llama`), `vllm`,
  `sglang` or `generic` (aliases `openai`, `tgi`, `ollama`, `lmstudio`; any
  other value means `generic`). Takes effect on restart.
- **`url`**: the server base (`http://host:port`); an address ending in
  `/v1` or `/v1/chat/completions` is accepted and normalized. Without `url`,
  `ip` and `port` give `http://ip:port`. Existing configurations
  (full URL) keep working.
- **`api_key`**: optional, the value of the server's `--api-key`, sent as
  `Authorization: Bearer` on every call to the default engine (`LLAMA_API_KEY`
  overrides it). It is never sent back to the interface: the console shows
  `********` and the raw editor keeps the key when this mask comes back unchanged; an
  emptied field removes it. It appears in no log.
- **`model`**: for vLLM, a served name (`--served-model-name`, otherwise the model
  path); vLLM refuses any other name, and the probe flags it.

What each profile does:

| | llama.cpp | vLLM 0.31 | SGLang 0.5.21 | generic |
|---|---|---|---|---|
| Health | `/health` | `/health` | `/health` | `/v1/models` |
| Version | `/props` (`build_info`) | `/version` | `/server_info` | — |
| Context | `/props` (per slot) | `max_model_len` from `/v1/models` | `max_model_len` from `/v1/models` | declared or guessed |
| Exact tokens | `/apply-template` then `/tokenize` | `/tokenize` (`messages` in one call) | `/v1/tokenize` (`messages` in one call) | estimated |
| Metrics | `/metrics` (`--metrics`) | `/metrics` (`vllm:*`) | `/metrics` (`--enable-metrics`) | — |
| KV cache of the gauge | `llamacpp:kv_cache_tokens` ÷ `n_ctx_total` | `vllm:kv_cache_usage_perc` × blocks from `vllm:cache_config_info` | `sglang:kv_used_tokens` ÷ `sglang:max_total_num_tokens` (`--dp` replicas added up, TP ranks counted once; otherwise `sglang:token_usage` and `max_total_num_tokens` from `/server_info`) | — |
| Engine prefill (load) | — | time to first token (`vllm:time_to_first_token_seconds`) | time to first token (`sglang:time_to_first_token_seconds`), prefill throughput (`sglang:realtime_tokens_total{mode="prefill_compute"}`) | — |
| Tokens reused from cache | `usage.prompt_tokens_details` or `timings.cache_n` | `usage.prompt_tokens_details.cached_tokens` (`--enable-prompt-tokens-details`) | same (`--enable-cache-report`) | if provided |
| Concurrency | Elpis queue (slots) | engine's continuous batching | engine's continuous batching | parallel requests |
| Speeds of a call (bubble) | stream `timings` | measured by Elpis: generation = after the first token; reading (prefill = time to first token, engine queue included) only with the cached tokens reported (`--enable-prompt-tokens-details`) | same (`--enable-cache-report`) | — |
| Load / unload | router mode | no (model chosen at launch) | no | no |

With vLLM and SGLang, requests go out in parallel: the engine groups them
itself (`--max-num-seqs`, `--max-running-requests`) and
`llama.max_concurrency` applies only to llama.cpp. The chat's model selector
shows neither "Load" nor "Unload"; the KV cache gauge and the
load line (running and waiting requests, throughput, prefill throughput,
time to first token, prefix cache) come from the engine's metrics. The
time to first token is the average of the requests finished between two reads;
with no new request, the last average stays displayed.

With vLLM and SGLang, the foot of the chat's model menu shows the context of
the open conversation ("Context"); the engine's KV pool, shared among
all conversations, stays in the tooltip. With no known usage
(new chat, after compression, old chat), the foot shows this pool under the
label "Engine". The per-conversation share of the cache that is read back
requires `--enable-prompt-tokens-details` (vLLM) or `--enable-cache-report` (SGLang).

Recommended launches (options checked in the code of these versions):

```bash
# vLLM 0.31 — the prefix cache is on by default; do not pass --disable-log-stats (metrics)
vllm serve Qwen/Qwen3-8B --host 0.0.0.0 --port 8000 \
  --max-model-len 32768 \
  --reasoning-parser qwen3 \
  --enable-auto-tool-choice --tool-call-parser hermes \
  --enable-prompt-tokens-details \
  --api-key "$CLE"

# SGLang 0.5.21
python -m sglang.launch_server --model-path Qwen/Qwen3-8B --host 0.0.0.0 --port 30000 \
  --context-length 32768 \
  --reasoning-parser qwen3 \
  --tool-call-parser qwen25 \
  --enable-metrics --enable-cache-report \
  --api-key "$CLE"
```

- **Thinking**: without `--reasoning-parser`, the thinking of a model that
  thinks arrives in the response. Names: `qwen3`, `deepseek_r1`,
  `openai_gptoss` (vLLM); `qwen3`, `deepseek-r1`, `gpt-oss` (SGLang).
- **Reasoning kept** (SGLang, off by default): the switch in the
  generation settings is offered when the server has a `--reasoning-parser`.
  When on, the thinking of each tool call of the turn is sent back to the engine
  (`reasoning_content` of the assistant message); the model's template decides
  what it keeps (Qwen3, GLM-4.5/4.6, MiniMax-M2: the thinking that follows the
  last question). The prompt of a tool turn grows by that much, and the next
  question recomputes the tool calls of that turn: this thinking
  is never recorded in the history. vLLM does not receive it.
- **Tools**: without a tool-call parser, the model cannot call Elpis's
  tools: `--enable-auto-tool-choice --tool-call-parser hermes`
  (vLLM, Qwen; `llama3_json` for Llama) or `--tool-call-parser qwen25`
  (SGLang; `llama3` for Llama). The parser follows the model's call format,
  not just its family; SGLang names: `qwen25` (Qwen2.5, Qwen3: JSON in
  `<tool_call>`), `qwen3_coder` (Qwen3-Coder and models using the XML format
  `<function=…>`), `glm45` (GLM-4.5, 4.6), `glm47`, `kimi_k2`, `minimax-m2`,
  `gpt-oss`. An unsuitable parser swallows the calls or delivers them as text; the
  probe flags it when the model name allows. An empty response after
  thinking when tools were offered can come from the tool parser
  or the thinking parser.
- **API key**: vLLM's `--api-key` protects only `/v1/*` (`/tokenize`,
  `/metrics`, `/version` stay open); SGLang's protects everything except
  `/health`, `/ready` and `/metrics`. Keep these servers on a closed network.
- **Port**: on Elpis's machine, port 8000 is the RAG extractor's;
  launch vLLM elsewhere or on another port (`--port`). The wizard and
  `configure` flag this.

The installer (`./install.sh`, `./elpis configure`) offers these four types,
with the default key and port of each; its final note and `./elpis doctor`
recall these flags for vLLM and SGLang. `./elpis doctor` also probes
`GET /v1/models` with the key ("key rejected" on a 401) and, if `main` is running,
shows the core's last probe (`[moteur]` lines of its log, since the last
startup).

**Probe.** At startup, the `main` process probes the declared engine and writes a
summary line (`[moteur] vLLM 0.31.0 sur http://…, modèle …, contexte …
jetons, métriques oui, tokenisation exacte oui, concurrence gérée par le
moteur`), then each missing option with the exact flag to add. Admin console ›
Inference › Capabilities shows the same report; "Test" redoes it, with a
one-token response to check vLLM's cached-token details. During
chat, thinking received in tags, tool calls received as text, an empty
response after thinking when tools were offered, or a vLLM response with no `prompt_tokens_details` add the
matching advice (log and console), once per engine. Testing a
`llamacpp`, `vllm` or `sglang` connector shows the same report.

**Connectors.** The `vllm` and `sglang` types (presets "vLLM (local)" and
"SGLang (local)") use the same profile as the default engine; their
address is the server base followed by `/v1`.

### Cloud providers for accounts (`llm.allowed_provider_types`)

An account connects a cloud provider with its own key in Settings › AI
models. `llm.allowed_provider_types` lists the types that **non-administrator**
accounts (moderators included) can choose there: `anthropic`, `openai`,
`mistral`, `groq`, `openrouter`, `deepseek`, `moonshot`, `opencode`.

- **Missing, empty or unreadable: none** (default since 0.1.0; before, all
  cloud types were open). An offline instance thus lets no data
  leave for a cloud service without an administrator decision.
- **Administrator** accounts are not affected: their personal connectors
  keep all cloud types, and shared connectors
  (Admin console › Models & services, including `llamacpp`, `vllm` and `generic`) do not change.
- The local types (`llamacpp`, `vllm`, `generic`) stay reserved for shared
  connectors: a non-administrator account uses them through the servers the
  administrator shares and through the built-in engine.
- The list is re-read on every creation and every generation: a personal
  connector of a closed type stays in the database, marked "closed by the administrator"
  in Settings, but is no longer usable ("This provider is no longer
  allowed on this instance.") until its type is reopened.

Setting: Admin console › Models & services › User access › Allowed providers, or by
hand:

```json
{ "llm": { "allowed_provider_types": ["anthropic", "mistral"] } }
```

**Upgrading from 0.0.1**: without this key, the personal cloud connectors
of non-administrator accounts stop working after the
upgrade; check the types to keep in the console.

Each user also has settings in the database (`users.settings_json`);

`user_db/configs/{user_id}.json` keeps a personal copy of the application
config.

> **GLOBAL feature flags** (`config.json › features`): read by
> `feature_enabled(name)` (default `true` if missing), **re-read from disk on every
> call** (so multi-worker-safe and no restart needed), exposed to the front end by
> `GET /api/public-config`, and **enforced on the backend** (404). Today:
> `opencode` and `office_preview`. The front end also receives `agents` (derived from `llm.task.enabled`),
> the master switch for subagents, as well as `voice_stt` and `voice_tts`
> (derived from `voice.enabled` **and** from the presence of an address). These two
> default to strict **OFF**: unlike the others, a feature that
> opens the microphone or produces sound is not turned on for backward compatibility.

### Environment variables

Any `config.json` value can be overridden by the environment, which
**always takes precedence**. A variable that is set but **empty** is treated
as missing.

#### Inference

| Variable | JSON key | Default | Description |
|---|---|---|---|
| `LLAMA_IP` | `llama.ip` | `127.0.0.1` | Engine address |
| `LLAMA_PORT` | `llama.port` | `8080` | Port |
| `LLAMA_URL` | `llama.url` | derived | Server base (`/v1` or `/v1/chat/completions` accepted) — takes precedence over IP/PORT |
| `LLAMA_API_KEY` | `llama.api_key` | empty | Default engine key (`Authorization: Bearer`), never displayed |
| `LLAMA_MODEL` | `llama.model` | `local-model` | Default model |
| `LLAMA_ENGINE` | `llama.engine` | `llamacpp` | `llamacpp` \| `vllm` \| `sglang` \| `generic` (the declared type is authoritative) |
| `LLAMA_TIMEOUT_SEC` | `llama.timeout_sec` | `600` | Request timeout |
| `LLAMA_RETRIES` | `llama.retries` | `3` | Attempts |
| `LLAMA_RETRY_BACKOFF_SEC` | `llama.retry_backoff_sec` | `0.6` | Backoff base |
| `LLAMA_RETRY_BACKOFF_CAP_S` | `llama.retry_backoff_cap_s` | `15` | Full-jitter cap |
| `LLAMA_LOADING_WAIT_S` | `llama.loading_wait_s` | `90` | Wait for "model loading" (503 → `/health` probe) |
| `LLAMA_MAX_CONCURRENCY` | `llama.max_concurrency` | `4` | llama.cpp: fallback if `/props.total_slots` is unavailable (vLLM and SGLang batch requests themselves) |
| `ELPIS_LLM_SLOTS_DIR` | — | `/tmp/elpis_llm_slots` | llama-server slots shared by all processes (one locked file per slot); must belong to the service account |
| `LLAMA_MAX_MODELS` | `llama.max_models` | `1` | Simultaneous models on the server |
| `LLAMA_MAX_TOOL_ITERATIONS` | `llama.max_tool_iterations` | `200` | Max **productive** iterations per turn |
| `LLAMA_TOOL_TIMEOUT_S` | `llama.tool_timeout_s` | `300` | Hard limit per tool call |
| `LLAMA_TOOL_LOOP_MAX_S` | `llama.tool_loop_max_s` | `0` (off) | Wall-clock budget of a tool-using turn: when it runs out, the generation in progress is cut (received text kept), then a synthesis turn without tools |
| `LLAMA_THINKING_BUDGET_TOKENS` | `llama.thinking_budget_tokens` | `8192` | Thinking budget (plain chat; clamped `[512..131072]`, llama.cpp alias `reasoning_budget_tokens`) |
| `LLAMA_MAX_TOKENS_CHAT` | `llama.max_tokens_chat` | `16384` | Theoretical generation cap (chat mode): "Auto" length and output reserve. A length chosen in the Generation panel is bounded only by the free room in the window (window − estimated prompt − margin), for all engines |
| `LLAMA_MAX_TOKENS_THINKING` | `llama.max_tokens_thinking` | `24576` | Theoretical cap (thinking mode) — mostly serves the **prompt reserve** since `thinking_output_uncapped` |
| `LLAMA_THINKING_OUTPUT_UNCAPPED` | `llama.thinking_output_uncapped` | `true` | **Local** thinking mode: no `max_tokens` sent (long reasoning not cut off; aligned with Open WebUI / the llama.cpp webui) |
| `LLAMA_THINK_RESUME_MAX` | `llama.think_resume_max` | `6` | Max auto-resumes of a cut-off reasoning (`finish=length` in the middle of `<think>`) per LLM call; `0` = off |
| `LLAMA_THINK_RESUME_TOTAL_TOKENS` | `llama.think_resume_total_tokens` | `131072` | Total thinking budget accumulated across a chain of auto-resumes |

> ⚠️ `LLAMA_MAX_MSGS` was **removed**. Clamping by *number* of
> messages silently cut the history. The only limit is now
> the **token** budget; beyond it, the server answers "context exceeded"
> (`KIND_CONTEXT_OVERFLOW`) with a clear user message.

#### Context, compaction, pruning

| Variable | JSON key | Default | Description |
|---|---|---|---|
| `APP_COMPACTION_BUFFER_TOKENS` | `llm.compaction.buffer_tokens` | `0` (auto) | Margin under the ceiling (`min(20k, 10 % n_ctx)`) |
| `APP_COMPACTION_PARTIAL_TARGET_RATIO` | `llm.compaction.partial_target_ratio` | `0.6` | Target of a partial compaction |
| `APP_COMPACTIONS_PER_RUN_MAX` | `llm.compaction.per_run_max` | `8` | Successful compactions per run (floor scaled to the iteration budget) |
| `APP_COMPRESSION_MODEL` | `llm.compression.external_model` | — | Model dedicated to the summary |
| `APP_COMPRESSION_ENDPOINT_URL` | `llm.compression.endpoint_url` | — | Dedicated endpoint (OpenAI path completed) |
| `APP_COMPRESSION_ENDPOINT_MODEL` | `llm.compression.endpoint_model` | — | Model on this endpoint |
| `APP_COMPRESSION_ENDPOINT_TIMEOUT_SEC` | … | `120` | Timeout |
| `APP_COMPRESSION_MAX_PER_CHAT` | `llm.compression.max_per_chat` | `12` | Hard cap (auto **and** manual); `0` = unlimited |
| `APP_PRUNE_PROTECT_TOKENS` | `llm.prune.protect_tokens` | `0` (auto 20 % n_ctx) | Recent window never pruned |
| `APP_PRUNE_MIN_TOKENS` | `llm.prune.min_tokens` | `0` (auto) | Minimum gain to commit a pass |
| `APP_PRUNE_EVERY_ITERS` | `llm.prune.every_iters` | `10` | Pruning cadence **during** a run (0 = end of turn) |
| `APP_CTX_IMAGE_TOKEN_COST` | `llm.ctx_image_token_cost` | `1500` | Flat cost of an image (deliberately overestimates) |

> **Inert keys.** `trigger_after_turns`, `compress_every`, `pct_of_ctx`,
> `cooldown_iters`, `min_growth_tokens` linger in old `config.json` files:
> nothing reads them anymore. The compaction trigger is a **single
> occupancy rule** — when the real prompt reaches `usable = n_ctx − generation
> cap − buffer`. Do not document them as levers.

#### Subagents

| Variable | JSON key | Default |
|---|---|---|
| `APP_TASK_CHILD_TIMEOUT_S` | `llm.task.child_timeout_s` | `3600` — **hard** timeout of a subagent, cap of `task`'s `max_seconds`, counted from entry into `task`, wait for an engine slot included (`queued_s` of the report; `duration_s` starts from that slot); the agent must finish before its soft deadline, `timeout − reserve` (reserve: `min(⅓ of the timeout, max(120 s, timeout / 10))`, enough to write the synthesis): at that deadline, the generation in progress is cut and so is each of its tool calls (at most 3 s later), then the agent writes its report; at the hard timeout (engine stuck or too slow), the report returned is the synthesis already produced, or a partial report assembled by the harness |
| `APP_TASK_SUBAGENT_DEPTH` | `llm.task.subagent_depth` | `1` — **no effect** in TS: a subagent never launches a subagent (read for `config.json` compatibility) |
| `APP_TASK_RESUME_TTL_S` | `llm.task.resume_ttl_s` | `21600` |
| `APP_TASK_RESUME_MAX` | `llm.task.resume_max` | `200` |
| `APP_TASK_MAX_ITERS_EXPLORE` / `_IMPLEMENT` / `_VERIFY` / `_WEB` / `_PR` | `llm.task.max_iters.*` | `60` / `100` / `60` / `60` / `40` |
| `APP_TASK_MAX_ITERS_CUSTOM` | `llm.task.max_iters.custom` | value of `_GENERAL` |
| `APP_TASK_MAX_ITERS_GENERAL` | `llm.task.max_iters.general` | `80` (fallback for custom agents) |
| — | `llm.task.enabled` | `true` (master switch) |

#### Application

| Variable | JSON key | Default | Description |
|---|---|---|---|
| `APP_CONFIG_PATH` | — | `config.json` (root) | Config path |
| `APP_CONTEXT_CONFIG` | `app.context_config_path` | `packages/config/context_config.json` | LLM texts |
| `APP_DB_PATH` | `app.db_path` | `user_db/app.db` | SQLite file (default engine) |
| `APP_SESSION_SECRET` | `app.session_secret` | `user_db/.session_secret` | Session signing |
| `APP_MAX_RECENT_CHATS` | `app.max_recent_chats` | `100` | Max active conversations — **destructive** beyond it (see below); re-read live |
| `APP_SANDBOX_DIR` | `app.sandbox_dir` | `user_sandboxes` | Sandbox root (propagated as an absolute path) |
| `APP_SKILLS_DIR` / `APP_USER_SKILLS_DIR` | `skills.dir` / `skills.user_dir` | `skills` / `user_skills` | Skill stores |
| `APP_SKINS_DIR` | `skins.dir` | `user_skins` | Skins imported or created from the console (one `<id>/` subfolder per skin) |
| `APP_MAX_UPLOAD_MB` | `app.max_upload_mb` | `50` | Cap per uploaded file |
| `APP_BUILD_ID` | — | auto | Asset cache busting |
| `APP_MODE` | — | `main` | `main` \| `admin` \| `full` (missing or invalid → `main`) |
| `APP_SERVICE` | — | `main` | Log tag (`./elpis start` sets it per service) |
| `ADMIN_PUBLIC_URL` / `MAIN_PUBLIC_URL` | — | — | External URLs (automatic localhost rewrite) |
| `APP_LLM_SCHEDULING` | `llm.scheduling_mode` | `auto` | `auto` \| `classic` \| `optimized` |
| `APP_GIT_TOOL_TIMEOUT_S` | `tools.git.timeout_s` | `60` | Local Git commands |
| `APP_*_RETENTION_DAYS` | `maintenance.*_retention_days` | 90 to 400 depending on the table | Retention (`0` = no purge); the one for `usage_events` also applies to runs (`runs`) |
| `APP_MAINTENANCE_HOUR` | `maintenance.hour` | `6` | Hour of the daily pass |

#### Journals

Variables read by the services and by `./elpis audit`; the units set the first two when
`sudo ./elpis audit setup` has created the folders.

| Variable | Default | Description |
|---|---|---|
| `ELPIS_AUDIT_DIR` | `/var/lib/elpis/audit` if writable, otherwise `logs/audit` in the repository | Folder of the security journal |
| `ELPIS_AUDIT_KEY_PATH` | `/etc/elpis/audit.key` | Signing key of the security journal (32 bytes at least); without a usable key, lines are written unsigned |
| `ELPIS_APP_LOG_DIR` | `user_db/logs` of the repository (`/var/log/elpis` under systemd) | Folder of the access log `app.log.jsonl` |
| `ELPIS_APP_LOG_MAX_MO` | `8` | Size in MB at which `app.log.jsonl` is rotated (1 to 1024) |
| `ELPIS_APP_LOG_ROTATIONS` | `3` | Rotated files kept, `app.log.jsonl.1` to `.N` (1 to 50) |
| `ACCESS_LOG_TRUSTED_PROXIES` | `127.0.0.0/8,::1` | Proxies (addresses or networks, comma-separated) whose `X-Forwarded-For` is believed for the client address of the access log and of the security journal |
| `ELPIS_GROUPE_JOURNAL` | `elpis-journal` | Group that reads the journal folders (`audit setup`; `adm` is accepted) |
| `ELPIS_GROUPE_CLE` | `elpis-cle` | Group of the signing key when the service account's primary group is not its own (`audit setup`) |
| `ELPIS_USER` | — | Service account for `audit setup`, `service install` and `./install.sh` run as root; see [Production mode](#production-mode-systemd) |

#### Local MCP server

**`mcp.json` manifest.** The default tool servers are
declared in `mcp.json` at the root (the `mcpServers` format of MCP clients +
an `x-elpis` block per entry: role, families, `default_on`, families published to
opencode, exported stdio command). Schema: `docs/schemas/mcp.schema.json`. Loader:
`packages/mcp/src/manifeste.ts`. Without a file, the manifest is synthesized from
the variables below (legacy behavior). With a file, `LOCAL_MCP_URL`,
`LOCAL_MCP_TOKEN`, `LOCAL_MCP_TOOL_FAMILIES` and `LOCAL_MCP_OPENCODE_FAMILIES`
remain OVERRIDES. Admin console → Models & services → MCP tools →
"Default tools": state of the entries + Reload (`POST /api/admin/mcp/manifest/reload`,
no restart). Servers with `x-elpis.role: external` appear in the
MCP panel ("Declared" block, per-chat state `mf:<name>`).

**One server = one entry = one endpoint.** `mcp.json` declares ONE
entry per tool family, each with its endpoint: `elpis-git` →
`http://<host>:8765/mcp/git`. Removing the entry (or `"enabled": false`) removes its
tools from the chat, without touching any other list. The host serves all three
transports in parallel for each family:

| transport | endpoint |
|---|---|
| Streamable HTTP | `…:8765/mcp/<family>` |
| SSE | `…:8765/sse/<family>` (messages on `/messages/`) |
| stdio | `node apps/toolhost/dist/main.mjs --stdio --families <family>` |

Without a family segment, `/mcp` and `/sse` serve all registered
families. The app always reaches the host over the network: it never launches a
stdio subprocess, and a stopped host makes the tools unavailable (message
in the log; `./elpis doctor` flags it). The stdio command of a
`role: toolhost` entry (`x-elpis.fallback`, derived by default:
`<node> apps/toolhost/dist/main.mjs --stdio --families <its families>`, `"fallback": false`
to remove it) is used only for export to a third-party application. In stdio, the host
itself serves its native families, with no token or port: the client is a trusted
local process, the account is the `_meta.username` of each call (`guest`
without it), like `python -m toolhost --stdio`; no family served: refusal (code 2).
One entry per family, like `mcp.example.json`. The export flags in `omis` (and the console
in its message) the entries without the requested transport; in SSE, it asks the host
(`/manifest`, service token and administrator envelope) which families
it serves and omits those it does not (silent host: nothing is removed). The account-bound families (`chart`, `memory`,
`skill`, `todo`) are `role: app` `type: inprocess` entries (no URL) served
by main itself: they write to the app's database and folders;
`/api/mcp-bridge/<family>` serves them directly and the tool host does not
register them. `./elpis configure`, `start` and `upgrade` remove the
`http://127.0.0.1:8766/...` URLs of the old `appmcp` service from an existing `mcp.json` (remote
URLs kept), and `./elpis doctor` flags those that remain. The host's origin and token live
in `toolHosts` (alias of `sandboxHosts`), with a `serve` block
(`host`/`port`/`transports`). `relay: true` (set by default, added to existing
`mcp.json` files by `./elpis configure`) makes main relay, even over
loopback, `/api/sandbox/*`, `/api/terminal/*`, `/ws/terminal*`, screenshots
(`/api/playwright/screenshot/*`) and frames (`/api/desktop/frame/*`) to
the host, with its token and the session's signed identity: main no longer serves
these routes itself. At sign-in, main also opens the account's file-history
session on the host (`POST /internal/file-history/session`, same
token and identity), where the editor and the assistant record their writes:
3 s wait at most; on failure, the sign-in goes through, a warning
is logged and the previous session continues. Loopback host stopped or
relay inactive: the session opens locally (same disk). Export ready to
paste into another application:
Admin console → Models & services → MCP tools → "Default tools" → Export, or
`GET /api/admin/mcp/manifest/export?transport=http|sse|stdio&with_token=1`, or
`GET /manifest?transport=…` on the host.

⚠ In stdio transport, standard output IS the JSON-RPC channel: every
service diagnostic goes to `stderr`.

**Personal tokens.** Each account creates its tokens in Settings ›
Access tokens; only their SHA-256 fingerprint is kept (token shown once,
regenerable). Three types: `pcr_` (opencode: plugin, `opencode.json`, MCP
relay), `ept_` (tools: MCP relay and OpenAPI facade, checked families ∩
policy, expiry) and `evt_` (vision for a desktop automation, 12 h,
`/api/desktop/locate` only, created automatically, 20 at most per account,
hidden from the list). `mcp.tokens.*` policy, re-read live: `tools_enabled`
(true), `tools_families` (`fs,shell,git,desktop,browser,skill_run`),
`max_days` (90; 0 = no limit), `max_per_user` (20, valid opencode and
tool tokens). Revoking an account's sessions, resetting or changing
its password also revokes all its tokens and its OAuth apps;
the administrator sees and cuts these accesses from the account's page.
`GET /api/code/config` no longer returns a token: the installer and pairing
create one.

**OpenAPI facade.** The families of the shared service that have an
external access point (`fs`, `shell`, `git`, `desktop`, `browser`, `skill_run`)
are also served as
OpenAPI 3.1 under the app's origin: `GET /api/tools/<family>/openapi.json`
(generated from `tools/list`, 60 s cache) and `POST /api/tools/<family>/<tool>`.
Authentication by `ept_` tool token only; scope = the token's families ∩
`mcp.tokens.tools_families`; `mcp.tokens.tools_enabled: false` cuts the facade
(404). The call goes out with the SERVICE token and the identity of the token's
owner in the MCP `_meta`, with the tool's own timeout; at most 4
simultaneous calls per account and per worker (429). Code:
`apps/core/src/outils/openapi.ts`, `apps/core/src/familles/openapi.ts`.

**MCP compliance.** The tool service follows the MCP
specification (revisions 2024-11-05 to 2025-11-25, streamable HTTP transport), verified by
a test bench that has the reference clients (official SDK and FastMCP) talk to the
relay: `initialize` for each version (Elpis version in `serverInfo`,
`tools.listChanged: false` — no list notification is emitted),
paginated `tools/list` (`nextCursor`, `LOCAL_MCP_LIST_PAGE_SIZE`, 100 by default,
enough to hold a family endpoint on one page), named, titled,
annotated tools (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`),
`inputSchema`/`outputSchema` in JSON Schema, `structuredContent` conforming to
`outputSchema`. A tool failure — invalid arguments included — is an `isError`
result; an unknown tool, a disabled tool, or one outside the client's families is a JSON-RPC
error `-32602` (same response in all three cases). Transport: the public relay
`/api/mcp-bridge[/<family>]` serves only streamable HTTP, rejects an unknown
`MCP-Protocol-Version` (400) and checks `Origin` (403) like the tool
service: a missing header (native clients) passes, otherwise the origin must appear
in `mcp.allowed_origins` (re-read live, `scheme://host:*` pattern accepted),
`app.cors_origins` or `LOCAL_MCP_ALLOWED_ORIGINS` (never inferred from the `Host`
header, relay included). The relay never forwards the client's token: it verifies it
(`apps/core/src/familles/pont-mcp.ts`) then presents the service with a
`dlg_…` DELEGATION token (`packages/mcp/src/delegation.ts`) — an HMAC envelope
signed with the service token, with audience `elpis-mcp`, valid ±60 s, carrying
the account, the client type and its families. The service derives from it the restrictions
the client's token would have had, never the app's trust; a service that
does not know `dlg_` rejects it (401). A personal token presented directly to the
service (local client on the loopback) is still accepted.

**OAuth 2.1 authorization for MCP clients.** Elpis is its own authorization
server (MCP "Authorization" specification 2025-11-25):
`/.well-known/oauth-protected-resource[/api/mcp-bridge[/<family>]]` (RFC 9728:
the advertised resource is the one of the requested path, `<origin>/api/mcp-bridge`
or `<origin>/api/mcp-bridge/<family>` — a token obtained for a family is
bound to it; scopes `tools` and `tools:<family>`), `/.well-known/oauth-authorization-server` (RFC 8414),
`/oauth/register` (RFC 7591, redirects limited to `http://127.0.0.1|localhost|[::1]`
and `https://`), `/oauth/authorize` (Elpis session then consent screen,
code + PKCE S256 mandatory, RFC 8707 `resource` mandatory), `/oauth/token`
(code or refresh with rotation), `/oauth/revoke` (RFC 7009). Clients
described by an https document (CIMD) are accepted when the document is
reachable (shared SSRF guard, connection to the verified address, document fetched
only for a signed-in account). As long as a self-registered client
has been authorized by no one, a request in error is shown in place,
with no redirect to its return address. The relay answers `401` with
`WWW-Authenticate: Bearer resource_metadata="…"` (and `scope="tools:<family>"` on
a family access point), and `403 insufficient_scope` for a family not
granted. Opaque tokens stored as SHA-256 fingerprints (`eoa_` access, `eor_`
refresh; a replayed refresh or code revokes the whole
authorization), tables from migration 0023, families always bounded by
`mcp.tokens.tools_enabled` / `tools_families`. `mcp.oauth.*` policy, re-read
live: `enabled` (true), `dcr_enabled` (true), `access_ttl_s` (3600),
`refresh_days` (30, bounded by `mcp.tokens.max_days`). Admin console › MCP tools:
settings and registered clients (deletion); Settings › Access tokens:
apps authorized by the account (removal).

**Execution policy and live events.** Each tool
carries ``meta.policy`` (``timeout_s``, ``serial``, ``replay_safe``, ``prune``,
``deny_for``) via ``_toolkit.tool_kw_*(…, **policy)`` / ``with_policy``; the
harness reads it at connection (``_mcp_categories.tool_policy``) and uses
the old by-name lists only as a fallback (external server, empty registry). The
live terminal travels as **structured** MCP notifications
(``ctx.log(…, logger_name="elpis.shell", extra={"kind": "shell_output", …})``,
correlated by ``log_token``/``call_id`` in ``extra``); the JSON sentinel
``__shell_output__`` is only a fallback now. A **heartbeat**
(``extra.kind: heartbeat``, every ``ELPIS_TOOL_HEARTBEAT_S`` s, default 15,
0 = off) keeps the HTTP stream of a long ``tools/call`` alive (shell, skill
scripts, ``pw_wait``, ``desktop_wait``); the client consumes it without an event.
``skill_run_script`` streams its output like ``execute_shell``.

**Relocatable tool host.** The tool host (``apps/toolhost``, Node bundle
``apps/toolhost/dist/main.mjs``) = the MCP service + the sandbox API (``/api/sandbox/*``, git, lifecycle, snapshots),
the terminal (``/api/terminal/*``, ``/ws/terminal*``) and the assets (screenshots,
frames) on ONE port, behind the service token and a signed identity
envelope (``X-Elpis-Identity``, ``packages/securite/src/identite.ts``). Local mode:
``./elpis start`` launches it on loopback, the app serves its routers directly
(no relay). Remote mode: ``mcp.json › sandboxHosts.<id>.url`` off loopback
(or ``relay: true``) → the core relay (``apps/core/src/relais/``) relays these
paths as they are to the host (HTTP + WebSocket), builds the envelope from the
session (never from a browser header), pushes the skills mirror
(``POST /api/sandbox/skills-mirror``), brings back screenshots/frames for vision and
opens the file-history session at sign-in (``POST /internal/file-history/session``).
With a ``toolhost.json`` (remote host), the host does not open ``app.db``: identity by envelope/``_meta``
(``IdentityCapture``), ``/api/internal/*`` callbacks (introspection of ``pcr_``
tokens, identity, git credentials; for the ``desktop`` family served by the TS host:
automation-finished notification and anchor memory, account taken from
the signed identity envelope) with the service token, LOCAL database
(``toolhost.json › db_path``) for its terminal sessions and the AX memory. The site
passwords of that memory are encrypted there with the host's master key, the only reader:
``APP_ENCRYPTION_KEY``, ``app.encryption_key``, otherwise ``.encryption_key`` created next to
its database on the first save (back it up with the database). Without a key the password is
not kept and the session still opens; with a lost or changed key it must be given again.
Rows saved before this version are not converted: those keyed by a bare site (without a scheme)
are never read again but keep their password in clear until the site is deleted from the AX memory.
ACCOUNT-bound families (``memory``, ``todo``, ``chart``, ``skill`` = library)
= ``role: app`` manifest entries, served by main, never by a remote
host (they write to its database); ``skill_run``
(execution in the sandbox) stays on the host. Deployment:
``deploy/toolhost/`` (``install_toolhost.sh``, ``toolhost.example.json``,
``elpis-toolhost.service``,
``Caddyfile.toolhost``), schema
``docs/schemas/toolhost.schema.json``. ``toolhost.json › bind.host`` is
``127.0.0.1`` in the example: the app reaches the host through ``Caddyfile.toolhost``
(TLS, ``reverse_proxy 127.0.0.1:8765``). Without this front end, ``0.0.0.0`` (or the private
IP) is needed, with the port filtered to the Elpis host. ``app.memory_dir`` / ``APP_MEMORY_DIR``:
root of the memory store (default: the sandbox root). **Upgrade**: the tool
host, local or remote, is upgraded with the core (like the browser service):
it strips the invisible joiner (U+2060) that the core slips into the turn markers of
results, from the arguments of the tools it serves (``identity: "meta"``), which the core sends
it exactly as the model wrote them; an older host would write this joiner into
files, commands and pages.

**TypeScript tool host.** The ``toolhost`` service of
``./elpis`` (unit ``elpis-toolhost``) is the Node bundle ``apps/toolhost/dist/main.mjs``;
it reads ``toolhost.json`` and the ``LOCAL_MCP_*`` / ``TOOLHOST_*`` variables (schema
checked at startup, deviations logged, never blocking) and, after a ``SIGHUP``,
stops cleanly then exits with 75 to be restarted, like the core. It serves
itself the families of ``families`` ported to TypeScript (``browser``,
``desktop``, ``fs``, ``git``, ``office``, ``shell``, ``skill_run``): ``/mcp/<family>`` and ``/sse/<family>`` of these families, same
tokens, scope and delegation; ``/health`` and ``/manifest`` aggregate them. To not
serve a family, remove it from ``families``. The old ``familles_natives`` key is
ignored with a warning (elpis-tools no longer exists); ``./elpis doctor`` shows
the families served (``main.mjs --familles-natives``).
Native ``office`` family: the host launches a shared Python worker (``python -m elpis_office``
from ``office/``, restarted on the next call if it disappears) that builds Word and
PowerPoint documents in memory; sandbox files, history, the editor lock, charts
from the core's cache, LibreOffice (``office_preview``) and ECharts rendering are done by the host.
``ELPIS_OFFICE_PARALLELE`` bounds the worker's simultaneous calls (8 by default).
Native ``skill_run`` family: the account's skills are read from its protected store
(``skills.user_dir``, local host) or, failing that, from the mirror
``<sandbox_dir>/<account>/skills`` that the app pushes after every change (remote
host); an old store left on a remote host by the Python core takes precedence over the
mirror: delete it.
Native ``git`` family: the network (clone, fetch, pull, push) goes through the authenticating
relay, and a Git connector's token is given only to the repository's exact host;
``git_submit`` pushes the agent branch then asks the core for the PR
(``POST /api/internal/git/pr``, account of the signed envelope), which resolves the
connector, keeps its ``api_base`` and calls the PR API: this API's token
never leaves the core. Core unreachable after the push: error
``pr_service_unavailable`` (branch pushed, PR to reopen); ``git_set_credential``
and the token entered at clone time are stored by the core
(``credential_store_unavailable`` if it does not answer). With this native family,
an agent tool creates a connector only for a host (port included) already
registered by the account or by an administrator: otherwise ``host_not_registered``,
and the connector is added in Settings → Git accounts; it updates only the
connectors it created (``auto``), never a connector entered in Settings or
imported (``connector_exists``); an old
``.git-credentials.json`` in the sandbox follows the same rule (kept if a host is refused);
the editor's clone has no such limit.
``TOOLHOST_APP_URL`` points to the local core (``http://127.0.0.1:8001``, set by
``./elpis`` unless a value is already in the environment): without the core URL, the
``/api/internal/*`` callbacks are inactive (``shell_job`` answers ``not_available_here``,
git credentials, PR, quota and notifications are ignored). An MCP request that no
native family takes answers 503 (``/sse`` is served only if ``sse`` is in
``bind.transports``). ``mcp_upstream`` and ``mcp_upstream_sse`` (or
``TOOLHOST_MCP_UPSTREAM[_SSE]``), which designated elpis-tools, are ignored with a
warning: the ``tools`` service no longer exists, and ``./elpis service install`` and
``install_toolhost.sh`` remove its unit. The core opens one MCP connection per
family (``/mcp/<family>``) to a multi-family ``toolhost`` entry and
merges their tools in canonical order; a dropped family is reopened alone,
and an unreachable family is removed without depriving the others and listed again 15 s later.
The old Python host (``python -m toolhost``) no longer exists since 0.1.0:
``ELPIS_TOOLHOST=python`` in ``.env`` is ignored (``./elpis doctor`` flags it).
**Build**: ``npm run build`` (core and host); node-pty, which has no prebuilt Linux
binary, is compiled by ``npm ci`` (build-essential, python3: apt group
``construction-hote``); the offline package from ``make_release.sh`` contains the
host bundle for its architecture (``toolhost/``). ``./elpis doctor`` checks
the bundle (``main.mjs --empreinte``, ``--natif``) and the import of the Office engine.

**Several tool hosts.** ``mcp.json › sandboxHosts`` can
declare N hosts; ``placement.strategy`` = ``single`` (everyone on
``placement.host``) or ``by_user`` (table ``sandbox_placements``: an account is
assigned on first use to the least loaded host, then stays there —
sandbox, terminal and tools on the same host). Admin console → Sandbox →
"Tool hosts": health of each host (``/health``), assigned accounts,
reassignment and MIGRATION of an account (``/api/sandbox/export`` of the old
host → ``/api/sandbox/import`` on the new one → reassignment; a snapshot
of the replaced ``/work`` is taken first, and the import is refused if one cannot
be taken). Routes:
``GET /api/admin/toolhosts``, ``POST /api/admin/toolhosts/placements/{uid}``
(``{host_id}``), ``…/migrate``, ``DELETE …``. Adding a host = one
``sandboxHosts`` entry in ``mcp.json`` + ``toolhost.json`` on the machine.
Deleting an account with its sandbox (``DELETE /api/admin/users/{id}?delete_sandbox=true``)
also deletes the one on a remote host, through that host's internal route
``POST /api/internal/sandbox/delete`` (signed envelope, never relayed),
before the local folder; an enforced network profile destroys the container on the account's host.
Every account deletion also calls ``POST /api/internal/account/purge`` on
each declared host (same signed envelope): the site credentials in the account's AX memory
are removed from the host's database. A host that is unreachable or has no token is
flagged in the response's ``hosts_purge_errors`` and in the log: its credentials
must then be removed before recreating an account with the same name.


| Variable | Default | Description |
|---|---|---|
| `MCP_TOOLS_CACHE_TTL_SEC` | `360` | TTL of the `list_tools` cache |
| `MCP_SERVERS_DIR` | `../mcp_custom_servers` | Uploaded servers |
| `LOCAL_MCP_URL` | derived (`http://127.0.0.1:8765/mcp`) | Tool host address (`…/mcp` = streamable HTTP, `…/sse` = SSE); the app never launches it as a subprocess |
| `LOCAL_MCP_HOST` / `LOCAL_MCP_PORT` / `LOCAL_MCP_TRANSPORT` | `127.0.0.1` / `8765` / `sse` | Used **by** the server in service mode (`./elpis start`: `streamable-http`) |

| `LOCAL_MCP_TOKEN` | — | App **service** token (Bearer, **verified** on the server side over SSE/HTTP); `./elpis configure` generates it in `user_db/.local_mcp_token` |
| `LOCAL_MCP_CLIENT_TOKENS` | — | Tokens of **external clients** configured by hand, each tied to an account: `tok1:alice,tok2:bob` (all families) |
| `LOCAL_MCP_TOOL_FAMILIES` | `all` | Registered families: `fs,shell,git` or `all,-desktop,-browser` |
| `MCP_TOOL_MAX_CONCURRENT` | `48` | Simultaneous tool calls on the service, all accounts combined (`0` = no cap) |
| `MCP_TOOL_MAX_CONCURRENT_PER_USER` | `12` | Simultaneous calls of a single account (`0` = no cap); a call with no identity counts only in the total |
| `MCP_TOOL_QUEUE_WAIT_S` | `30` | Maximum wait for a slot; beyond it (or with a full queue: twice the total cap, and no more waiting calls per account than its cap) the tool answers with an error the model can read. Short on purpose: a call abandoned by the app (Stop) but still queued would run in its place |
| `MCP_TOOL_THREADS` | `64` | Service threads for synchronous tools and its HTTP routes (anyio default: 40); keep 8 more threads than `MCP_TOOL_MAX_CONCURRENT` |
| `LOCAL_MCP_LIST_PAGE_SIZE` | `100` | Tools per `tools/list` page (pagination by `cursor`) |
| `LOCAL_MCP_ALLOWED_ORIGINS` | *(empty)* | Browser origins allowed in addition to `mcp.allowed_origins` and `app.cors_origins` (comma-separated, `scheme://host:*` accepted) |
| `LOCAL_MCP_OPENCODE_FAMILIES` | `git,browser,desktop` | Families **published** to opencode, one **MCP entry (= one toggle) per family** → `…/mcp/<family>`. Inclusion list: a family added later must be named to appear |
| `LOCAL_MCP_OPENCODE_EXCLUDE_FAMILIES` | `fs,shell,office,skill_run` | Families **always refused** to opencode clients (elpis-remote token `pcr_…`, accepted as Bearer) — opencode has its own file/shell tools; these families act on the host's sandbox |
| `LOCAL_MCP_PUBLIC_URL` | — | Service URL as workstations reach it (`mcp` block of `opencode.json`); empty → app host + `LOCAL_MCP_PORT` |
| `TOOL_TEXT_BUDGET` / `TOOL_LIST_BUDGET` | `6000` / `50` | Tool output budgets (characters of a text / items of a paginated list) |

> **MCP auth.** As soon as a token is configured, the shared service
> requires `Authorization: Bearer …` (FastMCP `StaticTokenVerifier`). The service
> token lets the `meta` (username/chat_id) be authoritative; a client token
> imposes the identity of the account tied to it. **With no token at all, the server
> refuses to bind off loopback.** External clients (opencode: `type: "remote"`,
> URL `…/mcp`, Bearer header).

#### Satellite services

| Variable | Default | Description |
|---|---|---|
| `PLAYWRIGHT_API_URL` | `http://localhost:3000` | Browser service (app side) |
| `FIREFOX_SERVICE_PORT` | `3000` | Browser service listening port |
| `BROWSER_SERVICE_TOKEN` | — | Browser service token (Bearer). Without it, `BROWSER_SERVICE_TOKEN_FILE`, then `user_db/.browser_service_token` (written by `./elpis configure`, read by the service, the core and the tool host). Without any token, the service only accepts direct local calls; an unreadable token file makes it refuse every call (503). A remote tool host passes the token in this variable |
| `PW_STATE_MAX_AGE_D` | `30` | Days to keep a saved browser state (`save_state`) after it is saved or attached, even if it is in use; `0` = never deleted. Read at browser service startup (`.env`). States from before 0.0.1, with no account, are never purged: see [operations.md](operations.md#upgrading) |
| `PW_ARTIFACT_MAX_AGE_H` | `24` | Hours to keep browser downloads, HAR files, videos and traces; `0` = never deleted |
| `PLAYWRIGHT_HEADLESS` / `PLAYWRIGHT_TIMEOUT` / `PLAYWRIGHT_VISION` | `true` / `10` (s) / `false` | Playwright options |
| `APP_VISION_ENDPOINT_URL` / `APP_VISION_FORMAT` / `APP_VISION_MODEL` | — / `omniparser` / — | Visual annotation endpoint |
| `APP_VISION_PASSES` / `APP_VISION_TIMEOUT_SEC` / `APP_VISION_PROMPT` | `2` (1-3) / `30` (5-300) / — | Passes, timeout, annotation prompt |
| `APP_DESKTOP_*` | see `config.py` | Control agents: timeouts, observation scope, capture format, caps |
| `DESKTOP_AGENT_TOKEN` | — | Token sent to desktop agents (`Authorization: Bearer`) when the machine has no `agent_token` of its own (`desktop.targets[].agent_token`, Admin console › Vision & machines, reloaded live). On the controlled machine: `DESKTOP_AGENT_TOKEN` or `agent_token.txt`, generated by the agent installation; with no token or file, the agent generates `agent_token.txt` at startup and writes the token in its log; `DESKTOP_AGENT_INSECURE=1` makes it start without a token. Administrators can see the token in the console (field masked at input only) |
| `OPENCODE_DIST_DIR` | `cli_dist/` | OpenCode binaries served on the LAN |

#### Resilience and locks

| Variable | Default | Description |
|---|---|---|
| `LLM_BREAKER` | `1` | LLM circuit breaker (`0` = disabled) |
| `LLM_BREAKER_FAILS` | `5` | Consecutive transport failures before opening |
| `LLM_BREAKER_COOLDOWN_S` | `15` | Fail-fast duration |
| `SKILLS_FILELOCK` | `1` | Cross-process file lock (`elpis.verrou.v1.1`) for skill writes |
| `ROUTINES_PER_USER_CAP` | `5` | Simultaneous runs per user |
| `ROUTINES_RUN_MAX_ATTEMPTS` / `_RETRY_BACKOFF_S` | `2` / `3.0` | Bounded retry of a run |
| `PTY_MAX_PER_USER` | derived | Terminals per user |

### Controlled browser: allowed destinations

The browser service (`browser-service/`, `pw_*` tools) reaches only
`http` and `https` addresses (plus `about:blank`). All its traffic — navigation,
redirects, subresources, WebSocket — goes through a local relay that
resolves each name itself and connects only to the address it has judged.
Refused: loopback, link-local (including metadata
addresses), addresses belonging to the Elpis host, and container
networks. The local network is allowed by default (intranet). Optional
allowlist, re-read live: `browser.url_allowlist` in
`config.json` (or `BROWSER_URL_ALLOWLIST`, separated by commas or
spaces) — exact hosts, `*.domain`, IP addresses or CIDR blocks; when set, it
restricts the LOCAL NETWORK to the hosts and networks it names (public
destinations stay reachable, and the refusals above stay
absolute). Sessions, saved states,
downloads and visual references are filed per account; at most 3
sessions per owner (`BROWSER_MAX_SESSIONS_PER_OWNER`), at most 4 for an account and
its subagents together (`BROWSER_MAX_SESSIONS_PER_GROUP`, never below the per-owner
quota), 10 in all for accounts (`BROWSER_MAX_SESSIONS`) and, separately, 6 in all for
subagents (`BROWSER_MAX_CHILD_SESSIONS`): a subagent never takes an account's place;
a new session never closes
another account's session, nor the account's or a sibling's session when a subagent
is the one asking. Each `task` subagent that drives the browser has its own private session, which
counts toward its account's group quota, with one place left for the chat's session:
the chat and three `web` agents fit in the four places by default, and a batch that contains a `web`
agent launches only three at a time. At the quota, startup is refused with the error `browser_quota` (with
its `fix`, readable by the model), and the launch of a `web` agent is refused even before it
tries (`task_unavailable`). Raise `BROWSER_MAX_SESSIONS_PER_GROUP` (simultaneous `web` agents
+ 1 for the chat's session), and `BROWSER_MAX_CHILD_SESSIONS`
if several accounts launch `web` agents in parallel.
Restart the service together with the core. A service or tool host older than the
core does not know the group quota (each child counts separately) or the
safe closing of a child's sessions: upgrade them together.

⚠ **Upgrade**: an automation that navigated to `localhost`,
the host's address or a local container is now refused.

### Image generation

A single engine, set in Admin console › Models & services › Images
(`config.json › image`, re-read live):

| Engine | API | Queue and stop |
|---|---|---|
| `sdcpp` | stable-diffusion.cpp `sd-server`, `/sdcpp/v1` (`capabilities`, `img_gen`, `jobs/{id}`) | sd-server queue, position displayed; Stop cancels a queued job, a job already started is abandoned and its result ignored |
| `openai` | `POST /v1/images/generations` and `/v1/images/edits` (LocalAI, sd-server in OpenAI dialect, gpt-image…) | `max_concurrent` generations at a time, all workers combined (file locks in the run directory) |

- **One model per process** on the sd-server side: changing the model means
  changing the address. "Test" reads the announced limits (`capabilities`).
- **Sizes**: `free` = width × height in multiples of 64, longest side
  ≤ `max_side`; `fixed` = closed `sizes` list (OpenAI models, default
  1024x1024, 1536x1024, 1024x1536). sd-server is always `free`, and
  `max_concurrent` applies only to an OpenAI service.
- **TLS**: system certificate store, plus the authority pasted into
  `ca_pem` (internal PKI). `verify: false` is for testing only.
- **API key**: encrypted (Fernet) in `api_key_enc`, written by
  `PUT /api/admin/image/key`, never sent back. It is tied to the engine's
  address (scheme, host and port): after changing the address to
  another machine, enter it again (the console says so). A test against
  another address uses only the key entered in the form.
- **Access**: `enabled` and an address; `groups` (ids, empty = everyone,
  administrators always allowed) is checked on every turn and on every
  call of the `generate_image` tool. Each account can then turn off
  "Images" and "Images by the model" in its Settings.
- **Model tool**: at most `tool_max_calls` calls and `max_n` images per
  turn, refused in plan mode.
- **Storage**: `user_db/generated_images/<account>/` (database folder),
  relative paths in the database, WebP thumbnails; the `keep_per_user` most
  recent images of each account are kept (never fewer than the batch just
  produced). Deleting a conversation or an account deletes its
  images; images from an ephemeral session are kept for one day. Daily
  maintenance sweeps orphan files and rows whose
  file is gone, and applies retention to all accounts. Images
  are included in `./elpis backup` (scopes `full` and `db`), with
  `user_db/` or separately if the database is elsewhere.
- ⚠ **Several hosts** on the same PostgreSQL database: each file
  stays on the host that wrote it.

### `context_config.json` — text injected into the LLM

Goal: **no text meant for the model should be a frozen Python
literal**. `packages/config/context_config.json` centralizes prefixes, headers,
separators, error catalog and budgets. Loaded once at boot.

Conventions:

```jsonc
"key": ""                    // empty → the caller keeps its fallback (historical behavior)
"key": {"file": "x.md"}      // content read at boot
"key": {"inline": "..."}     // inline text
"key": "text"                // direct text
// key missing               → caller's fallback
```

Sections: `budgets`, `tools.<name>.enabled` (per-tool kill switch),
`system_prompt`, `assembly`, `skills`, `memory`, `compression`, `context`,
`vision`, `result_formatting`, `model_profiles`, `errors` (overrides
`message`/`fix` per tool error code).

> ⚠️ `tool_gating.gated` (hiding categories by keywords) is **inert**:
> its only caller never passes `keywords_text`, because a tool set
> varying from message to message would invalidate the KV prefix cache. The function is
> tested but not wired; a warning is emitted at boot if the map is not
> empty. Only `tools.<name>.enabled` is wired.

### Resolution priority and hot reload

1. Environment variable (if set and **non-empty**)
2. Value in `config.json`
3. Default coded in `config.py`

Relative paths are resolved from `PROJECT_ROOT`.

**Three classes of settings**, not to be confused:

| Class | Mechanism | Examples |
|---|---|---|
| **Frozen at import** | Module-level constant of `config.py` | Subagent budgets, LLM timeouts, skill limits |
| **Re-read on every call** | Helper that reads the file | `feature_enabled()`, `https_enabled()`, `https_ports()`, `session_cookie_attrs()`, `max_recent_chats()`, `live_config_value()` |
| **Hot reload with mtime cache** | `reload_*_from_disk()` | `COMPRESSION_*`/`PRUNE_*`, `VISION_*`/`DESKTOP_*`, `MEMORY_*` |

> ⚠️ **Multi-worker trap.** Mutating a module-level constant from an admin
> endpoint changes the state only of the worker that received the POST. For any setting
> editable from the admin and read at runtime, use
> `live_config_value()` (source of truth = the file) or a
> `reload_*_from_disk()`.

[↑ Contents](#contents)

---

## Multi-process: main / admin split

| Aspect | main (8001) | admin (8002) |
|---|---|---|
| Mounted routes | Everything except `/api/admin/*` and `/admin` | `/api/admin/*`, auth, system-events, public-config, password change, `/admin` |
| Linux user | unprivileged | unprivileged, never root |
| HTTP surface | large | reduced |
| Schedulers | routines, maintenance, backups, sampler | sampler only |
| MCP prewarm | yes | no (the first tab opening pays ~500 ms) |
| Cookie | HOST-scoped — valid on both ports | same |

The core mounts its route families according to `APP_MODE` (missing or invalid:
`main`). Isolation happens **at mount time**: with `APP_MODE=main`, the
administration routes never enter the routing table.

Since cookies are HOST-scoped (not port-scoped), a session created on `:8001` is valid on
`:8002` — provided both processes share `APP_SESSION_SECRET`.

The front end's "Admin" button redirects to `ADMIN_PUBLIC_URL`; "Back to chat"
goes to `MAIN_PUBLIC_URL` (read from `/api/public-config`, with
automatic rewriting of `localhost` for a remote client).

---

## Core processes

The TypeScript core runs as **one process per mode** (`apps/core/dist/main.mjs`:
`APP_MODE=main` on 8001, `APP_MODE=admin` on 8002), without workers: the
Gunicorn configs and `uvicorn_worker.py` were removed along with the core's Python.
`SIGTERM`, `SIGINT` and `SIGHUP` trigger a graceful shutdown (generations in
progress up to 300 s); after a `SIGHUP`, the process exits with 75 to be
restarted by `./elpis` or systemd. The listening address follows the rule in [Listening](#listening-securitylisten)
(`BIND` takes precedence).

---

## HTTPS: Caddy front end

See [`deploy/caddy/README.md`](../deploy/caddy/README.md) for details.

```
browser ──https──▶ Caddy (same host, catch-all) ──http 127.0.0.1──▶ services
   :443  ────────────────────────────────────────▶ 127.0.0.1:8001  (main)
   :8443 ────────────────────────────────────────▶ 127.0.0.1:8002  (admin)
   :80   ─ redirects 302 to https + serves /ca.crt
         └ EXCEPTION @bootstrap: installers served IN CLEAR ─▶ :8001
```

Design points:

- **Stable 10-year openssl PKI**, not Caddy's `tls internal` (which rotates
  its certs every 12 h → the browser warning would keep coming back).
- **Catch-all sites**: any IP/name reaching the machine works.
  Main and admin share the hostname (different ports) → the host-scoped cookie
  stays shared.
- Caddy runs **permanently**; switching HTTPS ↔ direct HTTP is done from
  the admin console, which writes `security.https.enabled` then restarts the core
  (`SIGHUP`, restart by `./elpis` or systemd), which re-reads the flag at startup. An **anti-lockout
  guard** probes the ports before cutting off direct access.
- `@bootstrap`: the install routes stay in clear text on `:80` — the
  target machine does not know the CA yet. See
  [CLI distribution](architecture.md#cli-distribution--opencode-lan).

### `security.https` belongs to the toggle, and to no one else

The bind (`127.0.0.1` in HTTPS mode) is the only barrier: `security.https`,
`session.https_only` and `session.global_min_ts` belong to their endpoint,
and the "Main config" editor never rewrites them
(`apps/core/src/admin/config.ts › OWNED_PATHS`), otherwise a stale
copy of the form would reopen the public bind at the next restart.

Worth knowing:

- You **do not enable** HTTPS from the raw editor — only the toggle probes
  Caddy before writing (anti-lockout guard).
- The **RAG extractor (`:8000`)** has no Caddy site: it listens on
  `127.0.0.1` whatever the toggle says (`RAG_HOST` for a core on another
  machine). After an upgrade, `sudo deploy/caddy/install_caddy.sh` removes
  the old `:8444` site.

---

## Tracing and multi-user debugging

Each LLM request gets a traced identifier `[LLM_REQ xxxxxxxx]`.

| Event | Format |
|---|---|
| Start (plain chat) | `[LLM_REQ a1b2c3d4] START user='alice' model='GLM-4.7' thinking=… msgs=12 prompt_chars=3421 …` |
| Start (tool call) | `[LLM_REQ a1b2c3d4] START_TOOLS user='alice' model='GLM-4.7' n_tools=15 msgs=12 prompt_chars=…` |
| Slot | `[LLM_REQ a1b2c3d4] SLOT=2 assigné (user='alice')` (if the server exposes `id_slot`) |
| End (plain chat) | `[LLM_REQ a1b2c3d4] END user='alice' content_chars=… thinking_chars=… in_tok=1849 out_tok=425 resumes=0` |
| End (tool call) | `[LLM_REQ a1b2c3d4] END_TOOLS user='alice' n_tool_calls=2 content_chars=… in_tok=… out_tok=… finish=tool_calls` |
| Failed attempt | `[LLM_REQ a1b2c3d4] attempt=1 failed: …` |
| Cancellation | `[LLM_REQ a1b2c3d4] CANCEL mid-stream → fermeture stream` |

`stream_options.include_usage: true` is added automatically to streaming
requests — without it, `in_tok`/`out_tok` stay at 0. (The log lines are printed in French as shown: `assigné`, `fermeture stream`.)

```bash
./elpis logs main -f | grep a1b2c3d4         # one request
./elpis logs main -f | grep "user='alice'"   # one user
```

**LLM traffic.** If `llm.debug.enabled` (default `true`), every app ↔ engine
exchange (request + response, thinking excluded) is logged in the
`llm_calls` table (bounded ring, capped payloads) and can be viewed through the
administration API (`GET /api/admin/llm-traffic`); the console has no dedicated
view.

**Live logs.** Admin console → Monitoring → Logs: last 300 entries (server
ring buffer) then an SSE stream. `GET /api/admin/logs/recent` + `GET /api/system-events`.

[↑ Contents](#contents)

---
