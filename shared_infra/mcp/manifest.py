# SPDX-License-Identifier: MIT
"""shared_infra/mcp/manifest.py — manifeste ``mcp.json`` des outils par défaut.

(2026-09-11, plan ``docs/outils-portables-mcp-json-design-2026-09-11.md``, P1)

Un serveur d'outils par défaut se DÉCLARE dans ``mcp.json`` (racine du dépôt,
surcharge ``APP_MCP_MANIFEST``), au format des clients MCP courants
(``mcpServers`` — Claude Desktop, Cursor, LibreChat — ou ``servers`` — VS Code) :

    {
      "mcpServers": {
        "elpis-tools": {
          "type": "http", "url": "http://127.0.0.1:8765/mcp",
          "headers": {"Authorization": "Bearer ${file:user_db/.local_mcp_token}"},
          "description": "…",
          "x-elpis": {"role": "toolhost", "families": ["fs", "git", …],
                      "default_on": [], "opencode": {"families": ["git", …]},
                      "fallback": {"type": "stdio", "command": "${python}",
                                   "args": ["server/local_mcp_server.py"]}}
        },
        "weather": {"type": "http", "url": "…", "description": "…",
                    "x-elpis": {"default_on": true, "opencode": {"publish": true}}}
      }
    }

Tout ce qui est propre à Elpis vit sous ``x-elpis`` ; une entrée sans ce bloc
est un serveur MCP ordinaire — le fichier reste utilisable tel quel par un
autre client après substitution des ``${…}``.

Rôles : ``toolhost`` (le service d'outils intégré, sandbox derrière), ``app``
(outils liés au compte, servis par l'app — P4), ``external`` (défaut : un
serveur tiers déclaré ici, sans injection d'identité).

Compatibilité : sans fichier, le manifeste est SYNTHÉTISÉ depuis la config
héritée (``LOCAL_MCP_*``, ``mcp.local_servers``) — comportement strictement
identique à l'avant-manifeste. Les variables ``LOCAL_MCP_URL`` / ``LOCAL_MCP_TOKEN``
/ ``LOCAL_MCP_TOOL_FAMILIES`` restent des SURCHARGES du fichier (une version).

Ce module ne fait AUCUN import lourd au chargement (ni fastmcp, ni la config
de l'app) : il est lu par les workers FastAPI ET par le sous-process MCP.
"""
from __future__ import annotations

import json
import logging
import os
import re
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

from shared_infra.mcp.families import (
    DEFAULT_OPENCODE_EXCLUDE,
    FAMILY_CATEGORY,
    FAMILY_NAMES,
    parse_families,
    parse_family_set,
)

logger = logging.getLogger("uvicorn.error")

# Sentinelle HISTORIQUE que le front, les sous-agents, les routines et le
# pré-chauffage envoient pour désigner « le service d'outils intégré ». Elle
# reste acceptée comme ALIAS de l'entrée ``role: toolhost`` du manifeste.
BUILTIN_SENTINEL = "DEFAULT_LOCAL_PYTHON"

ROLE_TOOLHOST = "toolhost"
ROLE_APP = "app"
ROLE_EXTERNAL = "external"
_ROLES = (ROLE_TOOLHOST, ROLE_APP, ROLE_EXTERNAL)

TYPE_HTTP, TYPE_SSE, TYPE_STDIO, TYPE_INPROCESS = "http", "sse", "stdio", "inprocess"
_NETWORK_TYPES = (TYPE_HTTP, TYPE_SSE)

IDENTITY_META, IDENTITY_TOKEN = "meta", "token"

DEFAULT_TOOLHOST_NAME = "elpis-tools"
OPENCODE_PREFIX_DEFAULT = "elpis-"

MANIFEST_VERSION = 1

_SUBST_RE = re.compile(r"\$\{(env|file|python|root)(?::([^}]*))?\}")


# ─────────────────────────────────────────────────────────────────────────────
#  Emplacement + substitution
# ─────────────────────────────────────────────────────────────────────────────
def _project_root() -> Path:
    try:
        from shared_infra.config import PROJECT_ROOT
        return Path(PROJECT_ROOT)
    except Exception:
        return Path(__file__).resolve().parents[2]


def manifest_path() -> Path:
    """``APP_MCP_MANIFEST`` (env) sinon ``<racine>/mcp.json``. Le chemin est
    relu à CHAQUE appel : les tests le redirigent, et un déploiement peut le
    poser après le premier import."""
    raw = (os.environ.get("APP_MCP_MANIFEST") or "").strip()
    if raw:
        p = Path(raw).expanduser()
        return p if p.is_absolute() else (_project_root() / p)
    return _project_root() / "mcp.json"


def substitute(value: Any, *, root: Optional[Path] = None,
               warnings: Optional[List[str]] = None) -> Any:
    """``${env:NOM}`` → variable d'environnement, ``${file:chemin}`` → première
    ligne du fichier (relatif à la racine), ``${python}`` → interpréteur
    courant, ``${root}`` → racine du dépôt. Récursif sur dict/list. Une
    substitution impossible donne "" et un avertissement — jamais une exception
    (un jeton absent au premier lancement est un cas normal)."""
    root = root or _project_root()
    if isinstance(value, dict):
        return {k: substitute(v, root=root, warnings=warnings) for k, v in value.items()}
    if isinstance(value, list):
        return [substitute(v, root=root, warnings=warnings) for v in value]
    if not isinstance(value, str) or "${" not in value:
        return value

    def _one(m: "re.Match[str]") -> str:
        kind, arg = m.group(1), (m.group(2) or "").strip()
        if kind == "env":
            v = os.environ.get(arg)
            if v is None and warnings is not None:
                warnings.append(f"variable d'environnement absente : {arg}")
            return v or ""
        if kind == "file":
            p = Path(arg).expanduser()
            if not p.is_absolute():
                p = root / p
            try:
                lines = p.read_text(encoding="utf-8").splitlines()
                return lines[0].strip() if lines else ""
            except Exception:
                if warnings is not None:
                    warnings.append(f"fichier illisible : {arg}")
                return ""
        if kind == "python":
            return sys.executable or "python3"
        if kind == "root":
            return str(root)
        return m.group(0)

    return _SUBST_RE.sub(_one, value)


