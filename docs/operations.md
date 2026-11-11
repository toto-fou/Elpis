# Operations

Upgrade, roll back, back up, monitor, and recover after an incident.
Installation and settings are in [configuration.md](configuration.md).

The commands below assume systemd services
(`sudo ./elpis service install`); without them, `./elpis start`, `./elpis stop`
and `./elpis restart` do the same job. `start` and `restart` wait until
main and admin answer on `/api/health` (120 s at most,
`ELPIS_ATTENTE_SANTE` in `.env`); otherwise they return a non-zero code and
print the end of the log of the failing service.

The application (`main`, port 8001) and the console (`admin`, port 8002) are
the TypeScript core: a Node.js bundle, `apps/core/dist/main.mjs`, launched
twice by `./elpis` with `APP_MODE=main` or `APP_MODE=admin`. The tool host is
a second Node.js bundle (`apps/toolhost/dist/main.mjs`, service `toolhost`);
it starts the Office engine's Python worker itself. Account tools (memory,
tasks, skills, charts) are served by main itself; RAG and the browser remain
separate services; the browser runs on the core's Node.js (`node/`).

## System prerequisites (apt packages)

`install.sh` installs by itself, with `apt-get`, the OS packages listed in
[`deploy/prerequis-apt.txt`](../deploy/prerequis-apt.txt) that are missing
(`dpkg-query`): the base right after sudo, before the wizard (which runs in
Python), then, after the summary that lists them, the group for each chosen
component. `apt-get update` runs once before the first installation, and
waits up to 5 min for the package lists to be unlocked;
`apt-get install -y --no-install-recommends` runs without prompts
(`DEBIAN_FRONTEND=noninteractive`) and waits up to 5 min for the dpkg lock
(automatic updates on a first boot). A line `a | b` in the file accepts either
and installs the first one the repositories offer: Docker CE instead of
`docker.io`, Docker client in `docker.io` on Debian 12 and Ubuntu 24.04,
libraries without the `t64` suffix on Debian 12. With a sandbox (not with
`--sandbox none`), the `docker` service is enabled and the application account
joins the `docker` group: the installation builds the image under sudo,
`--start` goes through `sg docker`, and the systemd services get the group
automatically; for your own `docker` commands, sign in again.

Without administrator rights, with `--no-apt` (check only), or if apt fails,
`install.sh` stops: it lists the missing packages, prints the apt command to
run and the option that removes the component concerned. `--skip-system`
neither checks nor installs anything. `./elpis doctor` repeats the check.
Offline, apt goes through the LAN mirror or the OS installation media (DVD,
mounted ISO image). Node.js is not listed: it ships with Elpis. The commands,
for a manual installation (`--no-apt`), with Debian 13 names:

```bash
# base: Python and its venv, downloads, certificates, git updates, bubblewrap jail
sudo apt install --no-install-recommends python3 python3-venv git curl \
    ca-certificates openssl bubblewrap
# sandbox: Docker for the users' sandbox (terminal, code execution)
sudo apt install --no-install-recommends docker.io docker-cli xz-utils
# apercus-office: LibreOffice in a bubblewrap jail (Word, Excel, PowerPoint previews)
sudo apt install --no-install-recommends \
    libreoffice-writer-nogui libreoffice-calc-nogui libreoffice-impress-nogui \
    fonts-dejavu fonts-liberation fonts-crosextra-carlito \
    fonts-crosextra-caladea
# navigateur: libraries and fonts of the Chromium headless shell for the browser service
sudo apt install --no-install-recommends libglib2.0-0t64 libnss3 libnspr4 \
    libdbus-1-3 libudev1 libexpat1 libatk1.0-0t64 libatk-bridge2.0-0t64 \
    libatspi2.0-0t64 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 \
    libxfixes3 libxrandr2 libxkbcommon0 libgbm1 libasound2t64 \
    fontconfig-config fonts-liberation fonts-noto-color-emoji fonts-unifont \
    xfonts-scalable fonts-ipafont-gothic fonts-wqy-zenhei fonts-tlwg-loma-otf \
    fonts-freefont-ttf
# https: Caddy front end (local certificate or Let's Encrypt)
sudo apt install --no-install-recommends caddy
# postgresql-local: PostgreSQL server on this machine (--db postgres-local)
sudo apt install --no-install-recommends postgresql
# sauvegarde-distante: send backups with scp or rsync over SSH
sudo apt install --no-install-recommends openssh-client rsync
# construction-hote: compile node-pty when the tool host is built from source (no offline package)
sudo apt install --no-install-recommends build-essential python3
```

On Debian 12 and Ubuntu 24.04, `install.sh` picks the form the repositories
offer by itself (without `docker-cli`, which `docker.io` provides; on
Debian 12, without the `t64` suffix); Caddy comes from main on Debian 12 and
13, from universe on Ubuntu 24.04. Elsewhere, `install.sh` and `./elpis doctor`
handle only the base: install the equivalent of the file, then run
`./install.sh --skip-system`.

The `navigateur` group holds what the Chromium headless shell loads (the
browser service runs nothing else) and the fonts of Playwright's list for
Chromium (Latin, Chinese, Japanese, Korean, Thai, emoji), so that screenshots
read by a vision model show every script: no X server, no Xvfb. An
installation made before keeps the packages of the former, longer list:
nothing is removed.

`./install.sh --dry-run` prints what the installation would do on this
machine, without prompts (default answers and command-line options), without
calling or asking for sudo and without writing anything (no apt, `node/`,
`venv/`, configuration, database or temporary file). In order: missing apt
packages and the `apt-get` command (names read by `apt-cache`), `docker`
service and group, venv, Node.js, bundles, bubblewrap, database, browser,
Qdrant, sandbox image, configuration, startup; on an existing installation,
what is kept as is (`config.json`, `.env`, `user_db/`, `user_sandboxes/`);
with `--offline`, the package's parts. It also says why sudo would be
requested: indispensable (apt packages, Caddy, local PostgreSQL, systemd
services) or not (`docker` service and group). It exits 0 if the installation
could run to the end, otherwise 1 with the reason: missing packages with
`--no-apt` or without rights, sudo indispensable for an account outside the
`sudo`, `admin` and `wheel` groups (sudoers not read: this is an estimate),
incomplete offline package, unsupported system.

