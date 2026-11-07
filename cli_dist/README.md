# cli_dist — OpenCode artifacts served on the local network

This folder is served by the app through `/api/cli/bundle/{os}` so that machines on the
**local network** can install/download **OpenCode** *without Internet*
(chat menu → "OpenCode").

## How to populate this folder

Drop **one artifact per OS** here, named `opencode-<os>.<ext>`:

| OS | File name (examples) |
|----|---------------------------|
| Linux   | `opencode-linux.tar.gz` |
| macOS   | `opencode-macos.tar.gz` |
| Windows | `opencode-windows.zip`  |

- `<os>` ∈ `linux` \| `macos` \| `windows`.
- The extension is free (`tar.gz`, `zip`, or even a raw binary): the installer
  detects the format at run time. Only one `opencode-<os>.*` file per OS.
- The binary inside must be named `opencode` (or `opencode*.exe` on Windows).

Fetch the binaries from https://opencode.ai (releases) on a connected
machine, then copy them here on the server.

## llama.cpp config — generated on the fly (no more stale static file)

The shipped artifacts (`opencode-linux.tar.gz`, `opencode-windows.zip`, **opencode
v1.18.16**) contain **the binary + a fallback `opencode.json`** + a
`README-Elpis.txt`. But at installation the config is now **generated
dynamically by the server** (`GET /api/cli/opencode.json`) from the app's LIVE state:
`baseURL` of the current llama.cpp (`config.json › llama`) + the **real model
list** (`/v1/models` cache). Since opencode does NOT auto-discover models, this is what
avoids an obsolete model map. Fully offline fallback to the embedded `opencode.json`
if the server is unreachable (embedded openai-compatible provider,
`autoupdate`/`share` off, no key).

- **Installed via `install.sh` / `install.ps1`**: the fresh config is written to
  `~/.config/opencode/opencode.json` (**overwrite + `.bak` backup** of the old one),
  and the binary (`~/.local/bin` / `%LOCALAPPDATA%\opencode`) is **added to PATH
  automatically** (shell rc / Windows user PATH, idempotent).
- **Re-sync the config only** (after a model change on the server side):
  `curl -fsSL http://<LAN>/api/cli/opencode.json -o ~/.config/opencode/opencode.json`
  (clear-text bootstrap path — see "Certificate" below; no more `-k`).
- **Elpis tools in opencode (`mcp` block, 2026-09-03)**: once the account is connected, the installer
  fetches the config again WITH the elpis-remote token
  (`x-elpis-token`) — the server adds **one MCP entry per tool family**
  (`elpis-git`, `elpis-browser`, `elpis-desktop` → `…:8765/mcp/<family>`, Bearer =
  the same token as the `/remote` plugin) if its tools service is shared and
  authenticated (`LOCAL_MCP_URL` + `LOCAL_MCP_TOKEN`, see `./elpis start`).
  One entry = **one toggle** in opencode (its "MCPs" box has no
  finer granularity). Published families: `LOCAL_MCP_OPENCODE_FAMILIES`
  (default `git,browser,desktop` — opencode already handles the rest); **fs/shell**
  stay refused on the server side (`LOCAL_MCP_OPENCODE_EXCLUDE_FAMILIES`).
  The user picks their families in the app's OpenCode modal: that choice
  is rendered as `"enabled": true|false` and **survives the re-sync**, unlike
  the toggle in opencode's TUI (connect/disconnect, never written to the file).
  Re-sync with a token:
  `curl -H "x-elpis-token: $TOKEN" https://<app>/api/cli/opencode.json -o ~/.config/opencode/opencode.json`.
- ⚠️ **`limit` must carry `context` AND `output`.** The opencode schema requires
  both: with `context` alone, opencode REJECTS the whole file
  ("Missing key provider.elpis.models.\<id\>.limit.output") and the `elpis`
  provider disappears. And `output` must stay SMALL compared to `context`: opencode
  compacts as soon as `context − output` is reached (`_output_limit` in
  `apps/core/src/familles/cli.ts`: one eighth, bounded to [2048, 16384]).
- **Downloaded manually**: run opencode from the extracted folder (it reads the
  neighboring `opencode.json` = fallback version), or copy the file generated above.
- **Change the default model**: `config.json › opencode.default_model` (validated
  against the live roster; or edit `model` in `opencode.json`).
