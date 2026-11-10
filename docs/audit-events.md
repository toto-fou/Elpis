<!-- SPDX-License-Identifier: MIT -->

# Security journal: format and event catalogue

The security journal records who did what on an Elpis instance (ANSSI-PA-012, annex A). It is
written by every Elpis process (`main`, `admin`, `toolhost`, `cli`) into daily files
`audit-YYYY-MM-DD.jsonl` (UTC day) in `/var/lib/elpis/audit`, or `<root>/logs/audit` when that
folder is not writable. `ELPIS_AUDIT_DIR` overrides the folder. Forwarding to a central collector
is described in `deploy/rsyslog/README.md`.

## Line format (v1)

One JSON object per line, written with a single `O_APPEND` write (at most 4096 bytes). Keys are
always in this order:

| Field      | Type           | Content                                                                                   |
| ---------- | -------------- | ----------------------------------------------------------------------------------------- |
| `v`        | int            | Format version (`1`). Raised on any change of syntax or meaning.                          |
| `time`     | string         | RFC 3339 UTC time with milliseconds (`2026-11-07T21:04:05.123Z`).                         |
| `ts`       | float          | Same instant, Unix seconds.                                                               |
| `host`     | string         | Host name.                                                                                |
| `service`  | string         | Writing process: `main`, `admin`, `toolhost`, `cli`.                                      |
| `boot`     | string         | Random identifier (16 hex digits), new at each process start.                             |
| `seq`      | int            | 1, 2, 3... per `(host, service, boot)`. A missing number is a lost or deleted line.       |
| `action`   | string         | Event name, see the catalogue.                                                            |
| `outcome`  | string         | `success`, `failure` or `unknown`.                                                        |
| `user_id`  | int or null    | Account that acted. `null` for the system, a failed login to an unknown account, the CLI. |
| `username` | string or null | Its name.                                                                                 |
| `ip`       | string or null | Client address (see below). `null` when there is no client.                               |
| `details`  | object         | Event fields, keys sorted. Documented per action below.                                   |
| `kid`      | string         | Present on signed lines: first 8 hex digits of the SHA-256 of the key.                    |
| `hmac`     | string         | Present on signed lines: HMAC-SHA256 (hex) of the line.                                   |

`ip` is the client address: the address resolved by the HTTP server (loopback proxies applied) if it
is a valid IP address, otherwise the socket peer. When that address is a trusted proxy
(`ACCESS_LOG_TRUSTED_PROXIES`, loopback by default), `X-Forwarded-For` is read from right to left
up to the first entry that is not a trusted proxy, stopping at an entry that is not a valid IP
address, so a client cannot choose it. The access log and the login rate limiter use the same
address. `?` when unknown.

### Signature

`hmac` is the last field. It is computed over the exact text of the line without the trailing
`,"hmac":"..."`, so verification strips that suffix and recomputes, without re-serialising. The key
is `/etc/elpis/audit.key` (`ELPIS_AUDIT_KEY_PATH`), at least 32 bytes. Without a usable key the
lines are written unsigned (no `kid`, no `hmac`).

Text fields are made well-formed (lone UTF-16 surrogates become U+FFFD), non-finite numbers become
`null`, and `action`, `username` and `ip` are cut to 256 characters. A line over 4096 bytes is
rewritten with `details` replaced by
`{"_truncated": true, "_orig_len": n, "summary": "<first 500 characters>"}`. An event that cannot be
serialised at all is written as `audit.event.lost` (`details`: `action`, `error`), so it still
takes a `seq` number.

### Verification

`./elpis audit verify [--from D] [--to D] [--key PATH]... [--host NAME]` reads the daily files and
reports one status:

| Status        | Meaning                                                                                                                                                                                                           | Exit code |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `intact`      | Every line is signed with a given key and valid, no gap, no anomaly, and both ends of the journal are established (see below).                                                                                    | 0         |
| `anomalies`   | Invalid signature, unreadable line, missing numbers, duplicate or out-of-order line, a writer whose key changes or mixes signed and unsigned lines, a line outside the day of its file, a v0 line after v1 lines. | 1         |
| `non_verifie` | No anomaly, but some lines are unsigned or signed with an unknown key, no key was given, or the start or the end of the journal cannot be established (the reason is printed).                                    | 3         |
| `vide`        | Nothing in the period.                                                                                                                                                                                            | 3         |

Exit code 2 means a bad command line, a `--key` that is missing, unreadable or shorter than
32 bytes, or signed lines while no key could be read (the default key is readable by the service
account only: run the command as that account or pass `--key`).

Continuity is checked per `boot` over the whole period, so a clock moved back across midnight does
not create false gaps. The `prev` field of each `audit.writer.start` must match the last line of the
previous writer: missing final lines, or a whole missing writer, are gaps. Writers without
`audit.writer.stop` that went silent for more than 70 minutes are listed as uncertain ends (abrupt
stop, or lines deleted before a restart).

