# SPDX-License-Identifier: MIT
"""shared_infra/mcp/local_registry.py — registre des serveurs MCP LOCAUX.

(2026-09-05) Un serveur MCP local se déclare en JSON, au FORMAT STANDARD d'un
client MCP (le même que ``opencode.json`` / Claude Desktop) :

    "mon-serveur": {
        "transport": "stdio",              # stdio | sse | streamable-http
        "command": "python", "args": ["/opt/mcp/foo.py"], "env": {"K": "v"},
        "description": "…",                # libellé humain (optionnel)
        "expose_opencode": true            # publié dans opencode.json ? (défaut: false)
    }
    "mon-http": {
        "transport": "streamable-http",
        "url": "http://127.0.0.1:9000/mcp",
        "headers": {"Authorization": "Bearer …"},
        "expose_opencode": true
    }

(2026-09-11) DÉPRÉCIÉ au profit du manifeste ``mcp.json`` (``shared_infra.mcp.
manifest``) : ``mcp.local_servers`` reste LU (reversé dans le manifeste
synthétisé, avec avertissement) pendant une version. Les fonctions publiques
ci-dessous sont conservées comme façade et délèguent au manifeste.

Source : ``config.json › mcp.local_servers`` (dict nom→descripteur). Le service
d'outils INTÉGRÉ (« local-tools », familles fs/git/browser/…) en est l'entrée
par défaut, synthétisée par ``shared_infra.config`` (hôte/port/transport/jeton),
et surchargeable par une entrée ``local-tools`` du même dict.

BUT : ajouter un MCP local = ajouter une entrée JSON ; et la configuration
SURVIT au redémarrage (contrairement aux variables d'env du script de
lancement — cf. la régression corrigée le 2026-09-05).

Ce module ne touche PAS aux serveurs MCP EXTERNES (table chiffrée en base,
panneau d'outils) ni au dossier ``mcp_custom_servers`` : il ne décrit que les
serveurs LOCAUX déclarés en config.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

_REMOTE_TRANSPORTS = ("sse", "streamable-http")
_VALID_TRANSPORTS = ("stdio", "sse", "streamable-http")


def _norm_transport(raw: Any) -> str:
    t = str(raw or "").strip().lower()
    if t in ("http", "streamable_http", "streamablehttp"):
        return "streamable-http"
    return t if t in _VALID_TRANSPORTS else "stdio"


def _normalize(name: str, raw: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Descripteur brut → forme normalisée, ou ``None`` si inexploitable
    (un descripteur incohérent ne doit jamais faire tomber le registre)."""
    if not isinstance(raw, dict):
        return None
    d: Dict[str, Any] = dict(raw)
    d["name"] = name
    d["transport"] = _norm_transport(d.get("transport"))
    d["builtin"] = bool(d.get("builtin"))
    d["expose_opencode"] = bool(d.get("expose_opencode"))
    if d["transport"] in _REMOTE_TRANSPORTS:
        if not str(d.get("url") or "").strip() and not d["builtin"]:
            return None                      # réseau sans URL = inexploitable
    else:  # stdio
        if not str(d.get("command") or "").strip() and not d["builtin"]:
            return None                      # stdio sans commande = inexploitable
    return d


def _builtin() -> Dict[str, Any]:
    """Descripteur normalisé du service intégré, depuis ``shared_infra.config``.

    Import LOCAL (pas au niveau module) : ``config`` importe ce module
    indirectement via d'autres routes, et un import circulaire au chargement
    casserait le boot."""
    from shared_infra import config as cfg
    d = cfg._builtin_local_mcp()
    d = dict(d)
    d["name"] = "local-tools"
    d["transport"] = _norm_transport(d.get("transport"))
    d["builtin"] = True
    d.setdefault("expose_opencode", True)
    d["expose_opencode"] = bool(d.get("expose_opencode"))
    return d


def local_servers() -> Dict[str, Dict[str, Any]]:
    """Tous les serveurs MCP locaux déclarés, nom → descripteur normalisé.

    Le service intégré (« local-tools ») est TOUJOURS présent ; une entrée
    ``local-tools`` de ``mcp.local_servers`` le SURCHARGE (déjà fusionnée par
    ``config._builtin_local_mcp``), les autres noms s'ajoutent."""
    from shared_infra import config as cfg
    out: Dict[str, Dict[str, Any]] = {"local-tools": _builtin()}
    raw = getattr(cfg, "LOCAL_MCP_SERVERS_RAW", None)
    if isinstance(raw, dict):
        for name, spec in raw.items():
            if not isinstance(name, str) or not name.strip() or name == "local-tools":
                continue
            norm = _normalize(name.strip(), spec)
            if norm is not None:
                out[name.strip()] = norm
    return out


def service_upstream() -> Tuple[Optional[str], str]:
    """``(url, token)`` du service INTÉGRÉ partagé pour le relais
    ``/api/mcp-bridge`` — ou ``(None, "")`` s'il n'est pas exposable.

    (2026-09-11) Source UNIQUE : l'entrée ``role: toolhost`` du manifeste
    ``mcp.json`` (``shared_infra.mcp.manifest``). Sans fichier, le manifeste
    est synthétisé depuis la config héritée — même résolution qu'avant.

    INVARIANT DE SÉCURITÉ (inchangé) : sans jeton de SERVICE, le service tourne
    sans vérificateur → aucune requête ne porte ``client_kind=opencode`` → les
    familles fs/shell ne sont plus masquées. On ne relaie donc rien sans jeton.
    """
    from shared_infra.mcp import manifest as _mf
    return _mf.service_upstream()


def opencode_local_servers() -> List[Dict[str, Any]]:
    """Serveurs EXTERNES déclarés dans ``mcp.json`` avec
    ``x-elpis.opencode.publish: true`` et une URL réseau (opencode distant ne
    peut pas lancer un stdio de l'hôte serveur) — à publier tels quels dans
    ``opencode.json``. Les entrées héritées de ``mcp.local_servers`` y sont
    reversées par la synthèse du manifeste (``expose_opencode`` → ``publish``)."""
    from shared_infra.mcp import manifest as _mf
    out: List[Dict[str, Any]] = []
    for e in _mf.load().externals():
        if e.opencode_publish and e.is_network:
            d = {"name": e.name, "transport": ("sse" if e.type == "sse" else "streamable-http"),
                 "url": e.url, "headers": dict(e.headers), "enabled": e.enabled,
                 "description": e.description, "expose_opencode": True, "builtin": False}
            out.append(d)
    return out


def opencode_entry_for(d: Dict[str, Any]) -> Dict[str, Any]:
    """Descripteur local réseau → entrée ``opencode.json`` (``type: remote``)."""
    entry: Dict[str, Any] = {
        "type": "remote",
        "url": str(d.get("url") or "").strip(),
        "enabled": bool(d.get("enabled", True)),
    }
    hdrs = d.get("headers")
    if isinstance(hdrs, dict) and hdrs:
        entry["headers"] = {str(k): str(v) for k, v in hdrs.items()}
    return entry