def _strip_mcp_path(url: str) -> str:
    """``http://h:8765/mcp/git`` → ``http://h:8765``. Retire un segment de
    FAMILLE connue puis le segment de montage (``/mcp`` ou ``/sse``) : c'est ce
    qui permet de dériver l'origine de l'hôte depuis l'URL d'une entrée."""
    from urllib.parse import urlsplit, urlunsplit
    u = (url or "").strip().rstrip("/")
    if not u:
        return ""
    parts = urlsplit(u)
    if not parts.netloc:                       # pas une URL absolue : laisser tel quel
        return u
    # Ne toucher QU'AU CHEMIN : un hôte nommé « mcp » ne doit pas être amputé.
    segs = [x for x in parts.path.split("/") if x]
    for _ in range(2):
        if segs and (segs[-1] in FAMILY_NAMES or segs[-1] in ("mcp", "sse")):
            segs.pop()
            continue
        break
    return urlunsplit((parts.scheme, parts.netloc, "/".join([""] + segs) if segs else "",
                       "", "")).rstrip("/")


def _is_loopback_url(url: str) -> bool:
    from urllib.parse import urlparse
    try:
        h = (urlparse(url).hostname or "").lower()
    except Exception:
        return False
    return h in ("127.0.0.1", "localhost", "::1")


# ─────────────────────────────────────────────────────────────────────────────
#  Modèle
# ─────────────────────────────────────────────────────────────────────────────
@dataclass
class ServerEntry:
    name: str
    type: str = TYPE_HTTP
    url: str = ""
    headers: Dict[str, str] = field(default_factory=dict)
    command: str = ""
    args: List[str] = field(default_factory=list)
    env: Dict[str, str] = field(default_factory=dict)
    description: str = ""
    enabled: bool = True
    # ``x-elpis``
    role: str = ROLE_EXTERNAL
    identity: str = IDENTITY_TOKEN
    families: List[str] = field(default_factory=list)
    default_on: List[str] = field(default_factory=list)   # familles pré-cochées
    default_on_self: bool = False                          # entrée EXTERNE pré-cochée
    opencode_families: List[str] = field(default_factory=list)
    opencode_prefix: str = OPENCODE_PREFIX_DEFAULT
    opencode_publish: bool = False                        # entrée externe publiée telle quelle
    sandbox: str = ""
    host: str = ""                                        # clé dans ``toolHosts``
    fallback: Optional[Dict[str, Any]] = None
    serve: Dict[str, Any] = field(default_factory=dict)
    probe: Optional[bool] = None
    prompt_fragments: Dict[str, str] = field(default_factory=dict)
    raw: Dict[str, Any] = field(default_factory=dict)

    # ── Prédicats ────────────────────────────────────────────────────────
    @property
    def is_builtin(self) -> bool:
        return self.role in (ROLE_TOOLHOST, ROLE_APP)

    @property
    def is_network(self) -> bool:
        return self.type in _NETWORK_TYPES and bool(self.url)

    @property
    def token(self) -> str:
        """Jeton porté par ``Authorization: Bearer …`` (vide sinon)."""
        for k, v in (self.headers or {}).items():
            if str(k).lower() == "authorization":
                v = str(v or "").strip()
                if v.lower().startswith("bearer"):
                    return v[6:].strip()          # "Bearer" seul (jeton vide) → ""
                return v
        return ""

    @property
    def probe_before_use(self) -> bool:
        """Faut-il SONDER l'URL avant de s'y fier (repli stdio si injoignable) ?
        Explicite via ``x-elpis.probe`` ; sinon oui pour une URL loopback
        doublée d'un repli, non pour une URL distante (jamais de repli
        silencieux vers un stdio local)."""
        if self.probe is not None:
            return bool(self.probe)
        return bool(self.fallback) and _is_loopback_url(self.url)

    # ── Vue client (pool d'outils de l'app) ──────────────────────────────
    def client_cfg(self, filter_categories: Optional[List[str]] = None) -> Dict[str, Any]:
        """Config telle que le pool / ``_resolve_mcp_client`` la consomment.
        Une entrée INTÉGRÉE garde la forme sentinelle (``type: stdio`` +
        ``DEFAULT_LOCAL_PYTHON``) : c'est l'alias que tout le code existant
        reconnaît (clé de pool unique, injection d'identité). Le résolveur
        relit ensuite l'entrée du manifeste pour l'URL / le repli."""
        if self.role == ROLE_APP:
            # (2026-09-12, P4) MCP INTERNE de l'app : familles liées au compte,
            # servies dans le processus de la boucle de chat (transport mémoire).
            cfg: Dict[str, Any] = {"type": TYPE_INPROCESS, "name": self.name,
                                   "manifest": self.name, "identity": IDENTITY_META,
                                   "role": self.role, "families": list(self.families)}
        elif self.is_builtin:
            # (2026-09-12) UNE entrée = UN endpoint : le nom d'entrée est porté
            # dans ``manifest`` et devient la clé de pool — sans lui, toutes les
            # entrées intégrées se seraient fondues en une seule connexion.
            cfg = {"type": TYPE_STDIO, "name": self.name,
                   "command": BUILTIN_SENTINEL,
                   "manifest": self.name, "identity": IDENTITY_META,
                   "role": self.role, "families": list(self.families)}
        else:
            cfg = {"type": self.type, "name": self.name, "manifest": self.name,
                   "identity": self.identity, "role": self.role}
            if self.type in _NETWORK_TYPES:
                cfg["url"] = self.url
                if self.headers:
                    cfg["headers"] = dict(self.headers)
            elif self.type == TYPE_STDIO:
                cfg["command"] = " ".join([self.command] + list(self.args)).strip()
                if self.env:
                    cfg["env"] = dict(self.env)
        if filter_categories is not None:
            cfg["filter_categories"] = list(filter_categories)
        return cfg

    def endpoints(self, base_url: str = "") -> Dict[str, Any]:
        """Les trois façons de joindre CETTE entrée depuis un applicatif tiers.

        ``base_url`` = origine de l'hôte d'outils (``http://…:8765``) ; à défaut
        elle est dérivée de l'URL de l'entrée. Une entrée ``inprocess`` (familles
        liées au compte) n'a d'endpoint réseau que si l'hôte enregistre aussi sa
        famille — c'est le cas en mode local."""
        fam = self.families[0] if len(self.families) == 1 else ""
        base = (base_url or "").rstrip("/")
        if not base and self.url:
            base = _strip_mcp_path(self.url)
        seg = f"/{fam}" if fam else ""
        out: Dict[str, Any] = {}
        if base:
            out["http"] = f"{base}/mcp{seg}"
            out["sse"] = f"{base}/sse{seg}"
        fb = self.fallback or {}
        if fb.get("command"):
            out["stdio"] = {"command": fb["command"], "args": list(fb.get("args") or []),
                            "env": dict(fb.get("env") or {})}
        return out

    def opencode_entry(self) -> Dict[str, Any]:
        """Entrée ``opencode.json`` (``type: remote``) d'un serveur EXTERNE
        publié tel quel (URL + en-têtes propres)."""
        entry: Dict[str, Any] = {"type": "remote", "url": self.url,
                                 "enabled": bool(self.enabled)}
        if self.headers:
            entry["headers"] = {str(k): str(v) for k, v in self.headers.items()}
        return entry


