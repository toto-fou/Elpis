# HTTPS via Caddy (LAN, no domain, "actionless" on the client side)

Elpis is served over plain HTTP directly by the core (`:8001` main, `:8002` admin;
the RAG extractor, `:8000`, listens on localhost only). This folder provides the TLS front end: a local Caddy under
systemd plus a **stable** local PKI generated on the server. No domain,
no Let's Encrypt, and **nothing to install on client machines**.

## Client side: just connect

Users type `https://<ip>` — or even just `<ip>` (port 80
redirects). On the **first** connection, the browser shows the
"connection not secure" warning (unknown local certificate):
**"Advanced" → "Accept the Risk and Continue"**. One click, once
per machine and per port (443, and 8443 for admin) — the certificate is
stable for 10 years, so the warning never comes back.

> Why this single warning is unavoidable: without a public domain,
> no browser can trust a certificate by default —
> that is the PKI model itself, and nothing on the server can work around it.
> Traffic is encrypted in all cases.
>
> This is why we use stable openssl certificates instead of Caddy's `tls internal`:
> the latter rotates its certificates every 12 hours, which
> would bring the warning back at every rotation.

**Optional** — to remove even this first warning (clean padlock):
import `http://<ip>/ca.crt`. Firefox: Settings → Privacy &
Security → Certificates → View Certificates → Authorities →
Import → check "Trust this CA to identify websites".

## Architecture

```
browser ──https──▶ Caddy (same host, catch-all) ──http 127.0.0.1──▶ services
   :443  ─────────────────────────────────────────▶ 127.0.0.1:8001  (main)
   :8443 ─────────────────────────────────────────▶ 127.0.0.1:8002  (admin)
   :80   ─ redirects 302 to https + serves /ca.crt (optional import)
         └ EXCEPTION @bootstrap: installers served IN CLEAR ─▶ :8001
```

Caddy sites are **catch-all**: any IP/name that reaches the
machine works, with no reconfiguration. Main and admin share the same
hostname (different ports), so the host-scoped session cookie stays
shared (a login on the app also works for the admin console).

Caddy runs **permanently**; switching between HTTPS and direct HTTP is driven
from the admin console (System › HTTPS access), which toggles the
core binds `0.0.0.0` ↔ `127.0.0.1` and then restarts the app. With HTTPS mode
off, Caddy keeps running alongside, harmlessly.

## Installation (all on the server)

```bash
sudo ./install_caddy.sh                       # auto-detects IPs
sudo ./install_caddy.sh 10.0.0.7 elpis.lan    # extra SANs if needed
```

The script: installs caddy (see "Offline bundle" below), detects
the IPv4 addresses (`hostname -I`) and the hostname, generates the PKI in
`/etc/caddy/elpis-pki/` (10-year CA, never regenerated; 10-year server cert,
re-issued **only** if the SAN list changes), writes the Caddyfile,
validates it, and starts Caddy. It is idempotent: re-running it never breaks the exceptions
browsers have already accepted.

New LAN IP: re-run the script (the CA does not change;
only machines in "exception" mode will see a warning again,
once).

## Bootstrapping the installers (in clear, on purpose)

