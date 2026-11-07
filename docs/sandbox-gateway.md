# Sandbox gateway — the container agent and the Git relay

How Elpis acts on a user's sandbox: the container is the boundary. Every
agent operation runs in the user's sandbox: the host tells it what to do and
never touches the contents of `/work` itself, apart from the exceptions below.

## Access paths

| Caller | Path | Boundary |
|---|---|---|
| `execute_shell`, terminal | `docker exec`, UID 10001 | kernel / container |
| file tools; editor (tree, read, write, search, previews, imports) | container agent | container |
| Git tools, editor Git panel | container agent (`git`) | container |
| Git network operations started by Elpis (`clone`, `fetch`, `pull`, `push`, `ls-remote`) | agent, then host relay | ticket per operation |
| downloads, export and import, snapshots, backup and restore | container agent (`archive`, `extract`) | container |

A single UID writes to `/work`: the container's (10001 by default).
Files are 0644 and directories 0755 (agent, commands and terminal run with
umask 0022). At startup, the container root resets `/work` to that UID with
mode 0755. Once per account, it also fixes the whole tree inherited from the
old permission widening (0666 / 0777, files owned by the app UID):
`chown -R`, `chmod -R go-w` (`reconcileWorkModes`,
`packages/bac/src/conteneur.ts`).

Host exceptions, none of which reads file contents:

- `du` for the quota: metadata only, links not followed;
- account deletion: `/work` first, by the container root started for the
  occasion (account processes stopped, `find -delete`, then container
  removed: `purge`, `packages/bac/src/conteneur.ts`) — so Docker and the
  image are required; otherwise the account is deleted, the folder stays and
  the console says so; then the rest of `P`, by `rmtree` with descriptors;
- idle clock (GC): `lstat` of `/work` and `/work/.bg/*`, without following
  links; sandbox sizes (console): `lstat` only;
- cleanup of abandoned uploads: by the root of each running container
  (`find -mmin`), no longer by the host;
- creation of `P/work` and migration of an old tree (`ensureWorkSubdir`,
  `packages/bac/src/travail.ts`), before any use of the container.

The parts of `P` that belong to the host (skills mirror, memory, snapshot
store — outside the mount) are walked with descriptors, without following
links (`packages/securite/src/confinement.ts`).

## The agent

- `sandbox-agent/server.py`: Python (standard library,
  Python ≥ 3.9), the only gateway code that runs in the container. The code
  is mounted read-only (`/opt/elpis/agent`), started on demand by
  `docker exec -d` under the container UID, with no capabilities, and
  restarted if its version (file fingerprint) differs from the app's.
- Channel: HTTP/1.1 over `/run/elpis/agent.sock` (on the host:
  `<user>/.elpis-agent/agent.sock`). The host opens the socket without
  following links and treats every response as untrusted: sizes and timeouts
  are bounded, and a host path is never taken from a response
  (`@elpis/fichiers`, `packages/fichiers/src/agent.ts`).
- Passive call (editor polling): does not restart a stopped container and
  does not count as sandbox activity.
- `/v1` API: `hello`, `stat`, `read`, `list`, `grep`, `readmany`, `write`,
  `append`, `fsop` (`mkdir`, `remove`, `rename`, `copy`, `chmod`, `clear`,
  `du`), `changes/begin` and `changes/end`, `archive`, `extract`, `git`,
  `shutdown`; the details are at the top of `server.py`.
- File names: UTF-8. A name that is not valid UTF-8 (a file created by a
  third-party tool in the sandbox) does not appear in the editor; rename or
  delete it from the sandbox terminal.

## Git

- `git` runs in the container (`packages/fichiers/src/git.ts`, through the
  agent): sandbox UID, `HOME=/work`; for Elpis commands, no hooks, no
  monitor, no signing, no credential prompt; the default identity is
  "Elpis", which the user's configuration overrides.
