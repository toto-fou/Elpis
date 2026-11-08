<!-- SPDX-License-Identifier: MIT -->
# Forwarding Elpis logs to a central collector

Elpis writes its logs locally and never sends them over the network. Forwarding to a central
collector (a "puits de logs", ANSSI R9) is done by the host's rsyslog, from the examples in this
folder. syslog-ng works the same way (file inputs plus the journal).

## What is forwarded

| Source | Location | Tag | Content |
|---|---|---|---|
| Security journal | `/var/lib/elpis/audit/audit-YYYY-MM-DD.jsonl` | `elpis-audit` | One signed JSON line per security event (v1 format: `docs/audit-events.md`) |
| Access log | `/var/log/elpis/app.log.jsonl` | `elpis-app` | HTTP access lines |
| Service stderr | journald | `elpis-main`, `elpis-admin`, `elpis-toolhost`… | Technical messages |

`sudo ./elpis audit setup` (also run by `install.sh` and `sudo ./elpis service install`) creates
both folders with mode 2750, owned by the account the services run as (`User=` of the installed
systemd units) and the group `elpis-journal`, adds the `syslog` account to that group when it
exists, and creates the signing key `/etc/elpis/audit.key` (0440, root and a group holding the
service account only: its own primary group, or `elpis-cle`, `ELPIS_GROUPE_CLE`). The folders are never readable by
everyone (ANSSI R26/R27). `ELPIS_GROUPE_JOURNAL=adm` uses the `adm` group instead. Stop the services
first when moving an existing `logs/audit`: while they run, the files of the current and previous
day stay where they are.

## Packages

TLS needs `rsyslog-gnutls`, the RELP variant `rsyslog-relp`, on the Elpis host and on the collector;
neither is installed with rsyslog. Install them from the internal mirror. `rsyslogd -N1` does not
report a missing TLS driver (the connection then simply never opens); `./elpis doctor` does.

## Certificates

Mutual TLS is required: each Elpis host needs a client certificate issued by the internal CA, and the
collector a server certificate. Keep them in `/etc/rsyslog.d/keys/`, not in `/etc/elpis` (which only
the Elpis service account may read): Ubuntu 24.04 confines rsyslogd with AppArmor, which allows
`/etc/rsyslog.d/**` and no other folder of `/etc`.

| File | Owner and mode |
|---|---|
| `ca.pem`, `elpis-host.pem`, `collector.pem` | `root:root 0644` |
| `elpis-host.key`, `collector.key` | Debian (rsyslog runs as root): `root:root 0600`; Ubuntu (rsyslog runs as `syslog`): `root:syslog 0640` |

The Elpis console reads the CA and certificate paths from the rule and warns before they expire.

## Sender (Elpis host)

1. Put the CA, the host certificate and its key in `/etc/rsyslog.d/keys/` (table above).
2. Copy `60-elpis.conf.example` to `/etc/rsyslog.d/60-elpis.conf`; set the collector name, port and
   paths (rsyslog 8.2108 or later). Keep `elpis` in the file name: `./elpis doctor` looks for
   `*elpis*.conf`.
3. Size the disk queues: daily volume × longest expected outage in days × 1.5 (`queue.maxDiskSpace`),
   with `queue.size` (lines) above what that space holds.
4. Ubuntu: if `aa-status` shows rsyslogd in enforce mode (the default on 24.04), add
   `apparmor-local-usr.sbin.rsyslogd.example` to `/etc/apparmor.d/local/usr.sbin.rsyslogd` and reload
   the profile.
5. `rsyslogd -N1` must print no error; then `systemctl restart rsyslog`. `./elpis doctor` reports the
   rule and its packages.

On first activation the whole retained security journal is sent (`freshStartTail="off"`), throttled
by `queue.dequeueSlowdown` (ANSSI R18). Set `freshStartTail="on"` to send only new lines.

The security journal has its own disk queue, synced on every line and filled before imfile records a
line as read: a crash or a power cut of the Elpis host, or an outage of the collector, keeps the
lines already queued, though a line can then arrive twice, which `audit verify` of the central copy
counts as a duplicate (a warning, not an anomaly, when both copies are byte-identical and validly
signed). The RELP variant (commented at the end of the example; imrelp on the collector)
acknowledges each line and sends the unacknowledged ones again after a reconnection. Some losses
remain possible: see "What can still be lost".

## Collector

`collector-elpis.conf.example` (rsyslog 8.2112 or later) sets mutual TLS and its certificates on the
input itself, so it holds whatever the collector already loads or sets globally; `rsyslogd -N1` must print no error, since rsyslog
starts anyway and a rejected setting leaves the port open in plain TCP. Security journal lines are
stored raw, one folder per sending address (from the connection, not from the message) and one file
per UTC day of the event (the `time` field of the line, so late or replayed lines land in their day);
lines that are not v1 go to `unparsed-YYYY-MM-DD.jsonl`. They go through their own disk queue, in
rsyslog's work directory (`/var/spool/rsyslog`), synced on every line and retried forever: while
their file cannot be opened (rights, missing mount), they wait there. Size `queue.maxDiskSpace` like
the senders' queues. The example sets `dynafile.donotsuspend="off"` on the omfile module, which
applies to every `dynaFile` action of the collector; merge it into an existing
`module(load="builtin:omfile" ...)` statement if there is one. A central copy can be checked like
the local one:

```sh
ELPIS_AUDIT_DIR=/var/log/central/192.0.2.10 ./elpis audit verify --key /path/to/audit.key
```

Every line carries `host`, `service`, `boot` (one per process start) and `seq` (1, 2, 3… per
`boot`): a missing number in a `(host, service, boot)` sequence is a lost or deleted line.

## What can still be lost

The examples narrow the losses, they do not remove them:

- Plain TCP has no acknowledgement: lines in flight when the network fails without closing the
  connection are lost (use the RELP variant).
- RELP: lines sent but not yet acknowledged are lost if the sender's rsyslog crashes; the collector
  acknowledges a line once it is in its main queue, in memory, so a crash of the collector's rsyslog
  loses what that queue holds.
- Collector disk full: a write error on an open file drops the line being written (the first one or
  two of the incident; rsyslog logs "message lost, could not be processed"). The next lines wait in
  the disk queue and are written once space is back, some of them twice; meanwhile rsyslog retries
  without pause and logs an error per try.
- Full queues: past `queue.maxDiskSpace` or `queue.size`, on either side, new lines are dropped after
  2 seconds.

So watch for losses instead of assuming there are none:

- alert on "message lost", "write error" and "open error" in the rsyslog log of the collector and of
  each Elpis host, and on the free space of the collector's log volume and of each rsyslog work
  directory;
- run `audit verify` on each central copy periodically (daily, for instance): missing `seq` numbers
  show the lost lines, duplicates are reported too.

## Journald

`../journald/60-elpis.conf.example` makes the journal persistent. Its size and age limits, commented
out, apply to the whole journal of the host (sshd, sudo…), not only to Elpis: choose them for the host.
Service stderr holds user names and addresses: keep it shorter than the security journal.