## Installing an offline server

The server needs no internet access: everything comes from a package prepared
on a connected machine with the **same architecture** and the **same Python
version** as the server.

On the connected machine, at the wanted version:

```bash
git archive --format=tar.gz -o elpis-<version>.tar.gz <tag>
./make_release.sh <version> [--no-sandbox] [--no-browser] [--with-sources] [--sign]
```

`make_release.sh` writes `dist/elpis-offline-<version>-<arch>.tar`: Python
wheels, Qdrant, sandbox image, browser (npm dependencies, the Chromium
headless shell and ffmpeg, about 120 MB; without the OS packages, which
`install.sh` takes through apt from the LAN mirror, Caddy included), and for
the core:

- `node/`: the Node.js runtime, namely the official archive from nodejs.org
  (SHA-256 sum from the signed `SHASUMS256.txt`, pinned in
  `deploy/node/node.env`) **without npm, npx or corepack**. Its fingerprint
  (`NODE_RUNTIME_SHA256_<arch>`, computed by `deploy/node/runtime.sh` over its
  files) is pinned too: another runtime is refused at installation and
  reported by `./elpis doctor`;
- `core/`: the bundle built with this same Node for this architecture
  (`main.mjs`, `exploitation.mjs`, the image thread `pixels.mjs` and its
  libwebp WebAssembly codecs in `webp/`), then started once on a temporary
  database (native module loaded, `/api/health`, clean shutdown) before
  entering the package.

`MANIFEST.txt` gives the sum of each file. The package also contains, for
redistribution:

- at its root, `LICENSE`, `NOTICE`, `THIRD_PARTY_NOTICES.md`, `LICENSES/` and `THIRD_PARTY_LICENSES/`:
  the `.tar` that circulates without the sources archive keeps its notices;
- `wheels/LICENCES-PYTHON.txt`: name, version, license and license texts of
  each wheel, read from its `*.dist-info`;
- `sbom/`: CycloneDX JSON SBOMs, `npm.cdx.json` (`npm sbom`, without
  development dependencies), `python.cdx.json` (wheels, with their SHA-256;
  plus `python-requirements.cdx.json` if `cyclonedx-py` is installed) and
  `sandbox.cdx.json` (sandbox image, by `syft` if installed, otherwise the
  step is skipped with a message). These files appear in `MANIFEST.txt`;
- `sandbox/SOURCES.txt` (the image's Debian packages by `dpkg-query -W`,
  exact version and source archive of hadolint, upx and radare2) and
  `sandbox/OFFRE-SOURCES.txt` (written offer to provide the corresponding
  source for three years). These components are under GPL or LGPL: they bind
  only whoever **redistributes** the package to a third party.

`--with-sources` also downloads the source archives of hadolint, upx and
radare2 into `sandbox/sources/`. The sources of the image's Debian packages
cannot be downloaded this way (`apt-get source` needs a Debian system and its
source repositories): get them from https://snapshot.debian.org, at the
version in `sandbox/SOURCES.txt`, or keep the written offer. The voice bundle
(`deploy/voice/fetch_offline.sh --with-sources`) does the same for piper-tts
(GPL): `SOURCES-GPL.txt`, `OFFRE-SOURCES.txt` and `sources/`.

`--sign` writes a detached GPG signature (`gpg --detach-sign --armor`) of
`MANIFEST.txt` (stored in the package) and of the `.tar`: `MANIFEST.txt.asc`
and `elpis-offline-<version>-<arch>.tar.asc`. The key is the one in the
`ELPIS_SIGN_KEY` variable (fingerprint or ID); without `gpg`, without the
variable or without this secret key, the script stops before building. To
verify, after importing the maintainer's public key:

```bash
gpg --verify elpis-offline-<version>-<arch>.tar.asc elpis-offline-<version>-<arch>.tar
# extracted package: manifest signature, then the sum of each file
(cd elpis-offline-<version>-<arch> && gpg --verify MANIFEST.txt.asc MANIFEST.txt \
  && sed -n '/^[0-9a-f]\{64\}  /p' MANIFEST.txt | sha256sum -c --quiet -)
```

On the server, from the account that will run Elpis (`sudo` is requested for
the services):

```bash
mkdir elpis && tar -xzf elpis-<version>.tar.gz -C elpis && cd elpis
tar -xf ../elpis-offline-<version>-<arch>.tar -C ..
./install.sh --offline ../elpis-offline-<version>-<arch> --service
./elpis doctor
```

The apt packages (above) come from the LAN mirror or the OS media, through
`install.sh` itself. It then installs Node.js in `node/`, then the bundle in
`apps/core/dist`. This bundle is refused if it was built for other sources than
this repository (fingerprint of the sources listed in `construction.json`) or
if its native module (better-sqlite3) does not load here. The application
account must be able to read the package folder. When run again, `install.sh`
redoes only what is missing.

Without `--offline`, the official archive is downloaded (same sum) then
stripped the same way (same fingerprint), and the core is built in place
(`npm ci`, `npm run build`) with the network, using the npm from this archive,
kept only for the duration of the build. The core requires Node.js 24.x, 24.9
at least; `ELPIS_NODE=<path>` (in `.env`) points to another one than `node/`.

The charts cache (`CHART_CACHE_DIR`, `user_db/run/charts` by default) is
written by the core and read back by the tool host: `./elpis` sets the same
value for these services. Their units must not isolate `/tmp` (`PrivateTmp`),
and a value set in `.env` applies to all.

### Certificate authorities (internal PKI)

