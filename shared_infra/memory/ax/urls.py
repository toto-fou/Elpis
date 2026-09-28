# SPDX-License-Identifier: MIT
"""
URL normalisation and site-alias resolution.

Auto-extracted from the former monolithic ``backend/ax_memory/_legacy.py``.
Function bodies are byte-for-byte identical to the originals.
"""
from __future__ import annotations

import logging
import re
from urllib.parse import urlparse

log = logging.getLogger(__name__)



# ── Constants used by URL normalisation ──────────────────────────────
# Patterns that turn opaque IDs in URL paths into a stable "/*" placeholder
# so ``/users/abc123/profile`` and ``/users/def456/profile`` collapse to
# the same canonical path.
_ID_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
                r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?=/|$)"), "/*"),
    (re.compile(r"/[A-Z][A-Z0-9]{1,9}-\d+(?=/|$)"), "/*"),
    (re.compile(r"/[a-f0-9]{8,}(?=/|$)"), "/*"),
    (re.compile(r"/\d{3,}(?=/|$)"), "/*"),
]

# Private IPs (RFC1918 + loopback + link-local) → all normalised to ':port'
# so the same app deployed across multiple VMs shares a single AX tree.
_PRIVATE_IP_RX = re.compile(
    r"^("
    r"10\.\d{1,3}\.\d{1,3}\.\d{1,3}"
    r"|172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}"
    r"|192\.168\.\d{1,3}\.\d{1,3}"
    r"|127\.\d{1,3}\.\d{1,3}\.\d{1,3}"
    r"|169\.254\.\d{1,3}\.\d{1,3}"
    r")$"
)

# Wider regex: any literal IPv4 (private or public). Used when
# config.app.ax_dedup_any_ip is true — typical of deployments using
# public IP ranges (VPN, peering) that should still be treated as
# "the same app on multiple VMs".
_ANY_IP_RX = re.compile(
    r"^(\d{1,3}\.){3}\d{1,3}$"
)


def _should_dedup_any_ip() -> bool:
    """Flag config (cache non necessaire, lecture tres peu frequente)."""
    try:
        from shared_infra.config import read_config_json
        cfg = read_config_json() or {}
        return bool((cfg.get("app") or {}).get("ax_dedup_any_ip", False))
    except Exception:
        return False
def _load_site_aliases() -> dict:
    """
    Charge le mapping {port: alias_name} depuis config.json.
    Exemple de config :
        {"app": {"ax_site_aliases": {"1010": "jira", "2020": "confluence"}}}
    Retourne {} si rien configure ou si erreur.
    """
    try:
        from shared_infra.config import read_config_json
        cfg = read_config_json() or {}
        aliases = (cfg.get("app") or {}).get("ax_site_aliases") or {}
        # Normaliser en str (les ports peuvent etre int ou str en JSON)
        return {str(k): str(v) for k, v in aliases.items()}
    except Exception:
        return {}
def _normalize_site(netloc: str) -> str:
    """
    Normalise un netloc (host:port) pour que plusieurs IPs d'une meme app
    logique partagent la meme cle de stockage.

    Regles (ordre de priorite) :
      1. Si le port a un alias configure dans ax_site_aliases -> retourne l'alias
         (ex: "10.10.10.10:1010" + alias {1010: 'jira'} -> "jira")
      2. Si l'host est une IP privee (RFC1918) -> remplace l'host par ':'
         (ex: "10.10.10.10:1010" -> ":1010")
      3. Sinon (DNS name ou IP publique) -> retourne le netloc tel quel
         (ex: "jira.company.com" -> "jira.company.com")

    Le port par defaut (80/443) est preserve.
    """
    if not netloc:
        return ""
    # Separation host / port
    host = netloc
    port = ""
    if ":" in netloc:
        host, _, port = netloc.rpartition(":")
    host = host.lower().strip()
    port = port.strip()

    # Regle 1 : alias explicite pour ce port
    if port:
        aliases = _load_site_aliases()
        if port in aliases:
            return aliases[port]

    # Regle 2 : IP privee -> anonymisation
    if _PRIVATE_IP_RX.match(host):
        if port:
            return f":{port}"
        # IP privee sans port -> :http par defaut (rare)
        return ":_"

    # Regle 2bis : toute IPv4 litterale si le flag config est active.
    # Utile pour deploiements multi-VM avec IPs publiques/VPN distinctes
    # mais qui servent la meme app logique. Activer via :
    #   config.json > {"app": {"ax_dedup_any_ip": true}}
    if _ANY_IP_RX.match(host) and _should_dedup_any_ip():
        if port:
            return f":{port}"
        return ":_"

    # Regle 3 : sinon on garde tel quel
    return netloc.lower()
def normalize_url(url: str) -> tuple[str, str]:
    if not url:
        return "", "/"
    try:
        p = urlparse(url)
        site = _normalize_site(p.netloc or "")
        path = p.path or "/"
        for rx, repl in _ID_PATTERNS:
            path = rx.sub(repl, path)
        path = re.sub(r"/+", "/", path)
        if len(path) > 1 and path.endswith("/"):
            path = path[:-1]
        return site, path or "/"
    except Exception:
        return "", "/"


_WS = re.compile(r"\s+")
