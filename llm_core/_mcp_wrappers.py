# SPDX-License-Identifier: MIT
"""
backend.services._mcp_wrappers — MCP wrappers — Thin adapters around the MCP pool.

MCPStdioWrapper and MCPSSEWrapper expose a uniform ``call_tool`` /
``list_tools`` interface over stdio vs SSE MCP server connections.
mcp_tool_to_openai adapts an MCP tool schema into OpenAI tool-call JSON.

The big orchestrator ``run_chat_multi_mcp`` (613 l.) stays in _legacy
until a separate refactor breaks it into digestible helpers.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import shlex
import sys
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

# MCP client library — soft-import here since it's optional for lean deploys.
try:
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.sse import sse_client
    from mcp.client.stdio import stdio_client
    from mcp.client.streamable_http import streamablehttp_client
except ImportError:
    ClientSession = StdioServerParameters = None  # type: ignore
    stdio_client = sse_client = None  # type: ignore
    streamablehttp_client = None  # type: ignore

# Shared helper still in _legacy.
from llm_core._chat_classic import _dump
from shared_infra.config import (
    MCP_SERVERS_DIR,
    PROJECT_ROOT,
    SANDBOX_DIR,
)

logger = logging.getLogger("uvicorn.error")


def _shared_service_reachable(url: str, timeout: float = 0.5) -> bool:
    """Le service MCP partagé répond-il sur ``url`` ? Connexion TCP brève
    (host:port), sans requête HTTP — c'est juste « le port écoute-t-il ? ».
    Sert à décider, quand l'URL est DÉRIVÉE, s'il faut s'y fier ou retomber sur
    un sous-process stdio (cf. _resolve_mcp_client)."""
    import socket
    from urllib.parse import urlparse
    try:
        u = urlparse(url)
        host = u.hostname or "127.0.0.1"
        port = u.port or (443 if u.scheme == "https" else 80)
        with socket.create_connection((host, int(port)), timeout=timeout):
            return True
    except Exception:
        return False


def _resolve_mcp_client(cfg: Dict[str, Any]) -> Optional[Any]:
    """
    Crée et retourne un MCPStdioWrapper ou MCPSSEWrapper à partir d'une config
    de serveur MCP. Retourne None si la config est invalide.
    """
    ctype = cfg.get("type", "sse")

    if ctype == "stdio":
        cmd_raw    = cfg.get("command", "")
        target_cwd = str(PROJECT_ROOT)
        server_name = cfg.get("name", "")

        if server_name:
            potential_cwd = MCP_SERVERS_DIR / server_name
            if potential_cwd.exists() and potential_cwd.is_dir():
                target_cwd = str(potential_cwd)

        if cmd_raw == "DEFAULT_LOCAL_PYTHON":
            # Service d'outils INTÉGRÉ. (2026-09-11) La sentinelle est un ALIAS
            # de l'entrée ``role: toolhost`` du manifeste ``mcp.json``
            # (``shared_infra.mcp.manifest``) : URL, en-têtes (jeton de SERVICE
            # en Bearer, VÉRIFIÉ côté serveur), sonde et repli y sont déclarés.
            # Sans fichier, le manifeste est synthétisé depuis la config héritée
            # (``LOCAL_MCP_URL`` dérivée/explicite, jeton du fichier) — même
            # comportement qu'avant. L'identité (username/chat_id) reste
            # transmise par appel via le ``meta`` MCP : un service unique
            # partagé reste isolé par utilisateur.
            # (2026-09-12) UNE entrée par famille : ``cfg["manifest"]`` nomme
            # l'entrée à joindre (``elpis-git`` → ``…/mcp/git``). Une sentinelle
            # NUE (sous-agents, scan d'administration, appelants historiques)
            # retombe sur la première entrée toolhost déclarée.
            from shared_infra.mcp import manifest as _mf
            try:
                _m = _mf.load()
                _name = str(cfg.get("manifest") or "").strip()
                _th = _m.get(_name) if _name else None
                if _th is None or _th.role not in (_mf.ROLE_TOOLHOST, _mf.ROLE_APP):
                    if _name:
                        logger.warning("[mcp] entrée %r absente du manifeste — "
                                       "repli sur l'entrée toolhost par défaut", _name)
                    _th = _m.toolhost()
            except Exception:                                    # noqa: BLE001
                logger.warning("[mcp] manifeste illisible — repli stdio", exc_info=True)
                _th = None
            _url = (_th.url if (_th is not None and _th.is_network) else "").strip()
            _probe = bool(_th.probe_before_use) if _th is not None else False
            _hdrs = (dict(_th.headers) if (_th is not None and _th.headers) else None)
            # Une URL à SONDER (loopback doublée d'un repli, ou dérivée de la
            # config héritée) peut pointer vers un service qui ne tourne pas —
            # ex. un ``uvicorn`` nu sans le service partagé. Injoignable →
            # repli stdio par worker, pour que les outils du chat ne tombent
            # JAMAIS. Une URL EXPLICITE (env/config) ou DISTANTE reste de
            # confiance : jamais de repli silencieux vers un stdio local pour
            # un hôte distant (ses outils seraient absents, avec ``warning``).
            if _url and (not _probe or _shared_service_reachable(_url)):
                # Transport déduit de l'URL : ``…/mcp`` = HTTP streamable
                # (celui qu'attendent opencode & co.) → UN SEUL service peut
                # servir l'app ET les clients externes ; sinon SSE (legacy).
                if _url.rstrip("/").endswith("/mcp") or (_th is not None and _th.type == "http"):
                    return MCPStreamableHTTPWrapper(_url, headers=_hdrs)
                return MCPSSEWrapper(_url, headers=_hdrs)
            if _url and _probe:
                logger.info("[mcp] service partagé injoignable (%s) — "
                            "repli stdio par worker", _url)
            if _th is not None and _th.is_network and not _th.fallback and _url:
                # Hôte distant déclaré sans repli : on ne lance PAS un stdio
                # local à sa place (ce ne serait pas le même sandbox).
                logger.warning("[mcp] service d'outils %s injoignable et sans repli", _url)
                return None
            # Repli stdio (legacy, 1 subprocess par worker). On lance avec
            # ``sys.executable`` (l'interpréteur du venv courant) et NON le
            # binaire "python3" du PATH : ce dernier pouvait être le python
            # système, dont les dépendances (pydantic/fastmcp) divergent du venv
            # et faisaient échouer l'enregistrement des outils au démarrage.
            _fb = (_th.fallback if _th is not None else None) or {}
            _fb_cmd = str(_fb.get("command") or "").strip() or (sys.executable or "python3")
            _fb_args = list(_fb.get("args") or []) or [str(PROJECT_ROOT / "server" / "local_mcp_server.py")]
            # (passe 8, B2) sous-process = stdio, EXPLICITEMENT : le serveur lit
            # désormais le manifeste / la config quand le mode service y est
            # configuré.
            _fb_env = {"LOCAL_MCP_TRANSPORT": "stdio", **{k: str(v) for k, v in (_fb.get("env") or {}).items()}}
            return MCPStdioWrapper(_fb_cmd, _fb_args, cwd=str(PROJECT_ROOT), extra_env=_fb_env)

        parts = shlex.split(cmd_raw)
        if not parts:
            return None

        command  = "node" if parts[0].endswith("node.exe") else parts[0]
        raw_args = parts[1:]
        args: List[str] = []

        for a in raw_args:
            if a.endswith(".py") or a.endswith(".js"):
                found = False
                for search_path in [
                    Path(target_cwd) / a,
                    PROJECT_ROOT / a,
                    PROJECT_ROOT / "mcp_servers" / a,
                    MCP_SERVERS_DIR / a,
                ]:
                    if search_path.exists():
                        args.append(str(search_path))
                        found = True
                        break
                if not found:
                    args.append(a)
            else:
                args.append(a)

        return MCPStdioWrapper(command, args, cwd=target_cwd,
                               extra_env=_build_env(cfg))

    elif ctype == "inprocess":
        # (2026-09-12, P4) MCP INTERNE de l'app (entrée ``role: app`` du
        # manifeste) : familles liées au compte servies dans ce processus.
        fams = cfg.get("families")
        if not fams:
            try:
                from shared_infra.mcp import manifest as _mf
                e = _mf.load().get(str(cfg.get("manifest") or cfg.get("name") or ""))
                fams = list(e.families) if e is not None else []
            except Exception:
                fams = []
        from llm_core.tools.app_mcp import get_app_mcp
        return MCPInProcessWrapper(get_app_mcp(fams), name=str(cfg.get("name") or "elpis-app"))

    elif ctype in ("sse", "http", "streamable-http"):
        url = cfg.get("url", "")
        if not url:
            return None
        # v17.23+ — headers transport (Authorization & co). On accepte 3
        # formats côté config pour rester souple côté UI :
        #
        #   1. ``headers`` : dict { "Header-Name": "value", ... } direct
        #   2. ``authorization`` : raw string posée comme "Authorization"
        #      (ex: "Bearer eyJ..." ou "Basic dXNlcjp0b2tlbg==")
        #   3. ``basic_auth`` : { "username": "...", "password": "..." }
        #      → encodé base64 et collé en "Authorization: Basic ..."
        #
        # Cas Jenkins typique : l'utilisateur tape "ci-bot" + token API
        # dans le modal → on construit "Basic base64(ci-bot:token)" sans
        # qu'il ait à manipuler base64.
        headers = _build_auth_headers(cfg)
        if ctype == "sse":
            return MCPSSEWrapper(url, headers=headers or None)
        # HTTP streamable — transport MCP courant, celui que servent les
        # serveurs récents sur /mcp. SSE reste le chemin legacy.
        if streamablehttp_client is None:
            return None
        return MCPStreamableHTTPWrapper(url, headers=headers or None)

    return None


def _build_env(cfg: Dict[str, Any]) -> Dict[str, str]:
    """Variables d'environnement déclarées sur un connecteur stdio.

    Accepte les deux formes que peut prendre ``env`` selon d'où vient la
    config : dict (résolue par ``mcp_servers``) ou liste ``[{name, value}]``
    (forme au repos, telle qu'un instantané de routine la conserve).
    """
    raw = cfg.get("env")
    if isinstance(raw, list):
        raw = {p.get("name"): p.get("value") for p in raw
               if isinstance(p, dict) and p.get("name")}
    if not isinstance(raw, dict):
        return {}
    out: Dict[str, str] = {}
    for k, v in raw.items():
        if isinstance(k, str) and k and isinstance(v, (str, int, float)):
            sv = str(v)
            if sv:
                out[k] = sv
    return out


def _build_auth_headers(cfg: Dict[str, Any]) -> Dict[str, str]:
    """Construit le dict de headers à partir de la config user.

    Agnostique du transport : sert SSE comme HTTP streamable.
    Format de retour : dict[str, str]. Vide si rien n'est défini.
    """
    out: Dict[str, str] = {}

    # 1. Dict explicite — prend précédence
    raw_headers = cfg.get("headers")
    if isinstance(raw_headers, list):
        # Forme au repos des créneaux supplémentaires : [{name, value}]. Elle
        # arrive telle quelle quand la config vient d'un instantané de routine
        # ou d'un test, sans passer par ``personal_to_config``.
        raw_headers = {p.get("name"): p.get("value")
                       for p in raw_headers
                       if isinstance(p, dict) and p.get("name")}
    if isinstance(raw_headers, dict):
        for k, v in raw_headers.items():
            if isinstance(k, str) and isinstance(v, (str, int, float)):
                # Une valeur vide est un créneau en attente de saisie, pas un
                # en-tête à expédier vide (beaucoup de serveurs le rejettent,
                # et httpx refuse une valeur à espace final).
                sv = str(v).strip()
                if sv:
                    out[k] = sv
    elif isinstance(raw_headers, str):
        # Format texte multi-ligne "Key: value" — toléré pour les
        # uploads de config en JSON où l'user a posé une chaîne
        for line in raw_headers.splitlines():
            line = line.strip()
            if not line or ":" not in line:
                continue
            k, _, v = line.partition(":")
            out[k.strip()] = v.strip()

    # 2. authorization raw — écrase s'il y a conflit avec headers
    auth_raw = (cfg.get("authorization") or "").strip()
    if auth_raw:
        out["Authorization"] = auth_raw

    # 3. basic_auth { username, password } — build "Basic base64(u:p)"
    basic = cfg.get("basic_auth")
    if isinstance(basic, dict):
        u = (basic.get("username") or "").strip()
        p = (basic.get("password") or basic.get("token") or "").strip()
        if u and p:
            import base64
            encoded = base64.b64encode(f"{u}:{p}".encode("utf-8")).decode("ascii")
            out["Authorization"] = f"Basic {encoded}"

    return out


# ── Diagnostic d'erreur de connexion ─────────────────────────────────────────
# Partagé par le bouton « Tester » (routes/mcp.py) ET la boucle de chat, qui
# affichait jusqu'ici la trace brute du task group là où l'utilisateur avait
# besoin de lire « HTTP 401 : jeton refusé ».
def flatten_exc(e: BaseException) -> List[BaseException]:
    """Aplatit les ExceptionGroup : les transports MCP y enfouissent la cause."""
    out = [e]
    for sub in (getattr(e, "exceptions", None) or []):
        out.extend(flatten_exc(sub))
    return out


def friendly_mcp_error(e: BaseException) -> str:
    """Message actionnable plutôt qu'une trace de task group."""
    for x in flatten_exc(e):
        status = getattr(getattr(x, "response", None), "status_code", None)
        if status in (401, 403):
            return (f"HTTP {status} : jeton refusé ou absent. Vérifiez le mode "
                    f"d'authentification et le jeton.")
        if status == 404:
            return "HTTP 404 : l'URL ne correspond à aucun endpoint MCP."
        if status == 405:
            return ("HTTP 405 : cette URL ne sert pas ce transport "
                    "(essayez l'autre type, HTTP ou SSE).")
        if status:
            return f"HTTP {status}."
        if type(x).__name__ in ("ConnectError", "ConnectionRefusedError"):
            return "Connexion impossible : serveur injoignable à cette adresse."
        if type(x).__name__ in ("ConnectTimeout", "ReadTimeout"):
            return "Délai de connexion dépassé : adresse injoignable ou filtrée."
    msg = (str(e) or type(e).__name__).strip()
    # Le wrapper HTTP préfixe « MCP HTTP <url> — » : utile dans les journaux,
    # redondant dans un formulaire où l'URL est sous les yeux.
    if msg.startswith("MCP HTTP ") and " — " in msg:
        msg = msg.split(" — ", 1)[1]
    if msg.startswith("ConnectError"):
        return "Connexion impossible : serveur injoignable à cette adresse."
    if msg.startswith("ConnectTimeout") or msg.startswith("ReadTimeout"):
        return "Délai de connexion dépassé : adresse injoignable ou filtrée."
    return msg[:300]


# ── Normalisation JSON Schema pour le convertisseur GRAMMAIRE de llama.cpp ───
# Clés JSON-Schema dont la VALEUR est un sous-schéma (unique).
_JS_SINGLE_SCHEMA_KEYS = frozenset({
    "items", "additionalItems", "contains", "not", "if", "then", "else",
    "propertyNames", "unevaluatedItems", "unevaluatedProperties",
})
# Clés dont la valeur est un DICT nom → sous-schéma.
_JS_DICT_SCHEMA_KEYS = frozenset({
    "properties", "$defs", "definitions", "patternProperties", "dependentSchemas",
})
# Clés dont la valeur est une LISTE de sous-schémas.
_JS_LIST_SCHEMA_KEYS = frozenset({"prefixItems", "anyOf", "oneOf", "allOf"})


def _sanitize_schema_for_grammar(node: Any) -> Any:
    """Normalise un JSON Schema pour le convertisseur GRAMMAIRE (GBNF) de llama.cpp.

    Les builds RÉCENTS de llama.cpp (``--jinja``, ≈ b9xxx+) contraignent les
    tool_calls par une grammaire dérivée du ``parameters`` de chaque outil. Leur
    convertisseur REJETTE en **HTTP 400** (« Unable to generate parser…
    Unrecognized schema: true/false ») tout *schéma BOOLÉEN* — c.-à-d. ``true`` ou
    ``false`` posé LÀ OÙ UN SOUS-SCHÉMA est attendu : valeur d'une propriété,
    ``items``, entrée de ``prefixItems``/``anyOf``/``allOf``… pydantic/FastMCP en
    émet pour des champs ``Any``/``list`` nus, des ``dict`` ou des **tuples**
    (``"items": false`` pour interdire les éléments en trop). UN SEUL outil avec un
    tel champ faisait 400 TOUTE la requête → plus aucun appel MCP.

    On remplace donc chaque schéma booléen par ``{}`` (= « n'importe quoi », accepté
    par le convertisseur). EXCEPTION : ``additionalProperties: true|false`` est
    explicitement SUPPORTÉ (sémantique « (in)autorise les clés en plus ») → conservé.
    Pur, idempotent, ne touche QUE les schémas booléens (le reste passe inchangé)."""
    if isinstance(node, bool):
        return {}
    if not isinstance(node, dict):
        return node
    out: Dict[str, Any] = {}
    for k, v in node.items():
        if k == "additionalProperties":
            # Accepté tel quel par le convertisseur ; si c'est un sous-schéma
            # (dict, ex. dict[str, Model]), on le normalise quand même.
            out[k] = v if isinstance(v, bool) else _sanitize_schema_for_grammar(v)
        elif k in _JS_SINGLE_SCHEMA_KEYS:
            out[k] = _sanitize_schema_for_grammar(v)
        elif k in _JS_DICT_SCHEMA_KEYS and isinstance(v, dict):
            out[k] = {kk: _sanitize_schema_for_grammar(vv) for kk, vv in v.items()}
        elif k in _JS_LIST_SCHEMA_KEYS and isinstance(v, list):
            out[k] = [_sanitize_schema_for_grammar(e) for e in v]
        else:
            out[k] = v
    return out


def mcp_tool_to_openai(tool: Any) -> Dict[str, Any]:
    """
    Convertit un outil MCP en entrée tools[] format OpenAI function-calling.
    Le inputSchema MCP est un JSON Schema ; on le NORMALISE pour le convertisseur
    grammaire de llama.cpp (cf. _sanitize_schema_for_grammar) avant de l'utiliser
    comme "parameters".
    """
    d = _dump(tool)
    if isinstance(d, dict):
        name        = d.get("name", "unknown")
        description = d.get("description") or ""
        schema      = _dump(d.get("inputSchema") or d.get("input_schema") or {})
    else:
        name        = getattr(tool, "name", "unknown")
        description = getattr(tool, "description", "") or ""
        schema      = _dump(
            getattr(tool, "inputSchema", None) or getattr(tool, "input_schema", {})
        )

    if not isinstance(schema, dict):
        schema = {}
    # Normalisation grammaire llama.cpp : retire les schémas booléens (400 sinon).
    schema = _sanitize_schema_for_grammar(schema)
    schema.setdefault("type", "object")
    schema.setdefault("properties", {})

    # Override de description éditable à froid (context_config.json →
    # tools.<name>.description). Défaut = docstring actuelle (fallback) →
    # identique tant que le JSON ne la surcharge pas. Lazy import : pas de
    # cycle ni de coût à l'import du module.
    if name and name != "unknown":
        try:
            from llm_core.context_config import CTX as _CTX
            description = _CTX.tool_description(name, fallback=description)
        except Exception:
            pass

    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": schema,
        },
    }


