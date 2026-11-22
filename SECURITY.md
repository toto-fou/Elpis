# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.
Use the private vulnerability reporting of the repository hosting service
("Security" tab → "Report a vulnerability"), or contact the maintainers
privately. Include:

- the affected version or commit,
- a description of the problem and its impact,
- the steps to reproduce it (a minimal proof of concept if possible).

We aim to acknowledge a report within 7 days and to publish a fix, with
credit if you wish, once it is available.

## Scope

Elpis runs code on behalf of users inside a per-user Docker sandbox. Reports
about escaping that sandbox, crossing user boundaries, authentication or
session handling, and server-side request forgery are especially welcome.
Deployments that expose the `desktop-agent` or the tool host without
authentication are outside the supported configuration.

## Threat model (summary)

Elpis trusts its administrators. Users are authenticated and isolated from one
another. The LLM agent acting for a user, and everything in that user's
sandbox, are untrusted: the agent may follow instructions found in a web page,
a document or a repository. The per-user container is the security boundary.
The tool host's account drives Docker, which makes it close to root on the host:
run Elpis on a dedicated machine or VM. Details below.

## Threat model (details)

**Actors**

- Administrators: full trust (accounts, connectors and their keys,
  backups).
- Users: authenticated, isolated from one another (conversations, files,
  sandbox, Git credentials).
- A user's LLM agent: **untrusted**. It acts with that user's rights and
  may follow instructions found in a web page, a document or a repository.
- The content of a sandbox, written by the user and their agent: **untrusted**
  for the host.

**Boundaries**

- Browser ↔ server: session, roles and permissions; previews of active files
  (HTML, SVG) are served from an opaque origin.
- User ↔ user: data filtered by account on the server side; one sandbox and
  one container per account.
- Sandbox ↔ host: the container is the boundary (only the necessary
  capabilities — neither `NET_RAW` nor `MKNOD` —, memory, CPU and process
  limits, network by profile). Every agent operation runs inside the user's
  sandbox: the host neither reads nor writes the content of
  `/work` (exceptions, metadata only: `du` for the quota, idle clock,
  account deletion, creation of `P/work` —
  docs/sandbox-gateway.md), and a single UID, the container's, writes there. Git runs in the sandbox, and its network operations
  launched by Elpis go through a host relay that adds the
  credential: Git credentials stay on the host.
- Server ↔ network: addresses of Git repositories and MCP servers checked
  and resolved on the server side (see the limits below).
- External clients ↔ tools: an MCP or OpenAPI client (editor, agent,
  script) acts only through a personal token (`ept_`) or an OAuth
  authorization granted by the account on the consent screen,
  with THAT account's rights and only the families granted, bounded
  by the administrator's policy (`mcp.tokens.*`, `mcp.oauth.*`,
  including `mcp.oauth.dcr_enabled` for dynamic client
  registration). Tokens are stored as fingerprints, revocable by the account or by
  the administrator, and revoked along with the account's sessions. The relay
  never passes the client's token to the tool service (signed
  delegation) and refuses undeclared browser origins.
- OpenID Connect single sign-on (SSO; optional, off by default): an OpenID Connect provider
  decides who a person is and which groups they belong to; Elpis only signs in members of the required
  groups, never links a person to an existing account by name or email, and keeps the secrets of the
  providers in the vault. In scope: the sign-in and linking flows, the provider
  settings. Assumed: the identity provider (and any directory behind it) is trusted and well run, the host name of
  Elpis is dedicated to it, HTTPS is in force, and the certificate authority of the provider is the one
  configured. The person's password never goes through Elpis.
  Optionally (off by default), the role and some Elpis groups follow the provider's groups: exact matches
  only, a membership that cannot be read changes nothing, and administrator groups need an explicit
  confirmation and a second factor proven by the token. Provider-side sign-out and back-channel
  logout end the sessions of that provider only, on a signed logout token.
  See [docs/sso-oidc.md](docs/sso-oidc.md).
