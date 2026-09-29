# SPDX-License-Identifier: MIT
"""
backend.routes.config — Per-user JSON config CRUD.

Two endpoints:

- GET  /api/config   — returns the current user's config (defaults shipped
                        if neither global nor per-user file exists). The
                        endpoint also returns a few session diagnostics
                        (``session_keys``, ``logged_in``, ``db_user_found``)
                        the front uses to decide whether to show the
                        login screen. **Authentification requise** (cf. AUDIT
                        2026-08-30 / S1 ci-dessous).
- PUT  /api/config   — overwrites the per-user file (atomic). Capped at
                        200 KB to prevent a hostile user from filling the
                        disk with a giant config blob.

Why this is per-user
--------------------
The chat side of the app lets every user pick their own llama-server URL,
model defaults, etc. The admin side has its own /api/admin/config-file
which writes the GLOBAL config.json. These are intentionally separate —
mixing them up in the same file used to cause "I changed my user config
and the global config went with it" bugs.

Helpers (still in ``_legacy``)
------------------------------
- ``_session_uid_any``   — resolve uid from the session cookie, with the
                            same revocation/expiry checks as ``require_user_id``
- ``_read_json_file``    — best-effort JSON read (returns ``{}`` on error)
- ``_write_json_atomic`` — write-rename-replace so a crash mid-write
                            doesn't leave a half-written file
- ``_user_cfg_path``     — ``USER_CONFIG_DIR / "{uid}.json"``
"""
from __future__ import annotations

import json

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse

from shared_infra.accounts.users import get_username_by_id
from shared_infra.config import read_config_json
from shared_infra.routes._helpers import _read_json_file, _session_uid_any, _user_cfg_path, _write_json_atomic
from shared_infra.routes._state import router

# ─────────────────────────────────────────────────────────────────────────────
#  DEFAULTS
# ─────────────────────────────────────────────────────────────────────────────
# Returned when neither the global config.json nor the per-user file exist.
# Kept identical to the historical inline literal so existing user JSON files
# remain a strict superset.
_DEFAULT_CONFIG = {
    "llama": {
        "ip": "127.0.0.1", "port": "8080", "url": "", "model": "local-model",
        "timeout_sec": 600, "retries": 1, "retry_backoff_sec": 0.6,
    },
    "mcp": {
        "server_cmd": "server/local_mcp_server.py",
        "tools_cache_ttl_sec": 360.0,
    },
    "app": {
        "db_path": "user_db/app.db",
        "session_secret": "",
        "max_recent_chats": 100,
        "sandbox_dir": "user_sandboxes",
    },
    "security": {
        "password_policy": {
            "min_length": 0,
            "require_uppercase": False,
            "require_lowercase": False,
            "require_numbers": False,
            "require_special": False,
        },
    },
}


# ─────────────────────────────────────────────────────────────────────────────
#  BLANCHIMENT DES SECRETS (AUDIT 2026-08-30, S1)
# ─────────────────────────────────────────────────────────────────────────────
# Fermer la branche anonyme ne suffit pas : la branche AUTHENTIFIÉE copie le
# config.json d'instance dans le fichier per-user (``_write_json_atomic`` plus
# bas) puis le renvoie. Un compte ORDINAIRE lisait donc les mêmes secrets, et
# ils se retrouvaient dupliqués dans autant de fichiers que d'utilisateurs.
#
# Ces clés ne sont d'ailleurs pas per-user par nature — un secret de session ou
# un token de scrape n'a de sens qu'au niveau instance, où l'admin les édite via
# ``/api/admin/config-file``. On les retire donc de la vue per-user, en lecture
# comme à la copie initiale.
#
# Liste EXPLICITE plutôt qu'une heuristique sur le nom : une heuristique
# « contient token/secret/key » attraperait ``api_key_header`` ou
# ``public_key`` un jour, et raterait un champ nommé autrement. Chaque entrée
# est un chemin pointé dans le config.
_SECRET_PATHS = (
    "app.session_secret",
    # Clé Fernet de TOUS les secrets chiffrés (MCP, connecteurs) : absente de
    # la liste jusqu'au 2026-09-22, elle partait en clair si l'admin la posait
    # dans config.json plutôt que dans user_db/.encryption_key.
    "app.encryption_key",
    "rag.qdrant_api_key",
    "rag.service_token",
    "metrics.scrape_token",
    "agent_memory.qdrant_api_key",
    "agent_memory.embed_api_key",
    # Jetons des deux services vocaux (2026-09-22). Ils sont IMBRIQUÉS d'un
    # niveau de plus que les autres — d'où la marche en profondeur ci-dessous.
    "voice.stt.token",
    "voice.tts.token",
    # Jetons du serveur MCP local (audit 2026-09-22, M6) : ``local_client_tokens``
    # est un dict ``{jeton: utilisateur}`` — les CLÉS sont les secrets, d'où
    # un vidage qui garde le type (``{}``) plutôt qu'une chaîne.
    "mcp.local_token",
    "mcp.local_client_tokens",
)