# ── Support des kwargs de ``ClientSession.call_tool`` (mcp SDK) ────────────
# Résolu UNE fois par classe de session et mémoïsé : ``inspect.signature`` sur
# chaque appel d'outil serait payé des milliers de fois sur une mission longue.
_CALL_TOOL_KWARGS_CACHE: Dict[str, frozenset] = {}


# Bornes de la pagination de ``tools/list`` (AUDIT 2026-09-25).
_LIST_TOOLS_MAX_PAGES = 50
_LIST_TOOLS_MAX = 2000


async def _list_all_tools(session: Any) -> List[Any]:
    """Tous les outils d'un serveur, pages suivies (``nextCursor``).

    AUDIT 2026-09-25 — seule la 1re page était lue : un serveur qui pagine
    (FastMCP ``list_page_size``, serveurs du SDK TypeScript) n'exposait
    silencieusement qu'une partie de ses outils, et le modèle recevait
    « outil inconnu » pour les autres. Bornes : pages et nombre total."""
    res = await session.list_tools()
    tools = list(getattr(res, "tools", None) or [])
    cursor = getattr(res, "nextCursor", None)
    pages = 1
    seen_cursors = set()
    while (cursor and cursor not in seen_cursors
           and pages < _LIST_TOOLS_MAX_PAGES and len(tools) < _LIST_TOOLS_MAX):
        seen_cursors.add(cursor)
        res = await session.list_tools(cursor)
        tools.extend(getattr(res, "tools", None) or [])
        cursor = getattr(res, "nextCursor", None)
        pages += 1
    return tools[:_LIST_TOOLS_MAX]


