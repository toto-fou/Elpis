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

## systemd units

`sudo ./elpis service install` renders the units from the templates in
[`deploy/systemd/`](../deploy/systemd/) (`elpis-<service>.service`, `elpis.target`)
into `/etc/systemd/system/`, and the runtime folder shared by main, admin and the tool
host (`/run/elpis`: locks, turn journals, markers) into `/etc/tmpfiles.d/elpis.conf`.
`./elpis service print` shows them without installing anything, in the mode `service install` would choose.

Each unit runs without privileges (`NoNewPrivileges=`, empty
`CapabilityBoundingSet=`), with the system read-only (`ProtectSystem=strict`) except
the folders the service writes (`ReadWritePaths=`), a private `/tmp` and `/dev`,
protected kernel settings, modules and logs, and memory and task limits
(`MemoryMax=`, `TasksMax=`). `systemd-analyze security elpis-main` gives the exposure
score of a unit (every unit stays under 5, "OK"). Per service:

- main and admin: no new namespaces either; they write only their state folders (`user_db/`,
  logs, system prompts, skills, skins, sandboxes, RAG store), and the console the folder
  of `config.json` (below): the code of the installation stays read-only.
- toolhost and rag: bubblewrap (Office previews, RAG conversions) needs namespaces and
  a fresh `/proc`, hence no `RestrictNamespaces=`, `ProtectKernelTunables=`,
  `ProtectKernelLogs=`, `ProtectHostname=` (it covers part of `/proc/sys`),
  `RestrictSUIDSGID=` (its filter refuses a call bubblewrap makes) nor `PrivateUsers=`; the tool host keeps umask 022 under a single account, since the
  sandboxes' account reads some of the files it creates (`0007` with one account per service, below).
- qdrant: system call filter, no memory both writable and executable, only its folder
  writable, and reachable on the loopback only (`IPAddressDeny=any`,
  `IPAddressAllow=localhost`): a `qdrant_url` on the machine's LAN address is refused.

`ProtectHome=` is `yes`, or `read-only` when the installation, a data folder, the
services' account or the Playwright browsers sit under `/home`, `/root` or `/run/user`.
To change a limit (a large Qdrant collection, for example), add a drop-in, which
`service install` keeps: `sudo systemctl edit elpis-qdrant`, then

```ini
[Service]
MemoryMax=16G
```