Start of the journal. With `--from` on or after the oldest file present, the period starts inside
the journal and lines before it are out of scope. Otherwise (no `--from`, or a `--from` before the
oldest file) missing first lines are accepted only when the signed `audit.purge` line with the most
recent `newest` explains them: the oldest file present must not be later than its `kept_from` (the
first file the purge kept). An oldest file later than `kept_from` is reported as missing files
(`fichiers`), even when no writer spans the deleted days. Purge lines count only with a valid
signature when a key is given. With `--to` and no `--from`, the `audit.purge` lines of the files
after `--to` are read too (matched as bytes before any JSON parsing), since the latest purge is
usually written after the period. A purge written before `kept_from` existed (older format) cannot
bound the start: the status is `non_verifie`, until the next purge writes the field.

End of the journal. Without `--to`, the end is part of the period: when the last line of a host is
more than 2 hours old (a running instance writes a heartbeat every hour), or the last writer of a
service has no `audit.writer.stop` and went silent, deleted final files cannot be told from a
stopped instance, and the status is `non_verifie` with the reason (for example `dernière ligne de
host il y a 3 j`). Check a closed period with `--to`. On a central copy, a stopped or
decommissioned host needs `--to`, and a collector that keeps fewer days than the host needs
`--from`.

A byte-for-byte copy of a validly signed line (the rsyslog disk queue replayed after a crash, see
`deploy/rsyslog/README.md`) is counted as a duplicate, a warning that does not change the status. A
second line with the same `boot` and `seq` but other bytes, an invalid or no signature, or more than
50,000 signed lines after the first one, is an anomaly. Memory use does not grow with the number of
lines: numbers are kept as runs of consecutive values per writer.

`POST /api/admin/audit/verify` (console) returns the same counts, the reasons of a `non_verifie`
status in `reasons` and the duplicates in `duplicates`.

The local journal and its key belong to the service account: a local `verify` does not protect
against someone who controls that account, since such a person can rewrite and re-sign the files.
The CLI recalls it under an `intact` result. The proof is the copy held by the central collector,
checked with the same command, and only under two conditions:

- Forwarding is optional and off by default (`deploy/rsyslog/README.md`): on a default
  installation no copy exists, and nothing proves that the local journal was not rewritten.
- Checking the central copy needs the HMAC key, and whoever holds the key and can write to the copy
  can also rewrite and re-sign it. Keep the key away from the accounts that can write to the
  collector's storage (for example on a separate verification machine, or offline).

### Writer markers

| Action                   | When                              | `details`                                                                                                 |
| ------------------------ | --------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `audit.writer.start`     | A process begins writing.         | `pid`, `prev`: `{boot, seq}` of the last line of the previous writer of this host and service, or `null`. |
| `audit.writer.heartbeat` | Every hour.                       | `pid`, `failures`: number of lines that could not be written since start.                                 |
| `audit.writer.stop`      | Clean shutdown.                   | `pid`                                                                                                     |
| `audit.event.lost`       | An event could not be serialised. | `action` (64 characters at most), `error`                                                                 |

A `boot` without `audit.writer.stop` is a writer that is still running or stopped abruptly.
Write failures never interrupt a request: the line is lost, `failures` grows and a message goes to
the service log.

The search endpoint accepts `exclude_markers=1` to leave `audit.writer.*` lines out (the console
hides them by default); it has no effect when the searched `action` is itself a writer marker, and
the export never takes it.

Every `GET` of the console that writes a trace requires the header `X-Elpis-Console: 1`: the server
answers 403 (`Lecture refusée`) without it or when the request comes from another site, before any
work and without writing the read trace. Only the generic `auth.forbidden` denial is written, aggregated
per minute like other denials, with fixed details (`method`, route pattern, `status: 403`) and no
parameter chosen by the requester; it still shows the attempts. A top-level navigation from another
site cannot set the header, so it cannot make the server write lines in the admin's name with parameters
of its choosing. The routes are:

| Route                                       | Action written                        |
| ------------------------------------------- | ------------------------------------- |
| `GET /api/admin/audit/events`               | `admin.audit.search`                  |
| `GET /api/admin/observability/audit-recent` | `admin.audit.search` (`audit-recent`) |
| `GET /api/admin/export-metrics`             | `admin.metrics.export`                |
| `GET /api/admin/runs/:run_id/export`        | `admin.runs.export`                   |
| `GET /api/admin/llm-traffic/:call_id`       | `admin.llm_traffic.read`              |
| `GET /api/admin/backup`                     | `admin.backup.download`               |

The console sets the header on its own `fetch` calls (the run export is a download button, not a link).
Administration routes are authenticated by the browser session only, so no script is affected.
`action_prefix` of `audit-recent` is cut to 120 characters. The `ip` filter is an exact match when the value is a
complete IPv4 or IPv6 address, a prefix otherwise. Signed lines carry their `kid` in the results
(never the `hmac`).