def _session_supports(session: Any, kwarg: str) -> bool:
    """True si ``session.call_tool`` accepte ce kwarg (ou accepte **kwargs).

    Remplace l'ancien repli « appeler, rattraper TypeError, rappeler » qui
    RÉ-EXÉCUTAIT l'outil quand le TypeError venait du corps de l'outil et non
    de la signature (cf. call_tool ci-dessous)."""
    fn = getattr(session, "call_tool", None)
    if fn is None:
        return False
    key = f"{type(session).__module__}.{type(session).__qualname__}"
    names = _CALL_TOOL_KWARGS_CACHE.get(key)
    if names is None:
        try:
            import inspect
            params = inspect.signature(fn).parameters
            if any(p.kind is inspect.Parameter.VAR_KEYWORD for p in params.values()):
                # **kwargs : on ne peut rien exclure, on tente tout.
                names = frozenset({"meta", "progress_callback"})
            else:
                names = frozenset(params)
        except (TypeError, ValueError):
            # Signature illisible (builtin, mock exotique) : rester
            # PERMISSIF — l'ancien comportement tentait l'appel complet.
            names = frozenset({"meta", "progress_callback"})
        _CALL_TOOL_KWARGS_CACHE[key] = names
    return kwarg in names


def _log_call_token(meta: Optional[Dict[str, Any]]) -> str:
    """Jeton identifiant un appel pour le routage des logs.

    AUDIT 2026-08-23 — on prend d'abord ``log_token``, tiré une fois par RUN
    par le harnais (``_run_log_tok`` + call_id). ``call_id`` seul ne convient
    pas : il n'est unique qu'au sein d'un run (le harnais fabrique
    ``call_{iter}_{idx}``, llama.cpp renvoie ``call_0``), or ce routeur est
    partagé par tous les comptes du worker — deux appels concurrents se
    volaient l'emplacement, et la sortie du terminal d'un compte partait chez
    l'autre. ``call_id`` reste le repli pour un appelant qui ne pose pas le
    jeton (routines, sous-agents, tests) ; sinon un jeton local anonyme.
    """
    if isinstance(meta, dict):
        tok = meta.get("log_token") or meta.get("call_id")
        if tok:
            return str(tok)
    import secrets as _secrets
    return "_anon_" + _secrets.token_hex(6)