`./elpis` starts the core with `--use-system-ca`: its outgoing HTTPS calls
(MCP client, RAG, relays) recognize Node.js's embedded store and the system's,
read the way OpenSSL does: the `SSL_CERT_FILE` file (by default
`/etc/ssl/cert.pem`) and the `SSL_CERT_DIR` folder (just one; by default
`/etc/ssl/certs`). The inference engine client takes `SSL_CERT_FILE` alone,
otherwise `SSL_CERT_DIR` (hashed names; an `a:b` list is still read, but
reported in the log), otherwise this same default store. On the Python side,
the default `httpx` client (inference, RAG) takes `SSL_CERT_FILE`, otherwise
`SSL_CERT_DIR`, otherwise certifi; clients that build their own TLS context
(images, Git relays) start from the system store, which `SSL_CERT_FILE` also
replaces. Both variables come from `.env`, read by `./elpis` and by the
systemd units. For all these clients to see the same authorities, set
`SSL_CERT_FILE`, or a single `SSL_CERT_DIR` folder with hashed names
(`openssl rehash <folder>`).

`./elpis configure` sets `SSL_CERT_FILE` there to the system store
(`/etc/ssl/certs/ca-certificates.crt`, which contains the internal CA once
added by `update-ca-certificates`), unless `.env` already sets one of the two
variables. `--ca-file <PEM file>` points to another authority; `--ca-file
aucun` goes back to the default stores. `./elpis doctor` checks the file or
folder it points to, and reports a list of folders.

## Upgrading

```bash
./elpis upgrade               # full backup, then upgrade
./elpis upgrade --no-backup   # without a prior backup
```

In order: refusal if the repository has local modifications, full backup in
`backups/` (fails if the database could not enter it), `git pull --ff-only`,
Python dependencies (the AGPL extras stay up to date if installed), Node.js
runtime from `deploy/node/node.env` into `node/`, core rebuilt (`npm ci`,
`npm run build`, with the official archive's npm for the duration of the build;
the old bundle stays in place if the build fails), sandbox image expected by
the code (loaded from `deploy/docker/sandbox/elpis-sandbox-<version>.tar.gz`
if the archive is there, otherwise built — network required; on failure, the
upgrade stops with the steps to follow), restart, then checks: the application
and the console answer, and no database migration is pending — they are
applied at startup, **forward only**. The command stops at the first failing
step, prints the start and end commits (`Code : a1b2c3d → e4f5a6b`, note the
first for a rollback) and ends with `./elpis doctor`.