### Outcome

`outcome` is explicit when the code states it, otherwise `failure` for an action ending in
`.denied` or `.failed` and `success` for everything else. `unknown` is used for aggregate
overflow lines only.

### Burst aggregation

Events that can arrive in bursts (refusals, public client registrations) go through an
aggregator keyed by action and a source key (client address, account, method and route pattern —
never the raw path; for registrations, the client address). The first occurrence is written at once. Later ones in the same 60-second window are
counted, and one summary line is written when the window ends (or at clean shutdown) with the
fields of the first occurrence plus:

| `details` field       | Content                                           |
| --------------------- | ------------------------------------------------- |
| `repeated`            | Number of occurrences after the first.            |
| `first_ts`, `last_ts` | Unix seconds of the first and last of the window. |
| `window_s`            | Window length (`60.0`).                           |

New keys are limited per window, so noise from some clients cannot hide the refusals of others:

- a source is an address group (an IPv6 address counts for its /64, where a host picks its addresses
  freely; an IPv4 address counts alone) together with the account when the event carries one (from
  the session or the signed cookie, so it cannot be forged). A source opens at most 8 new keys, at
  most 4 of them for the same action;
- an account opens at most 32 keys across all address groups;
- events without an account share at most 512 keys, at most 128 for the same action: the other half
  of the 1024 tracked keys stays available to signed-in accounts, even behind a shared address (NAT,
  proxy, remote desktop server).

Beyond that, occurrences are only counted, and one `audit.aggregate.overflow` line per address group
(`outcome: unknown`, `user_id: null`; `ip` is the first address seen, `null` for the groups beyond
the 256th, counted together) is written per window:

| `details` field | Content                                                                                                                                                               |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dropped`       | Occurrences counted.                                                                                                                                                  |
| `actions`       | Count per action, at most 20 distinct, the rest under `_other`.                                                                                                       |
| `user_ids`      | Accounts seen, at most 16.                                                                                                                                            |
| `sample`        | At most 6 occurrences, 2 per action: `{action, user_id, ip, method, route}` (`route` cut to 100 characters). An occurrence with an account replaces an anonymous one. |
| `network`       | The IPv6 /64 of the group, for IPv6 only.                                                                                                                             |
| `window_s`      | Window length.                                                                                                                                                        |

At most 1024 first occurrences, 1024 summaries and 257 overflow lines are written per window and
per process. Because a window keeps the details of its first line, a different reason inside the
same window (for example two kinds of password-change refusal) appears only in `repeated`.

Reads of the journal by an admin (`admin.audit.search`) do not use these limits: the same search
(account, address, period and filters) within a minute is counted and summarised with `repeated`
like a burst; 256 searches are tracked at a time, and beyond that each one is written.

## Catalogue

"Admin" actions need the `admin` role unless stated. All lines carry the account of the session
and the client address unless the table says otherwise. `*` marks an event aggregated as a burst.
For refusals, `route` is the route pattern; an unknown path gives `route: "(no route)"` and the
path, cut to 200 characters, in `path`. The client address follows the rule of the `ip` field
above. A cross-site refusal carries the account of the signed session cookie when there is one.

### Authentication

| Action                          | Outcome | When                                                                                    | `details`                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------- | ------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth.login`                    | success | Successful password login.                                                              | `user_agent` (200 characters at most), `reason: null`                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `auth.login.denied`             | failure | Login refused. `user_id` and `username` are set when the account exists.                | `user_agent`, `reason`: `bad_password`, `rate_limited`, `unknown_user`, `bootstrap_locked`, `bootstrap_denied`. For an unknown account (and for `bootstrap_denied`, a name other than `admin` on an instance without accounts) `username` and `user_id` are `null`; when an audit key is loaded, `identifier_hash` holds the first 16 hex digits of the HMAC-SHA256 of the typed name, so attempts can be correlated without keeping the text (no hash without a key). |
| `auth.bootstrap`                | success | First administrator created by the first `admin` login. The account is the one created. | `mode`: `local` (login from the machine itself) or `file` (initial password of `user_db/.bootstrap_admin`), `target_user_id`, `must_change`                                                                                                                                                                                                                                                                                                                            |
| `auth.logout`                   | success | `POST /api/logout-lite` with a session. Nothing without a session.                      | `user_agent`                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `auth.password.change`          | success | Own password changed.                                                                   | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `auth.password.change.denied` * | failure | Own password change refused.                                                            | `method`, `route`, `reason`: `missing_old_password`, `bad_old_password`, `policy`                                                                                                                                                                                                                                                                                                                                                                                      |
| `auth.csrf.denied` *            | failure | Cross-site request refused by a common guard.                                           | `method`, `route`, guard fields                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `auth.role.denied` *            | failure | Role insufficient (common guards and the AX routes).                                    | `method`, `route`, `required` where known (`staff`, `admin`)                                                                                                                                                                                                                                                                                                                                                                                                           |
| `auth.loopback.denied` *        | failure | Route reserved to the local machine called from elsewhere.                              | `method`, `route`                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `auth.internal.denied` *        | failure | Internal route called without the internal credentials.                                 | `method`, `route`, `reason`: `not_loopback`, `bad_token`                                                                                                                                                                                                                                                                                                                                                                                                               |
| `auth.service.denied` *         | failure | Route reserved to the toolhost called with a wrong service token.                       | `method`, `route`, `reason: bad_token`                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `auth.forbidden` *              | failure | Any other 403 returned by a handler (role or ownership checks).                         | `method`, `route`, `status: 403`                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `toolhost.gate.denied` *        | failure | Toolhost gate refused a request.                                                        | `reason`, `method`, `route`                                                                                                                                                                                                                                                                                                                                                                                                                                            |

