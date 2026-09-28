# SPDX-License-Identifier: MIT
"""
gunicorn_admin_conf.py — Admin process gunicorn configuration.

Differences from gunicorn_conf.py
=================================

* **Single worker by default** — the admin UI sees one operator at a
  time, in-memory state per worker (admin's view of ``system_events``,
  the rate-limit dict, etc.) does not need to be shared across workers
  for this use case. One worker also keeps the surface trivially auditable.
* **Different port** (8002 by default; override with ``BIND``).
* **Different access/error log labels** so the systemd journal lets you
  filter ``main`` vs ``admin``.
* **Lower ``max_requests``** because the traffic is sparse — recycling
  too aggressively would just churn a fresh process for no benefit.

Launch
------
::

    APP_MODE=admin APP_SERVICE=admin \\
        gunicorn -c gunicorn_admin_conf.py admin_app:app
"""
import os

# ── Workers ──────────────────────────────────────────────────────
# Admin is a single-operator surface: one worker is plenty.
# Override via ADMIN_WORKERS=N in the environment if you really want to.
workers = int(os.environ.get("ADMIN_WORKERS", "1"))

# Class de worker : uvicorn async, durci (audit 2026-08-02, W1/W2 —
# cf. server/uvicorn_worker.py : timeout_graceful_shutdown borné + annonce
# du shutdown aux clients SSE).
worker_class = "server.uvicorn_worker.ElpisUvicornWorker"

# ── Réseau ───────────────────────────────────────────────────────
# Default :8002 — main app uses :8001. Le host par défaut suit le toggle
# HTTPS admin (config.json › security.https.enabled) : 127.0.0.1 quand le
# reverse proxy Caddy est le seul point d'entrée ; en accès direct,
# security.listen (local → 127.0.0.1, lan → 0.0.0.0). Règle : _bind_host.py.
# Même mécanique que gunicorn_conf.py (lecture JSON pure, ré-exécutée au
# SIGHUP → re-bind). Break-glass : env BIND prioritaire.
def _default_host():
    # Chargé par chemin : le master gunicorn exécute ce fichier hors paquet.
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "_bind_host", os.path.join(os.path.dirname(os.path.abspath(__file__)), "_bind_host.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.default_host()

_default_host = _default_host()
bind = os.environ.get("BIND", f"{_default_host}:8002")

# Voir gunicorn_conf.py : requis pour que le SIGHUP du toggle HTTPS puisse
# re-binder le même port sur un host différent pendant que les anciens
# workers tiennent encore l'ancienne socket.
reuse_port = True


def on_reload(server):
    # Voir gunicorn_conf.py : en reuse_port, reload() recrée à tort des
    # listeners côté master (socket jamais accept()ée = requêtes pendues) ;
    # on les referme, les workers rebinderont leurs propres sockets.
    if not server.cfg.reuse_port:
        return
    for lnr in server.LISTENERS:
        try:
            lnr.close()
        except Exception:
            pass
    server.LISTENERS = []

# Keep-alive élevé pour les SSE des logs (admin UI lit /api/system-events).
keepalive = 120

# Timeout généreux : un restore / backup peut prendre des dizaines de
# secondes mais reste très en-dessous de 600s.
timeout = 600
# AUDIT 2026-08-02 (E1) — le worker admin utilise désormais
# ``ElpisUvicornWorker`` (drain borné à ``GRACEFUL_SHUTDOWN_S=300 s``, cf.
# server/uvicorn_worker.py). Comme la conf principale, ``graceful_timeout``
# DOIT excéder ce drain : sinon un SIGTERM (toggle HTTPS / self-reload) en
# plein backup/restore (« des dizaines de secondes ») SIGKILL le worker à
# T+30 s, tronquant l'écriture et sautant le lifespan-shutdown. Borné par
# ``timeout=600`` (murder_workers) en ultime recours.
graceful_timeout = 330

# ── Logging ──────────────────────────────────────────────────────
# Uvicorn's loggers are bridged into the JSONL file by access_logging.py
# anyway — we still send to stdout/stderr for systemd/journald visibility.
accesslog = "-"
errorlog = "-"
loglevel = "info"

# ── Stabilité ────────────────────────────────────────────────────
# Le seuil était plus bas que celui de l'app principale, au motif que « le
# trafic admin est rare, donc le recyclage est bon marché ». C'est l'inverse :
# le process admin ne tourne qu'à **1 worker** (ADMIN_WORKERS), donc son
# recyclage n'est absorbé par personne — c'est une coupure franche de la
# console, pas une perte de 1/N de capacité.
#
# Et 5000 requêtes, ce n'est pas 5000 gestes d'administration : ``admin.html``
# charge 38 sous-ressources, servies par ce même process. Une console ouverte
# et rechargée quelques dizaines de fois suffisait à provoquer le recyclage.
#
# Même valeur que l'app principale, même raisonnement (cf. gunicorn_conf.py et
# la campagne tests/load), et même garde-fou sur le jitter.
max_requests = max(0, int(os.environ.get("ADMIN_MAX_REQUESTS", "50000")))
max_requests_jitter = (max_requests // 10) if max_requests else 0

# Pas de preload : same reason as main — asyncio resources don't survive fork.
preload_app = False
