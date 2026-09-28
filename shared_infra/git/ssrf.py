# SPDX-License-Identifier: MIT
"""
shared_infra.git.ssrf — Validateur SSRF UNIFIÉ pour les opérations git/API host-side.

Fusionne les deux validateurs divergents qui coexistaient :
  - ``git_tools._clone_url_block_reason`` (https-only, IP privées) ;
  - ``sandbox_git._validate_git_url`` (http/https/git, suffixes internes,
    anti-DNS-rebinding).

``git clone/fetch/push/pull`` et les appels d'API PR tournent sur l'HÔTE (hors
container ``--network=none``) → une URL interne est exploitable (pivot LAN,
metadata cloud). On bloque tout ce qui résout vers une IP non globale.

``allow_hosts`` = exception explicite (opt-in) pour les hosts de connecteurs
ENREGISTRÉS par l'utilisateur (ex. ``gitlab.acme.internal``) — sinon le blocage
IP-privée interdirait tout self-hosted légitime.
"""
from __future__ import annotations

import ipaddress
import socket
from typing import Iterable, Optional
from urllib.parse import urlsplit

_BLOCKED_HOST_SUFFIXES = (".local", ".internal", ".lan", ".home", ".corp", ".intranet")
_BLOCKED_HOST_LITERALS = frozenset({
    "localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback",
})

# Schémas autorisés pour un REMOTE git (clone/fetch/push/pull). Source UNIQUE
# partagée par la route sandbox (``sandbox_git``) ET les outils git de l'agent
# (``llm_core.tools.git_tools``) — historiquement divergents : la route
# autorisait http/https/git mais les outils forçaient https-only, si bien qu'un
# repo à remote HTTP (serveur git interne, miroir public en clair) clonable via
# l'UI se prenait un ``blocked_remote`` dès que l'agent faisait fetch/push. Le
# schéma n'est PAS la barrière anti-SSRF : ce sont les checks IP/host/DNS
# ci-dessous (une IP interne reste bloquée en http comme en https). ``file://``
# / ``ssh://`` restent exclus. Les appels d'API PR (git_connectors) gardent, eux,
# ``https`` seul (ce sont des API REST, pas des remotes git).
GIT_REMOTE_SCHEMES = frozenset({"http", "https", "git"})


def block_remote_url_reason(url: str, *,
                            allow_schemes: Iterable[str] = ("https",),
                            allow_hosts: Iterable[str] = (),
                            critical_only: bool = False) -> Optional[str]:
    """Renvoie un motif de blocage (str) ou ``None`` si l'URL est sûre.

    ``allow_schemes`` : schémas autorisés (``https`` pour clone ; routes peuvent
    passer ``http``/``git``). ``allow_hosts`` : hosts (``host`` ou ``host:port``)
    autorisés malgré une IP privée (connecteurs self-hosted enregistrés).

    ``critical_only`` (AUDIT 2026-08-02) : ne bloque QUE les cibles SSRF à haute
    valeur — loopback (services locaux) et link-local ``169.254/16`` / ``fe80::/10``
    (**metadata cloud** : vol de credentials d'instance), plus unspecified /
    multicast. Les IP LAN PRIVÉES (``10/172.16/192.168``, ULA) et les hostnames
    internes (``.internal``, ``.lan``…) sont AUTORISÉS : c'est là que vit un
    serveur git self-hosted légitime. Utilisé par les outils git de l'AGENT
    (``git_tools``) — le « critique » y est la protection de branche ``main``,
    PAS le fait d'atteindre le LAN interne du propriétaire. Les routes UI
    (``sandbox_git``) et les API PR (``git_connectors``) gardent le mode strict
    (défaut ``False`` : tout ce qui n'est pas ``is_global`` est bloqué)."""
    u = (url or "").strip()
    if not u:
        return "empty_url"
    try:
        p = urlsplit(u)
    except Exception:
        return "malformed_url"

    scheme = (p.scheme or "").lower()
    if p.username or p.password or "@" in (p.netloc or ""):
        return "credentials_in_url"

    host = (p.hostname or "").lower()
    if not host:
        return "no_host"

    # Opt-in self-hosted : host explicitement enregistré par l'utilisateur.
    allow = {h.lower() for h in (allow_hosts or ()) if h}
    cands = {host}
    if p.port:
        cands.add(f"{host}:{p.port}")
    allowlisted = bool(cands & allow)

    # Schéma : un host de connecteur ENREGISTRÉ (opt-in propriétaire) peut
    # utiliser http/https/git — un Gitea/GitLab self-hosted sur le LAN est
    # souvent en HTTP. Sinon on applique strictement ``allow_schemes``. (file://
    # / ssh:// restent refusés même pour un host allowlisté : pas de host http.)
    effective = {s.lower() for s in allow_schemes}
    if allowlisted:
        effective |= {"http", "https", "git"}
    if scheme not in effective:
        return f"scheme_not_allowed ({scheme or 'empty'})"

    # Host allowlisté → bypass des checks IP/suffixe/résolution (l'utilisateur
    # l'a explicitement enregistré comme connecteur, IP privée comprise).
    if allowlisted:
        return None

    def _ip_blocked(ipobj) -> bool:
        # Mode ``critical_only`` : seules les cibles réellement dangereuses —
        # loopback + link-local (metadata) + unspecified/multicast. Le LAN privé
        # est autorisé (serveur git self-hosted légitime). Mode strict (défaut) :
        # tout ce qui n'est pas globalement routable est bloqué.
        if critical_only:
            return (ipobj.is_loopback or ipobj.is_link_local
                    or ipobj.is_unspecified or ipobj.is_multicast)
        return not ipobj.is_global

    # IP littérale (décimale/octale/IPv6 gérées par ipaddress).
    try:
        ip = ipaddress.ip_address(host)
        return f"blocked_ip ({ip})" if _ip_blocked(ip) else None
    except ValueError:
        pass

    # Loopback nommé : bloqué dans les DEUX modes (c'est du loopback).
    if host in _BLOCKED_HOST_LITERALS:
        return f"blocked_host ({host})"
    # Suffixes internes (.internal/.lan/…) : bloqués en STRICT seulement. En
    # critical_only on les laisse résoudre — s'ils pointent vers du loopback/
    # link-local, la résolution ci-dessous les rattrape ; sinon (LAN privé) OK.
    if not critical_only:
        for suffix in _BLOCKED_HOST_SUFFIXES:
            if host == suffix.lstrip(".") or host.endswith(suffix):
                return f"internal_suffix ({suffix})"

    # Anti DNS-rebinding : résoudre et vérifier CHAQUE IP selon le mode.
    try:
        infos = socket.getaddrinfo(host, p.port or None, proto=socket.IPPROTO_TCP)
    except OSError:
        return "unresolvable_host"
    for info in infos:
        try:
            rip = ipaddress.ip_address(info[4][0])
        except (ValueError, IndexError):
            continue
        if _ip_blocked(rip):
            return f"resolves_to_blocked ({rip})"
    return None