### Personal tokens and OAuth

| Action                                          | Outcome | When                                                                                                                                                                      | `details`                                                                |
| ----------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `token.create`                                  | success | Personal token created.                                                                                                                                                   | `token_id`, `name`, `type`, `expires_at` (Unix seconds or `null`)        |
| `token.regenerate`                              | success | Token value renewed.                                                                                                                                                      | `token_id` (the id before renewal), `new_token_id`                       |
| `token.delete`                                  | success | Token revoked.                                                                                                                                                            | `token_id`                                                               |
| `oauth.client.register` *                       | success | Public dynamic client registration. `user_id` is `null`. One line per registration, up to 10 per client address and per minute; beyond, aggregated (key: client address). | `client_id`, `client_name` (100 characters at most)                      |
| `oauth.authorize`                               | success | The user accepted the consent page.                                                                                                                                       | `client_id`, `scope` (tool families granted)                             |
| `oauth.authorize.denied`                        | failure | The user refused, or no family was left.                                                                                                                                  | `client_id`, `scope` (families requested)                                |
| `oauth.token`                                   | success | Authorization code or refresh token exchanged. Account: the owner of the grant.                                                                                           | `client_id`, `grant_type`                                                |
| `oauth.token.denied` *                          | failure | Exchange refused.                                                                                                                                                         | `method`, `route`, `client_id`, `grant_type`, `error` (OAuth error code) |
| `oauth.revoke`                                  | success | `POST /oauth/revoke` revoked at least one token. Nothing for an unknown, foreign or already revoked token. Account: the owner of the token.                               | `client_id` (read from the database)                                     |
| `oauth.revoke.denied` *                         | failure | Client authentication refused at `POST /oauth/revoke` (`client_id` cut to 100 characters).                                                                                | `method`, `route`, `client_id`, `error` (OAuth error code)               |
| `oauth.grant.delete`                            | success | The user withdrew an authorization.                                                                                                                                       | `grant_id`, `client_id`                                                  |
| `admin.oauth_client.delete`                     | success | Admin deleted an OAuth client.                                                                                                                                            | `client_id`                                                              |
| `admin.security.sessions.revoke_all`            | success | All sessions revoked.                                                                                                                                                     | `global_min_ts`                                                          |
| `admin.security.sessions.revoke_user`           | success | One account's sessions, tokens and OAuth grants revoked.                                                                                                                  | `target_user_id`, `session_min_ts`, `tokens_revoked`, `oauth_revoked`    |
| `admin.security.sessions.clear_user_revocation` | success | Per-account revocation mark removed.                                                                                                                                      | `target_user_id`                                                         |
| `admin.users.access.revoke`                     | success | Account's tokens and OAuth grants cut.                                                                                                                                    | `target_user_id`, `tokens`, `oauth`                                      |

### Accounts and groups (admin)

| Action                       | Outcome | When                                                                                                | `details`                                                                           |
| ---------------------------- | ------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `admin.user.create`          | success | Account created.                                                                                    | `target_user_id`, `target_username`, `role` (`admin`, `moderator`, `user`)          |
| `admin.user.delete`          | success | Account deleted.                                                                                    | `target_user_id`, `target_username`                                                 |
| `admin.user.role`            | success | Role changed.                                                                                       | `target_user_id`, `before`, `after`                                                 |
| `admin.user.password_reset`  | success | Password reset by an admin. Nothing when the account does not exist (the route still answers `ok`). | `target_user_id`, `must_change` (`true`)                                            |
| `admin.user.groups`          | success | Group membership replaced.                                                                          | `target_user_id`, `before`, `after` (group ids, sorted)                             |
| `admin.user.llm_access`      | success | LLM access of an account set.                                                                       | `target_user_id`, `target_username`, `engine_keys`, `can_manage_models`             |
| `admin.user.desktop_targets` | success | Desktop machines of an account set.                                                                 | `target_user_id`, `target_username`, `targets`, `changed`                           |
| `admin.user.network_profile` | success | Sandbox network profile of an account set.                                                          | `target_user_id`, `target_username`, `forced`, `effective`, `container_destroyed`   |
| `admin.group.create`         | success | Group created.                                                                                      | `group_id`, `group_name`                                                            |
| `admin.group.update`         | success | Group renamed or described again.                                                                   | `group_id`, `before`, `after` (only the changed fields among `name`, `description`) |
| `admin.group.delete`         | success | Group deleted.                                                                                      | `group_id`, `group_name`                                                            |
| `admin.group.llm_access`     | success | LLM access of a group set.                                                                          | `group_id`, `group_name`, `engine_keys`, `can_manage_models`                        |