The install one-liners (OpenCode, desktop agent) run on a
machine that **does not yet know** the local CA. While they used
https, the command had to disable certificate verification itself:
on Windows, a preamble of about 400 characters (forced TLS 1.2
plus a compiled C# callback) whose failure — always the same message,
"The underlying connection was closed" — depended on the installed
.NET version. Unreadable and unstable commands.

The `:80` site therefore makes an **exception** (the `@bootstrap` matcher): the install
routes, which are public and carry no secret, are proxied in clear
to `:8001` instead of being redirected. Everything else redirects
as before. The commands become simple again:

```bash
curl -fsSL http://<ip>/opencode | bash     # OpenCode (Linux/macOS)
curl -fsSL http://<ip>/agent    | bash     # desktop agent (Linux)
```
```powershell
iex(irm http://<ip>/opencode.ps1)          # OpenCode (Windows)
iex(irm http://<ip>/agent.ps1)             # desktop agent (Windows)
```

The downloaded script then fetches the CA (`http://<ip>/ca.crt`) and
**pins** it in the `elpis-remote` plugin config: whatever talks to the app
afterwards does so over **verified** https — better than the old
`-k` fallback. The trade-off is limited to bootstrapping: on a trusted LAN, a binary
downloaded in clear is equivalent to the old `-k` (neither
authenticates the server), for a command without pitfalls.

> Never add anything to `@bootstrap` that requires a session or exposes a
> secret: it is the only unencrypted door of the front end. The contract is
> locked by `tests/deploy/test_install_bootstrap_contract.py`.

## The `caddy` package: an apt prerequisite

The `caddy` package is an apt prerequisite (`https` group of
[`deploy/prerequis-apt.txt`](../prerequis-apt.txt)): `install.sh --with-caddy`
installs it through apt (Debian 12 and 13 repositories, universe on Ubuntu 24.04;
offline, the LAN mirror or the OS media), then configures it;
`./elpis configure` only configures it. The offline package from
`make_release.sh` does not contain it.

### .deb bundle (manual tool, outside install.sh)

For a machine without a mirror, an administrator can still vendor the
`.deb` files on a connected machine (the dev VM works), **once**:

```bash
deploy/caddy/fetch_caddy_debs.sh    # vendors caddy + deps into deploy/caddy/debs/
```

The `.deb` files then travel with the app folder (gitignored, like
the Python wheels — transfer by copying the folder, not by git clone).
`sudo deploy/caddy/install_caddy.sh`, run **by hand**, detects and
installs them **without network**, installing only what is missing on the target
(never downgrading a base lib that is already present); without a bundle, it
falls back to online apt. openssl is present by default on Debian — nothing
else to plan for.

If the fetch prints "dependency not vendored" (stale apt index →
404): these base libs (libc6…) are present on any
Debian anyway; for a complete bundle, run `sudo apt-get update` and try again.

## Points to watch

- **The core re-reads the bind on restart**: the toggle sends it a
  `SIGHUP`, it exits with code 75, and `./elpis` or systemd restarts it. A core started
  with `BIND` in the env keeps that bind whatever the toggle says.
- **No HSTS, :80 redirect is a 302**: intentional — going back to direct HTTP
  through the admin toggle must stay possible. Do not "harden" it.
- **The `@bootstrap` block must stay BEFORE the catch-all `handle {}`** of the
  `:80` site: `handle` blocks are mutually exclusive and evaluated in
  written order — placed after it, the catch-all would swallow the
  installers and the commands would go back to https (and so be long).
  After updating the Caddyfile: `sudo deploy/caddy/install_caddy.sh`.
- **Never regenerate the CA** (`/etc/caddy/elpis-pki/ca.*`): machines that
  imported it would lose trust. The script preserves it;
  do not delete the folder by hand.
- **Duplicated ports**: `443/8443` exist in the Caddyfile AND
  in `config.json › security.https.{main_port,admin_port}`
  (the toggle's anti-lockout guard + URL synthesis). Keep them aligned.
- **`security.https` belongs to the toggle, and nobody else.** The console's
  "Main config" editor sends back the ENTIRE config.json: without
  safeguards, a save made from a form loaded *before* the
  switch put `enabled: false` back. Nothing showed while the app
  was running (the bind lives in memory); at the next restart the core
  rebound `0.0.0.0` and the app answered in clear on `:8001`/`:8002`
  while Caddy still served https. `apps/core/src/admin/config.ts ›
  OWNED_PATHS` now restores these paths from disk, in both
  directions: **enabling HTTPS through the raw editor does not work either**
  — you need the toggle, which probes Caddy before writing.
- **Break-glass** (app unreachable, e.g. Caddy is dead while HTTPS
  mode is active → loopback binds):
  - either temporarily restart with an open bind:
    `BIND=0.0.0.0:8001 ELPIS_RACINE=$PWD APP_MODE=main node/bin/node apps/core/dist/main.mjs`
    (the `BIND` env takes priority over the toggle);
  - or edit `config.json` (repository root) → `security.https.enabled: false`
    (+ `security.session.https_only: false`) and restart the app.
- **The RAG extractor (`:8000`) has no Caddy site**: only the core
  calls it, on `127.0.0.1` whatever the toggle says (`RAG_HOST` for a
  core on another machine). An upgraded installation keeps the old
  `:8444` site until `sudo deploy/caddy/install_caddy.sh`.
- **Cookies**: HTTP→HTTPS keeps the session; HTTPS→HTTP forces a
  new login (the `Secure` cookie is no longer sent in clear). Expected.