@dataclass
class Manifest:
    servers: Dict[str, ServerEntry] = field(default_factory=dict)
    sandbox_hosts: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    placement: Dict[str, Any] = field(default_factory=dict)
    source: str = "synthesized"            # "file" | "synthesized"
    path: Optional[Path] = None
    warnings: List[str] = field(default_factory=list)
    errors: List[str] = field(default_factory=list)
    loaded_at: float = 0.0
    mtime: float = 0.0
    version: int = MANIFEST_VERSION

    def toolhost(self) -> Optional[ServerEntry]:
        """La PREMIÈRE entrée ``role: toolhost`` (activée ou non) — l'entrée de
        référence pour l'hôte par défaut (transport à servir, jeton, préfixe
        opencode). Depuis 2026-09-12 il y en a normalement une PAR FAMILLE :
        préférer ``toolhosts()`` pour raisonner sur l'ensemble."""
        for e in self.servers.values():
            if e.role == ROLE_TOOLHOST:
                return e
        return None

    def toolhosts(self, *, enabled_only: bool = True) -> List[ServerEntry]:
        """Toutes les entrées ``role: toolhost``, dans l'ordre de déclaration."""
        return [e for e in self.servers.values()
                if e.role == ROLE_TOOLHOST and (e.enabled or not enabled_only)]

    def apps(self, *, enabled_only: bool = True) -> List[ServerEntry]:
        """Toutes les entrées ``role: app`` (servies en mémoire par l'app)."""
        return [e for e in self.servers.values()
                if e.role == ROLE_APP and (e.enabled or not enabled_only)]

    def host(self, key: str = "") -> Dict[str, Any]:
        """Descripteur d'hôte d'outils (``toolHosts``/``sandboxHosts``). Sans
        clé : celui du placement, sinon ``main``, sinon le premier déclaré."""
        key = str(key or "").strip()
        if key and key in self.sandbox_hosts:
            return dict(self.sandbox_hosts[key])
        for k in (str(self.placement.get("host") or ""), "main"):
            if k and k in self.sandbox_hosts:
                return dict(self.sandbox_hosts[k])
        for v in self.sandbox_hosts.values():
            return dict(v)
        return {}

    def host_base_url(self, key: str = "") -> str:
        """Origine de l'hôte d'outils (``http://127.0.0.1:8765``) — descripteur
        ``toolHosts`` d'abord, sinon dérivée de l'URL d'une entrée toolhost."""
        url = str(self.host(key).get("url") or "").strip().rstrip("/")
        if url:
            return _strip_mcp_path(url)
        for e in self.toolhosts():
            if e.is_network:
                return _strip_mcp_path(e.url)
        return ""

    def mcp_base_url(self, key: str = "") -> str:
        """Base du service MCP (``…/mcp``) — ce que relaie ``/api/mcp-bridge``
        et ce à quoi opencode ajoute ``/<famille>``."""
        base = self.host_base_url(key)
        if base:
            return base + "/mcp"
        return ""

    def host_token(self, key: str = "") -> str:
        """Jeton de service de l'hôte : descripteur d'hôte, sinon en-tête
        ``Authorization`` d'une entrée toolhost."""
        tok = str(self.host(key).get("token") or "").strip()
        if tok:
            return tok[7:].strip() if tok.lower().startswith("bearer") else tok
        for e in self.toolhosts():
            if e.token:
                return e.token
        return ""

    def builtins(self, *, enabled_only: bool = True) -> List[ServerEntry]:
        return [e for e in self.servers.values()
                if e.is_builtin and (e.enabled or not enabled_only)]

    def externals(self, *, enabled_only: bool = True) -> List[ServerEntry]:
        return [e for e in self.servers.values()
                if not e.is_builtin and (e.enabled or not enabled_only)]

    def get(self, name: str) -> Optional[ServerEntry]:
        return self.servers.get(str(name or "").strip())

    def families(self) -> List[str]:
        """Familles à ENREGISTRER sur le service d'outils : union des entrées
        intégrées (toolhost + app), ordre canonique. Les familles liées au
        compte en font partie — en mode local l'hôte les sert aussi, donc
        ``/mcp/memory`` reste joignable par un applicatif tiers ; en déport,
        ``toolhost.json › families`` les retire."""
        want: Set[str] = set()
        for e in self.builtins():
            want |= set(e.families)
        out = [f for f in FAMILY_NAMES if f in want]
        return out or (list(FAMILY_NAMES) if not self.builtins() else [])

    def toolhost_families(self) -> List[str]:
        """Familles servies par les entrées ``role: toolhost`` seules."""
        want: Set[str] = set()
        for e in self.toolhosts():
            want |= set(e.families)
        return [f for f in FAMILY_NAMES if f in want]

    def entry_for_family(self, family: str) -> Optional[ServerEntry]:
        fam = str(family or "").strip().lower()
        for e in self.builtins():
            if fam in e.families:
                return e
        return None

    def default_on_categories(self) -> Set[str]:
        """Catégories (identifiants portés par les outils) pré-cochées dans un
        nouveau chat — dérivées des ``default_on`` des entrées intégrées."""
        out: Set[str] = set()
        for e in self.builtins():
            for fam in e.default_on:
                out.add(FAMILY_CATEGORY.get(fam, fam))
        return out

    def default_on_externals(self) -> List[str]:
        return [e.name for e in self.externals() if e.default_on_self]

    def opencode_families(self) -> List[str]:
        """Familles publiées à opencode, dans l'ordre canonique.

        Deux déclarations, cumulées : ``x-elpis.opencode.publish: true`` sur une
        entrée (le geste naturel maintenant qu'il y a une entrée par famille) et
        ``x-elpis.opencode.families`` (forme héritée, entrée monolithique).
        L'exclusion INVARIANTE (fs/shell/office/skill_run) s'applique toujours."""
        want: Set[str] = set()
        for e in self.toolhosts():
            if e.opencode_publish:
                want |= set(e.families)
            want |= {f for f in e.opencode_families if f in e.families}
        exc = parse_family_set(DEFAULT_OPENCODE_EXCLUDE)
        return [f for f in FAMILY_NAMES if f in want and f not in exc]

    def opencode_prefix(self) -> str:
        th = self.toolhost()
        return th.opencode_prefix if th else OPENCODE_PREFIX_DEFAULT

    def to_public_dict(self) -> Dict[str, Any]:
        """Vue d'administration (jetons MASQUÉS)."""
        def _mask_headers(h: Dict[str, str]) -> Dict[str, str]:
            out = {}
            for k, v in (h or {}).items():
                out[k] = ("***" if str(k).lower() == "authorization" and v else str(v))
            return out
        servers = []
        base = self.host_base_url()
        for e in self.servers.values():
            servers.append({
                "endpoints": e.endpoints(base if e.role == ROLE_TOOLHOST else ""),
                "name": e.name, "type": e.type, "url": e.url,
                "headers": _mask_headers(e.headers),
                "command": e.command, "args": list(e.args),
                "description": e.description, "enabled": e.enabled,
                "role": e.role, "identity": e.identity,
                "families": list(e.families), "default_on": list(e.default_on),
                "default_on_self": e.default_on_self,
                "opencode_families": list(e.opencode_families),
                "opencode_publish": e.opencode_publish,
                "has_token": bool(e.token), "fallback": bool(e.fallback),
                "probe": e.probe_before_use, "sandbox": e.sandbox,
                "host": e.host,
            })
        return {"version": self.version, "source": self.source,
                "host_base_url": base, "mcp_base_url": self.mcp_base_url(),
                "path": str(self.path) if self.path else "",
                "loaded_at": self.loaded_at, "servers": servers,
                "sandbox_hosts": {k: {kk: ("***" if kk == "token" and vv else vv)
                                      for kk, vv in (v or {}).items()}
                                  for k, v in self.sandbox_hosts.items()},
                "placement": dict(self.placement),
                "warnings": list(self.warnings), "errors": list(self.errors)}