- **Regenerate a package**: take opencode.ai's raw asset
  `opencode-<os>-x64.(tar.gz|zip)` and add `opencode.json` (fallback) + `README-Elpis.txt` to it.

## `elpis-remote` plugin — sessions in the "Code" page

The installer **offers** (`y/N` choice, overridable with
`ELPIS_INSTALL_PLUGIN=y|n`; default `y` if a token is provided) the
**elpis-remote** plugin — **native TypeScript** (opencode/Bun loads `*.{ts,js}`
without a build): `~/.config/opencode/plugin/elpis-remote.ts`, served by
`GET /api/code/plugin.ts` with the app URL baked in (source:
`apps/core/greffon-opencode/`). Declining the plugin **removes** any plugin
already installed. `GET /api/code/plugin.js` now only serves a migration shim
for old `.js` files (≤ v8) that run `/remote update`.

The install command copied from the modal (connected session) embeds
`ELPIS_REMOTE_TOKEN=<user's token>` as an env variable in the pipe (never in
the URL or the access logs); the script writes `~/.config/opencode/elpis-remote.json`
(`enabled` preserved on reinstall, local CA pinned or `insecure` fallback if
the app is behind Caddy https). Then, in opencode: a plain **`/remote`**
turns reporting on — the session appears in the "Code" page, history
included, tied to the right user, and can be **driven** from the app
(prompts, interrupt). `/remote` toggles on/off, `/remote status` shows
the state; `/remote <token>` is still available (manual install / regenerated token).

## Endpoints (public, gated by the admin flag `features.opencode`)

- `GET /api/cli/install.sh`  — bash install script (rendered with the current LAN URL)
- `GET /api/cli/install.ps1` — PowerShell install script
- `GET /api/cli/bundle/{os}` — downloads the OS artifact
- `GET /api/cli/opencode.json` — config generated on the fly (current models + endpoint)

## Config

- Folder configurable through env `OPENCODE_DIST_DIR` or `config.json › opencode.dist_dir`
  (default: this folder `<repo>/cli_dist`).
- Enable/disable in **Admin console › Configuration › System › Features › OpenCode**.

## Startup: why opencode took 30 s to 1 min 30

As soon as **a plugin** is present, opencode runs `npm install
@opencode-ai/plugin` in **each config folder** and **blocks plugin
loading** on it (`config.ts › waitForDependencies`) — and so the display. Measured
here: **30 s** (1.17.7) and **71 s** (1.18.16) on first launch *with* Internet;
**never finished** when the network does not answer (firewall that drops) — which is
the normal case of a LAN deployment without Internet.

opencode skips the install entirely if `node_modules` exists **and** the lock
declares the dependency (`packages/core/src/npm.ts › install`). The installers
therefore create three artifacts, **without downloading anything**:

```
~/.config/opencode/node_modules/        (empty folder)
~/.config/opencode/package.json         { "dependencies": { "@opencode-ai/plugin": "<version>" } }
~/.config/opencode/package-lock.json    packages[""].dependencies: the same
```

Startup measured with the network cut: **8.6 s** instead of "never". An already
populated `node_modules` is **never** touched.

⚠️ A project that has its own `.opencode/` folder pays the same cost the
first time (opencode also installs inside it): create the same three
artifacts there, or run opencode once with Internet.

## Self-signed certificate (HTTPS front end)

Assumed model on a LAN without Internet: **bootstrap happens in clear, then the
app's CA is installed on the machine**. The certificate keeps its role and there is
no `-k` anywhere.

- **Two sources**: `http://<host>/ca.crt` (Caddy `:80`) and
  `GET /api/cli/ca.crt` (served by the app — covers deployments without a `:80`
  front end, the only case where the installer stayed on `-k`). The content is verified (real
  PEM) before any use, and stored in `~/.config/opencode/elpis-ca.crt`.
- **Installation on the machine by default** (`update-ca-certificates` /
  `update-ca-trust` / `Cert:\CurrentUser\Root`) → `curl`, `git` and the browser
  talk to the app over verified https. Opt-out: `ELPIS_TRUST_CA=n`. Without
  administrator rights, the script prints the exact command to replay.
- **Pinning kept** (`elpis-remote.json › ca_file`, `--cacert`): ⚠ Bun
  does **not** use the OS store, so the plugin needs the explicit path.

The unverified fallback remains only if no CA is reachable, and it is
announced explicitly.

> The binaries are **not** versioned (see `.gitignore`): the administrator
> drops them in this folder before enabling the feature.