class _LogRouter:
    """Aiguille les notifications de log MCP vers le BON appel en cours.

    AUDIT 2026-08-22 (C2) — il y avait ici UN SEUL emplacement
    (``_current_log_cb``), écrit à l'entrée de ``call_tool`` et remis à None à
    sa sortie. La docstring qui l'autorisait disait « les appels sont
    sérialisés sur la session par le verrou du pool » : c'était vrai jusqu'à
    l'audit 2026-08-01 (P1-5), qui a fait passer les transports SSE/HTTP sur un
    SÉMAPHORE (8 appels de front). Depuis, le serveur d'outils locaux étant
    partagé par TOUS les utilisateurs d'un worker, deux appels concurrents se
    volaient l'emplacement : la sortie du terminal en direct d'Alice partait
    dans le flux de Bob — étiquetée avec l'identifiant d'appel de Bob — puis le
    retour de l'appel de Bob remettait l'emplacement à None et le terminal
    d'Alice devenait muet jusqu'à la fin de la commande.

    Le protocole MCP ne corrèle pas une notification de log à la requête qui
    l'a provoquée : il n'y a pas d'identifiant de requête dans
    ``LoggingMessageNotificationParams``. On aiguille donc dans cet ordre :

      1. ``__shell_output__.call_id`` — le pont d'exécution shell (le gros du
         volume, et le seul flux où une erreur d'attribution se VOIT) place
         l'identifiant d'appel dans sa charge utile ;
      2. un seul appel en vol → c'est forcément le sien (cas courant, et
         comportement historique) ;
      3. le ``logger`` de la notification désigne un seul appel en vol par son
         nom d'outil ;
      4. sinon on jette, en le disant : mieux vaut une ligne de log perdue
         qu'une ligne attribuée au mauvais utilisateur.
    """

    __slots__ = ("_calls", "_dropped")

    def __init__(self) -> None:
        # token d'appel → (nom d'outil, callback|None)
        self._calls: "Dict[str, tuple]" = {}
        self._dropped = 0

    def register(self, token: str, tool_name: str,
                 cb: Optional[Callable]) -> str:
        """Inscrit l'appel et rend le jeton EFFECTIF — à passer tel quel à
        ``unregister`` (il diffère de ``token`` en cas de collision)."""
        # Défense en profondeur (audit 2026-08-23) : un jeton déjà pris n'est
        # JAMAIS écrasé. Écraser revenait à voler l'emplacement du voisin —
        # sa sortie partait chez le nouveau venu, puis le premier
        # ``unregister`` coupait les deux. En cas de collision on s'enregistre
        # sous un jeton anonyme : cet appel-là ne sera pas routé par id (il
        # retombe sur les heuristiques), mais personne n'est mal servi.
        if token in self._calls:
            import secrets as _secrets
            _alt = "_dup_" + _secrets.token_hex(6)
            logger.warning(
                "[mcp_log_router] jeton d'appel '%s' déjà enregistré (%s) — "
                "le nouvel appel '%s' prend un jeton anonyme plutôt que de "
                "détourner la sortie du premier.",
                token, self._calls[token][0], tool_name)
            self._calls[_alt] = (tool_name, cb)
            return _alt
        self._calls[token] = (tool_name, cb)
        return token

    def unregister(self, token: str) -> None:
        self._calls.pop(token, None)

    @staticmethod
    def _call_id_of(params: Any) -> Optional[str]:
        data = getattr(params, "data", None)
        # (2026-09-11, P3) notification STRUCTURÉE : ``data = {"msg", "extra"}``
        # avec ``extra.kind`` ∈ {shell_output, heartbeat} et l'identifiant
        # d'appel dans ``extra`` — plus de JSON à parser dans le message.
        if isinstance(data, dict) and isinstance(data.get("extra"), dict):
            _x = data["extra"]
            if _x.get("kind") in ("shell_output", "heartbeat"):
                cid = _x.get("log_token") or _x.get("call_id")
                return str(cid) if cid else None
        # AUDIT 2026-08-23 — déballage du ``LogData``. Depuis fastmcp 2.14,
        # ``Context.info`` n'envoie plus le message en texte brut : il
        # construit un ``LogData(msg, extra)``, donc ``params.data`` arrive en
        # DICT ``{"msg": "<json>", "extra": …}``. Sans ce déballage, la garde
        # ``isinstance(data, str)`` rendait None pour 100 % des notifications
        # réelles : tout le routage par identifiant était inerte, et le
        # terminal en direct retombait sur les heuristiques (donc muet dès que
        # deux appels tournaient de front). ``engine/tool_exec`` déballe déjà.
        if isinstance(data, dict) and isinstance(data.get("msg"), str):
            data = data["msg"]
        if not isinstance(data, str) or "__shell_output__" not in data:
            return None
        try:
            payload = json.loads(data)
        except Exception:                                       # noqa: BLE001
            return None
        inner = payload.get("__shell_output__") if isinstance(payload, dict) else None
        if not isinstance(inner, dict):
            return None
        cid = inner.get("log_token") or inner.get("call_id")
        return str(cid) if cid else None

    def resolve(self, params: Any) -> Optional[Callable]:
        cid = self._call_id_of(params)
        if cid is not None:
            entry = self._calls.get(cid)
            if entry is not None:
                return entry[1]
            # Identifiant présent mais inconnu ici : l'appel s'est terminé
            # (ou vit sur une autre session). Ne PAS retomber sur un autre
            # destinataire — ce serait exactement l'erreur d'attribution
            # qu'on corrige.
            self._dropped += 1
            return None
        live = list(self._calls.values())
        if len(live) == 1:
            return live[0][1]
        logger_name = getattr(params, "logger", None)
        if logger_name:
            matches = [cb for (tname, cb) in live if tname == logger_name]
            if len(matches) == 1:
                return matches[0]
        self._dropped += 1
        if self._dropped in (1, 10, 100, 1000):
            logger.debug(
                "[mcp_wrapper] notification de log non attribuable "
                "(%d appels en vol, logger=%r) — %d ignorée(s) au total",
                len(live), logger_name, self._dropped)
        return None