### Settings and security (admin)

| Action                                            | Outcome | When                                                                                                                       | `details`                                                                                                                                                 |
| ------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin.config.patch`                              | success | Field-by-field write of `config.json`. Nothing on a 400 or 409.                                                            | `force`, `changes`, `more`                                                                                                                                |
| `admin.config.file_save`                          | success | Whole-file save of `config.json`: disk before against content written (after restoring masked secrets and owned sections). | `changes`, `more`                                                                                                                                         |
| `admin.config.compression`                        | success | Compression and compaction settings saved.                                                                                 | `changes`, `more`                                                                                                                                         |
| `admin.security.https`                            | success | HTTPS mode switched.                                                                                                       | `before`, `after` (booleans)                                                                                                                              |
| `admin.security.listen`                           | success | Listening mode switched.                                                                                                   | `before`, `after` (`local` or `lan`)                                                                                                                      |
| `admin.agents.update`                             | success | Sub-agent settings saved.                                                                                                  | `max_tasks_per_turn`, `max_child_tokens_per_turn`, `forced`, `thinking`, `thinking_budget_tokens`, `background_timeout_s`, `user_browser_session_allowed` |
| `admin.executors.update`                          | success | Executor settings saved.                                                                                                   | `force_user_docker`                                                                                                                                       |
| `admin.sandbox.stop`, `admin.sandbox.destroy`     | success | Account's sandbox container stopped or destroyed.                                                                          | `target_user_id`, `target_username`                                                                                                                       |
| `admin.sandbox.gc`                                | success | Idle containers stopped.                                                                                                   | `stopped`                                                                                                                                                 |
| `admin.toolhosts.assign`, `.migrate`, `.unassign` | success | Account placed on, moved between, or removed from a toolhost.                                                              | `user_id`, `host_id` (assign), migration report fields (migrate)                                                                                          |
| `admin.rag.collection.delete`                     | success | RAG collection deleted.                                                                                                    | `collection_id`, `name`, `owner_user_id`                                                                                                                  |
| `admin.rag.quota.set`                             | success | RAG quota override set.                                                                                                    | `target_user_id`, `override`                                                                                                                              |
| `admin.rag.reindex_all`                           | success | Re-indexing of all collections started.                                                                                    | `force`, `collections`                                                                                                                                    |
| `admin.restart`                                   | success | `POST /api/admin/restart` accepted by `main`.                                                                              | `target` (`main`)                                                                                                                                         |
| `admin.restart.failed`                            | failure | `main` unreachable or refused.                                                                                             | `target`                                                                                                                                                  |

`changes` is a list of `{path, before, after}`: the whole configuration before and after the write
is compared, nested objects key by key and lists and scalars as a whole (absent is shown as
`null`). The list keeps the path order and stops at 50 entries or about 3000 bytes of JSON, so the
line is never cut; `more` is the number of entries left out.

A secret name is a key that contains `password`, `passwd`, `pwd`, `secret`, `token`, `api_key` (or
`api-key`), `key_enc`, `private_key`, `passphrase`, `credential`, `authorization` or `bindpw`, or
ends in `_pw`; a name ending in `_policy` (`security.password_policy`) holds rules, not a secret.
A known secret (the list masked by the console, including `mcp.local_client_tokens`, whose keys are
tokens), or a secret name whose value is an object, is compared as one value: the path stops there
and its keys are never written. At any depth, inside a listed or replaced value too:

- a string, or a non-empty list or object, under a secret name is shown as `"********"`;
- any non-empty value, numbers and booleans included, is masked under a known secret, a name that
  ends with the secret word (`bind_password`, `api_token`, `bindDN_pw`), and under `env`,
  `environment` and `headers` (their keys stay readable); elsewhere numbers, booleans, `null` and
  empty values stay readable (`buffer_tokens: 1000`);
- lists and texts under `args`, `argv`, `command` or `cmd` are masked like a command line
  (`--token ****`, `--password=****`);
- in URLs, credentials are removed (`scheme://***@host/`) and the value of a query or fragment
  parameter with a secret name, or named `key`, `sig` or `signature`, becomes `***`; a text with an
  `@` after `://` that does not parse as a URL is masked whole.

