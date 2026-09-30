# SPDX-License-Identifier: MIT
"""
shared_infra.security.browser_url — navigateur : propriétaire des sessions et
destinations autorisées, côté Python (2026-09-30).

Le service navigateur (``browser-service``) tourne sur l'hôte d'Elpis et fait
foi : il vérifie le propriétaire de chaque session et applique la garde des
destinations (``browser-service/url_guard.js``) à toutes les requêtes des
pages. Ce module fait deux choses pour les outils ``pw_*`` :

* ``pw_owner`` : l'identifiant de propriétaire transmis au service, dérivé
  du compte Elpis de façon injective (deux comptes ne partagent jamais une
  session, même si leurs noms ne diffèrent que par des accents) ;
* ``browser_url_block_reason`` : un refus ANTICIPÉ, avec un message clair
  pour le modèle, avant même d'appeler le service. Même politique (D-A1) :
  http/https (et about:blank) seulement ; jamais la boucle locale, le
  lien-local (métadonnées), les adresses de l'hôte ni ses réseaux de
  conteneurs ; réseau local autorisé, restreint par la liste blanche
  optionnelle ``browser.url_allowlist`` ; un nom est jugé sur les adresses
  qu'il résout. Réutilise ``shared_infra.git.ssrf`` (mode ``critical_only``).
"""
from __future__ import annotations

import hashlib
import ipaddress
import re
import socket
from typing import Iterable, List, Optional, Sequence, Set, Tuple, Union
from urllib.parse import urlsplit, urlunsplit

from shared_infra.git.ssrf import block_remote_url_reason

_OWNER_OK = re.compile(r"[A-Za-z0-9_-]{1,64}")