class MCPStdioWrapper:
    def __init__(self, command: str, args: List[str], cwd: Optional[str] = None,
                 extra_env: Optional[Dict[str, str]] = None):
        env = os.environ.copy()
        env["APP_SANDBOX_DIR"] = str(SANDBOX_DIR)

        if cwd:
            cwd_path = Path(cwd)
            if cwd_path.is_file():
                cwd = str(cwd_path.parent)
            env["PYTHONPATH"] = cwd + os.pathsep + env.get("PYTHONPATH", "")
            node_roots = [str(Path(cwd) / "node_modules")]
            if args and args[-1].endswith(".js"):
                script_dir = Path(args[-1]).parent
                node_roots.append(str(script_dir / "node_modules"))
                node_roots.append(str(script_dir.parent / "node_modules"))
            env["NODE_PATH"] = (
                os.pathsep.join(set(node_roots)) + os.pathsep + env.get("NODE_PATH", "")
            )

        # Variables déclarées sur le connecteur — c'est ainsi que se configure
        # la majorité des serveurs MCP npm/npx (jeton, URL du service…).
        # Posées APRÈS le bloc ci-dessus : PYTHONPATH/NODE_PATH sont calculés
        # ici et ne doivent pas être écrasés (la liste blanche des noms les
        # refuse déjà à la saisie, cf. mcp_servers._RESERVED_ENV — ceci est la
        # seconde barrière, pour une config venue d'un instantané ancien).
        for k, v in (extra_env or {}).items():
            if (isinstance(k, str) and k
                    and k not in ("PYTHONPATH", "NODE_PATH", "APP_SANDBOX_DIR")
                    and isinstance(v, (str, int, float))):
                env[k] = str(v)

        final_command = command
        final_args = args

        if cwd:
            if sys.platform == "win32":
                final_command = "cmd.exe"
                cmd_line = f'cd /d "{cwd}" && {command} ' + " ".join(f'"{a}"' for a in args)
                final_args = ["/c", cmd_line]
            else:
                final_command = "sh"
                cmd_line = (
                    f"cd {shlex.quote(cwd)} && exec {command} "
                    + " ".join(shlex.quote(a) for a in args)
                )
                final_args = ["-c", cmd_line]

        self.params = StdioServerParameters(command=final_command, args=final_args, env=env)
        self.cwd = cwd
        self.ctx = None
        self.session = None
        # v18 — routage PAR APPEL des notifications de log. Le callback posé
        # sur la session à l'``__aenter__`` interroge ce routeur pour rendre
        # chaque ``ctx.info()/warning()/error()`` du serveur à SON appelant
        # (cf. _LogRouter : plusieurs appels vivent de front sur une même
        # session depuis l'audit P1-5).
        self._log_router = _LogRouter()

    async def __aenter__(self):
        self.ctx = stdio_client(self.params)
        read, write = await self.ctx.__aenter__()
        # v18 — register a session-wide logging callback that routes to
        # the currently-active call's log_cb (set by call_tool below).
        async def _session_log_cb(params):
            cb = self._log_router.resolve(params)
            if cb is None:
                return
            try:
                await cb(params)
            except Exception:
                logger.exception("[mcp_wrapper] log callback raised")

        try:
            self.session = ClientSession(read, write, logging_callback=_session_log_cb)
        except TypeError:
            # Very old mcp SDK without logging_callback kwarg — degrade
            # silently. Logs from ctx.info()/etc just don't reach the UI.
            self.session = ClientSession(read, write)
        await self.session.__aenter__()
        await self.session.initialize()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        # AUDIT 2026-08-23 — un objet, un try. C'est ``self.ctx`` (le
        # générateur ``stdio_client``/``sse_client``) qui TUE le sous-process
        # et referme le flux ; ``self.session.__aexit__`` est le
        # ``BaseSession.__aexit__`` du SDK, qui sort un groupe de tâches anyio
        # — et un groupe dont la boucle de réception a échoué sur un tuyau
        # cassé remonte un ``ExceptionGroup``. Cette exception sautait la
        # ligne suivante : le transport n'était JAMAIS quitté. Aux deux points
        # d'appel du pool, l'erreur est avalée par un ``except Exception``
        # (dont hérite ExceptionGroup) — donc rien ne remontait, et le process
        # ``server/local_mcp_server.py`` restait vivant pour toute la durée de
        # vie du worker. ``MCPStreamableHTTPWrapper._unwind`` faisait déjà les
        # choses correctement 80 lignes plus bas.
        for obj in (self.session, self.ctx):
            if obj is None:
                continue
            try:
                await obj.__aexit__(exc_type, exc_val, exc_tb)
            except BaseException:                               # noqa: BLE001
                logger.debug("[MCP] fermeture partielle ignorée", exc_info=True)
        self.session = None
        self.ctx = None

    async def list_tools(self):
        return await _list_all_tools(self.session)

    async def call_tool(self, name: str, arguments: dict,
                        meta: Optional[Dict[str, Any]] = None,
                        progress_callback: Optional[Callable] = None,
                        log_callback: Optional[Callable] = None):
        """Appel d'un tool MCP avec support optionnel du `_meta` field.

        v17.20+ (Phase 2b) — ``meta`` est transmis comme MCP request meta
        (ne traverse PAS les arguments — invisible au LLM). Mécanisme
        natif depuis mcp >= 1.19.0 ; sur les versions plus anciennes le
        kwarg n'existe pas et on fallback gracieusement sans meta (l'appel
        marche, juste sans l'identité user — le tool serveur résoudra
        sur "guest" comme avant).

        v18 (Tier 1 MCP best practices) — deux nouveaux callbacks optionnels :
        ``progress_callback(progress, total, message)`` reçoit les
        ``ctx.report_progress()`` du tool serveur ; ``log_callback(params)``
        reçoit les ``ctx.info/warning/error()``. L'orchestrateur de chat
        les wire pour traduire en events SSE ``tool_progress`` / ``tool_log``
        consommés par le frontend. Aucun caller existant n'est forcé à
        passer ces callbacks — ils sont strictement additifs.
        """
        # Enregistre CET appel auprès du routeur de logs (le callback posé
        # sur la session à l'``__aenter__`` l'y retrouvera). Le jeton est
        # l'identifiant d'appel du harnais quand il est fourni — c'est lui que
        # le pont d'exécution shell recopie dans ses notifications.
        _tok = _log_call_token(meta)
        # Jeton EFFECTIF : sur collision, désinscrire le jeton d'origine
        # coupait l'appel voisin encore en cours et laissait fuir le nôtre.
        _tok = self._log_router.register(_tok, name, log_callback)
        try:
            # AUDIT long-run 2026-08-21 — on INSPECTE la signature au lieu de
            # rattraper un ``TypeError``. L'ancien repli ne pouvait pas
            # distinguer « le SDK ne connaît pas ce kwarg » d'un ``TypeError``
            # levé DANS le corps de l'outil (un ``None`` non subscriptable
            # suffit) : dans ce second cas il REJOUAIT l'appel, jusqu'à 3 fois.
            # Sur un outil MUTANT (write_file, execute_shell, git_commit) le
            # même effet de bord s'appliquait deux ou trois fois, et le modèle
            # n'en voyait qu'un — c'est l'anomalie « il a écrit deux fois » des
            # missions longues. Un TypeError du corps de l'outil remonte
            # désormais tel quel : le harnais le rend en tool-error.
            kwargs: Dict[str, Any] = {}
            if meta and _session_supports(self.session, "meta"):
                kwargs["meta"] = meta
            if progress_callback is not None and _session_supports(
                    self.session, "progress_callback"):
                kwargs["progress_callback"] = progress_callback
            return await self.session.call_tool(name, arguments, **kwargs)
        finally:
            self._log_router.unregister(_tok)