The units are rendered for the paths in force at `service install`. Data folders that may
live outside the installation (`MCP_SERVERS_DIR`, the folder of `app.db_path`, `MEMORY_DIR`,
`USER_SKILLS_DIR`, `SKINS_DIR`, `APP_FILE_HISTORY_DIR`, `office_preview.cache_dir`, and
`backup.remote.dest_path` of the "mounted" connector) are made writable for the services
that write them; after changing one of them, run `sudo ./elpis service install` again (or add
`ReadWritePaths=` in a drop-in). With one account per service, these folders come from `.env`
only (see [Service accounts](#service-accounts)). Every value written into a unit is checked
first, before any other test, and `service install` stops with nothing installed when one
fails: a path must be absolute and made of letters, digits and `. _ @ + / -` only; any other
value (URL, host) may not contain a control character (a line break among them), `"`, `\`,
`%`, `$` or a backtick; values are inserted in one pass (a value is never read again as a
template marker). Main and the
console keep their turn journals and task resumes in `user_db/run/` (`/run` is in memory);
locks and stamps stay in `/run/elpis`. The Docker socket is hidden from main, the console,
the RAG and Qdrant (only the tool host drives Docker), and the audit key from the RAG and
Qdrant.

`./elpis start` (without systemd) applies none of this.

### `config.json` under systemd

`service install` moves `config.json` (with `config.json.bak` and `config.json.lock`) to
`/etc/elpis/config/` and leaves a link at its place: only the console writes it (Admin console),
main and the tool host read it. With one account per service, the folder and the file belong
to the console (`elpis-admin`, group `elpis-donnees`): `sudo ./elpis configure` runs the
assistant and `deploy/configure.py` under the console's account (never as root), followed by
`sudo ./elpis service install`. That run writes `config.json`, the database and the console's
own files; it never writes the operator's files: the lines `.env` would get are printed, to be
copied into `.env` from the operator's account, `mcp.json` is updated by `./elpis configure
--migrer-mcp` (without `sudo`), Caddy by `sudo deploy/caddy/install_caddy.sh`, and the platform
secrets and tokens are created by `service install`. `./elpis configure` without `sudo` stops
with that advice before any question (`--migrer-mcp` and the checks that run no core,
`--check-llm`, `--conseils-moteur`, `--verifier-mcp` and `--verifier-familles-mcp`, still run;
`--check-db` needs `sudo`). With one
account for every service, they belong to that account, and `sudo ./elpis configure` runs
`deploy/configure.py` as root: it then writes every file through its folder opened without
following any link (a random temporary file created exclusively, then renamed; owner and group
of the file it replaces, else of its folder), follows only the `config.json` link that
`service install` set, never takes a path from `config.json` (the database folder comes from
`APP_DB_PATH` or `user_db/`), opens a SQLite database only when it is a regular file of root or of
the installation's owner, and keeps the wizard's answers (those of `sudo ./install.sh` too) in a
temporary folder only root can read, never under `user_db/`. A `config.json` file put back in place of the link (an edit with
`sed -i`, for example) wins: the next `service install` moves it over the old one and restores
the link. Platform secrets found in `config.json` (`app.session_secret`, `app.encryption_key`,
`rag.service_token`) are moved to their files at each `service install`: `deploy/configure.py
--ranger-secrets`, run under the account that owns `config.json`, takes them out of it and out of
`config.json.bak` and hands them over through a pipe; root writes `.session_secret` and
`.encryption_key` next to the database, the RAG token in its file, never through a link and never
at a path taken from `config.json` (targets checked first: if one is a link, nothing is moved).
With one account per service, a missing session secret is created there (`0640 root:elpis-cle`),
so that main and the console share it.

## Service accounts

`sudo ./elpis service install` runs each service under its own system account (no shell, no
password), so that a flaw in one service does not hand over the files of the others:

| Service | Account |
|---|---|
| main | `elpis-main`, primary group `elpis-donnees` |
| admin (console) | `elpis-admin`, primary group `elpis-donnees` |
| toolhost | `elpis-toolhost`, primary group `elpis-donnees`, home `/var/lib/elpis-toolhost`; the only unit that gets the `docker` group (`SupplementaryGroups=docker`) |
| rag | `elpis-rag`, primary group `elpis-rag`; cache in `/var/cache/elpis-rag` (`CacheDirectory=`); a static account, since `DynamicUser=` would impose `RestrictSUIDSGID=`, which bubblewrap does not survive |
| qdrant | a dynamic account (`DynamicUser=yes`), storage in `/var/lib/elpis-qdrant` (`StateDirectory=`: systemd keeps it in `/var/lib/private/elpis-qdrant`, where `service install` moves `rag_app/qdrant/storage` once, the folder given back to root first so that systemd hands the whole tree to the dynamic account at the next start; back to one account, the storage returns to `rag_app/qdrant/storage`, to that account) |

| Group | Members | For |
|---|---|---|
| `elpis-donnees` | `elpis-main`, `elpis-admin`, `elpis-toolhost`, the operator | shared state: database and `user_db/`, sandboxes, `logs/`, `/run/elpis` |
| `elpis-cle` | `elpis-main`, `elpis-admin` | remote backup credentials; without [keys handed by systemd](#platform-keys), also the vault key, legacy encryption key and session secret: never the tool host |
| `elpis-journal` | `elpis-main`, `elpis-admin`, `elpis-toolhost` (writers), `syslog` (reader) | security journal, access log; without keys handed by systemd, also the signing key |
| `elpis-rag` | `elpis-main`, `elpis-admin`; primary group of `elpis-rag` | RAG store (main and the console write it, the RAG reads it); without keys handed by systemd, also the RAG token |

The **operator** is the account that administers Elpis: `ELPIS_USER`, otherwise the account
that ran `sudo`, otherwise the owner of the installation. It owns the code, joins
`elpis-donnees` (taken by a new session: `./elpis doctor` reads the services' files through it)
and is no longer added to the `docker` group nor to the key groups. It runs no code of the
application on the services' configuration: without their keys, the core would create new ones
next to the database. The commands that run it ask for `sudo` (`sudo ./elpis db info`,
`sudo ./elpis backup`, `sudo ./elpis vault status`, `sudo ./elpis secret ls`, `sudo ./elpis audit
verify`, `--key` included, `sudo ./elpis configure`); `./elpis doctor` skips the core's checks (file
locks, database, LLM server, RAG, vault), which `sudo ./elpis doctor` runs. The checks of the tool
host bundle (`./elpis doctor`, the installer) run as the tool host does (`APP_SERVICE=toolhost`,
which never reads nor creates the session secret), and the bubblewrap probe reads no
configuration. An `elpis-*` account that already exists must be a system account without shell (uid 1
to 999, `nologin` or `false`): otherwise `service install` stops.

Root runs no code of the application. Every call `./elpis` makes under `sudo` to the core
(`exploitation.mjs`: settings, migrations, vault, backup, doctor checks), to the tool host, to the
browser service or to `deploy/configure.py` and `deploy/wizard.py` goes through one function,
`app_console`, which runs it under the console's account, from the installation folder, with an
environment built for it (the console unit's paths and groups, `.env`; never passed on a command
line) and never root's terminal (`sudo ./elpis configure` gets a new pseudo-terminal). With
systemd 250 or later, it is a transient unit (`systemd-run --wait --pipe --collect`, user
`elpis-admin`, group `elpis-donnees`) that receives the console's [platform keys](#platform-keys)
from systemd and the console unit's hardening (no new privileges, no capability, system read-only
except the console's folders, `ProtectHome=` of the installed console unit, private `/tmp`, `/dev`
and IPC, no namespace, same memory and task limits; only the bubblewrap probe of `./elpis doctor`
runs without the settings bubblewrap cannot live with); its
environment goes through a file only root can read (`EnvironmentFile=`, removed afterwards), never
through the unit's properties. Older systemd: `runuser -u elpis-admin`. Root reads no path from `config.json`: the data folders it prepares come
from `.env` (or root's environment) and the installation's defaults, and the units fix them for
the services (`APP_SANDBOX_DIR`, `APP_DB_PATH`, `RAG_STORE_DIR`, `APP_MEMORY_DIR`,
`APP_SKILLS_DIR`, `APP_USER_SKILLS_DIR`, `APP_SKINS_DIR`, `MCP_SERVERS_DIR`,
`APP_FILE_HISTORY_DIR`, `APP_OFFICE_CACHE_DIR`, `CHART_CACHE_DIR`), so that a path setting of
`config.json` has no effect: `service install` and `./elpis doctor` warn about each one that
differs, with the line to put in `.env`. A mounted remote backup destination outside these
folders is reported too: open it to main and the console with a drop-in
(`sudo systemctl edit elpis-main elpis-admin`, `ReadWritePaths=`). `.env` must be absent or a
regular file of root or the operator, with one link, that no service account can write or
replace (nor its folder): otherwise these commands stop. `./elpis start` and `restart` refuse
to run under such units, as root or as the operator (`sudo systemctl start|restart
elpis.target`); `./elpis upgrade` refuses root and runs from the operator's account: the backup
and the restart ask for `sudo` by themselves, and it ends with `sudo ./elpis doctor`.

What root starts under another account never gets root's terminal: each command runs in a
session of its own (`setsid`), its input is `/dev/null` when it is a terminal, and its outputs,
to a terminal, a pipe or the installer's log alike, go through a one-pass filter
(`deploy/droits.py filtre`: OSC, DCS, APC, PM, SOS and C1 controls dropped, other escape
sequences too except colours, other control characters shown as `?`; nothing removed can
rejoin into a sequence); only a backup archive passes as it is. `sudo ./elpis configure` gets
a new pseudo-terminal (`runuser --pty`) whose screen keeps its cursor sequences but loses the
OSC, DCS, APC, PM, SOS and C1 ones. The console's commands run with umask `0007`. Under units
with one account per service, `service install` first stops every Elpis unit, so that no
running service can kill or trace the probes it runs under the services' accounts, and limits
`ptrace` to a process's own descendants (`kernel.yama.ptrace_scope = 1` in
`/etc/sysctl.d/05-elpis-ptrace.conf`, applied at once, only when the value is `0`; Ubuntu's
default, a setting of the whole host; the file sorts first, so a stricter value of another
file wins at boot); `service remove` and the return to one account remove the file (the
kernel's value comes back at the next boot) and `./elpis doctor` checks the value. The messages of `./elpis` and `deploy/droits.py` replace
control characters (line breaks included) by `?`: a file name chosen by a service adds no line
to the terminal or a log. Root takes from the core only values it can check: the unit of the
local database is `postgresql.service` or `postgresql@<version>-main.service`, anything else
stops `service install`; a unit's command must start with an absolute path. PID files are read
without following links (a regular file of digits), and root signals the process alone, never
its group; under one account per service, a service's PID file only leads to a process of that
service's account. Files the services write are read by root as regular files only, without
following links or waiting, with a size limit: `config.json` (through the one link
`service install` sets), the logs (`./elpis logs` under `sudo`, or with one account per service:
50 last lines, 1 MiB at most, filtered as above; `journalctl` keeps its own pager on a
terminal): a FIFO, `/dev/zero` or a device that acts when opened blocks or triggers nothing.

Rights are set again at every `service install`, services stopped, by `deploy/droits.py`, at
the very moment they are set (no verdict kept from earlier): each folder is opened component by
component from `/` without following any link, and refused if a service account could replace
one of its parent folders (owner, write right of its group or of everyone, unless the sticky bit
protects an entry that is not a service's), or if it is a mount point owned by a service; the
walk never crosses into another file system and never enters the `work/` folder of a sandbox
(owned by the sandboxes' user). Folders that overlap (the same, one inside the other) are
refused, except the RAG store inside the database folder. Inside each folder, only entries of
the operator and of former single accounts are taken over, plus root's folders: never a file of
root or of a service account, which a service could have moved there. Every walk leaves the
secrets, the relay authority, `run/chat_runs` and `run/task_resume` to their own line below:

| Path | Rights |
|---|---|
| `user_db/` (and the folder of `app.db_path`, when `APP_DB_PATH` in `.env` names it too) | `2771 root:elpis-donnees`; content group `elpis-donnees`, `g+rwX`, nothing for others |
| `.vault.key`, `.encryption_key`, `.session_secret` (and their `.lock`) | `0640 root:elpis-cle`; with [keys handed by systemd](#platform-keys), moved into `/etc/elpis/credentials/` (a fallback vault key kept for `vault rekey` stays here) |
| `.local_mcp_token` | `0640 root:elpis-donnees` |
| RAG token | moved from `user_db/.rag_service_token` (which `./elpis configure` may write again: it then wins at the next `service install` if it belongs to the operator, has one link and nobody else can write it; read through its descriptor, copied, then removed) to `/etc/elpis/rag.token`, `0440 root:elpis-rag` (`RAG_SERVICE_TOKEN_FILE` of main, the console and the RAG); with keys handed by systemd, to the key `rag.token`; a copy left in `user_db` (refused, or written again) is closed to its owner (`0600`), never shared |
| RAG store (`user_db/rag` by default) | `2770 elpis-main:elpis-rag`, content group `elpis-rag`, `g+rwX`; read-only in the RAG unit |
| `.db_password*` | `0640 elpis-admin:elpis-donnees` (the console rewrites it) |
| `.backup_ssh_key`, `.backup_rsync_password` | `0640 elpis-admin:elpis-cle` (main runs the scheduled remote backups) |
| `.backup_known_hosts` | `0660 elpis-admin:elpis-cle` (OpenSSH, run by main or the console, adds new hosts to it) |
| `user_db/browser-relay-ca/` | `0700 elpis-toolhost` |
| `user_db/run/chat_runs/`, `user_db/run/task_resume/` | `0700 elpis-main`, content included |
| `mcp.json`, `toolhost.json` | `0640`, operator, group `elpis-donnees` |
| `/etc/elpis/config/` (`config.json`, `.bak`, `.lock`) | folder `2750 elpis-admin:elpis-donnees`, files `0640 elpis-admin:elpis-donnees`, `config.json.bak` `0600` (console only) |
| `system_prompts/`, `skills/` | operator, group `elpis-donnees`, `2770`, content `g+rwX` |
| sandboxes (`user_sandboxes/`) | `2770 root:elpis-donnees`; content `g+rwX`, except each `work/` and `.elpis-agent/` |
| `logs/`, data folders outside the installation | `2770 root:elpis-donnees`; content `g+rwX` (outside the installation, only the content of Elpis accounts; folders accepted as below) |
| `backups/` | `0700`, operator and its primary group, content included: only `./elpis backup` writes it (with one account per service, under `sudo`; the archive is then handed to the operator); the services never reach it |
| `/etc/elpis` | `0751 root:root` (keys protected one by one) |
| `/etc/elpis/credentials/` | `0700 root:root`, each key `0600 root:root`, encrypted by `systemd-creds` ([Platform keys](#platform-keys)) |
| `/etc/elpis/vault.key` | `0440 root:elpis-cle` (without keys handed by systemd) |
| `/etc/elpis/audit.key` | `0440 root:elpis-journal` (without keys handed by systemd) |
| `/var/lib/elpis/audit`, `/var/log/elpis` | `2770 root:elpis-journal`, files `0660` |
| `/run/elpis` | `2770 root:elpis-donnees` (systemd-tmpfiles) |

Folders named by the settings (`.env`; with one account for every service, `config.json` too)
are used by root, for rights and for the units' `ReadWritePaths=`, only if they are, inside the
installation, one of its state folders (`user_db`, `user_sandboxes`, `logs`, `user_skins`,
`user_skills`) or a folder below them and, elsewhere, a folder that already exists and belongs to
`root:elpis-donnees` or to an Elpis account (the default MCP folder next to the installation is
created); never `/`, the installation or one of its parents, a home folder, nor a system or Elpis
folder. A refused folder is
reported at each `service install` and left as it is: create it yourself
(`sudo install -d -o root -g elpis-donnees -m 2770 /srv/elpis-data`), then run `service install`
again. With one account for every service, a folder of that account is accepted too, and each
pass gives the state folders back to it (`0700`), content left by the Elpis accounts included;
coming back from one account per service, this is the first step, before any key is written
into them. A non-empty folder of root goes to that account only if nobody else can write its
parent (no write for group or others, or a parent of that account written by its private group).
Under units with one account per service, `sudo ./install.sh` leaves the owners and groups of the
state folders alone.

The units of main, the console and the tool host get umask `0007` (the code sets the modes of
what the tool host shares with the sandboxes itself), `ELPIS_GROUPE_DONNEES=elpis-donnees` (the
services then create their shared files for the group) and `ELPIS_COMPTES` (the mode, shown by the
console and `./elpis doctor`); main and the console also get `ELPIS_GROUPE_CLE=elpis-cle`, the group
of the remote backup credentials the console writes. The tool host reads the Playwright browsers
from `PLAYWRIGHT_BROWSERS_PATH`, by default the operator's `~/.cache/ms-playwright`. When its
account cannot reach that cache (a closed home folder), `service install` copies it, if the copy is
missing or lists other browsers, to `/var/lib/elpis-toolhost/ms-playwright` (owner `elpis-toolhost`,
folders `0755`, files `0644`, programs `0755`: the sandboxes' user reads them through their mount)
and points the tool host at the copy; new browsers are copied at the next `service install`. A
`PLAYWRIGHT_BROWSERS_PATH` set in `.env` wins in the unit: that folder must then be reachable by
other accounts.

### An installation other accounts can reach

The service accounts read the code: every folder from `/` down to the installation must let
other accounts through (`o+x`), and the code must be readable by them (Playwright browsers out
of their reach are copied, above). A clone in a home folder is not (`/home/<name>`
is 0700 on Debian, 0750 on Ubuntu): `service install` then keeps one account for every service,
as before (fallback mode, `ELPIS_COMPTES=repli`), says why, and `./elpis doctor` warns at every
run. This fallback only happens on a first installation: once units with one account per
service are installed, or the `elpis-main` account exists, a closed folder or a failed probe
stops `service install` with the reason and leaves the units as they were (a service must not
be able to force the fallback); one account is then chosen only explicitly
(`sudo ELPIS_COMPTE_UNIQUE=1 ./elpis service install`). For a server, install in `/opt/elpis`:

```bash
sudo install -d -o "$USER" /opt/elpis
git clone https://github.com/toto-fou/Elpis.git /opt/elpis && cd /opt/elpis
./install.sh --service
```

For an existing installation, either let other accounts through its parent folders
(`chmod o+x /home/alice`: they can then reach paths they know, not list the folder; the files
keep their own rights), or move it: stop the services (`sudo systemctl stop elpis.target`),
move the folder, remove `venv/` (its scripts carry the old path), check the absolute paths of
`config.json` (`sandbox_dir`, `app.db_path`…), then run `./install.sh --yes --service` from the
new place. Then run `sudo ./elpis service install` again: each pass converges to the mode
in force, with no other command.

To keep one account on purpose: `sudo ELPIS_COMPTE_UNIQUE=1 ./elpis service install`
(`ELPIS_COMPTES=unique`; `ELPIS_USER` then names that account, `./elpis doctor` only reports
it). `service remove` keeps the accounts and groups.

## Platform keys

With one account per service and systemd 250 or later (with `systemd-creds`, part of systemd on
Debian 12/13 and Ubuntu 24.04), the keys of the platform no longer sit in files that a group of
accounts can read: `sudo ./elpis service install` encrypts each of them with
`systemd-creds encrypt --with-key=auto` into `/etc/elpis/credentials/` (folder `0700 root:root`,
each key `0600 root:root`), and systemd hands each unit only the keys it uses, decrypted for that
unit alone (`LoadCredentialEncrypted=`, read from the unit's `$CREDENTIALS_DIRECTORY`):

| Key | Units | Variable given to the code | Taken over from |
|---|---|---|---|
| `vault.key` | main, the console | `ELPIS_VAULT_KEY_PATH` | `/etc/elpis/vault.key`; when only the fallback `user_db/.vault.key` exists, it becomes the key (same secrets, no rekey); when both exist, the fallback stays for `vault rekey --from`; none: created |
| `encryption.key` | main, the console | `APP_ENCRYPTION_KEY_PATH` | `user_db/.encryption_key` (next to the database), or `app.encryption_key` of `config.json`; none: created, in the format the core creates |
| `session.secret` | main, the console | `APP_SESSION_SECRET_FILE` | `user_db/.session_secret`, or `app.session_secret` of `config.json`; none: created |
| `audit.key` | main, the console, the tool host | `ELPIS_AUDIT_KEY_PATH` | `/etc/elpis/audit.key`; none: created |
| `qdrant.key` | main, the console, Qdrant | `QDRANT_API_KEY_FILE` (Qdrant: `QDRANT__SERVICE__API_KEY`, set by `deploy/qdrant/lancer.sh` from its credentials) | `rag.qdrant_api_key` of `config.json`; none: created (48 random characters) |
| `rag.token` | main, the console, the RAG | `RAG_SERVICE_TOKEN_FILE` | `rag.service_token` of `config.json`, `/etc/elpis/rag.token` or `user_db/.rag_service_token`, while no token is in service (`./elpis configure` no longer writes that file once the units receive the key); none: created |

The tool host never receives the vault key, the encryption key nor the session secret, the RAG
its token only; rsyslog (`elpis-journal`) reads the log files only, no longer the signing key;
`elpis-cle` keeps the remote backup credentials only, `elpis-rag` the RAG store only. Qdrant then
refuses any request without its key (its health endpoints `/healthz`, `/livez` and `/readyz` stay
open); with one account for every service, and with `./elpis start`, Qdrant keeps running without
a key, as before. Without such a systemd (or with one account for every service),
the files of [Service accounts](#service-accounts) stay, and `./elpis doctor` says so.

**Taking keys over.** At each `service install`, services stopped, a plaintext key found at its
former place is read without following links (a regular file with one link, belonging to root,
the operator or a former single account, that nobody else can write), encrypted through a pipe
(never a plaintext temporary file, never a command line), decrypted again and compared, and only
then removed: no plaintext copy stays on the machine. A file that does not qualify is reported and
left as it is, and no new key replaces it. A plaintext file that differs from a key already in
service is left too, with a warning: keep the right one (copy it off the machine first), remove
the other, run `service install` again. Values of `config.json` (`app.session_secret`,
`app.encryption_key`, `rag.service_token`, `rag.qdrant_api_key`) come first and fill only a key
that is missing: a session secret of 40 characters at least, a token or key of 32, an encryption
key in the Fernet format; a value that differs from the key in service, or is refused, stays in
`config.json` with a warning (remove it). They are taken in two steps: `deploy/configure.py
--ranger-secrets --sortie - --garder` hands them over without removing them, root writes and checks
the keys, then `--ranger-secrets --retirer` removes from `config.json` only the values written or
equal to the key, if unchanged. A second pass changes nothing.

**Copy off the machine.** The backups of Elpis no longer contain these keys (they were in
`user_db/`). Keep a copy of the vault key, the encryption key and the signing key off the machine
(offline medium, the administrators' password manager), away from the backups:

```bash
sudo sh -c 'umask 077; systemd-creds decrypt --name=vault.key /etc/elpis/credentials/vault.key FILE'
sudo sh -c 'umask 077; systemd-creds decrypt --name=encryption.key /etc/elpis/credentials/encryption.key FILE'
sudo sh -c 'umask 077; systemd-creds decrypt --name=audit.key /etc/elpis/credentials/audit.key FILE'
```

`umask 077` creates `FILE` readable by root only: write it to the offline medium. `service install`
prints the command when it creates or takes over one of these keys, `vault setup` and
`audit setup` always.

**TPM.** With a TPM2 (and outside a container), `--with-key=auto` binds each key to the TPM2 and to
the host key `/var/lib/systemd/credential.secret`: the keys can then only be decrypted on this
machine. They are bound to no PCR (`--tpm2-pcrs=`, set explicitly: systemd 250 to 257 bind to PCR 7
by default, so a Secure Boot change such as a db/dbx update would have made every key unreadable at
the next boot; this is not verified on a real or virtual TPM yet). Clearing the TPM, replacing the motherboard (or the virtual TPM of a VM), or losing
`/var/lib/systemd/credential.secret` makes them unreadable; `./elpis doctor` reports it and the
units, like the commands `sudo ./elpis` runs under the console's account, fail to start.
Recovery: put the copies made off the machine back at their former places (table below), then run
`sudo ./elpis service install`, which encrypts them again (an unreadable key is replaced by its
plaintext file). Without a copy, remove the unreadable key (`sudo rm
/etc/elpis/credentials/NAME`) and run `service install`, which creates a new one: the secrets of a
lost vault key must then be entered again. Without a TPM2, only the host key protects them: a copy
of the disk that includes `/var/lib/systemd/` holds both.

**Restoring on another machine.** Put each plaintext key back at its former place, then run
`sudo ./elpis service install`:

| Key | Place (root, `0600`) |
|---|---|
| `vault.key` | `/etc/elpis/vault.key` |
| `encryption.key` | `.encryption_key` next to the database (`user_db/` by default) |
| `session.secret` | `.session_secret` next to the database (without it, a new one is created: sessions are closed) |
| `audit.key` | `/etc/elpis/audit.key` |
| `rag.token`, `qdrant.key` | not needed: new ones are created |

**Back to one account, `service remove`.** `sudo ELPIS_COMPTE_UNIQUE=1 ./elpis service install`
decrypts each key back to its file of the single account (`/etc/elpis/vault.key` and
`/etc/elpis/audit.key` `0440`, root and the key group; `.encryption_key` and `.session_secret`
`0600` next to the database and the RAG token to `user_db/.rag_service_token`, `0600`, all three to
that account, the state folders being given back to it first; the Qdrant key is dropped, Qdrant
running without one), then removes `/etc/elpis/credentials/`; `service remove` does the same for
the operator, so the next `service install` takes the token over again. A file already there that differs keeps the key in the folder, with a
warning. Both can be run again.

**Commands.** Under `sudo`, the commands that need a key (`vault status`, `vault rekey`,
`secret ls`, `audit verify`, `doctor`, `backup`) run in the console's transient unit, which
receives its keys from systemd. For `vault rekey --from FILE`, root checks `FILE` (a regular file
of root or the operator, one link) and hands a copy of it to that unit (`LoadCredential=`): a copy
only root can read works. Without `sudo`, these commands say `lancez sudo ./elpis …`
([Service accounts](#service-accounts)); under `sudo`, `audit verify --key FILE` reads `FILE` as
the console's account (a copy it can read, outside `/tmp`).

**What `./elpis doctor` checks.** The systemd version, that each key is there and that
`systemd-creds` decrypts it (under `sudo`), that each unit carries the keys it uses and no other,
and that no plaintext key is left in `/etc/elpis` or next to the database. Without `sudo`, the
core's checks, the RAG's included, are skipped: the operator runs no code on the services'
configuration (`sudo ./elpis doctor` runs them with the console's keys).

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
# socle: Python and its venv, downloads, certificates, git updates, bubblewrap jail
sudo apt install --no-install-recommends python3 python3-venv git curl \
    ca-certificates openssl bubblewrap
# sandbox: Docker for the users' sandbox (terminal, code execution)
sudo apt install --no-install-recommends docker.io docker-cli xz-utils
# apercus-office: LibreOffice in a bubblewrap jail (Word, Excel, PowerPoint previews)
sudo apt install --no-install-recommends \
    libreoffice-writer-nogui libreoffice-calc-nogui libreoffice-impress-nogui \
    fonts-dejavu fonts-liberation fonts-crosextra-carlito \
    fonts-crosextra-caladea
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

The browser needs no apt package on the host: the Chromium headless shell only
runs inside the sandboxes, whose image carries its libraries and fonts. An
installation made before keeps the packages of the former `navigateur` group:
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
  (`main.mjs`, `exploitation.mjs`, the RAG chunking thread
  `decoupage-fil.mjs`, the image thread `pixels.mjs` and its
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
- The browser only runs in the sandboxes now. What the former central browser
  service left (its data in `user_db/browser/` or in folders of
  `browser-service/` such as `cookies/`, the token
  `user_db/.browser_service_token`, the packages of the former `navigateur` apt
  group) is no longer used and stays in place: delete it by hand if you wish
  (saved states keep session cookies). Run `sudo ./elpis service install` once
  after the upgrade: it removes the old `elpis-browser` unit, which would
  otherwise keep restarting (the service no longer starts outside a sandbox).

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

## Deleted accounts and their sandbox folder

Deleting an account, with or without its sandbox, always runs in the same order, so that an account created later
under the same name never inherits anything of the old one:

1. Access is cut (sessions revoked, container removed by the tool host of this machine: the console never runs
   Docker; if that host does not answer, the account is not deleted).
2. The sandbox folder and its snapshots (`user_sandboxes/_snapshots/<name>`) are renamed
   `.supprime-<account id>-<timestamp>` in the sandbox directory (`user_sandboxes/`), locally and on the remote
   tool host of the account. If a rename fails, the account is not deleted, everything is put back and the console
   reports a failure: retry once the host answers.
3. The site credentials of the account are removed on every declared tool host that has a URL and a service token
   (a host without them holds none and is skipped). If a host cannot be reached or fails, the account is not deleted, everything is put back and the failing host is named in the
   server log: fix it, or remove the host from the manifest, then retry.
4. The account is deleted from the database. If that fails, the renamed folders are put back; if the account was
   already deleted by a concurrent request, nothing is put back.
5. With the sandbox (`delete_sandbox=true`), the renamed folders are then deleted, locally and on the remote host;
   a `/work` that the console cannot empty (files owned by the container's UID) is emptied by the tool host of this
   machine. A failure here does not bring the account back: the console reports the reason (`sandbox_error`) and the
   renamed folders stay out of reach of any account name until an administrator deletes them on the host.

Without the sandbox (the console default), the renamed folders are kept: an administrator can recover files from
them on the host (or delete them); they are not listed anywhere in the console.

Account names cannot start with `_` (the sandbox directory keeps `_snapshots` there); an older account whose name
does, when deleted, never has its folders renamed or deleted.

## Backing up and restoring

| Method | Use |
|---|---|
| `./elpis backup [full\|db\|sandboxes\|mcp] [--dest DOSSIER]` | archive in `backups/` (file 0600, folder 0700 if created; with one account per service, `sudo ./elpis backup`, without `--dest`: the core runs under the console's account, builds the archive in `/var/tmp` and writes it to its output, which root stores in `backups/` and hands to the operator; `./elpis upgrade` takes its backup through `sudo`); each account's `/work` is read through the tool host, which must be running (`./elpis start`; it starts a sleeping sandbox for the duration of the read); without it, each sandbox line says its `/work` was not saved; exit code 1 if the database is missing from the archive, 3 if the archive is made without the `/work` of at least one account (tool host stopped or sandbox unreadable; `./elpis upgrade` then continues) |
| Admin console › System › Data › Backup | download of the same archive |
| Admin console › System › Maintenance › Remote backup | scheduled upload: SFTP (key), rsync over SSH, or a mounted folder |
| Admin console › System › Data › Restore | full archive or by scope |

With one account per service (see [Service accounts](#service-accounts)), a restore from the
console recreates the restored files under the console's account: run
`sudo ./elpis service install` afterwards, which gives each file back its owner and rights.

The full archive contains the database (SQLite snapshot, whatever the engine),
`user_db/` (including the encryption key, the session secret and, while no vault
key is set up, the fallback key of the secrets vault: protect them
accordingly, and the RAG store `user_db/rag`: uploaded documents and extracted
texts), the sandboxes, the MCP servers, the skins, the personal skills
store and the security journal (`audit/`, see
[Security journal and log forwarding](#security-journal-and-log-forwarding)). In the sandboxes, only regular files are backed up; other entries are
listed in `backup-warnings.txt`.

In `user_db/`, a link to a file is never followed: it is listed in `backup-warnings.txt`. With one
account per service, the archive does not hold the tool host's private browser relay authority
(`user_db/browser-relay-ca/`, its account's alone, listed as unreadable): it is created again when
missing, and the sandboxes' browsers then trust the new one.

Not included, to be backed up separately: `config.json`, `.env`, `mcp.json`,
the key of the secrets vault (`/etc/elpis/vault.key`, see
[Secrets vault key](#secrets-vault-key)),
the browser's saved states (`browser-service/cookies/`), a RAG store placed
outside `user_db/` (`rag.store_dir`); what is specific to the machine
(`.db_password`, state of a database switch); logs, PID files and the
extractor cache (`user_db/logs/`, `user_db/run/`, `user_db/rag-cache/`), neither
backed up nor restored. The Qdrant index (`rag_app/qdrant/storage/`, or
`/var/lib/elpis-qdrant/storage/` with one account per service) is not
there either: after a restore on another machine, Admin console › Models & services ›
RAG › Embedding model change › "Reindex all collections" (checkbox "Even those
already using this model") rebuilds it from the store's extracted texts.

A restore from the console that replaces the database (**Full** or
**Database** scope) cuts every session (global cut in `config.json`) as soon
as the database is replaced, before the rest of the archive is written (an
error in the rest leaves them cut): the administrator who ran it sees the
result, then the page reloads on the sign-in screen (with errors, the message
says so and the next action leads there). The accounts come back as they were
in the archive, and the confirmation says so: suspensions, token revocations
and password changes made since the backup are undone, make them again after
the restore. SSO accounts are checked again by their provider at their next
sign-in.

The `*.lock` files in `user_db/`, in the sandboxes and in `skills/` are locks
in use: useless in a backup, taken over automatically if their process has
disappeared, and can be deleted with services stopped (like the
`*.lock.perime.*` and `*.lock.rendu` files that a hard stop can leave).

```cron
# Full backup every night at 3 a.m., under the application account (with one
# account per service, in root's crontab); archives older than 14 days are deleted.
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
| `/var/lib/elpis/audit` and `/var/log/elpis` | Mode `2750`, owned by the service account and the group above, never readable by everyone; with one account per service, `2770`, root and the group above, which the three writers join (files `0660`). The first holds the security journal, the second the access log |
| `/etc/elpis/audit.key` | Signing key (0440, root and a group holding the service account only: its own primary group, or `elpis-cle`, name set by `ELPIS_GROUPE_CLE`; with one account per service, `elpis-journal`). Created if missing or empty, never replaced. With one account per service and systemd 250 or later, no plaintext file: `/etc/elpis/credentials/audit.key`, created in memory and encrypted, handed by systemd to the three writers only ([Platform keys](#platform-keys)). **Back it up off the machine**: without it, signatures can no longer be checked |
| Existing `logs/audit` | The files of an earlier installation are moved to `/var/lib/elpis/audit` (a file of the same day is appended to). While the services run, the files of today and yesterday stay where they are: stop them (`./elpis stop`, or `sudo systemctl stop elpis.target`) and run the command again |

Run it again after changing the service account, after stopping the services to finish the move
of `logs/audit`, and whenever `./elpis doctor` or the console asks for it. Without it, the journal
falls back to `logs/audit` in the repository, and its lines are unsigned if the key is missing.

The service account is the `User=` of the installed units, otherwise `ELPIS_USER`, otherwise the
account that ran `sudo`; it is never root. With one account per service (units installed in that
mode, see "Service accounts"), the command sets that layout, whatever `ELPIS_USER` says. From a root shell (`su -`, `sudo -i`) there is no
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
| 2 | Bad command line; `--key` missing, unreadable or shorter than 32 bytes; or signed lines and no readable key (the default key is readable by the service account only: run the command as that account, or pass `--key`; with one account per service, `sudo ./elpis audit verify`, `--key` included) |
| 3 | `non_verifie` (unsigned lines, unknown key, start or end of the journal not established, reason printed) or `vide` (nothing in the period) |

The command is itself written to the journal (`cli.audit.verify`). The same check is available in
the console (Monitoring › Logs › Security › Verify integrity). On a central copy, use the same
command with `ELPIS_AUDIT_DIR` and `--key` (see the rsyslog README).

### What `./elpis doctor` checks

- the two folders: mode `2750`, service account, group `elpis-journal` (or `adm`), or `2770` root
  with one account per service; the fallback
  folder `logs/audit` in use, or files left in it;
- the key: 0440 root, group reserved to the service account (to the three writers and `syslog`
  with one account per service), readable by each writer, 32 bytes at least
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
`/etc/elpis` (0750); with one account per service, group `elpis-cle` (main and the console only)
in `/etc/elpis` (0751). The service account is found as for `audit setup`. Safe to run again: an
existing key is kept, never replaced, and its owner and mode are applied again. The key is checked
by the core itself, with the rule the services apply (canonical base64 or 64 hexadecimal digits,
32 bytes, not a single repeated byte): an invalid key is refused and left as it is. The command
therefore needs the core bundle (`./install.sh`). The services read the key when they start, and
`sudo ./elpis service install` hides it from the units other than `main` and `admin`.

With one account per service and systemd 250 or later, `vault setup` writes no plaintext file: an
existing `/etc/elpis/vault.key` is checked by the core, encrypted into
`/etc/elpis/credentials/vault.key`, then removed (kept while the installed units still read it:
the next `sudo ./elpis service install` gives them the key and removes it; `audit setup` does the
same with the signing key); otherwise the key in place is kept, or a new one is created in memory
and encrypted directly. It then prints the command that copies it off the machine
([Platform keys](#platform-keys)).

If secrets were saved before, under the fallback key, re-encrypt them once the services have
restarted, then delete the fallback:

```bash
./elpis vault rekey --from user_db/.vault.key
./elpis vault status          # exit code 0: every secret uses the current key
rm user_db/.vault.key
```

`rekey` also renews the test fingerprints of the OpenID Connect single sign-on providers whose registered
secret is unchanged: these providers stay active after a key change.

With one account per service, the operator cannot read the key: prefix these commands with
`sudo` (they then run under `elpis-admin`).

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
`/etc/elpis/vault.key` (nor `/etc/elpis/credentials/vault.key`: `sudo systemd-creds decrypt
--name=vault.key /etc/elpis/credentials/vault.key FILE` copies it, see
[Platform keys](#platform-keys)). **Back the key up separately, off the machine** (offline medium,
administrators' password manager): without it, the secrets cannot be decrypted and must be
entered again. Keep it away from the backups: whoever holds a backup and the key can read every
secret. The fallback `user_db/.vault.key` is inside the backups, which is why `./elpis doctor`
warns while it is in use.

### Changing the key

1. Keep a copy of the old key, readable by the service account (`rekey` runs under it), for
   example `sudo install -m 0400 -o <account> /etc/elpis/vault.key /home/<account>/vault.key.old`.
   With keys handed by systemd, a copy only root can read is enough (`sudo ./elpis vault rekey
   --from /root/vault.key.old`: root checks it and hands it to the console's transient unit).
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

- with keys handed by systemd, `/etc/elpis/credentials/vault.key` (see
  [Platform keys](#platform-keys)); otherwise
- `/etc/elpis/vault.key`: 0440, root, group reserved to the service account (to main and the
  console with one account per service), readable by each of them. Run
  under the service account, a session opened before the account joined that group cannot read it
  (the services started from it could not open the vault): the doctor says so, as for the key of
  the security journal;
- the key in use, as the core sees it: a warning for the fallback `user_db/.vault.key`, for a key
  that cannot be read or is invalid, for secrets encrypted with another key
  (`./elpis vault rekey`), and for secrets left without any key (restore it).

## SSO (OpenID Connect): emergency exit

Settings: [configuration.md](configuration.md#openid-connect-single-sign-on-auth); setup guide and troubleshooting:
[sso-oidc.md](sso-oidc.md). Three commands run on the host,
with the core bundle, as the service account (with `sudo` they switch to it):

| Command | Role |
|---|---|
| `./elpis auth status` | Public address, local password mode, whether the secure connection (https) holds as of the next start of the services, number of active administrators with a local password, and for each provider: id, type, switched on, active (`non (inopérant)` when switched on but not active), tested |
| `./elpis auth off` | Switches off every provider, reopens the local password to every account (`auth.local.mode` back to `all`), cuts the sessions of every account attached to a provider recorded in the database, whatever the file says (run it again if the database was unreachable), and writes `auth.cli.off` to the security journal. Nothing else in `config.json` changes; no restart is needed |
| `./elpis auth reactivate <account>` | Lifts the suspension of an account through the same function as the console (sessions opened during the suspension stay refused) and writes `auth.cli.reactivate` to the security journal, a failed attempt (unknown account, account not suspended) included. The way back in when every administrator is suspended |

The provider test (console) warns when a target address is one of this machine's own: that is allowed (an identity provider installed on the same host is legitimate), but the address is then not that of a separate server.

At least one active administrator with a local password must always remain: suspending, deleting
or demoting the last one, switching the local mode to `admins` or switching a provider on is
refused otherwise. An account created by a provider has no local password (it cannot sign in or
change one with a password), so keep an administrator that has one.

## Browser in the sandbox

The browser runs only inside each account's sandbox (see `docs/configuration.md`, "Controlled
browser"); there is no browser service on the host. It needs:

1. Docker and the image `elpis/sandbox:1.8.0`: `./install.sh --sandbox build` (or
   `deploy/docker/sandbox/build_offline.sh`, which builds 1.7.0 then the browser layer of
   `deploy/docker/sandbox-browser/`); offline, `deploy/docker/sandbox/load_image.sh
   elpis-sandbox-1.8.0.tar.gz`. Existing containers are recreated on it at their next use
   (`/work` is kept), and once more when the browser is installed after them (its mounts).
2. The browser installed (`./install.sh --with-browser`): the service bundle
   (`browser-service/dist/main.mjs`, built by the installer from `browser-service/src`, shipped
   prebuilt in the offline package; `./elpis upgrade` rebuilds it), its `node_modules`
   (Playwright), the Node runtime and the Playwright cache (Chromium headless shell), mounted
   read-only in the sandboxes and readable by the sandbox UID 10001 (nothing else of
   `browser-service/` is mounted; `chmod o+rx browser-service/node_modules browser-service/dist`
   if they were created 0700). `./elpis doctor` checks that the bundle matches the sources.
3. Preferably two CPUs per sandbox (`"executors": {"limits": {"cpu_quota_pct": 200}}`):
   Chromium shares the sandbox's CPU quota, and at the default 100 % a step screenshot (off by
   default, turned on per account in Settings › Chat) of a heavy page can miss its 3 s delay
   (none at 200 %; `./elpis doctor` warns).

Without one of them the `pw_*` tools answer `browser_sandbox_unavailable` with the cause and its
fix. `browser.mode` and `browser.sandbox_users` from earlier versions are ignored.

**Relay CA.** `user_db/browser-relay-ca/` (or `ELPIS_BROWSER_CA_DIR`): `ca.key` (ECDSA P-256,
0600, never copied into a sandbox) and `ca.crt` (365 days). Only the certificate goes to the
sandboxes (`/run/elpis/browser-ca.crt`, imported into the NSS database of each service). Back
the folder up with `user_db`. Rotation is automatic: when less than 30 days remain, the tool host
creates a new CA at its next use, recreates the relays and each sandbox service is restarted at
its account's next `pw_*` call with the new certificate. To rotate at once (suspected leak): stop
the tool host, delete the folder, start the tool host.

**Doctor.** `./elpis doctor` checks Docker and the sandbox image (the browser needs both), the
browser files, the CA (and its 0600 key), the Chromium headless shell, that the mounted files are
readable by the sandbox UID, the CPU quota, and, for each running sandbox service (reached without
following links), that the relay socket of its account is listening.

**Logs.** `./elpis logs browser <account> [-f]` (the account is required) shows the service log of that account's sandbox
(`/work/.elpis-browser/service.log`, rotated at 5 MB), without control characters (the sandbox
writes it). Relay refusals and upstream failures are in
the tool host log (`[relay <account>]`).

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