- Network (`packages/fichiers/src/relais-git.ts`):
  - each app process listens on `user_sandboxes/.elpis-relay/<pid>.sock`, a
    folder mounted read-only at `/run/elpis-relay`;
  - an Elpis network operation receives a ticket (a random token kept in
    memory by the process that issues it): account, upstream repository, Git
    service, refs allowed for push, deadline; it is revoked when the
    operation ends;
  - for the duration of the command, the agent opens `127.0.0.1:<port>` in
    the container and relays each connection to that socket, preceded by a
    line that carries the ticket; `git` is pointed there by
    `url.<relay>.insteadOf` (the remote URL does not change);
  - the relay accepts only the Git "smart HTTP" protocol for the ticket's
    repository, filters headers, adds the connector's credentials (credentials
    typed by the user are sent only after a 401 from upstream), repeats the
    anti-SSRF check and reaches the upstream without a proxy, over TLS for an
    `https://` remote (an `http://` remote goes in clear); an upstream
    redirect is refused; on push, it reads the commands and refuses a ref
    outside the ticket or a deletion. The refs of an editor push ticket are
    those returned by `git push --dry-run --porcelain`;
  - Git's output and `FETCH_HEAD` keep the original URL; `pull` = `fetch`
    through the relay, then merge in the container.
- The relay socket is reachable from all sandboxes: a connection without a
  valid ticket is closed (5 s to present it, 64 connections at most). During
  an operation, the agent's local listener is reachable by any process in the
  sandbox, for the ticket's repository, service and refs only. Outside an
  operation, the terminal has only the network of its profile.

## Archives: what to know

- Snapshot restore and archive import: an old entry that the agent cannot
  delete (a directory owned by someone else) is set aside as
  `<name>.elpis-ancien-<hex>`; a new entry that cannot take its place is set
  aside as `<name>.elpis-restaure-<hex>`. Nothing is lost; the interface
  reports the number of entries to check.
- Before an import, a snapshot of `/work` is taken ("Before import of …",
  stored outside `/work`, restorable from the editor). If it cannot be taken
  (too large, operation in progress), the import is refused and `/work` stays
  intact. Like any snapshot, it can cause the oldest one to be removed beyond
  the per-account retention count.
- A restore needs the snapshot's size in addition to `/work` (extract, then
  swap); without enough space: 507, `/work` intact.
- Streamed download or export: six hours at most; a client that reads nothing
  for ten minutes is cut off.
- Admin backup: a stopped sandbox is started to read its `/work`, which does
  not count as activity, then stopped again. If an account's `/work` cannot be
  read (Docker stopped, image missing), the backup is named `…_incomplet.zip`
  and is not counted as successful by the console, by the remote upload, or by
  `./elpis backup` (exit code 3, which `./elpis upgrade` lets through).
- A file's history (editor) is read through the agent: it starts the
  container if needed.

## Measured performance

On a real `elpis/sandbox:1.7.0` container:

- container started in 1.2 s, agent launched on demand in 0.3 s (Python
  3.11), under UID 10001, with no effective capability;
- inherited permissions fixed once (file 0666 → 0644 at the container UID,
  directory 0777 → 0755), agent writes at 0644;
- Git in the container (init, commit, status); clone and fetch through the
  relay (40 ms for the fetch);
- account purge in 115 ms.

Latency per agent operation (median of 20, same machine):

| Operation | Median | p90 |
|---|---|---|
| `hello` | 1.4 ms | 1.8 ms |
| `stat` (1 path) | 1.5 ms | 1.7 ms |
| `read` 4 KiB | 1.5 ms | 1.7 ms |
| `write` 4 KiB | 1.6 ms | 1.9 ms |
| `list` (100 entries) | 2.7 ms | 3.6 ms |
| `readmany` (10 files) | 2.0 ms | 2.1 ms |
| `fsop` mkdir then remove | 3.1 ms | 5.1 ms |
| `git status` (median of 10) | 3.2 ms | 5.6 ms |

## Tests

The gateway is covered by the maintainers' tests (development repository):
agent and client, Git and relay end to end (with `git http-backend`), editor
flows without following links, archives, a guard that fails any test where host
code touches `/work`, and, on request, an adversarial pass in a real container
(`elpis/sandbox` image and container agent, traps set from inside the container).
