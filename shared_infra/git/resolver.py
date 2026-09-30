# SPDX-License-Identifier: MIT
"""
shared_infra.git.resolver — Résolution UNIFIÉE des credentials git.

Remplace le fichier sale ``.git-credentials.json`` ET le mécanisme par-requête
``cred_user``/``cred_token``. Un SEUL point d'entrée, consommé par le chemin MCP
(``git_submit`` push + PR) et les routes (push/pull) :

    resolve_git_credential(user_id, remote_url) -> {username, token,
        provider_type, host, api_base} | None

Le token n'est lu QUE côté hôte (jamais sérialisé HTTP, jamais écrit dans
``/work``). ``import_legacy_git_credentials`` importe l'ancien fichier, lu par
l'agent de la sandbox (``git_ops.import_legacy_credentials``).
"""
from __future__ import annotations

import json
import logging
from typing import Any, Dict, Optional
from urllib.parse import urlsplit

from shared_infra.git import connectors as _gc
from shared_infra.git.detect import default_provider_type, detect_provider, normalize_host
from shared_infra.git.providers import get_provider

logger = logging.getLogger("uvicorn.error")

_CANONICAL_HOST = {"github": "github.com", "gitlab": "gitlab.com", "bitbucket": "bitbucket.org"}


def _host_and_provider(target: str) -> tuple:
    """``(host, detected_provider)`` depuis une URL de repo OU un ``host[:port]``
    nu. Vide si non exploitable."""
    info = detect_provider(target or "")
    if info.get("host"):
        return (info["host"] or "").lower(), info.get("provider", "unknown")
    return (normalize_host(target) or "").lower(), "unknown"


def save_git_credential(user_id: int, target: str, username: str, token: str,
                        provider_type: str = "") -> Optional[int]:
    """Enregistre (UPSERT) un credential git keyé sur le HOST de ``target`` — une
    URL de repo ou un ``host[:port]`` nu.

    But (AUDIT 2026-08-02) : l'utilisateur donne ses creds UNE FOIS (au clone, ou
    dans le chat au modèle) ; on les persiste pour ce host afin que clone / push /
    pull / PR — et les outils du modèle — les réutilisent AUTOMATIQUEMENT, SANS
    créer/matcher un connecteur à la main (le host est déduit de l'URL → il matche
    toujours ensuite). Retourne le ``connector_id`` ou ``None``.

    Un connecteur EXISTANT pour ce host voit juste son token (et son username si
    fourni) rafraîchi — son ``provider_type`` est respecté. Sinon on en crée un ;
    ``provider_type`` déduit (github/gitlab/bitbucket) ou ``gitea`` par défaut pour
    un self-hosted inconnu (le plus courant sur LAN ; couvre l'API PR)."""
    if not (user_id and token and (token or "").strip()):
        return None
    host, detected = _host_and_provider(target)
    if not host:
        return None
    token = token.strip()
    existing = _gc.find_for_host(int(user_id), host)
    if existing:
        _gc.update_connector(int(user_id), existing[0]["id"], token=token,
                             username=(username or None))
        return existing[0]["id"]
    ptype = (provider_type or "").lower().strip()
    if ptype not in _gc.PROVIDER_TYPES:
        det = default_provider_type(detected)      # "generic" pour unknown
        ptype = det if det != "generic" else "gitea"
    return _gc.create_connector(int(user_id), ptype, host, token=token,
                                username=(username or ""), label="auto")


def resolve_git_credential(user_id: int, remote_url: str) -> Optional[Dict[str, Any]]:
    """Credentials pour ``remote_url`` (match par host, fallback par type), ou None.

    Bump ``last_used`` sur le connecteur choisi. ``api_base`` = override du
    connecteur sinon dérivé par le provider (cloud vs self-hosted).
    """
    if not user_id or not remote_url:
        return None
    info = detect_provider(remote_url)
    if not info:
        return None
    host = (info.get("host") or "").lower()

    rows = _gc.find_for_host(user_id, host) if host else []
    if not rows:
        ptype = default_provider_type(info.get("provider", ""))
        if ptype and ptype != "generic":
            rows = _gc.find_for_provider(user_id, ptype)
    if not rows:
        # (2026-09-11, P4) hôte d'outils DISTANT : la base locale ne connaît
        # aucun connecteur — l'app résout et renvoie l'identifiant (TLS).
        try:
            from shared_infra.toolhost import client as _thc
            if _thc.enabled():
                cred = _thc.git_credential(int(user_id), remote_url)
                if cred and cred.get("token"):
                    _pt = default_provider_type(info.get("provider", "")) or "generic"
                    _h = host or str(cred.get("host") or "")
                    return {"username": str(cred.get("username") or ""),
                            "token": str(cred.get("token") or ""),
                            "provider_type": _pt, "host": _h,
                            "api_base": get_provider(_pt).api_base(_h, ""),
                            "connector_id": None}
        except Exception:                                       # noqa: BLE001
            pass
        return None

    row = rows[0]  # déjà trié last_used desc, created_at desc
    _gc.bump_last_used(row["id"])
    provider_type = row["provider_type"]
    api_base = get_provider(provider_type).api_base(host or row["host"], row.get("api_base") or "")
    return {
        "username": row.get("username") or "",
        "token": row.get("token") or "",
        "provider_type": provider_type,
        "host": host or row["host"],
        "api_base": api_base,
        "connector_id": row["id"],
    }


# ── Bascule hors du fichier sandbox ───────────────────────────────────────────

def import_legacy_git_credentials(user_id: int, data: bytes) -> int:
    """Importe le contenu de l'ancien ``/work/.git-credentials.json`` dans le
    store (idempotent : un hôte déjà présent n'est pas recréé). Lu, puis
    supprimé, par l'agent de la sandbox (``git_ops``) : les jetons vivent
    hors de la sandbox. Best-effort.

    Format hérité : ``{provider: {token, user?, url?}}``. Le host vient de ``url``
    si présent (GitLab self-hosted) sinon du host canonique du provider.
    Renvoie le nombre de connecteurs créés, ``-1`` si l'import a échoué (base
    indisponible…) : l'appelant garde alors le fichier.
    """
    if not user_id:
        return 0
    try:
        entries = json.loads(data.decode("utf-8", errors="replace"))
    except ValueError:
        return 0                                        # illisible : rien à garder
    if not isinstance(entries, dict):
        return 0
    try:
        created = 0
        for provider_key, entry in entries.items():
            if not isinstance(entry, dict):
                continue
            token = (entry.get("token") or "").strip()
            if not token:
                continue
            url = (entry.get("url") or "").strip()
            host = (urlsplit(url).hostname or "").lower() if url else \
                _CANONICAL_HOST.get(str(provider_key).lower(), "")
            if not host:
                continue
            if _gc.find_for_host(user_id, host):       # déjà présent → idempotent
                continue
            _gc.create_connector(
                user_id, default_provider_type(str(provider_key).lower()), host,
                token=token, username=(entry.get("user") or ""), label="imported")
            created += 1
        if created:
            logger.info("[git] %d connecteur(s) importé(s) depuis .git-credentials.json (user=%s)",
                        created, user_id)
        return created
    except Exception as e:                              # noqa: BLE001 — best-effort
        logger.warning("[git] import legacy credentials échoué (user=%s): %s", user_id, e)
        return -1
