# SPDX-License-Identifier: MIT
"""
server/_bind_host.py — hôte d'écoute par défaut des deux confs gunicorn.

Audit 2026-09-22 (H2) : ``gunicorn_conf.py`` et ``gunicorn_admin_conf.py``
lisaient ``shared_infra/config.json``, déplacé à la racine le 2026-09-04.
L'ouverture échouait, le repli « fail-open » donnait ``0.0.0.0`` : app ET
admin exposées en clair sur le LAN même avec HTTPS activé.

Même résolution que ``shared_infra.config._resolve_config_json_path``
(``APP_CONFIG_PATH`` > racine > ancien emplacement), en JSON pur : le master
gunicorn n'importe pas l'app. Fichier PRÉSENT mais illisible = on ne sait
pas si HTTPS est actif : loopback (fail-closed), le break-glass ``BIND``
reste disponible.

2026-09-28 : réglage ``security.listen`` (« local » → 127.0.0.1, « lan » →
0.0.0.0), sans objet en HTTPS (Caddy est le frontal). Fichier ABSENT →
loopback (sûr par défaut). Clé ABSENTE d'une config existante → 0.0.0.0 :
les installations d'avant le réglage restent joignables après mise à jour.
Même règle dupliquée dans ``elpis`` (``_bind_default``).
"""
from __future__ import annotations

import json
import os
import sys

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def config_path() -> str:
    env = os.environ.get("APP_CONFIG_PATH")
    if env:
        return env
    for cand in (os.path.join(_ROOT, "config.json"),
                 os.path.join(_ROOT, "shared_infra", "config.json")):
        if os.path.exists(cand):
            return cand
    return os.path.join(_ROOT, "config.json")


def host_for(cfg: dict) -> str:
    """Hôte d'écoute d'une config lue (dict). Lève si la forme est invalide."""
    sec = cfg.get("security") or {}
    if bool((sec.get("https") or {}).get("enabled", False)):
        return "127.0.0.1"
    listen = sec.get("listen")
    if listen is None:
        # Config d'avant le réglage : accès direct historique conservé.
        return "0.0.0.0"
    return "0.0.0.0" if str(listen).strip().lower() == "lan" else "127.0.0.1"


def default_host() -> str:
    path = config_path()
    if not os.path.exists(path):
        return "127.0.0.1"
    try:
        with open(path, encoding="utf-8") as f:
            return host_for(json.load(f))
    except Exception as e:                                   # noqa: BLE001
        print(f"[gunicorn] config.json illisible ({path}: {e}) : écoute sur "
              f"127.0.0.1 par prudence. BIND=0.0.0.0:<port> pour forcer.",
              file=sys.stderr, flush=True)
        return "127.0.0.1"