class MCPSSEWrapper:
    def __init__(self, url: str, headers: Optional[Dict[str, str]] = None):
        """v17.23+ — ``headers`` est un dict de headers HTTP à attacher
        à toutes les requêtes SSE (auth Bearer/Basic notamment, ou
        n'importe quel header custom dont le serveur a besoin).

        Le SDK mcp ``sse_client(url, headers=...)`` supporte ce kwarg
        nativement depuis longtemps ; on le forward simplement. ``None``
        ou dict vide → comportement historique sans header custom.
        """
        self.url = url
        self.headers = dict(headers) if headers else None
        self.ctx = None
        self.session = None
        # v18 — cf. MCPStdioWrapper pour le contrat de routage des logs.
        self._log_router = _LogRouter()

    def _open_transport(self):
        """Ouvre le contexte de transport. Surchargé par le wrapper HTTP."""
        return sse_client(self.url, headers=self.headers)

    async def _enter_transport(self):
        """Rend (read, write). ``sse_client`` donne un 2-uplet."""
        read, write = await self.ctx.__aenter__()
        return read, write

    async def __aenter__(self):
        # PAS de repli sans headers ici. Un `except TypeError` qui rejouerait
        # sse_client(self.url) partirait NON AUTHENTIFIÉ vers un serveur que
        # l'utilisateur croit authentifié : le 401 se lirait « serveur en
        # panne » au lieu de « le jeton n'est jamais parti ». On laisse
        # remonter.
        self.ctx = self._open_transport()
        read, write = await self._enter_transport()

        async def _session_log_cb(params):
            cb = self._log_router.resolve(params)
            if cb is None:
                return
            try:
                await cb(params)
            except Exception:
                logger.exception("[mcp_wrapper sse] log callback raised")

        try:
            self.session = ClientSession(read, write, logging_callback=_session_log_cb)
        except TypeError:
            self.session = ClientSession(read, write)
        await self.session.__aenter__()
        await self.session.initialize()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        # AUDIT 2026-08-23 — un objet, un try. C'est ``self.ctx`` (le
        # générateur ``stdio_client``/``sse_client``) qui TUE le sous-process
        # et referme le flux ; ``self.session.__aexit__`` est le
        # ``BaseSession.__aexit__`` du SDK, qui sort un groupe de tâches anyio
        # — et un groupe dont la boucle de réception a échoué sur un tuyau
        # cassé remonte un ``ExceptionGroup``. Cette exception sautait la
        # ligne suivante : le transport n'était JAMAIS quitté. Aux deux points
        # d'appel du pool, l'erreur est avalée par un ``except Exception``
        # (dont hérite ExceptionGroup) — donc rien ne remontait, et le process
        # ``server/local_mcp_server.py`` restait vivant pour toute la durée de
        # vie du worker. ``MCPStreamableHTTPWrapper._unwind`` faisait déjà les
        # choses correctement 80 lignes plus bas.
        for obj in (self.session, self.ctx):
            if obj is None:
                continue
            try:
                await obj.__aexit__(exc_type, exc_val, exc_tb)
            except BaseException:                               # noqa: BLE001
                logger.debug("[MCP] fermeture partielle ignorée", exc_info=True)
        self.session = None
        self.ctx = None

    async def list_tools(self):
        return await _list_all_tools(self.session)

    async def call_tool(self, name: str, arguments: dict,
                        meta: Optional[Dict[str, Any]] = None,
                        progress_callback: Optional[Callable] = None,
                        log_callback: Optional[Callable] = None):
        """Voir ``MCPStdioWrapper.call_tool`` — même contrat."""
        _tok = _log_call_token(meta)
        # Jeton EFFECTIF : sur collision, désinscrire le jeton d'origine
        # coupait l'appel voisin encore en cours et laissait fuir le nôtre.
        _tok = self._log_router.register(_tok, name, log_callback)
        try:
            # Même règle que MCPStdioWrapper.call_tool : signature INSPECTÉE,
            # jamais de rejeu sur TypeError (qui ré-exécutait l'outil).
            kwargs: Dict[str, Any] = {}
            if meta and _session_supports(self.session, "meta"):
                kwargs["meta"] = meta
            if progress_callback is not None and _session_supports(
                    self.session, "progress_callback"):
                kwargs["progress_callback"] = progress_callback
            return await self.session.call_tool(name, arguments, **kwargs)
        finally:
            self._log_router.unregister(_tok)