- Driven browser: it runs inside each account's sandbox; its traffic
  leaves through the account's relay on the host, which applies the
  sandbox network profile and refuses loopback, link-local and the
  addresses of the host or its containers; vault secrets never enter
  the sandbox (the relay substitutes them for the secret's own origins).

**Out of scope**

- A malicious administrator, or a host machine that is already compromised.
- A compromised directory or identity provider, or one that vouches for the wrong people.
- The accuracy of a model's answers, the models and providers
  themselves.
- A `desktop-agent` or a tool host exposed without authentication; an
  instance open to the network without HTTPS.

**Known limits**

- During a network Git operation launched by Elpis (at most its duration), the
  relay accepts the Git requests coming from the sandbox for only the repository and
  the service of that operation; a push modifies only the requested
  refs there, with no deletion. Outside an operation, a connection to the relay without
  a valid ticket is closed without relaying anything.
- A Git remote over `http://` is relayed in clear, connector credential
  included.
- Which repositories the Git relay reaches is set per network profile, whatever its
  mode: all of them (the default), only servers chosen by the administrator (a whole
  server, or a server and an organization), or only those covered by the account's own
  verified Git accounts. A Git account on a server the rule leaves out is refused, and
  the pull requests Elpis opens follow the same rule. The rule is read when an operation
  starts and applied to each of its requests. It bounds the Git relay only: an open
  profile still reaches the network directly, unless its protections refuse it; the
  Git relay applies those protections too, with no IPv6 when one is ticked; only the
  servers chosen by the administrator escape the local network and host protections,
  never the metadata one. Under a profile without network, this relay is the sandbox's
  only way out (the browser relay refuses everything there): with chosen servers and
  none listed, nothing leaves over the network.
- Remote MCP server: its address is checked when it is registered, not
  at every DNS resolution. The server runs no command taken from its
  configuration: a third-party MCP server is reached over HTTP. An entry
  that asks for a local command is refused when it is added from the
  interface or the API, and never run (a legacy entry left in a
  configuration file is refused at use).
- The site map of screen vision (sites and paths already visited
  by the control agent) is a memory shared by the team: an account
  sees the sites mapped by the others.

**Responsibilities**

| Layer | Ensures |
|---|---|
| Interface | content escaping, no client-side secret, isolated active previews |
| API | authentication, roles and permissions, size and rate limits on tools |
| Agent runtime | tools allowed per conversation, budgets, cancellation |
| Sandbox | container isolation, quotas, network profiles |
| Administration | accounts, connectors and their keys, backups |

**Supported configurations**: Debian 12/13 or Ubuntu 24.04; the distribution's Docker and
`bubblewrap` (`./elpis doctor`, isolated Office previews);
local listening by default,
HTTPS (Caddy) as soon as the instance is open to the network.

**Service accounts**: under systemd, each service runs under its own system account
(`elpis-main`, `elpis-admin`, `elpis-toolhost`; `docs/operations.md`, "Service
accounts"). Only the tool host unit gets the `docker` group, which makes that account in
effect **close to root** on the host: dedicate a machine or VM to Elpis. The other services
never reach Docker, and each file is reserved to the accounts that use it: the vault key,
the session secret and the remote backup credentials to main and the console (`elpis-cle`),
the signing key to the journal writers, the shared state (`user_db/`, sandboxes, logs) to
the `elpis-donnees` group, the local backups to the operator, nothing to other accounts. With
systemd 250 or later, the platform keys are no longer files a group reads: the vault key, the
legacy encryption key, the session secret and the signing key are encrypted by `systemd-creds` in
`/etc/elpis/credentials/` (root only; bound to the TPM2 when there is one) and systemd hands each
unit, decrypted for it alone, only the keys it uses: main and the console all four plus the RAG
token and the Qdrant API key, the tool host the signing key only, the RAG extractor its token
only, Qdrant its API key only (it then refuses any request without it). `elpis-cle` then only gives the remote backup
credentials, rsyslog reads the logs but not the signing key, and no platform key is left in
`user_db/`, where the tool host could replace it, except a fallback vault key `user_db/.vault.key`
kept for `vault rekey --from` until its secrets are re-encrypted (`./elpis doctor` reports it). The
values of `config.json` no longer choose these keys: when the units point the core at the key files,
`config.json` is ignored, and the console refuses to set them. The commands root runs under the console's
account are a transient unit (`systemd-run`) that gets the console's keys the same way; copies of
the keys are kept off the machine (`docs/operations.md`, "Platform keys"). The operator's commands
never run the application's code on the services' configuration (without their keys, the core would
create new ones next to the database): those that need it ask for `sudo`. The RAG extractor, which
converts untrusted documents, runs as `elpis-rag` and only reads the RAG store and its token. When other accounts cannot
reach the installation (a clone in a home folder) or with `ELPIS_COMPTE_UNIQUE=1`, every service
keeps one account, which then drives Docker itself; `./elpis doctor` warns about this fallback
at every run. `user_sandboxes/` is reserved to these accounts (2770): a container's root can
place setuid files there; a dedicated `nosuid,nodev` mount point neutralizes them for the
service accounts too.

**systemd units** (`deploy/systemd/`): every service runs without privileges, with the
system read-only except its own folders, a private `/tmp` and `/dev`, and memory and task
limits; `systemd-analyze security` rates each unit "OK" (details in `docs/operations.md`).

**Sandbox containers** (`packages/bac/src/conteneur.ts`, `durcissement.ts`,
`sandbox-agent/demarrage.sh`): commands, the agent, the browser service and the
terminal enter directly under the account's user (`executors.exec_user`, 10001 by
default), never through a root step, and the container's own `PATH` holds system
folders only. By default the account can become root in its own container with `sudo`
(`executors.allow_sudo`); a kernel flaw is then all that separates that root from the
host. With `sudo` turned off, and always on a network profile that filters
(allowlist, or open with a protection), the container is hardened: `no-new-privileges`,
seven capabilities (plus `NET_ADMIN` for the startup script of a filtered profile,
dropped before the account's command), read-only root filesystem, `/tmp` in memory, and the account never
runs as root there. Only the startup script, with a clean environment, and a few host
steps (ownership of `/work`, process cleanup, the sweep of stale uploads, account
purge) run as root, with system programs. Open and allowlist sandboxes are on the
`elpis-sandbox` network (bridge `br-elpis-sb`), with traffic between containers
disabled (Docker 26 or later; `./elpis doctor` warns otherwise); the host still reaches
a sandbox (server preview). An allowlist profile refuses everything, then opens its
IPv4 destinations and its resolvers on port 53; with no destination left, nothing else
is reachable. An open profile can refuse cloud metadata (169.254.0.0/16 and the other
addresses of the main providers), the local network (private, shared, link-local,
multicast and reserved ranges) and the host (its IPv4 addresses, broadcast and
multicast; the list is read again before each use, and a container that does not
refuse a new address yet is recreated); new profiles refuse metadata and the host. A profile with one of these
protections runs hardened, and the browser relay applies the same protections, with no
IPv6 at all; the account can read the refused list inside its sandbox. Names are
resolved by Docker's internal DNS, which asks the host's resolvers from the host itself
(Docker 26 and later), whatever the protections. The addresses
of an allowlist's domains are pinned when the container is created, except loopback,
link-local, multicast, cloud metadata addresses and the host's own addresses and
container networks, which a domain never opens unless the profile lists them among
its addresses; the console shows
the domains that no longer resolve and offers to recreate the containers none of whose
pinned addresses for a domain are still returned. An open profile without protection
reaches the LAN, the host's ports bound to all interfaces and a cloud metadata
address; filter them on the host if needed, for example:

```bash
iptables -I DOCKER-USER -i br-elpis-sb -d 169.254.169.254 -j DROP
iptables -I DOCKER-USER -i br-elpis-sb -d 10.0.0.0/8 -j DROP   # LAN, adapt
iptables -I INPUT -i br-elpis-sb -m conntrack --ctstate NEW -j DROP   # the host's own ports
```

Known limits of the sandbox: the `/work` quota is enforced by the application, not by
the kernel, so put `user_sandboxes/` on its own filesystem if a full disk must not
reach the host; while `sudo` is allowed, the container layer is writable without a
quota (a dedicated Docker data root bounds it; `--storage-opt size=` in
`executors.extra_run_args` works only with overlay2 on xfs mounted with project quotas,
and elsewhere no sandbox starts). `./elpis doctor` reports the state of this isolation.

**Hardened isolation**, not covered by our tests:

- an application-kernel runtime, gVisor (`executors.runtime = "runsc"`):
  the most isolating option for a multi-user instance;
- UID remapping of the Docker daemon (`userns-remap`) or rootless Docker: the
  container's root is no longer root on the host. These are daemon settings,
  which apply to all its containers; on the host, the files in `/work`
  then belong to shifted UIDs.