# Mêmes réseaux « locaux » que url_guard.js (soumis à la liste blanche).
_RESEAUX_LOCAUX = tuple(ipaddress.ip_network(n) for n in (
    "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "fc00::/7"))
_INTERFACES_CONTENEURS = re.compile(r"^(docker|br-|veth|virbr|cni|flannel|podman|lxc|lxd|incus|vnet|kube)")

IpNet = Union[ipaddress.IPv4Network, ipaddress.IPv6Network]
IpAddr = Union[ipaddress.IPv4Address, ipaddress.IPv6Address]


def pw_owner(username: Optional[str]) -> str:
    """Propriétaire transmis au service navigateur pour ce compte.

    Le nom lui-même s'il est déjà sûr (``[A-Za-z0-9_-]``, 64 max), sinon une
    empreinte stable : jamais deux comptes pour un même propriétaire (retirer
    les caractères non ASCII confondait « rené » et « ren »)."""
    u = (username or "").strip() or "guest"
    if _OWNER_OK.fullmatch(u):
        return u
    return "u_" + hashlib.sha256(u.encode("utf-8")).hexdigest()[:32]


def _ip(v: str) -> Optional[IpAddr]:
    try:
        a = ipaddress.ip_address((v or "").strip("[]").split("%")[0])
    except ValueError:
        return None
    if isinstance(a, ipaddress.IPv6Address) and a.ipv4_mapped:
        return a.ipv4_mapped
    return a


def host_addresses() -> Tuple[Set[IpAddr], List[IpNet]]:
    """Adresses de toutes les interfaces de l'hôte, et sous-réseaux des
    interfaces de conteneurs (ponts Docker…)."""
    adresses: Set[IpAddr] = set()
    reseaux: List[IpNet] = []
    try:
        import psutil
        interfaces = psutil.net_if_addrs()
    except Exception:                                            # noqa: BLE001
        return adresses, reseaux
    for nom, liste in interfaces.items():
        for a in liste:
            if a.family not in (socket.AF_INET, socket.AF_INET6):
                continue
            ip = _ip(a.address)
            if ip is None:
                continue
            adresses.add(ip)
            if _INTERFACES_CONTENEURS.match(nom) and a.netmask:
                try:
                    reseaux.append(ipaddress.ip_network(f"{ip}/{a.netmask}", strict=False))
                except ValueError:
                    pass
    return adresses, reseaux


def _liste_blanche(entrees: Union[str, Iterable[str], None]):
    brut = re.split(r"[\s,]+", entrees) if isinstance(entrees, str) else list(entrees or [])
    hotes: Set[str] = set()
    suffixes: List[str] = []
    reseaux: List[IpNet] = []
    for e0 in brut:
        e = str(e0 or "").strip().lower()
        if not e:
            continue
        try:
            reseaux.append(ipaddress.ip_network(e, strict=False))
            continue
        except ValueError:
            pass
        if e.startswith("*."):
            suffixes.append(e[1:])
        elif e.startswith("."):
            suffixes.append(e)
        else:
            hotes.add(e)
    return hotes, suffixes, reseaux


def _motif_ip(ip: IpAddr, nom: str, hote: Tuple[Set[IpAddr], Sequence[IpNet]], liste) -> Optional[str]:
    if ip.is_loopback or ip.is_link_local or ip.is_unspecified or ip.is_multicast \
            or (isinstance(ip, ipaddress.IPv4Address) and ip.is_reserved):
        return f"adresse réservée à l'hôte ou au réseau local de la machine ({ip})"
    adresses, reseaux_hote = hote
    if ip in adresses:
        return f"adresse de la machine qui héberge Elpis ({ip})"
    if any(ip in n for n in reseaux_hote if n.version == ip.version):
        return f"réseau interne de la machine qui héberge Elpis ({ip})"
    hotes, suffixes, reseaux = liste
    if (hotes or suffixes or reseaux) and any(ip in n for n in _RESEAUX_LOCAUX if n.version == ip.version):
        par_nom = nom in hotes or any(nom.endswith(s) for s in suffixes)
        if not par_nom and not any(ip in n for n in reseaux if n.version == ip.version):
            return f"hôte du réseau local absent de la liste autorisée ({nom or ip})"
    return None


def browser_url_block_reason(url: str, *, allowlist: Union[str, Iterable[str], None] = None,
                             hote: Optional[Tuple[Set[IpAddr], Sequence[IpNet]]] = None,
                             resolve=None) -> Optional[str]:
    """Motif de refus d'une URL pour le navigateur, ou ``None``.

    ``allowlist`` : liste blanche du réseau local (défaut :
    ``browser.url_allowlist``, lue à chaud) ; ``hote`` et ``resolve`` sont
    injectables pour les tests. Un nom qui ne résout pas n'est pas refusé ici
    (le navigateur échouera seul, avec son message)."""
    u = (url or "").strip()
    if not u:
        return "adresse vide"
    if u.lower() == "about:blank":
        return None
    try:
        p = urlsplit(u)
    except ValueError:
        return "adresse mal formée"
    schema = (p.scheme or "").lower()
    if schema not in ("http", "https"):
        return f"schéma non autorisé ({schema or 'aucun'}:) — seuls http et https le sont"
    nom = (p.hostname or "").lower()
    if not nom:
        return "adresse sans hôte"
    if nom == "localhost" or nom.endswith(".localhost"):
        return f"adresse réservée à l'hôte ou au réseau local de la machine ({nom})"
    # Identifiants dans l'URL : permis au navigateur (authentification HTTP),
    # retirés avant le contrôle commun, qui les refuse par principe.
    sans_id = urlunsplit((p.scheme, nom + (f":{p.port}" if p.port else ""), p.path, p.query, ""))
    motif = block_remote_url_reason(sans_id, allow_schemes=("http", "https"), critical_only=True)
    if motif and not motif.startswith("unresolvable_host"):
        return f"adresse réservée à l'hôte ou au réseau local de la machine ({motif})"
    if allowlist is None:
        try:
            from shared_infra.config import live_config_value
            allowlist = live_config_value("browser.url_allowlist", []) or []
        except Exception:                                        # noqa: BLE001
            allowlist = []
    liste = _liste_blanche(allowlist)
    hote = hote if hote is not None else host_addresses()
    ip = _ip(nom)
    if ip is not None:
        return _motif_ip(ip, nom, hote, liste)
    resoudre = resolve or (lambda n: [i[4][0] for i in socket.getaddrinfo(n, None, proto=socket.IPPROTO_TCP)])
    try:
        adresses = resoudre(nom)
    except OSError:
        return None
    for a in adresses:
        rip = _ip(str(a))
        if rip is None:
            continue
        m = _motif_ip(rip, nom, hote, liste)
        if m:
            return m
    return None


def refus_message(url: str, motif: str) -> str:
    """Même message que le service (url_guard.messageRefus)."""
    return (f"Adresse refusée par la politique du navigateur : {motif}. "
            f"URL : {(url or '')[:200]}. Le navigateur ne peut joindre que des sites "
            f"http/https hors de la machine qui héberge Elpis.")


__all__ = ["browser_url_block_reason", "host_addresses", "pw_owner", "refus_message"]