class MCPStreamableHTTPWrapper(MCPSSEWrapper):
    """Transport « HTTP streamable » (POST /mcp), standard MCP courant.

    Même contrat que ``MCPSSEWrapper`` — seule l'ouverture du transport
    diffère : ``streamablehttp_client`` rend un 3-uplet
    ``(read, write, get_session_id)`` là où ``sse_client`` en rend deux.

    ⚠ ``_mcp_pool._transport_concurrency`` teste le NOM de la classe :
    celle-ci doit y figurer, sinon les appels d'outils repassent en série.
    """

    def __init__(self, url: str, headers: Optional[Dict[str, str]] = None):
        super().__init__(url, headers=headers)
        self._get_session_id: Optional[Callable] = None

    def _open_transport(self):
        return streamablehttp_client(self.url, headers=self.headers)

    async def _enter_transport(self):
        read, write, self._get_session_id = await self.ctx.__aenter__()
        return read, write

    async def __aenter__(self):
        try:
            return await super().__aenter__()
        except BaseException as exc:
            # ``streamablehttp_client`` fait la vraie requête dans le task
            # group de son générateur asynchrone. Un 401 (ou un refus de
            # connexion) y est levé, le scope saute, et l'appelant ne reçoit
            # qu'un CancelledError opaque — qui n'est PAS une ``Exception`` et
            # traverse donc le ``except Exception`` de ``_chat_with_tools``,
            # avortant tout le tour au lieu de signaler ce seul serveur.
            #
            # Il faut D'ABORD quitter le scope du transport : tant qu'on est
            # dedans, tout nouvel await est annulé d'office, sondage compris.
            await self._unwind(exc)
            if isinstance(exc, asyncio.CancelledError):
                task = asyncio.current_task()
                if task is not None:
                    task.uncancel()
                try:
                    await asyncio.sleep(0)
                except asyncio.CancelledError:
                    pass
            # Soupape : si l'annulation venait vraiment de l'extérieur (client
            # déconnecté), le sondage sera annulé à son tour et le
            # CancelledError repartira — ``_diagnose`` n'attrape qu'``Exception``.
            raise RuntimeError(
                f"MCP HTTP {self.url} — {await self._diagnose()}"
            ) from exc

    async def _unwind(self, exc: BaseException) -> None:
        """Referme session + transport, au mieux, après un échec d'entrée."""
        for obj in (self.session, self.ctx):
            if obj is None:
                continue
            try:
                await obj.__aexit__(type(exc), exc, exc.__traceback__)
            except BaseException:
                pass
        self.session = None
        self.ctx = None

    async def _diagnose(self) -> str:
        """Rejoue UNE requête pour nommer la cause réelle de l'échec.

        Uniquement sur le chemin d'erreur : coût nul en régime normal.
        """
        try:
            import httpx
            headers = dict(self.headers or {})
            headers.setdefault("Content-Type", "application/json")
            headers.setdefault("Accept", "application/json, text/event-stream")
            payload = {
                "jsonrpc": "2.0", "id": 0, "method": "initialize",
                "params": {
                    "protocolVersion": "2025-06-18", "capabilities": {},
                    "clientInfo": {"name": "diag", "version": "0"},
                },
            }
            async with httpx.AsyncClient(timeout=5.0) as cli:
                r = await cli.post(self.url, json=payload, headers=headers)
            if r.status_code in (401, 403):
                return (f"HTTP {r.status_code} : jeton d'authentification "
                        f"refusé ou absent")
            if r.status_code == 405:
                return ("HTTP 405 : cette URL ne sert pas le transport HTTP "
                        "streamable (essayez le type SSE)")
            if r.status_code >= 400:
                return f"HTTP {r.status_code}"
            return f"HTTP {r.status_code} : négociation MCP échouée"
        except Exception as e:
            return f"{type(e).__name__}: {e}"