def export_servers(entries: List[ServerEntry], *, base_url: str = "",
                   transport: str = "http", token: str = "",
                   prefix: str = "") -> Dict[str, Any]:
    """``{"mcpServers": {…}}`` prêt à coller dans la configuration d'un AUTRE
    applicatif (Claude Desktop, Cursor, LibreChat, VS Code, opencode…).

    Un bloc par entrée, avec le transport demandé et l'endpoint qui va avec.
    Le jeton n'est inclus que s'il est fourni explicitement par l'appelant —
    la vue d'administration, elle, le masque."""
    transport = (transport or "http").strip().lower()
    if transport in ("streamable-http", "streamable_http", "remote"):
        transport = "http"
    out: Dict[str, Any] = {}
    for e in entries:
        eps = e.endpoints(base_url)
        name = f"{prefix}{e.name}" if prefix else e.name
        if transport == "stdio":
            st = eps.get("stdio")
            if not st:
                continue
            spec: Dict[str, Any] = {"type": TYPE_STDIO, "command": st["command"],
                                    "args": list(st["args"])}
            if st.get("env"):
                spec["env"] = dict(st["env"])
        else:
            url = eps.get(transport)
            if not url:
                continue
            spec = {"type": (TYPE_SSE if transport == "sse" else TYPE_HTTP), "url": url}
            if token:
                spec["headers"] = {"Authorization": f"Bearer {token}"}
        if e.description:
            spec["description"] = e.description
        out[name] = spec
    return {"mcpServers": out}


# ─────────────────────────────────────────────────────────────────────────────
#  Normalisation
# ─────────────────────────────────────────────────────────────────────────────
_TYPE_ALIASES = {
    "http": TYPE_HTTP, "streamable-http": TYPE_HTTP, "streamable_http": TYPE_HTTP,
    "streamablehttp": TYPE_HTTP, "remote": TYPE_HTTP,
    "sse": TYPE_SSE,
    "stdio": TYPE_STDIO, "local": TYPE_STDIO,
    "inprocess": TYPE_INPROCESS, "in-process": TYPE_INPROCESS,
}


def _norm_type(raw: Any, has_url: bool, has_cmd: bool) -> str:
    t = str(raw or "").strip().lower()
    if t in _TYPE_ALIASES:
        t = _TYPE_ALIASES[t]
        # ``remote`` sans suffixe : SSE si l'URL finit par /sse
        return t
    if has_url:
        return TYPE_HTTP
    if has_cmd:
        return TYPE_STDIO
    return TYPE_HTTP


def _as_str_dict(raw: Any) -> Dict[str, str]:
    if isinstance(raw, list):                       # forme au repos [{name,value}]
        raw = {p.get("name"): p.get("value") for p in raw
               if isinstance(p, dict) and p.get("name")}
    if not isinstance(raw, dict):
        return {}
    return {str(k): str(v) for k, v in raw.items()
            if isinstance(k, str) and k and v is not None}