A value longer than 200 characters of JSON is replaced by `{len, sha256}` (12 hex digits, computed
after masking). Paths longer than 200 characters are cut.

### LLM and Git connectors

| Action                            | Outcome | When                                                 | `details`                                                 |
| --------------------------------- | ------- | ---------------------------------------------------- | --------------------------------------------------------- |
| `llm.connector.create`            | success | Connector created (personal, or shared by an admin). | `connector_id`, `provider_type`, `scope`                  |
| `llm.connector.update`            | success | Connector edited.                                    | `connector_id`, `scope` (admin)                           |
| `llm.connector.delete`            | success | Connector deleted.                                   | `connector_id`, `scope` and `access_lists_purged` (admin) |
| `llm.connector.test`              | success | Connector tested.                                    | `connector_id`, `ok`, `status`                            |
| `llm.allowed_providers.set`       | success | Allowed provider types set.                          | `allowed`                                                 |
| `llm.engine.test`                 | success | Built-in engine probed.                              | `type`, `joignable`                                       |
| `git.connector.create`            | success | Git connector created.                               | `connector_id`, `provider_type`, `host`                   |
| `git.connector.update`, `.delete` | success | Git connector edited or deleted.                     | `connector_id`                                            |
| `git.connector.list_repos`        | success | Repositories listed.                                 | `connector_id`, `ok`, `count`                             |
| `git.connector.test`              | success | Connector tested.                                    | `connector_id`, `ok`, `status`                            |

### Backups, restore, exports and traces (admin)

| Action                                           | Outcome | When                                          | `details`                                                              |
| ------------------------------------------------ | ------- | --------------------------------------------- | ---------------------------------------------------------------------- |
| `admin.backup.download`                          | success | Backup archive starts to be sent.             | `scope`                                                                |
| `admin.restore`                                  | success | Archive restored.                             | `size` (bytes)                                                         |
| `admin.restore.failed`                           | failure | Restore failed (invalid archive, I/O error).  | `size`, `error` (200 characters at most)                               |
| `admin.backup.remote.update`                     | success | Remote backup settings saved.                 | `changed`: names of the fields that differ                             |
| `admin.backup.remote.key`                        | success | SSH key stored.                               | none                                                                   |
| `admin.backup.remote.password`                   | success | Rsync password stored.                        | none                                                                   |
| `admin.backup.remote.test`                       | success | Remote destination tested.                    | `ok`                                                                   |
| `admin.backup.remote.send`                       | success | Remote send run.                              | `ok`                                                                   |
| `admin.metrics.export`                           | success | CSV export of metrics.                        | `days`, `target` (`metric_events` or `usage_events`), `format` (`csv`) |
| `admin.metrics.purge`                            | success | Metric tables purged (not a dry run).         | `targets`, `deleted`, `from`, `to`, `event_types`, `sources`           |
| `admin.metrics.scrape_token.generate`, `.revoke` | success | Prometheus scrape token generated or revoked. | none                                                                   |
| `admin.runs.export`                              | success | Execution trace exported.                     | `run_id`                                                               |
| `admin.llm_traffic.read`                         | success | Prompt and response of one LLM call read.     | `call_id`                                                              |
| `admin.llm_traffic.delete`                       | success | LLM traffic log cleared.                      | `deleted` (rows)                                                       |

The LLM traffic list (`GET /api/admin/llm-traffic`) returns summaries without prompt or response
text and is not logged.

### Sandbox and code execution

| Action                                        | Outcome | When                                                                                          | `details`                                                                                                     |
| --------------------------------------------- | ------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `user.sandbox.mode`                           | success | Account switched sandbox mode.                                                                | `mode`, `network_profile_id`                                                                                  |
| `user.sandbox.restart`, `.destroy`, `.delete` | success | Account's sandbox container restarted, destroyed or deleted.                                  | `container` (and `deleted` for delete)                                                                        |
| `user.toolhost.purge`                         | success | Account's data purged from a toolhost.                                                        | `credentials`                                                                                                 |
| `code.exec.<kind>`                            | success | Command or code run in a sandbox. Kinds: `tools.shell`, `tools.shell_job`, `tools.skill_run`. | `code_sha256`, `code_len`, `pipeline_id`, `run_id`, `node_id`, `executor`, plus `cmd_argv` for shell commands |