class MCPInProcessWrapper(MCPSSEWrapper):
    """Transport EN MÉMOIRE (``fastmcp.client.transports.FastMCPTransport``) vers
    une instance FastMCP du MÊME processus — le MCP interne de l'app
    (2026-09-12, P4). Même contrat que les autres wrappers : ``list_tools``,
    ``call_tool(meta=…, progress_callback=…, log_callback=…)`` et le routeur de
    logs. ⚠ ``_mcp_pool._transport_concurrency`` teste le NOM de la classe.
    """

    def __init__(self, server: Any, name: str = "elpis-app"):
        super().__init__(f"inprocess://{name}", headers=None)
        self.server = server
        self._cm = None

    async def __aenter__(self):
        from fastmcp.client.transports import FastMCPTransport

        async def _session_log_cb(params):
            cb = self._log_router.resolve(params)
            if cb is None:
                return
            try:
                await cb(params)
            except Exception:
                logger.exception("[mcp_wrapper inprocess] log callback raised")

        transport = FastMCPTransport(self.server)
        self._cm = transport.connect_session(logging_callback=_session_log_cb)
        self.session = await self._cm.__aenter__()
        await self.session.initialize()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        cm, self._cm, self.session = self._cm, None, None
        if cm is not None:
            try:
                await cm.__aexit__(exc_type, exc_val, exc_tb)
            except BaseException:                               # noqa: BLE001
                logger.debug("[mcp_wrapper inprocess] fermeture", exc_info=True)
        return False