def _families_list(raw: Any, *, warnings: List[str], where: str,
                   default: Optional[List[str]] = None) -> List[str]:
    """Liste de familles CONNUES (ordre canonique). Accepte une liste ou la
    grammaire ``all,-x``. Un nom inconnu est ignoré avec avertissement : le
    manifeste ne charge JAMAIS un module arbitraire."""
    if raw is None:
        return list(default) if default is not None else []
    if isinstance(raw, str):
        return parse_families(raw, warn=lambda m: warnings.append(f"{where} : {m}"))
    if isinstance(raw, bool):
        return list(default if (raw and default is not None) else (FAMILY_NAMES if raw else []))
    if isinstance(raw, list):
        wanted = {str(x).strip().lower() for x in raw if isinstance(x, str)}
        for u in sorted(wanted - set(FAMILY_NAMES)):
            warnings.append(f"{where} : famille d'outils inconnue ignorée : {u!r}")
        return [f for f in FAMILY_NAMES if f in wanted]
    warnings.append(f"{where} : liste de familles invalide ({type(raw).__name__})")
    return list(default) if default is not None else []


def normalize_entry(name: str, raw: Dict[str, Any], *, warnings: List[str],
                    root: Optional[Path] = None) -> Optional[ServerEntry]:
    """Entrée brute (déjà substituée) → ``ServerEntry``, ou ``None`` si
    inexploitable (une entrée incohérente ne fait jamais tomber le manifeste)."""
    if not isinstance(raw, dict):
        warnings.append(f"{name} : entrée ignorée (pas un objet)")
        return None
    url = str(raw.get("url") or "").strip()
    command = str(raw.get("command") or "").strip()
    args = [str(a) for a in (raw.get("args") or []) if isinstance(a, (str, int, float))]
    xe = raw.get("x-elpis")
    xe = dict(xe) if isinstance(xe, dict) else {}
    role = str(xe.get("role") or ROLE_EXTERNAL).strip().lower()
    if role not in _ROLES:
        warnings.append(f"{name} : rôle inconnu {role!r} → external")
        role = ROLE_EXTERNAL
    typ = _norm_type(raw.get("type"), bool(url), bool(command))
    is_builtin = role in (ROLE_TOOLHOST, ROLE_APP)
    if role == ROLE_APP and not url and not command:
        typ = TYPE_INPROCESS                       # défaut d'une entrée app
    if typ in _NETWORK_TYPES and not url and not is_builtin:
        warnings.append(f"{name} : serveur réseau sans url — ignoré")
        return None
    if typ == TYPE_STDIO and not command and not is_builtin:
        warnings.append(f"{name} : serveur stdio sans command — ignoré")
        return None
    if typ == TYPE_INPROCESS and not is_builtin:
        warnings.append(f"{name} : type inprocess réservé aux entrées intégrées — ignoré")
        return None

    identity = str(xe.get("identity") or (IDENTITY_META if is_builtin else IDENTITY_TOKEN)).strip().lower()
    if identity not in (IDENTITY_META, IDENTITY_TOKEN):
        warnings.append(f"{name} : identity inconnue {identity!r}")
        identity = IDENTITY_META if is_builtin else IDENTITY_TOKEN
    if identity == IDENTITY_META and not is_builtin:
        # L'injection d'identité est réservée aux services de confiance.
        warnings.append(f"{name} : identity=meta refusée pour un serveur externe → token")
        identity = IDENTITY_TOKEN

    # (2026-09-12) Une entrée intégrée = UNE famille (ou quelques-unes) : plus de
    # défaut « toutes les familles ». Le manifeste à UNE SEULE entrée toolhost
    # garde l'ancien défaut, appliqué dans ``_build`` (vue d'ensemble requise).
    families = _families_list(xe.get("families"), warnings=warnings, where=name, default=[])
    d_on_raw = xe.get("default_on")
    default_on_self = False
    if is_builtin:
        # ``true`` = « les familles de cette entrée sont pré-cochées » (une
        # entrée par famille rend la liste redondante) ; une liste reste possible.
        default_on = (list(families) if d_on_raw is True
                      else _families_list(d_on_raw, warnings=warnings,
                                          where=f"{name}.default_on", default=[]))
        default_on = [f for f in default_on if f in families]
    else:
        default_on = []
        default_on_self = bool(d_on_raw) if not isinstance(d_on_raw, list) else bool(d_on_raw)

    oc = xe.get("opencode")
    oc = dict(oc) if isinstance(oc, dict) else {}
    oc_publish = bool(oc.get("publish", False))
    oc_prefix = str(oc.get("prefix") or OPENCODE_PREFIX_DEFAULT)
    oc_families = (_families_list(oc.get("families"), warnings=warnings,
                                  where=f"{name}.opencode.families", default=[])
                   if is_builtin else [])

    fb = xe.get("fallback")
    fallback: Optional[Dict[str, Any]] = None
    if fb is False:
        fb = None                                   # repli explicitement refusé
    if isinstance(fb, dict) and str(fb.get("command") or "").strip():
        fallback = {"type": TYPE_STDIO,
                    "command": str(fb.get("command")).strip(),
                    "args": [str(a) for a in (fb.get("args") or [])],
                    "env": _as_str_dict(fb.get("env"))}
    elif fb is not None:
        warnings.append(f"{name} : fallback invalide (command manquante) — ignoré")

    serve = xe.get("serve")
    serve = dict(serve) if isinstance(serve, dict) else {}
    probe = xe.get("probe")
    probe = bool(probe) if isinstance(probe, bool) else None
    pf = xe.get("prompt_fragments")
    pf = {str(k): str(v) for k, v in pf.items()} if isinstance(pf, dict) else {}

    return ServerEntry(
        name=name, type=typ, url=url, headers=_as_str_dict(raw.get("headers")),
        command=command, args=args, env=_as_str_dict(raw.get("env")),
        description=str(raw.get("description") or "").strip(),
        enabled=(raw.get("enabled") is not False),
        role=role, identity=identity, families=families,
        default_on=default_on, default_on_self=default_on_self,
        opencode_families=oc_families, opencode_prefix=oc_prefix,
        opencode_publish=oc_publish,
        sandbox=str(xe.get("sandbox") or "").strip(),
        host=str(xe.get("host") or xe.get("sandbox") or "").strip(),
        fallback=fallback, serve=serve, probe=probe, prompt_fragments=pf,
        raw=raw,
    )


