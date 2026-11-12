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
The service account drives Docker, which makes it close to root on the host:
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
  script) acts only through a personal token (`ept_`, `pcr_`) or an OAuth
  authorization granted by the account on the consent screen,
  with THAT account's rights and only the families granted, bounded
  by the administrator's policy (`mcp.tokens.*`, `mcp.oauth.*`,
  including `mcp.oauth.dcr_enabled` for dynamic client
  registration). Tokens are stored as fingerprints, revocable by the account or by
  the administrator, and revoked along with the account's sessions. The relay
  never passes the client's token to the tool service (signed
  delegation) and refuses undeclared browser origins.
- Driven browser: it runs inside each account's sandbox; its traffic
  leaves through the account's relay on the host, which applies the
  sandbox network profile and refuses loopback, link-local and the
  addresses of the host or its containers; vault secrets never enter
  the sandbox (the relay substitutes them for the secret's own origins).

**Out of scope**

- A malicious administrator, or a host machine that is already compromised.
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
- Remote MCP server: its address is checked when it is registered, not
  at every DNS resolution.
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

**Service account**: it drives Docker; as a member of the `docker` group, it is
in effect **close to root** on the host. Dedicate a machine or VM
to Elpis, and protect the account, `user_db/` and `backups/`. `user_sandboxes/`
is reserved to it (0700): a container's root can place setuid files there;
a dedicated `nosuid,nodev` mount point neutralizes them for
the service account too.

**Hardened isolation**, not covered by our tests:

- an application-kernel runtime, gVisor (`executors.runtime = "runsc"`):
  the most isolating option for a multi-user instance;
- UID remapping of the Docker daemon (`userns-remap`) or rootless Docker: the
  container's root is no longer root on the host. These are daemon settings,
  which apply to all its containers; on the host, the files in `/work`
  then belong to shifted UIDs.
