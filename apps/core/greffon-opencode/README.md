# opencode plugin "elpis-remote" (native TypeScript)

Canonical source of the plugin that reports/drives opencode sessions from the
app's "Remote code" page. **No build step**: opencode runs on
Bun and loads `*.{ts,js}` plugins natively (glob verified in the 1.17.x
binary) — the `.ts` is served and installed as is.

| File | Role |
|---|---|
| `elpis-remote.ts` | Canonical plugin (v9+), served by `GET /api/code/plugin.ts`, installed at `~/.config/opencode/plugin/elpis-remote.ts` |
| `elpis-remote-bootstrap.js` | Migration shim served by `GET /api/code/plugin.js`: old `.js` plugins (≤ v8) that run `/remote update` write it in place of their `elpis-remote.js`; at the next startup it installs the `.ts`, delegates the hooks, then **deletes itself** |

`apps/core/src/code/greffon.ts` reads these files at startup, PARSES the version
(`const PLUGIN_VERSION = N`, its single source) and refuses to
start if the shim is out of sync with the `.ts`.

## Rules to follow when changing `elpis-remote.ts`

1. **Bump `PLUGIN_VERSION`** on every behavior change (this is what
   triggers the `/remote update` offer on the CLI side, and the min-version gates
   in `code.py`).
2. Keep the **first line** `// elpis-remote` and the literal
   `const PLUGIN_VERSION = N`: the update flows (v8 on plugin.js, v9+ on
   plugin.ts) validate the response with `startsWith` + regex before overwriting the
   local file.
3. **"Erasable" TypeScript only** (no enum/namespace/decorators) and
   **no imports** outside `node:*` — the file is self-contained, with no node_modules.
4. **Performance budget** (the reason v9 exists — tested by
   `tests/deploy/test_opencode_plugin_files.py` and the smoke test):
   - never a permanent patch of `process.stdout/stderr` or `console.*` — the
     `/remote` anti-dump filter is armed for ~4 s then **restored**;
   - the `event` hook **never** does a network `await` (opencode's event
     bus would wait) — pushes go through the serialized chain;
   - remote inactive ⇒ zero timers, zero fetches, immediate returns.
5. HTTPS: the app may sit behind the Caddy front end (self-signed LAN cert,
   `deploy/caddy`) — `fetch` passes Bun's `tls` option (CA pinned through
   `conf.ca_file`, set by the installer, otherwise a remembered `insecure` fallback).

## Checking

```bash
# types (dev, network required for npm):
npx -y -p typescript tsc --noEmit --strict --target es2022 --module esnext \
    --moduleResolution bundler --skipLibCheck apps/core/greffon-opencode/elpis-remote.ts
# structure + installer (offline, in the suite):
pytest tests/deploy/test_opencode_plugin_files.py
# behavior under Bun (opencode's real runtime):
HOME=$(mktemp -d) bun tests/opencode_plugin/smoke.ts
```