# ─────────────────────────────────────────────────────────────────────────────
#  Validation (JSON Schema, tolérante)
# ─────────────────────────────────────────────────────────────────────────────
_SCHEMA_CACHE: Dict[str, Any] = {}


def schema_path() -> Path:
    return _project_root() / "docs" / "schemas" / "mcp.schema.json"


def validate_raw(raw: Any) -> List[str]:
    """Erreurs de schéma (liste vide = valide). Sans ``jsonschema`` ou sans
    fichier de schéma : validation structurelle minimale."""
    errors: List[str] = []
    if not isinstance(raw, dict):
        return ["le manifeste doit être un objet JSON"]
    root_key = "mcpServers" if "mcpServers" in raw else ("servers" if "servers" in raw else None)
    if root_key is None:
        errors.append("clé racine absente : mcpServers (ou servers)")
    elif not isinstance(raw.get(root_key), dict):
        errors.append(f"{root_key} doit être un objet nom → serveur")
    try:
        import jsonschema  # type: ignore
    except Exception:
        return errors
    sp = schema_path()
    try:
        key = str(sp)
        schema = _SCHEMA_CACHE.get(key)
        if schema is None:
            schema = json.loads(sp.read_text(encoding="utf-8"))
            _SCHEMA_CACHE[key] = schema
    except Exception:
        return errors
    try:
        v = jsonschema.Draft202012Validator(schema)
        for err in sorted(v.iter_errors(raw), key=lambda e: list(e.absolute_path)):
            where = "/".join(str(p) for p in err.absolute_path) or "(racine)"
            errors.append(f"{where} : {err.message}")
    except Exception as e:                                       # noqa: BLE001
        errors.append(f"validation impossible : {e!r}")
    return errors


# ─────────────────────────────────────────────────────────────────────────────
#  Synthèse depuis la config héritée (aucun fichier)
# ─────────────────────────────────────────────────────────────────────────────
def _legacy_toolhost_raw(warnings: List[str]) -> Dict[str, Any]:
    """Entrée ``elpis-tools`` équivalente à la résolution d'avant le manifeste
    (``config.LOCAL_MCP_URL`` dérivée/explicite, jeton du fichier, familles,
    familles opencode)."""
    from shared_infra import config as cfg
    from shared_infra.mcp.families import opencode_families as _oc_fams
    url = str(getattr(cfg, "LOCAL_MCP_URL", "") or "").strip()
    derived = bool(getattr(cfg, "LOCAL_MCP_URL_IS_DERIVED", False))
    token = str(getattr(cfg, "LOCAL_MCP_TOKEN", "") or "").strip()
    fams_raw = str(getattr(cfg, "LOCAL_MCP_TOOL_FAMILIES", "all") or "all")
    entry: Dict[str, Any] = {
        "type": (TYPE_SSE if url.rstrip("/").endswith("/sse") else TYPE_HTTP) if url else TYPE_STDIO,
        "description": "Outils intégrés (service local d'outils)",
        "x-elpis": {
            "role": ROLE_TOOLHOST, "identity": IDENTITY_META,
            "families": parse_families(fams_raw, warn=lambda m: warnings.append(m)),
            "default_on": [],
            "opencode": {"families": _oc_fams(warn=lambda m: warnings.append(m), use_manifest=False),
                         "prefix": OPENCODE_PREFIX_DEFAULT},
            "fallback": {"type": TYPE_STDIO, "command": sys.executable or "python3",
                         "args": [str(_project_root() / "server" / "local_mcp_server.py")],
                         "env": {"LOCAL_MCP_TRANSPORT": "stdio"}},
            "probe": derived,
        },
    }
    if url:
        entry["url"] = url
    if token:
        entry["headers"] = {"Authorization": f"Bearer {token}"}
    return entry


def _legacy_extra_servers(warnings: List[str]) -> Dict[str, Dict[str, Any]]:
    """``mcp.local_servers`` (registre 2026-09-05) → entrées externes du
    manifeste. Déprécié : un avertissement au chargement."""
    from shared_infra import config as cfg
    raw = getattr(cfg, "LOCAL_MCP_SERVERS_RAW", None)
    out: Dict[str, Dict[str, Any]] = {}
    if not isinstance(raw, dict):
        return out
    extras = {k: v for k, v in raw.items()
              if isinstance(k, str) and k.strip() and k != "local-tools"}
    if extras:
        warnings.append("config.json › mcp.local_servers est déprécié : déclarez "
                        "ces serveurs dans mcp.json (mcpServers)")
    for name, spec in extras.items():
        if not isinstance(spec, dict):
            continue
        d = dict(spec)
        d["type"] = d.pop("transport", d.get("type"))
        xe = {"role": ROLE_EXTERNAL,
              "opencode": {"publish": bool(d.pop("expose_opencode", False))}}
        d["x-elpis"] = xe
        out[name.strip()] = d
    return out


def _synthesize(warnings: List[str]) -> Dict[str, Any]:
    servers: Dict[str, Any] = {DEFAULT_TOOLHOST_NAME: _legacy_toolhost_raw(warnings)}
    servers.update(_legacy_extra_servers(warnings))
    return {"version": MANIFEST_VERSION, "mcpServers": servers}