`code.exec.*` stores the SHA-256 and length of the command after masking, never the raw command:
a hash of the raw text would let a weak secret be guessed offline. For shell commands the split
command line (`cmd_argv`) is stored with secrets masked (`****`): the value after a password,
token or key option, `user:password` arguments (`-u admin:x`, `-uadmin:x`, `smbclient -U alice%x`),
URL credentials (and a token used as the URL user name, such as 40 hex digits), `Authorization`
and `Cookie` headers, SQL passwords (`IDENTIFIED BY '…'`, `PASSWORD '…'`), short password options
of known tools (`mysql -p`, `sshpass -p`, `redis-cli -a`, `ldapsearch -w`, `zip`/`unzip -P`,
`7z -p…`, `sqlcmd -P`, `ssh-keygen -N`/`-P`, `openssl -k`/`-K`), and assignments whose name ends in
`PASSWORD`, `PASS`, `TOKEN`, `SECRET` or `_KEY`, also inside a query string or form body
(`user=a&password=x`). The generic `-p` is not masked (`mkdir -p`, `ssh -p`). The text of `bash -c`
is read as shell words, so these rules also apply inside it. Masking avoids hiding code that runs: a
word holding a command substitution (`$(…)`, backticks, `<(…)`) is kept as is, and a value found in
the raw text stops at a blank, a quote or a shell operator (`;`, `&`, `|`, a new line).

### Security journal (admin)