def _redact_secrets(cfg: dict) -> dict:
    """Copie de ``cfg`` sans les valeurs de ``_SECRET_PATHS``.

    Copie PROFONDE des seules branches touchées : le reste est partagé (ces
    dicts viennent de ``read_config_json``, dont la vue est mise en cache pour
    tout le process — la muter contaminerait chaque lecteur). Les clés sont
    conservées et vidées, jamais supprimées : le front d'administration
    distingue « champ absent » de « champ non renseigné », et une clé qui
    disparaît ferait remonter le défaut du code au lieu de la valeur.
    """
    if not isinstance(cfg, dict):
        return cfg
    out = dict(cfg)
    for path in _SECRET_PATHS:
        *parents, cle = path.split(".")
        # Marche en profondeur, en recopiant chaque niveau traversé. Un
        # ``partition(".")`` ne gérait que « section.clé » : ``voice.stt.token``
        # serait allé chercher une clé littérale « stt.token », et le jeton
        # serait parti en clair.
        noeud = out
        for parent in parents:
            enfant = noeud.get(parent)
            if not isinstance(enfant, dict):
                noeud = None
                break
            enfant = dict(enfant)          # copie AVANT mutation
            noeud[parent] = enfant
            noeud = enfant
        if noeud is not None and cle in noeud:
            v = noeud[cle]
            noeud[cle] = {} if isinstance(v, dict) else [] if isinstance(v, list) else ""
    return out


# ─────────────────────────────────────────────────────────────────────────────
#  ENDPOINTS
# ─────────────────────────────────────────────────────────────────────────────
@router.get("/api/config")
def api_get_config(request: Request):
    uid = _session_uid_any(request)
    default_cfg = read_config_json() or {}
    if not isinstance(default_cfg, dict) or not default_cfg:
        default_cfg = dict(_DEFAULT_CONFIG)  # shallow copy: callers may mutate
    username = get_username_by_id(uid) if uid is not None else None
    logged = bool(username)
    if not logged:
        # AUDIT 2026-08-30 (S1) — cette branche renvoyait ``default_cfg``, donc
        # le config.json d'instance ENTIER (402 Ko mesurés), à un client
        # ANONYME : secrets (``app.session_secret``, ``rag.qdrant_api_key``,
        # ``rag.service_token``, ``metrics.scrape_token``, les deux clés
        # d'``agent_memory``), topologie interne (IP et ports de llama, vision,
        # moteur vocal, agent desktop, Qdrant), arborescence serveur et
        # politique de mots de passe.
        #
        # Le secret de session publié était le PLACEHOLDER — ``config.py``
        # le neutralise au profit de ``user_db/.session_secret`` — donc aucune
        # forge de cookie n'était possible en l'état. Mais la résolution du
        # secret documente une branche « config.json › app.session_secret =
        # config explicite de l'admin » : le jour où un opérateur l'emprunte,
        # la route publie la clé de signature et l'usurpation devient
        # immédiate. Le champ est publié inconditionnellement ; il était vide
        # par chance, pas par construction.
        #
        # 401 plutôt qu'une vue restreinte : AUCUN client ne consomme cette
        # route sans session. L'écran de connexion utilise ``/api/public-config``
        # (cf. ``frontend/js/app-auth.js``), qui ne rend que ``welcome`` /
        # ``app_info`` / ``login_page`` — c'est LA vue publique, et elle
        # existe déjà. Accessoirement, on cesse de servir 402 Ko à un anonyme
        # sur une route sans rate-limit.
        raise HTTPException(status_code=401, detail="not logged in")
    upath = _user_cfg_path(int(uid))
    # Blanchiment AVANT la copie : sans lui, chaque nouvel utilisateur se voyait
    # matérialiser une copie des secrets d'instance dans son propre fichier —
    # N copies à faire tourner le jour d'une rotation, et autant de chances
    # qu'une fuite. Les fichiers DÉJÀ écrits gardent leurs valeurs ; le
    # blanchiment de sortie ci-dessous les couvre.
    if not upath.exists():
        _write_json_atomic(upath, _redact_secrets(default_cfg))
    user_cfg = _read_json_file(upath)
    if not isinstance(user_cfg, dict) or not user_cfg:
        user_cfg = default_cfg
    return JSONResponse(
        {
            "mode": "user",
            "editable": True,
            "logged_in": True,
            "session_user_id": int(uid),
            "db_user_found": True,
            "username": username,
            "session_keys": list(request.session.keys()),
            "config": _redact_secrets(user_cfg),
        },
        headers={"Cache-Control": "no-cache"},
    )


@router.put("/api/config")
async def api_put_config(request: Request):
    uid = _session_uid_any(request)
    username = get_username_by_id(uid) if uid is not None else None
    if not username:
        raise HTTPException(status_code=401, detail="not logged in")
    payload = await request.json()
    cfg = payload.get("config")
    if not isinstance(cfg, dict):
        raise HTTPException(status_code=400, detail="config must be an object")
    raw = json.dumps(cfg, ensure_ascii=False)
    if len(raw) > 200_000:
        raise HTTPException(status_code=413, detail="config too large")
    upath = _user_cfg_path(int(uid))
    _write_json_atomic(upath, cfg)
    return {"ok": True, "path": str(upath)}