# ─────────────────────────────────────────────────────────────────────────────
#  Surcharges d'environnement (une version de transition)
# ─────────────────────────────────────────────────────────────────────────────
def _apply_env_overrides(servers: Dict[str, ServerEntry], warnings: List[str],
                         *, hosts: Optional[Dict[str, Dict[str, Any]]] = None,
                         placement: Optional[Dict[str, Any]] = None) -> None:
    """``LOCAL_MCP_URL`` / ``LOCAL_MCP_TOKEN`` / ``LOCAL_MCP_TOOL_FAMILIES`` /
    ``LOCAL_MCP_OPENCODE_FAMILIES`` posées en ENV priment sur le fichier — c'est
    ce que fait le script de lancement, et l'échappatoire d'exploitation.

    (2026-09-12) Avec UNE ENTRÉE PAR FAMILLE, ces variables portent sur
    l'ENSEMBLE des entrées intégrées, pas sur la première :

    * ``LOCAL_MCP_URL`` donne l'ORIGINE de l'hôte ; le segment de famille de
      chaque entrée est reconstruit derrière. Réécrire la seule première entrée
      l'aurait pointée sur l'endpoint « toutes familles » — elle aurait rendu
      les 56 outils pendant que les cinq autres rendaient les leurs, soit un
      catalogue en double sans le moindre message d'erreur ;
    * ``LOCAL_MCP_TOKEN`` s'applique à toutes ;
    * ``LOCAL_MCP_TOOL_FAMILIES`` RETIRE les entrées hors liste — même effet
      qu'éditer ``mcp.json``, sans toucher au fichier.
    """
    ths = [e for e in servers.values() if e.role == ROLE_TOOLHOST]
    hosts = hosts if hosts is not None else {}
    # Hôte par DÉFAUT (celui du placement, sinon ``main``, sinon le premier) :
    # c'est lui que décrivent les variables héritées, mono-hôte par nature.
    _hk = ""
    for k in (str((placement or {}).get("host") or ""), "main"):
        if k and k in hosts:
            _hk = k
            break
    if not _hk and hosts:
        _hk = next(iter(hosts))
    url = (os.environ.get("LOCAL_MCP_URL") or "").strip()
    if url and ths:
        base = _strip_mcp_path(url)
        from urllib.parse import urlsplit
        segs = [x for x in urlsplit(url.rstrip("/")).path.split("/") if x]
        mount = "/sse" if "sse" in segs else "/mcp"
        for e in ths:
            fam = e.families[0] if len(e.families) == 1 else ""
            e.url = f"{base}{mount}" + (f"/{fam}" if fam else "")
            e.type = TYPE_SSE if mount == "/sse" else TYPE_HTTP
            e.probe = False                                  # explicite = de confiance
        if _hk:
            hosts[_hk]["url"] = base
    tok = (os.environ.get("LOCAL_MCP_TOKEN") or "").strip()
    if tok:
        if _hk:
            hosts[_hk]["token"] = tok
        for e in ths:
            e.headers = {**{k: v for k, v in e.headers.items() if k.lower() != "authorization"},
                         "Authorization": f"Bearer {tok}"}
    fams = os.environ.get("LOCAL_MCP_TOOL_FAMILIES")
    if fams is not None and fams.strip():
        wanted = set(parse_families(fams, warn=lambda m: warnings.append(m)))
        for name, e in list(servers.items()):
            if not e.is_builtin:
                continue
            kept = [f for f in e.families if f in wanted]
            if not kept:
                servers.pop(name, None)
            else:
                e.families = kept
                e.default_on = [f for f in e.default_on if f in kept]
    ocf = os.environ.get("LOCAL_MCP_OPENCODE_FAMILIES")
    if ocf is not None:
        allowed = set(parse_families(ocf, warn=lambda m: warnings.append(m))) if ocf.strip() else set()
        for e in [x for x in servers.values() if x.role == ROLE_TOOLHOST]:
            e.opencode_families = [f for f in e.families if f in allowed]
            e.opencode_publish = bool(e.opencode_families)


# ─────────────────────────────────────────────────────────────────────────────
#  Chargement (cache par mtime ; synthèse recalculée à chaque appel)
# ─────────────────────────────────────────────────────────────────────────────
_lock = threading.Lock()
_cached: Optional[Manifest] = None
_cached_key: Tuple[str, float] = ("", 0.0)


def _derive_fallbacks(entries: List[ServerEntry]) -> None:
    """Repli stdio AUTOMATIQUE d'une entrée toolhost qui n'en déclare pas :
    ``${python} -m toolhost --stdio --families <ses familles>``.

    Pourquoi le dériver : avec une entrée par famille, écrire dix blocs
    ``fallback`` identiques au segment d'URL près serait dix occasions de se
    tromper — et un repli erroné ne se voit que le jour où l'hôte tombe.
    ``"fallback": false`` reste le moyen de le refuser explicitement."""
    for e in entries:
        _xe = e.raw.get("x-elpis") if isinstance(e.raw, dict) else None
        if e.fallback is not None or not e.is_network:
            continue
        if isinstance(_xe, dict) and _xe.get("fallback") is False:
            continue
        if not e.families:
            continue
        e.fallback = {"type": TYPE_STDIO, "command": sys.executable or "python3",
                      "args": ["-m", "toolhost", "--stdio", "--families",
                               ",".join(e.families)],
                      "env": {"LOCAL_MCP_TRANSPORT": "stdio"}}


def _build(raw: Dict[str, Any], *, source: str, path: Optional[Path],
           mtime: float, warnings: List[str], errors: List[str]) -> Manifest:
    root = _project_root()
    sub_warnings: List[str] = []
    raw_sub = substitute(raw, root=root, warnings=sub_warnings)
    warnings.extend(sub_warnings)
    root_key = "mcpServers" if "mcpServers" in raw_sub else "servers"
    servers_raw = raw_sub.get(root_key) if isinstance(raw_sub.get(root_key), dict) else {}
    servers: Dict[str, ServerEntry] = {}
    for name, spec in servers_raw.items():
        if not isinstance(name, str) or not name.strip():
            continue
        e = normalize_entry(name.strip(), spec, warnings=warnings, root=root)
        if e is not None:
            servers[e.name] = e
    sandbox_hosts: Dict[str, Dict[str, Any]] = {}
    for _key in ("sandboxHosts", "toolHosts"):
        _raw_hosts = raw_sub.get(_key)
        if isinstance(_raw_hosts, dict):
            for k, v in _raw_hosts.items():
                if isinstance(v, dict):
                    sandbox_hosts.setdefault(str(k), {}).update(v)
    pl = raw_sub.get("placement")
    placement = dict(pl) if isinstance(pl, dict) else {}
    ths = [e for e in servers.values() if e.role == ROLE_TOOLHOST]
    # (2026-09-12) Entrée toolhost UNIQUE sans ``families`` : ancien défaut
    # « toutes les familles ». Avec plusieurs entrées, chacune doit se nommer —
    # sinon deux entrées serviraient les mêmes outils sur deux endpoints.
    if len(ths) == 1 and not ths[0].families:
        ths[0].families = list(FAMILY_NAMES)
    for e in ths:
        if not e.families:
            warnings.append(f"{e.name} : entrée toolhost sans x-elpis.families — "
                            "aucun outil ne lui est rattaché")
    if source == "file":
        _apply_env_overrides(servers, warnings, hosts=sandbox_hosts, placement=placement)
        ths = [e for e in servers.values() if e.role == ROLE_TOOLHOST]
    _derive_fallbacks(ths)
    try:
        version = int(raw_sub.get("version") or MANIFEST_VERSION)
    except (TypeError, ValueError):
        version = MANIFEST_VERSION
    return Manifest(servers=servers, sandbox_hosts=sandbox_hosts, placement=placement,
                    source=source, path=path, warnings=warnings, errors=errors,
                    loaded_at=time.time(), mtime=mtime, version=version)