| Action                 | Outcome | When                                                              | `details`                                                                                                                                                                               |
| ---------------------- | ------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin.audit.settings` | success | Retention, hold or expected forwarding changed.                   | `changes`: `[{field, before, after}]` (`before` keeps a hand-written value that the change normalised)                                                                                  |
| `admin.audit.search`   | success | Every page of a search, and each `audit-recent` read (see below). | `from`, `to`, `filters`, `source` (`audit-recent` only)                                                                                                                                 |
| `admin.audit.export`   | success | Export started (written before the file is sent).                 | `from`, `to`, `format` (`csv`, `jsonl`), `filters`                                                                                                                                      |
| `admin.audit.verify`   | success | Verification run from the console.                                | `from`, `to`, `status`, `intact`, `lines`                                                                                                                                               |
| `audit.test`           | success | Test event requested from the console, to find in the collector.  | `nonce`                                                                                                                                                                                 |
| `audit.purge`          | success | Written by the daily upkeep before deleting files.                | `retention_days`, `count`, `oldest`, `newest`, `kept_from` (first file kept after this run), `bytes`, `files` (50 at most), `remaining`, `agent` and `rule` when forwarding is expected |
| `audit.purge.skipped`  | success | Files beyond retention kept.                                      | Same summary plus `reason`: `hold` (with `hold_reason`) or `forwarding_missing` (with `agent`, `active`, `rule`)                                                                        |
| `audit.purge.failed`   | failure | Some files could not be deleted.                                  | `files`, `count`                                                                                                                                                                        |

Search: refused to a request coming from another site; every page is traced, with or without a cursor, and so is each
`GET /api/admin/observability/audit-recent` (`source: "audit-recent"`); the same search within a
minute is counted (see Burst aggregation). Two searches at a time, `audit-recent` included
(otherwise 429).

Export (POST, under the CSRF guard): the file is sent only once `admin.audit.export` is written
(otherwise 503), two exports at most at a time, and the transfer stops when the client leaves or
reads nothing for 60 s. A JSONL export without filters is a byte-for-byte copy of the daily files,
one after the other, unreadable lines included (the line being written in today's file is left
out); every line keeps its signature. `./elpis audit verify` reads daily `audit-YYYY-MM-DD.jsonl`
files, so to check an export, split it back into one file per UTC day (field `time`, or `ts` for
old lines), or check the journal or the collector copy directly. Lines longer than 64 KiB are
skipped by search and by filtered exports.

Retention: a daily file is deleted only when its whole UTC day is older than `retention_days`
(`security.audit`, 365 by default, 180 to 1095 from the console) **and** it is not among the
`retention_days` most recent files, at most 31 files per run, so a clock set ahead does not empty
the journal. Nothing is deleted while a hold is set (in `config.json` or by the `.hold` marker file
next to the journal), while `config.json` or the retention value cannot be read, while expected
forwarding is not confirmed (agent installed, active according to systemd, and a rule reading this
journal folder), or when the `audit.purge` line cannot be written first.

The console also writes the retention and the expected forwarding to a `.settings` file next to the
journal, and the daily purge keeps it in step with `config.json`. When `config.json` is empty, not
a JSON object or unreadable, nothing is purged; when it no longer has these fields (file replaced
or rewritten), the purge uses the values of `.settings` and the console shows an alert.

Backups: a full backup made from the console or by `./elpis backup` includes the security journal.
A remote send (`backup.remote`) leaves it out unless `backup.remote.include_audit` is `true`. Keep
backups for no longer than the journal retention.

### Secrets vault

Written by `main` (the account's secrets, the tool host's resolutions), `admin` (instance secrets)
and `cli` (`vault rekey`). `owner` is `user` or `instance` (secrets of shared connectors, managed by
admins). `details` never carry a value, a ciphertext or the key: `scope` lists exact origins, a git
host, a connector or a server id; `target` is the normalised origin (or host, connector, server) a
secret was asked for, never the page's path or query.

| Action                  | Outcome | When                                                                                                                              | `details`                                                                                                                                                                        |
| ----------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vault.secret.created`  | success | Secret created (Settings › Secrets, a connector form, or an import).                                                              | `secret_id`, `name`, `kind`, `owner`, `scope`, `state`                                                                                                                           |
| `vault.secret.updated`  | success | Secret edited. A new value raises `version`.                                                                                      | `secret_id`, `name`, `kind`, `owner`, `fields` (among `name`, `scope`, `username`, `policy`, `meta`, `value`), `version`; `scope` when it changed, `tls` when the policy changed |
| `vault.secret.rotated`  | success | New value: by its owner, or by an admin for an instance secret.                                                                   | `secret_id`, `name`, `kind`, `owner`, `version`                                                                                                                                  |
| `vault.secret.verified` | success | An imported secret (`unverified`) was verified by its owner.                                                                      | `secret_id`, `name`, `kind`, `owner`, `scope`                                                                                                                                    |
| `vault.secret.deleted`  | success | Secret deleted.                                                                                                                   | `secret_id`, `name`, `kind`, `owner`                                                                                                                                             |
| `vault.secret.used`     | success | The tool host received the value (`POST /api/internal/secrets/resolve`). Account: the one of the signed identity; `ip` is `null`. | `secret_id`, `name`, `kind`, `owner`, `usage`, `target`, `version`, `chat_id`, `run`, `subagent`                                                                                 |
| `vault.secret.refused`  | failure | A resolution was refused.                                                                                                         | `code` (a `secret_*` code, see [architecture.md](architecture.md#secrets-vault)), `usage`, `target`, `name`, `chat_id`, `run`, `subagent`                                        |
| `vault.secret.attached` | success | A secret was attached to a conversation (send payload `secrets`, or `PUT /api/chats/:chat_id/secrets`).                           | `secret_id`, `name`, `kind`, `chat_id`                                                                                                                                           |
| `vault.secret.detached` | success | A secret was detached from a conversation (same ways).                                                                            | `secret_id`, `name` and `kind` (`null` once the secret is deleted), `chat_id`                                                                                                    |
| `vault.ax.imported`     | success | Former AX credentials imported, once per account: migration 0030 (`source` `core`) or the tool host (`toolhost`).                 | `source`, `imported`, `existing`, `skipped`, `failed`, `skipped_sites` (up to 10 `{site, reason}`), `undecryptable` (core)                                                       |
| `vault.key.rekeyed`     | success | `./elpis vault rekey --from FILE` (service `cli`, `user_id` `null`); `failure` for any exit code but 0.                           | `from_kid`, `to_kid`, `rekeyed`, `failed`, `remaining`, `os_user`                                                                                                                |

Each secret the import creates also writes `vault.secret.created` (`state` `unverified`). The `reason`
of a skipped site is `no_origin`, `empty_value`, `invalid_username`, `invalid_value` or `owner_unknown`.

### Command line (`./elpis`)

Written by the `cli` service for `backup`, `db transfer`, `db use`, `audit verify` and `vault rekey`
(`vault.key.rekeyed`, see [Secrets vault](#secrets-vault)) once the command has parsed its
arguments (not for help or usage errors). The action comes from the parsed subcommand, global
options such as `--password-env` included, and `db transfer` and `db use` are
written before their checks, so a refusal or an unreachable target is logged too. `user_id` and
`username` are `null`; `outcome` is `success` for exit code 0 and `failure` otherwise. Every line
carries `os_user` (`SUDO_USER`, otherwise the current system account). An audit failure never
changes the exit code. Nothing is written while the audit directory does not exist (the command
says so on stderr): a command run as root never creates it with the wrong owner; `sudo ./elpis
audit setup` creates it.

| Action             | `details`                                                    |
| ------------------ | ------------------------------------------------------------ |
| `cli.backup`       | `scope`, `os_user`                                           |
| `cli.db.transfer`  | `to_backend` (`sqlite`, `postgres`...), `dry_run`, `os_user` |
| `cli.db.use`       | `backend`, `os_user`                                         |
| `cli.audit.verify` | `from`, `to` (days or `null`), `intact`, `os_user`           |

## Never logged

- Passwords, including generated ones, and the text typed in a login field for an unknown
  account (only `identifier_hash`, and only with an audit key).
- Token values, token prefixes or hints, token hashes, OAuth codes, access and refresh tokens,
  PKCE verifiers, client secrets, the scrape token.
- Private keys (SSH, TLS), certificate contents, the audit key, the session secret.
- Values of the secrets vault, their ciphertexts and the vault key (only its `kid`).
- Cookies and `Authorization` headers.
- Base URLs carrying credentials (`scheme://user:pass@host`), database passwords.
- Contents of `config.json` in clear: only changed values, secrets masked at any depth, long values
  reduced to a length and a hash.
- Prompt and response text of LLM calls, uploaded archive contents, backup passwords.
- The code run in a sandbox (hash and length only).