`upgrade` goes through the package registries (pip, npm) and nodejs.org (the
official Node.js archive, for the runtime and the build's npm): it needs the
network. An offline server is upgraded with the code and the offline package of
the new version: backup (`./elpis backup full`), services stopped, code files
replaced by those of the new version (what git ignores stays in place:
configuration, `.env`, data, `venv/`, `node/`), then `./install.sh --offline
<package>` and `sudo systemctl start elpis.target`. Files that the new version
deleted stay in place without bothering the core: its check covers only the
bundle's sources, listed in `apps/core/dist/construction.json`. Before a
restart, `./elpis restart` and `./elpis doctor` show the migrations that
startup will apply.

`upgrade` redoes neither the apt packages, nor the browser service's
dependencies, nor the systemd units: when the release notes
([CHANGELOG.md](../CHANGELOG.md)) ask for it, run
`./install.sh --yes --service` again (below).

**Re-running `install.sh` on an existing installation** is the most complete
upgrade, and the only one for the move from the Python core to the TypeScript
core. With `--yes`, nothing is asked (except sudo, at the start) and the
configuration is not redone: `config.json`, `.env` and the database
(`user_db/`) stay as they are, and the database receives its migrations at
startup. The script installs the missing apt packages, updates the venv, puts
Node.js in `node/`, builds the core, the tool host and the interface
(`deploy/node/installer.sh node`, `bundles` then `web`), loads or builds the
expected sandbox image, updates `mcp.json` (relays, tool families) and, with
`--service`, rewrites the systemd units then starts (`--start` without
systemd). Components stay as in the installation: the browser stays installed
or not, the sandbox too (kept if there is an `elpis/sandbox` image or an
`elpis-sb-*` container, or if Docker does not answer; `--sandbox build` or
`--sandbox none` to decide), Caddy keeps its configuration (`--with-caddy`
redoes it), LibreOffice is checked if present. Without `--yes`, `./install.sh`
reopens the wizard, pre-filled with the current configuration, and reapplies it
(`./elpis configure`). `./install.sh --dry-run` shows beforehand what would be
done and what would be kept, without writing anything.

**Moving from the Python core (0.0.1, tag `python-final`) to the TypeScript
core (0.1.0).** Do not use `./elpis upgrade`: it is still the 0.0.1 script that
runs, and it restarts the Python core that 0.1.0 removed
(`server/gunicorn_conf.py`, `toolhost/`). It then exits with an error after
about 90 s ("L'application ne répond pas après la mise à jour", the message
the script prints), without a migration check or `doctor`, service stopped;
under systemd, the old units fail and restart in a loop (every 3 s). Under the
application account, at the repository root:

```bash
git rev-parse --short HEAD           # start commit, to note for a rollback
./elpis backup full                  # full backup, using the 0.0.1 script
sudo systemctl stop elpis.target     # without systemd: ./elpis stop
git pull --ff-only
./install.sh --yes --service         # without systemd: --start instead of --service
./elpis doctor
```

`sudo` is requested at the start of `install.sh` (apt packages, `docker`
group, systemd units). Without sudo rights, replace `--service` with `--start`:
if sudo is refused, `install.sh` continues without the system steps provided
the apt packages are already there (`./install.sh --dry-run --start` tells you
beforehand). With a sandbox, the `elpis/sandbox:1.7.0` image is already there
if 0.0.1 built it, otherwise `install.sh` builds it (10 to 20 min); without a
sandbox, it installs neither Docker nor an image. Already ran
`./elpis upgrade`? Its error is expected and the code is already pulled: stop
the services (`sudo systemctl stop elpis.target`; without systemd,
`./elpis stop`, which also stops the RAG and Qdrant that the old script
restarted), then `./install.sh --yes --service`. Offline: services stopped,
code replaced (above), then `./install.sh --yes --offline <package> --service`.
Users sign in again: the session format changes.

Two settings change meaning when moving to 0.1.0:

- **Cloud providers for accounts**: without `llm.allowed_provider_types`,
  non-administrator accounts can no longer connect a cloud provider, and their
  personal cloud connectors stop serving. To keep them, check the wanted types
  in Admin console › Users & access › Default permissions › Allowed providers (details:
  docs/configuration.md, "Cloud providers for accounts"). Shared connectors and
  administrators' connectors do not change.
- **Rollbacks to Python**: `ELPIS_TOOLHOST=python`, `ELPIS_APPMCP=python` and
  `ELPIS_CLI=python` no longer have any effect; `./elpis doctor` reports those
  that remain in `.env`, to be removed. The complete return to the Python
  version goes through the `python-final` tag (below).

**MariaDB/MySQL is no longer supported** (SQLite and PostgreSQL remain). An
instance still on this engine moves off it **before** the upgrade, with the
version in place: Admin console › System › Data › "Back to SQLite" (full, verified
copy; the old SQLite file is kept as `app.db.bak-<date>`), or "Migrate and
switch" to an empty PostgreSQL; on the command line, `./elpis db transfer --to
postgres://…` then `./elpis db use postgres://…`. `install.sh` and
`./elpis configure` refuse to continue as long as the database is set to
MariaDB/MySQL. If the upgrade is already done: the application refuses to
start, with a message in the log, without writing to any database; go back to
the previous code (`git update-index -q --refresh`, `git reset --keep <start
commit>` then `venv/bin/pip install -r requirements-rag.txt`, without
restoring the database), move off MariaDB as above, then upgrade again. The
MariaDB server, installed from the OS packages, is uninstalled by hand if it
is no longer used.

The tool host (`toolhost`) is required: the application no longer starts a
tools subprocess in its place. Account-bound tools are served by main:
`./elpis configure`, `./elpis start` and `./elpis upgrade` remove from
`mcp.json` the `http://127.0.0.1:8766/...` URLs of `role: app` entries (a
remote URL set by hand is kept; `./elpis doctor` reports those that remain),
and `sudo ./elpis service install` removes an `elpis-appmcp` unit left in
place. `./elpis configure` also sets `relay: true` in an existing `mcp.json`;
as long as it is missing, main keeps serving the sandbox and the terminal
itself.

For an installation that predates the security changes of the current
version:

- bubblewrap (`./install.sh` installs it with the base): Office previews and
  the RAG extractor's analyses run in a `bwrap` jail. On Ubuntu, `sudo
  ./install.sh` sets the AppArmor profile if `bwrap` is blocked.
- The tools' and editor's Git runs in the sandbox; its network operations go
  through the host relay, over `https` or `http` only (no more `ssh` or
  `git://`).
- The sandbox image becomes `elpis/sandbox:1.7.0`, **mandatory**:
  `./elpis upgrade` loads or builds it; otherwise `./install.sh --sandbox
  build`, or `deploy/docker/sandbox/load_image.sh <archive>` offline. As long
  as it is missing, existing containers are not recreated and, without the new
  image's agent, the sandboxes' files, editor and Git are unavailable (explicit
  message); only the terminal and command execution still work. They are
  recreated on first use once the image is present.
- Sandbox containers are recreated on first use: whatever had been installed
  outside `/work` is lost.
- They keep only the capabilities they need: without `NET_RAW`, `ping` works,
  `tcpdump` and `mtr` do not. A specific need is restored in Admin console › Sandbox ›
  Limits & policy › Advanced ("`docker run` flags", one argument per line, for
  example `--cap-add=NET_RAW`); it applies to containers created afterwards
  (delete them in "Active containers", they are recreated on next use). A
  third-party image derived from an `elpis/sandbox` older than 1.7.0 must
  remove the file capability from `ping` (`setcap -r /usr/bin/ping`) or start
  again from 1.7.0.
- Without a `security.listen` setting (configuration from before this
  setting), the application stays open to the network, as before;
  `./elpis configure --listen local` restricts it to this machine.
- Browser states saved before 0.0.1 (`browser-service/cookies/state_<id>.json`)
  belong to no account: they are never reloaded and never purged (they keep
  session cookies). The browser service reports them at startup; delete them by
  hand (`rm browser-service/cookies/state_<id>.json`).

## Rolling back

Migrations go forward only, so a rollback = the old version of the code **and**
the database from before the upgrade.

```bash
sudo systemctl stop elpis.target
git update-index -q --refresh      # install.sh touched tracked files
git reset --keep a1b2c3d           # start commit printed by upgrade
venv/bin/pip install -r requirements-rag.txt
# SQLite database: the backup snapshot is a standalone file.
unzip -p backups/backup_complet_<horodatage>.zip db/app.db > user_db/app.db
sudo systemctl start elpis.target
```

Since the version where the sandbox agent alone writes to `/work`, the files
in `/work` belong to the container user, with no write access for others: the
old version, which wrote from the host, redoes its own permission repair at
first startup (the new version's markers are removed for this). Restart the
sandbox containers after the rollback (Admin console › Sandbox › Containers › Active
containers).

Since the version where personal tokens are stored as fingerprints, a database
restored from BEFORE the upgrade gets its old opencode tokens back; a database
upgraded and then kept with the old code does not (pair opencode again from the
Remote code page).

The rest of the archive (sandboxes, `user_db/`, skills…) is restored from
Admin console › System › Data › Restore, within the limit of 500 MB per upload
(`APP_MAX_RESTORE_MB`), or unpacked by hand with services stopped. Database on
a PostgreSQL server: restore it with the server's tools, or start again from
the backup's SQLite snapshot (see [Recovering from an
incident](#recovering-from-an-incident)).

### Returning to the Python version (tag `python-final`)

The `python-final` tag designates the last Elpis version with a Python core.
0.1.0 leaves the database readable by it: the TypeScript core runs no
destructive migration on it. The return is therefore done through the code,
without restoring the database. The units are first removed by the current
`./elpis`: the elpis-tools one, set by the first 0.1.0 releases, does not exist
in the Python version and would restart endlessly.

Under the application account, at the repository root:

```bash
sudo ./elpis service remove          # core and tool host units (and the removed elpis-tools one)
git fetch origin tag python-final    # the tag, if not already there (network)
git update-index -q --refresh        # install.sh touched tracked files
git reset --keep python-final
venv/bin/pip install -r requirements-rag.txt
sudo ./elpis service install         # Python version units, started
./elpis doctor
```

Without systemd: `./elpis stop` instead of `service remove`, the `git` and
`pip` commands, then `./elpis start`.

Without network: dependencies come from the Python version's offline package,
prepared beforehand on a connected machine
(`git checkout python-final && ./make_release.sh`):
`venv/bin/pip install --no-index --find-links <package>/wheels -r requirements-rag.txt`.
Server installed from an archive (no `.git`): services stopped
(`sudo ./elpis service remove`), replace the code files with those of the tag's
archive (`git archive --format=tar.gz -o elpis-python-final.tar.gz
python-final`, on the connected machine), as for an offline upgrade, then run
`./install.sh --offline <python-final package>` and
`sudo ./elpis service install`.

`node/`, `apps/core/dist`, `apps/toolhost/dist` and `frontend/dist` stay on
disk, with no effect on the Python version's `./elpis`. The `dist` folders are
ignored by git; `node/` is not in `python-final`: `git status` shows it
untracked (`?? node/`), with no consequence (`./elpis upgrade` looks only at
tracked files). Keep it to return to 0.1.0, or delete it. The database keeps
0.1.0's `shell_jobs` and `shell_job_events` tables (and their `kind` and
`detail_json` columns for background subagents, ignored by an older core: a
background subagent left active after a hard stop would pass there for a
command, which the tool host declares lost), and `mcp.json` its migration
(`relay: true`, `elpis-office` family): the Python version copes with it.
Non-administrator accounts' personal cloud connectors become usable again there
(it allows all types). Users sign in again: the session cookies of the two
versions differ. If the database has already received migrations added by the
TypeScript core, start again from the backup taken before the upgrade
([Rolling back](#rolling-back)).

To return to the TypeScript version afterwards: services stopped,
`git update-index -q --refresh`, `git reset --keep <TypeScript commit>`
(found with `git reflog`), then `./install.sh --yes --service` (`--start`
without systemd; without network, `--offline <package>`). It keeps Node.js and
the core and tool host bundles if they match the sources, and rebuilds the
interface; by hand, this is `deploy/node/installer.sh node`, then `bundles`,
then `web`, and `sudo ./elpis service install`.

### Operations commands run by the core

`./elpis backup`, `./elpis db`, the backup step of `./elpis upgrade` and the
checks of `./elpis doctor` (database reachable, file locks, bubblewrap, LLM
server) go through the Node.js core (`apps/core/dist/exploitation.mjs`): same
options, same outputs and same exit codes as in the Python version. The venv is
now used only for the Office engine, the RAG extractor and `./elpis configure`.
`./elpis configure` itself asks the core to test a database (`db check`), to create
the database and the administrator account (`admin`) and to save the cloud
connector (`connecteur`, API key encrypted by the core); `admin` and `connecteur` read
a JSON request on stdin, so no secret goes on a command line. The configuration
therefore needs the core bundle, which `./install.sh` builds before configuring.

## Backing up and restoring

| Method | Use |
|---|---|
| `./elpis backup [full\|db\|sandboxes\|mcp] [--dest DOSSIER]` | archive in `backups/` (file 0600, folder 0700 if created); each account's `/work` is read by its sandbox's agent (started for the duration of the read if it was asleep); exit code 1 if the database is missing from the archive, 3 if the archive is made without the `/work` of at least one account (unreadable sandbox; `./elpis upgrade` then continues) |
| Admin console › System › Data › Backup | download of the same archive |
| Admin console › System › Maintenance › Remote backup | scheduled upload: SFTP (key), rsync over SSH, or a mounted folder |
| Admin console › System › Data › Restore | full archive or by scope |

The full archive contains the database (SQLite snapshot, whatever the engine),
`user_db/` (including the encryption key, the session secret and, while no vault
key is set up, the fallback key of the secrets vault: protect them
accordingly, and the RAG store `user_db/rag`: uploaded documents and extracted
texts), the sandboxes, the MCP servers, the skins, the personal skills
store and the security journal (`audit/`, see
[Security journal and log forwarding](#security-journal-and-log-forwarding)). In the sandboxes, only regular files are backed up; other entries are
listed in `backup-warnings.txt`.

Not included, to be backed up separately: `config.json`, `.env`, `mcp.json`,
the key of the secrets vault (`/etc/elpis/vault.key`, see
[Secrets vault key](#secrets-vault-key)),
the browser's saved states (`browser-service/cookies/`), a RAG store placed
outside `user_db/` (`rag.store_dir`); what is specific to the machine
(`.db_password`, state of a database switch); logs, PID files and the
extractor cache (`user_db/logs/`, `user_db/run/`, `user_db/rag-cache/`), neither
backed up nor restored. The Qdrant index (`rag_app/qdrant/storage/`) is not
there either: after a restore on another machine, Admin console › Models & services ›
RAG › Embedding model change › "Reindex all collections" (checkbox "Even those
already using this model") rebuilds it from the store's extracted texts.

The `*.lock` files in `user_db/`, in the sandboxes and in `skills/` are locks
in use: useless in a backup, taken over automatically if their process has
disappeared, and can be deleted with services stopped (like the
`*.lock.perime.*` and `*.lock.rendu` files that a hard stop can leave).

```cron
# Full backup every night at 3 a.m., under the application account;
# archives older than 14 days are deleted.
0 3 * * * cd /opt/elpis && ./elpis backup full >/dev/null && find backups -name 'backup_*.zip' -mtime +14 -delete
```

## Monitoring

| Command | Role |
|---|---|
| `./elpis status` | services and ports |
| `./elpis doctor` | full diagnostic (dependencies, the core's Node.js, built bundle, up to date with the sources and native module loaded, database as seen by the core, certificate authorities, Docker, sandbox image, bubblewrap, HTTPS, LLM engine probed with its key, recommended launch flags for vLLM and SGLang, the core's last engine probe if `main` is running, RAG: extractor and its isolation, shared store and token, Qdrant, embeddings, OCR, browser states to attach, security journal, key of the secrets vault); optional items are reported without counting as a problem |
| `./elpis logs [service] [-f]` | logs (`qdrant`, `rag`, `toolhost`, `main`, `admin`, `browser`) |
| `GET /api/admin/metrics/prometheus` | Prometheus metrics (admin process, :8002): admin session or collection token |

The console overview reports a backup that is too old.

## Security journal and log forwarding

Elpis keeps two kinds of logs. The **security journal** records who did what (sign-ins,
accounts, rights, settings, backups, exports, commands): one signed JSON line per event, one file
per UTC day, in `/var/lib/elpis/audit`. Its format and the catalogue of events are in
[audit-events.md](audit-events.md). The **technical logs** are the services' messages and the HTTP
access log. Elpis sends nothing over the network: sending to a central collector is done by the
host's rsyslog, from the examples in `deploy/rsyslog/` (see its
[README](../deploy/rsyslog/README.md)).

### Setting up the journal

```bash
sudo ./elpis audit setup
```

Run by `./install.sh` and by `sudo ./elpis service install`; safe to run again. It creates, and
checks at the end (non-zero exit on any difference):

| What | Detail |
|---|---|
| Group `elpis-journal` | Read access to the journals (`ELPIS_GROUPE_JOURNAL=adm` uses the `adm` group instead). The `syslog` account, when it exists, joins it so that rsyslog can read the files; rsyslog is restarted for that |
| `/var/lib/elpis/audit` and `/var/log/elpis` | Mode `2750`, owned by the service account and the group above, never readable by everyone. The first holds the security journal, the second the access log |
| `/etc/elpis/audit.key` | Signing key (0440, root and a group holding the service account only: its own primary group, or `elpis-cle`, name set by `ELPIS_GROUPE_CLE`). Created if missing or empty, never replaced. **Back it up off the machine**: without it, signatures can no longer be checked |
| Existing `logs/audit` | The files of an earlier installation are moved to `/var/lib/elpis/audit` (a file of the same day is appended to). While the services run, the files of today and yesterday stay where they are: stop them (`./elpis stop`, or `sudo systemctl stop elpis.target`) and run the command again |

Run it again after changing the service account, after stopping the services to finish the move
of `logs/audit`, and whenever `./elpis doctor` or the console asks for it. Without it, the journal
falls back to `logs/audit` in the repository, and its lines are unsigned if the key is missing.

The service account is the `User=` of the installed units, otherwise `ELPIS_USER`, otherwise the
account that ran `sudo`; it is never root. From a root shell (`su -`, `sudo -i`) there is no
`SUDO_USER`: give the account, `sudo ELPIS_USER=name ./elpis audit setup`. When units are
installed under another account than `ELPIS_USER`, the command refuses; change the account with
`sudo ELPIS_USER=name ./elpis service install`.

### After an update

`./elpis upgrade` restarts the existing units without rewriting them. After the update that
brings the security journal, run, in this order:

```bash
sudo ./elpis audit setup
sudo ./elpis service install
```

`service install` rewrites the units (each service gets `SyslogIdentifier=elpis-<service>` and
the `ELPIS_AUDIT_DIR` and `ELPIS_APP_LOG_DIR` variables), moves what remains in `logs/audit`, and
restarts `elpis.target`.

### Verifying the journal

```bash
./elpis audit verify [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--key PATH]... [--host NAME]
```

Checks the signature of each line and the continuity of the numbers (`seq`) of each writer
(`boot`), over the whole journal or a period. Exit codes:

| Code | Meaning |
|---|---|
| 0 | `intact`: every line signed and valid, no gap, both ends of the journal established |
| 1 | `anomalies`: invalid signature, unreadable, missing, duplicated or out-of-order lines |
| 2 | Bad command line; `--key` missing, unreadable or shorter than 32 bytes; or signed lines and no readable key (the default key is readable by the service account only: run the command as that account, or pass `--key`) |
| 3 | `non_verifie` (unsigned lines, unknown key, start or end of the journal not established, reason printed) or `vide` (nothing in the period) |

The command is itself written to the journal (`cli.audit.verify`). The same check is available in
the console (Monitoring › Logs › Security › Verify integrity). On a central copy, use the same
command with `ELPIS_AUDIT_DIR` and `--key` (see the rsyslog README).

### What `./elpis doctor` checks

- the two folders: mode `2750`, service account, group `elpis-journal` (or `adm`); the fallback
  folder `logs/audit` in use, or files left in it;
- the key: 0440 root, group of the service account alone, readable by it, 32 bytes at least
  (otherwise lines are written unsigned);
- forwarding: a rule `*elpis*.conf` in `/etc/rsyslog.d` (or `/etc/syslog-ng/conf.d`), and the
  packages its drivers need (`rsyslog-gnutls` for TLS, `rsyslog-relp` for RELP); no rule is
  reported, not counted as a problem;
- journald persistent (`/var/log/journal`), see below;
- the clock synchronised (`timedatectl`), counted as a problem when it is not.

### Retention, hold and purge

The daily maintenance pass (`maintenance.hour`) deletes the daily files whose whole UTC day is older
than `security.audit.retention_days` (365 by default, 180 to 1095; see
[configuration.md](configuration.md#security-journal-securityaudit)). At most 31 files go per pass,
and the `retention_days` most recent files always stay, so a clock set ahead does not empty the
journal. A signed `audit.purge` line is written before anything is deleted; if it cannot be written,
nothing is.

- **Hold.** `hold` with a mandatory reason keeps every file, for an investigation or an authority's
  request. A `.hold` marker in the journal folder doubles it. Set and lifted in Admin console ›
  System › Logging.
- **Expected forwarding.** With `forwarding_expected` on, files are deleted only once the syslog
  agent is installed, active according to systemd, and has a rule reading the journal folder. Turn
  it on when forwarding is in place: nothing is then erased that was not sent.
- Also kept, with an alert in the console: a `config.json` or a retention value that cannot be read
  (the retention and the expected forwarding are copied to a `.settings` file in the journal folder
  and taken from it if `config.json` loses them).

Each skipped pass writes `audit.purge.skipped` with its reason. The console shows the disk space
left and the days it represents at the current pace, and raises an alert below 7 days.

### Backups

A full backup (`./elpis backup`, the console, the upgrade backup) includes the journal in an
`audit/` folder (`backup.include_audit`, on by default). The scheduled remote send leaves it out
unless `backup.remote.include_audit` is on. A restore never writes it back over the journal in
place. Keep the backups for no longer than the journal's retention (the example cron above keeps 14
days): a deleted day must not live on in older archives. The signing key is not in the backup.

### Clock

Timestamps are only as good as the clock. Point the host at an internal time server of the LAN,
with chrony (or `systemd-timesyncd`): no public server is needed or wanted. For example, in
`/etc/chrony/chrony.conf`, `server ntp.example.lan iburst`, then `sudo systemctl restart chrony`.
`./elpis doctor` and the console (Logging page) report an unsynchronised clock.

### Technical logs

| Log | Where | Notes |
|---|---|---|
| Service output | journald, tag `elpis-<service>` (`elpis-main`, `elpis-admin`, `elpis-toolhost`…) | `./elpis logs main -f`, or `journalctl -t elpis-main`. Make journald persistent with `deploy/journald/60-elpis.conf.example` (`Storage=persistent`); its optional size and age limits apply to the whole host journal. Keep it shorter than the security journal: it holds names and addresses |
| Access log | `app.log.jsonl` in `ELPIS_APP_LOG_DIR` (`/var/log/elpis`); `user_db/logs/` of the repository when the variable is not set | Rotated by Elpis itself at 8 MB, 3 old files kept (`ELPIS_APP_LOG_MAX_MO`, `ELPIS_APP_LOG_ROTATIONS`) |
| `logs/<service>.log` | Repository, only with `./elpis start` (no systemd) | Rotated at each start when above 64 MB, 3 old files kept (`.1` to `.3`) |

Neither rotation depends on systemd or logrotate. Both journal folders must stay readable by the
rsyslog account: that is what `audit setup` does.

For sending the security journal, the access log and the services' output to a collector (mutual
TLS, disk queues, what can still be lost), follow
[deploy/rsyslog/README.md](../deploy/rsyslog/README.md).

## Secrets vault key

Secrets saved in Elpis (website logins, HTTP authentication, Git, LLM and MCP keys, tokens) are
rows of the `vault_secrets` table. Each value is encrypted with AES-256-GCM and bound to its owner,
kind, name and to the columns that decide its use (scope, policy, state, version, user name): a
row changed directly in the database no longer decrypts. The secrets of routine webhooks are
encrypted with the same key, in their routine's row; `status` and `rekey` include them. The key is
never in the database; the services take the first of:

1. `ELPIS_VAULT_KEY` (environment): avoid it, prefer the key file (see
   [configuration.md](configuration.md#secrets-vault));
2. `/etc/elpis/vault.key` (or `ELPIS_VAULT_KEY_PATH`);
3. `user_db/.vault.key`, a fallback created next to the database when the first secret is saved,
   and only while the vault is empty.

Only `main` and `admin` can read the key: the other units neither receive the variables nor see
the key files.

Each encrypted value carries the `kid` of its key (first 8 hexadecimal digits of the SHA-256 of
the key), so a key change is detected and repaired with `rekey`. Variables:
[configuration.md](configuration.md#secrets-vault).

### Setting up the key

```bash
sudo ./elpis vault setup
sudo systemctl restart elpis.target    # or ./elpis restart
```

It creates `/etc/elpis/vault.key`: 32 random bytes in base64, mode 0440, owned by root and by the
key group of the security journal (the service account's own primary group, or `elpis-cle`), in
`/etc/elpis` (0750). The service account is found as for `audit setup`. Safe to run again: an
existing key is kept, never replaced, and its owner and mode are applied again. The key is checked
by the core itself, with the rule the services apply (canonical base64 or 64 hexadecimal digits,
32 bytes, not a single repeated byte): an invalid key is refused and left as it is. The command
therefore needs the core bundle (`./install.sh`). The services read the key when they start, and
`sudo ./elpis service install` hides it from the units other than `main` and `admin`.

If secrets were saved before, under the fallback key, re-encrypt them once the services have
restarted, then delete the fallback:

```bash
./elpis vault rekey --from user_db/.vault.key
./elpis vault status          # exit code 0: every secret uses the current key
rm user_db/.vault.key
```

### Updating: connector and image engine keys

From the version that adds migration `0028_vault_llm_images`, the API keys of the LLM connectors
and of the image engine live in the vault. At the first start of `main` (admin, the tool host and
the commands leave it to `main`), the migration moves them there and the log says how many
(`migration 0028_vault_llm_images : …`).
Set the key up **before** that restart (`sudo ./elpis vault setup`), so that they go under
`/etc/elpis/vault.key` rather than the fallback key. Then:

- `./elpis secret ls` lists them: `llm-<provider>-<id>` (an account's, or the instance's for a
  shared connector) and `image-engine`;
- a key that the current encryption key could not decrypt is kept and logged as a warning; the
  console shows "clé à ressaisir" on the connector: enter the key again, or restore the former
  `APP_ENCRYPTION_KEY` / `user_db/.encryption_key` and restart. Without any encryption key, none
  is created: the Fernet keys wait as they are and move at a start where the key is back;
- if the vault key cannot be read, the migration fails (error in the log, `./elpis doctor`
  lists it as pending) and nothing changes until a restart with a readable key;
- the secrets it creates are reported in that startup log and written to the security journal
  (`vault.secret.created`);
- `main` then compacts the database once (`VACUUM` on SQLite, `VACUUM FULL` of the connectors
  table on PostgreSQL; a failure is logged as a warning and does not stop the start);
- at the next starts, `main` retries what is left (kept keys, MCP values not moved yet, former AX
  credentials) under the schema lock, writes nothing when nothing is left, and compacts again only
  after a retry that removed old values;
- **rotate the provider keys afterwards** (in the provider's console, then in Administration ›
  Connexions and Images): the backups taken before the update still hold the old keys, encrypted
  with the Fernet key, which they or the machine may also hold. The update removes them from the
  database file (`secure_delete` and the compaction), from `config.json` and from
  `config.json.bak`.

Going back to an earlier version is not supported. A key that an earlier version writes again is
compared with the vault at the next start of `main`: the vault value is kept, the other removed,
and a warning is logged when they differ.

### Backing up the key

Backups (`./elpis backup`, the console) contain the database, so the encrypted secrets, but not
`/etc/elpis/vault.key`. **Back the key up separately, off the machine** (offline medium,
administrators' password manager): without it, the secrets cannot be decrypted and must be
entered again. Keep it away from the backups: whoever holds a backup and the key can read every
secret. The fallback `user_db/.vault.key` is inside the backups, which is why `./elpis doctor`
warns while it is in use.

### Changing the key

1. Keep a copy of the old key, readable by the service account (`rekey` runs under it), for
   example `sudo install -m 0400 -o <account> /etc/elpis/vault.key /home/<account>/vault.key.old`.
2. Remove `/etc/elpis/vault.key` (`setup` never replaces it), run `sudo ./elpis vault setup`
   (or set `ELPIS_VAULT_KEY`) and restart the services. Until the next step, the secrets of the old
   key are refused (`secret_undecryptable`).
3. `./elpis vault rekey --from /home/<account>/vault.key.old` re-encrypts, one by one, the
   secrets of the old key with the current one. A secret changed meanwhile is left for the next
   run. The command is written to the security journal (`vault.key.rekeyed`, outcome `failure`
   for any exit code other than 0). Exit codes:

   | Code | Meaning |
   |---|---|
   | 0 | No secret is left under another key than the current one |
   | 1 | At least one secret of the old key could not be re-encrypted (altered, or a column changed in the database) |
   | 2 | Bad command line, old key missing or invalid, no current key |
   | 3 | Nothing altered, but secrets remain under another key: a third key, or secrets changed during the run (run it again, then `./elpis vault status`) |

4. `./elpis vault status` reports no secret under another key: destroy the old copy.

A relative `--from` path is read from the Elpis folder.

### Commands

| Command | Role |
|---|---|
| `sudo ./elpis vault setup` | Creates the key (above) |
| `./elpis vault status` | Source and `kid` of the key, number of secrets (accounts, instance), secrets under another key. Exit code 0 when the key is readable and every secret uses it, 1 otherwise |
| `./elpis vault rekey --from FILE` | Re-encrypts the secrets of an old key with the current one |
| `./elpis secret ls [--user ACCOUNT]` | Metadata of the secrets: owner, name, kind, scope, user name, state, version, uses, last use, key. Never a value |

They use the core bundle and the database. Run them as the service account; with `sudo`, they
switch to it, so that root never creates database files.

### Losing the key

When `/etc/elpis/vault.key` disappears while secrets exist, the services cannot read them (after
a restart), and saving a secret is refused (`secret_key_unavailable`): no new fallback key is
created, since secrets encrypted with it would hide the problem. `./elpis doctor` and
`./elpis vault status` say so. Restore the key from its copy and restart the services. Without a
copy, run `sudo ./elpis vault setup`, then give each secret its value again (rotation).

### What `./elpis doctor` checks

- `/etc/elpis/vault.key`: 0440, root, group of the service account alone, readable by it. Run
  under the service account, a session opened before the account joined that group cannot read it
  (the services started from it could not open the vault): the doctor says so, as for the key of
  the security journal;
- the key in use, as the core sees it: a warning for the fallback `user_db/.vault.key`, for a key
  that cannot be read or is invalid, for secrets encrypted with another key
  (`./elpis vault rekey`), and for secrets left without any key (restore it).

## Recovering from an incident

- **Database server unreachable**: `./elpis db use sqlite` then
  `sudo systemctl restart elpis.target`. The application restarts on the local
  SQLite file — the one from before the switch to the server, or a backup
  snapshot put in its place: what has been written to the server since is not
  in it. To go back to the server, `./elpis db transfer --to <target>` copies
  to an **empty** database (empty or recreate the server's database), then
  `./elpis db use <target>` selects it.
- **Restart during a generation**: on shutdown, the core gives running
  generations 300 s (systemd units: `TimeoutStopSec=310`; `./elpis stop` waits
  as long, and stops the tools only afterwards), then closes; the conversation
  keeps what was saved, so send the request again. Per-conversation locks are
  `flock`s: released when the process dies, nothing to clean up.
- **Restart requested** ("Restart" in the console, end of a database or HTTPS
  switch): the core shuts down cleanly with exit code 75. systemd restarts it
  (`Restart=always`); under `./elpis start`, `deploy/node/relance.sh` restarts
  main or admin, and only on that code (a stop by `./elpis stop` or a crash does
  not restart it).
- **Interrupted sandbox snapshot restore**: the interface reports it; run the
  restore again.
- **Failed upgrade**: `./elpis upgrade` stops at the failing step and says so;
  fix the problem, then `./elpis upgrade --no-backup` (the first run's backup is
  in `backups/`), or roll back.
- In all cases: `./elpis doctor`.

## Compatibility

| Component | Versions |
|---|---|
| System | Debian 12 and 13, Ubuntu 24.04 (amd64) |
| Python | 3.11 to 3.13 (tested in CI: 3.11 and 3.13) |
| Node.js (core and browser) | 24.x, 24.9 at least; installed by `install.sh` in `node/`, without npm (version and fingerprint from `deploy/node/node.env`) |
| Database | SQLite (default); the distribution's PostgreSQL — tested in CI: PostgreSQL 17 |
| Docker | distribution package (`docker.io`) |
| bubblewrap | distribution package, user namespaces allowed (`./elpis doctor`) |
| Inference | `llama-server` (llama.cpp, with `--jinja`), any OpenAI-compatible server, or a remote provider |