def load(force: bool = False) -> Manifest:
    """Le manifeste courant. Fichier présent → cache invalidé par son mtime ;
    absent → synthèse depuis la config héritée, recalculée à chaque appel
    (peu coûteux, et fidèle aux surcharges de test)."""
    global _cached, _cached_key
    p = manifest_path()
    try:
        mtime = p.stat().st_mtime if p.is_file() else 0.0
    except OSError:
        mtime = 0.0
    if mtime > 0.0:
        key = (str(p), mtime)
        with _lock:
            if not force and _cached is not None and _cached_key == key:
                return _cached
            warnings: List[str] = []
            errors: List[str] = []
            try:
                raw = json.loads(p.read_text(encoding="utf-8"))
            except Exception as e:                                # noqa: BLE001
                errors.append(f"{p.name} illisible : {e}")
                raw = None
            if isinstance(raw, dict):
                errors.extend(validate_raw(raw))
            if errors and not isinstance(raw, dict):
                # Fichier cassé : on N'ABANDONNE PAS les outils — synthèse,
                # avec l'erreur visible dans la vue d'administration.
                logger.error("[mcp.json] %s — repli sur la configuration héritée",
                             "; ".join(errors))
                m = _build(_synthesize(warnings), source="synthesized", path=p,
                           mtime=mtime, warnings=warnings, errors=errors)
            else:
                for w in errors:
                    logger.warning("[mcp.json] schéma : %s", w)
                m = _build(raw, source="file", path=p, mtime=mtime,
                           warnings=warnings, errors=errors)
                if m.toolhost() is None:
                    m.warnings.append("aucune entrée role=toolhost : le service "
                                      "d'outils intégré n'est pas déclaré")
            for w in m.warnings:
                logger.warning("[mcp.json] %s", w)
            _cached, _cached_key = m, key
            return m
    warnings = []
    m = _build(_synthesize(warnings), source="synthesized", path=None, mtime=0.0,
               warnings=warnings, errors=[])
    return m


def reload() -> Manifest:
    """Relecture forcée (route d'administration) + purge du cache."""
    global _cached, _cached_key
    with _lock:
        _cached, _cached_key = None, ("", 0.0)
    return load(force=True)


# ─────────────────────────────────────────────────────────────────────────────
#  Raccourcis
# ─────────────────────────────────────────────────────────────────────────────
def toolhost_entry() -> Optional[ServerEntry]:
    return load().toolhost()


def builtin_client_cfg(filter_categories: Optional[List[str]] = None,
                       *, name: Optional[str] = None) -> Dict[str, Any]:
    """Config sentinelle du service intégré, telle que la route de chat, les
    sous-agents et le pré-chauffage l'envoient au pool."""
    th = toolhost_entry()
    if th is None:
        cfg: Dict[str, Any] = {"type": TYPE_STDIO, "name": name or DEFAULT_TOOLHOST_NAME,
                               "command": BUILTIN_SENTINEL, "identity": IDENTITY_META}
        if filter_categories is not None:
            cfg["filter_categories"] = list(filter_categories)
        return cfg
    cfg = th.client_cfg(filter_categories)
    if name:
        cfg["name"] = name
    return cfg


def builtin_client_cfgs(filter_categories: Optional[List[str]] = None) -> List[Dict[str, Any]]:
    """Configs de pool de TOUTES les entrées intégrées activées — UNE PAR
    ENTRÉE depuis 2026-09-12 (une famille = une entrée = un endpoint).

    Retirer une entrée de ``mcp.json`` retire donc ses outils du chat sans autre
    geste. La boucle de chat développe la sentinelle en cette liste
    (``_collect_mcp_tools``) ; le nom d'entrée devient la clé de pool."""
    entries = load().builtins()
    out = [e.client_cfg(filter_categories) for e in entries]
    if not out:
        # Manifeste sans aucune entrée intégrée (fichier partiel) : la sentinelle
        # nue reste le filet — les outils du chat ne tombent jamais en silence.
        out.append(builtin_client_cfg(filter_categories))
    return out


def resolve_external_cfg(name: str) -> Optional[Dict[str, Any]]:
    """Config de pool d'une entrée EXTERNE du manifeste (par nom), ou ``None``
    (inconnue, désactivée, ou intégrée — celles-ci passent par la sentinelle).
    Le SERVEUR fait autorité : le navigateur n'envoie que le nom."""
    e = load().get(name)
    if e is None or not e.enabled or e.is_builtin:
        return None
    return e.client_cfg(None)


def service_upstream() -> Tuple[Optional[str], str]:
    """``(url, jeton)`` du service intégré partagé (réseau) — ou ``(None, "")``.
    INVARIANT DE SÉCURITÉ : sans jeton de SERVICE il n'y a rien à relayer ni à
    publier (le service tournerait sans vérificateur → fs/shell visibles)."""
    m = load()
    if not any(e.is_network for e in m.toolhosts()):
        return None, ""
    base = m.mcp_base_url()
    tok = m.host_token()
    if not base or not tok:
        return None, ""
    return base, tok


