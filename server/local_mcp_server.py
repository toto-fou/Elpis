# SPDX-License-Identifier: MIT
from __future__ import annotations

"""
local_mcp_server.py — entry point for the local tools MCP server.

FastMCP-native: the ``CategorizingMCP`` wrapper and the
``.tool_manifest.json`` side-car are GONE. Each tool module now tags its
tools with its category (``@mcp.tool(tags={...}, meta={...})`` — see
``tools/memory_tools.py``), so the category → tools mapping travels in
the protocol and the backend reads it straight off ``list_tools()``.

Why this matters: the old manifest was written by THIS process at
startup and read by the FastAPI workers. Those workers import their
modules before this subprocess finishes booting → they saw no manifest
→ ``_mcp_categories`` fell back to an AST scan with empty tool lists →
``LOCAL_PREFIXES`` ended up empty → ``_username``/``_chat_id`` were
never injected → todo writes silently went to ``guest/todos_default``.
With the mapping in-protocol there is nothing to race.

Each tool module still exports ``register(mcp, ...)``. It no longer
needs to export a ``CATEGORY`` *to this file* — the category is applied
inside the module itself. (Modules may keep a ``CATEGORY`` dict as the
source for their own tags/meta; that's a module-internal detail.)
"""

import os
import sys
from pathlib import Path

# Ce module vit désormais dans ``server/`` mais reste lancé en sous-process
# par chemin absolu (``python <root>/server/local_mcp_server.py``). Lorsqu'on
# exécute un script par son chemin, ``sys.path[0]`` est le dossier du script
# (``server/``), pas la racine du projet — donc ``import tools`` (package à la
# racine) échouerait. On insère explicitement la racine en tête de path.
_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

# Lancé PAR CHEMIN (``python <root>/server/local_mcp_server.py``), donc
# ``server/__init__.py`` n'est jamais exécuté : on repose le garde-fou ici,
# avant fastmcp → pydantic. Ce process est un SOUS-PROCESS du worker, ses
# ~21 Mo de RSS évités se cumulent à ceux du worker lui-même.
import shared_infra.runtime.pyruntime  # noqa: E402,F401  (effet de bord, avant pydantic)

from fastmcp import FastMCP

MCP_NAME = os.environ.get("MCP_NAME", "local-tools")

# ── Familles d'outils (2026-09-02, revue adhérences MCP — A1/A2/A3) ─────────
# Chaque famille est un module ``llm_core.tools.<x>`` exportant ``register`` ;
# importée PARESSEUSEMENT dans ``register_all_tools`` et TOUTE erreur d'import
# ou d'enregistrement la rend simplement absente (avertissement) — avant, sept
# familles étaient importées en dur (un module retiré = crash au boot) et les
# deux « optionnelles » ne toléraient qu'``ImportError``. La sélection vient de
# ``LOCAL_MCP_TOOL_FAMILIES`` (cf. shared_infra.config) : ``all``, liste
# explicite ``fs,shell,git`` ou exclusions ``all,-desktop,-browser``.
#
# (2026-09-03) La TABLE et la grammaire vivent dans ``shared_infra.mcp.families``
# : la route ``/api/cli/opencode.json`` doit annoncer exactement les mêmes noms
# de familles (ils deviennent des URL et des noms de serveurs MCP côté client).
from shared_infra.mcp.families import (            # noqa: E402
    FAMILY_REGISTER_FN as _FAMILY_REGISTER_FN,
    TOOL_FAMILIES, FAMILY_NAMES as _FAMILY_NAMES,
    parse_families as _parse_families,
    opencode_families as _opencode_families,
)


def _warn(msg: str) -> None:
    print(f"WARN: {msg}", flush=True)


def selected_families(raw: "str | None") -> "list[str]":
    """Résout ``LOCAL_MCP_TOOL_FAMILIES`` en liste ordonnée de familles
    (grammaire dans ``shared_infra.mcp.families``)."""
    return _parse_families(raw, warn=_warn)


def _load_tokens() -> "tuple[str, dict[str, str]]":
    """Jetons vérifiés côté serveur (cf. shared_infra.config). Lecture
    tolérante : ce process peut tourner sans la config de l'app."""
    svc = (os.environ.get("LOCAL_MCP_TOKEN") or "").strip()
    clients: "dict[str, str]" = {}
    try:
        from shared_infra import config as _cfg
        svc = svc or str(getattr(_cfg, "LOCAL_MCP_TOKEN", "") or "").strip()
        clients = dict(getattr(_cfg, "LOCAL_MCP_CLIENT_TOKENS", {}) or {})
    except Exception:
        pass
    if not clients and os.environ.get("LOCAL_MCP_CLIENT_TOKENS"):
        for part in os.environ["LOCAL_MCP_CLIENT_TOKENS"].split(","):
            if ":" in part:
                t, u = part.split(":", 1)
                if t.strip() and u.strip():
                    clients[t.strip()] = u.strip()
    return svc, clients


SCOPE_LOCAL_TOOLS = "local-tools"


def build_token_table(service_token: str, client_tokens: "dict[str, str]") -> "dict[str, dict]":
    """Table du ``StaticTokenVerifier`` : le jeton de SERVICE porte
    ``trusted_meta`` (l'identité vient du ``meta`` de l'appel — client de
    confiance : l'app) ; un jeton CLIENT est lié à un compte (``username``),
    le ``meta`` est ignoré (cf. llm_core.tools._toolkit.get_username)."""
    table: "dict[str, dict]" = {}
    if service_token:
        table[service_token] = {"client_id": "elpis-app", "scopes": [SCOPE_LOCAL_TOOLS],
                                "trusted_meta": True}
    fams_by_tok: "dict[str, list[str]]" = {}
    try:
        from shared_infra import config as _cfg
        fams_by_tok = dict(getattr(_cfg, "LOCAL_MCP_CLIENT_TOKEN_FAMILIES", {}) or {})
    except Exception:
        pass
    for tok, user in (client_tokens or {}).items():
        if tok and user and tok != service_token:
            claims = {"client_id": f"ext:{user}", "scopes": [SCOPE_LOCAL_TOOLS],
                      "username": user, "trusted_meta": False}
            # (2026-09-11, P2 — A14) politique CÔTÉ SERVEUR par jeton : familles
            # autorisées (liste vide = toutes, comme avant).
            if fams_by_tok.get(tok):
                claims["families"] = list(fams_by_tok[tok])
            table[tok] = claims
    return table


def bind_allowed(host: str, has_tokens: bool) -> bool:
    """Un service SANS jeton n'a que le loopback comme frontière : refuser tout
    autre bind (l'identité serait auto-déclarée par n'importe quel client)."""
    return has_tokens or (host or "").strip().lower() in ("127.0.0.1", "localhost", "::1")


def _service_settings() -> "tuple[str, str, int]":
    """(passe 8, B2) ``(transport, host, port)`` : environnement d'abord, puis
    ``shared_infra.config`` (``mcp.local_transport`` / ``local_host`` /
    ``local_port``) — la config ne pilote le TRANSPORT que si le mode service
    y est configuré (``mcp.local_url`` non vide) : son défaut est ``sse``,
    alors qu'un serveur lancé sans rien est un sous-process stdio (l'app pose
    d'ailleurs ``LOCAL_MCP_TRANSPORT=stdio`` explicitement au spawn)."""
    env_t = (os.environ.get("LOCAL_MCP_TRANSPORT") or "").strip().lower()
    env_h = (os.environ.get("LOCAL_MCP_HOST") or "").strip()
    env_p = (os.environ.get("LOCAL_MCP_PORT") or "").strip()
    cfg_h, cfg_p = "", ""
    reg_t = ""                                   # transport déclaré dans le registre
    expl_t = ""                                  # déduit d'une URL EXPLICITE (mcp.local_url/env)
    try:
        from shared_infra import config as _cfg
        cfg_h = str(getattr(_cfg, "LOCAL_MCP_HOST", "") or "").strip()
        cfg_p = str(getattr(_cfg, "LOCAL_MCP_PORT", "") or "").strip()
        # (2026-09-05) Le SERVICE ne passe en réseau que sur un signal EXPLICITE.
        # ⚠ NE PAS se fier à ``config.LOCAL_MCP_URL`` : elle est désormais
        # DÉRIVÉE par défaut (streamable-http) — s'en servir ici ferait démarrer
        # un serveur HTTP à chaque lancement nu, alors que le sous-process d'un
        # worker DOIT rester stdio (il pose ``LOCAL_MCP_TRANSPORT=stdio``).
        # Registre : ``mcp.local_servers['local-tools'].transport`` (opt-in).
        _raw = getattr(_cfg, "LOCAL_MCP_SERVERS_RAW", None)
        if isinstance(_raw, dict) and isinstance(_raw.get("local-tools"), dict):
            reg_t = str(_raw["local-tools"].get("transport") or "").strip().lower()
            if reg_t in ("http", "streamable_http"):
                reg_t = "streamable-http"
        # URL explicite (env LOCAL_MCP_URL ou mcp.local_url) → son transport.
        _expl_url = str(getattr(_cfg, "LOCAL_MCP_URL_EXPLICIT", "") or "").strip().rstrip("/")
        if _expl_url:
            expl_t = "sse" if _expl_url.endswith("/sse") else "streamable-http"
    except Exception:
        pass
    # (2026-09-11) Manifeste ``mcp.json`` PRÉSENT : son entrée ``toolhost``
    # (bloc ``x-elpis.serve`` — transport/host/port — sinon dérivé d'une URL
    # loopback) est un signal explicite de mode service. Le sous-process d'un
    # worker pose toujours ``LOCAL_MCP_TRANSPORT=stdio`` en env, qui prime.
    mf_t, mf_h, mf_p = "", "", ""
    try:
        from shared_infra.mcp import manifest as _mf
        _m = _mf.load()
        _th = _m.toolhost() if _m.source == "file" else None
        if _th is not None:
            _srv = dict(_th.serve or {})
            mf_t = str(_srv.get("transport") or "").strip().lower()
            if mf_t in ("http", "streamable_http"):
                mf_t = "streamable-http"
            mf_h = str(_srv.get("host") or "").strip()
            mf_p = str(_srv.get("port") or "").strip()
            if _th.is_network and _th.url:
                from urllib.parse import urlparse as _up
                _u = _up(_th.url)
                if not mf_t:
                    mf_t = "sse" if (_u.path or "").rstrip("/").endswith("/sse") else "streamable-http"
                if not mf_h and (_u.hostname or "").lower() in ("127.0.0.1", "localhost", "::1"):
                    mf_h = _u.hostname or ""
                if not mf_p and _u.port:
                    mf_p = str(_u.port)
    except Exception:
        pass
    # Priorité : env (script de lancement / worker) → manifeste → registre →
    # URL explicite → défaut stdio (legacy : sous-process par worker, aucun réseau).
    transport = env_t or mf_t or reg_t or expl_t or "stdio"
    host = env_h or mf_h or cfg_h or "127.0.0.1"
    try:
        port = int(env_p or mf_p or cfg_p or 8765)
    except ValueError:
        port = 8765
    return transport, host, port


_TRANSPORT, _HOST, _PORT = _service_settings()
_IS_HTTP_TRANSPORT = _TRANSPORT in ("sse", "http", "streamable-http")


def token_config_error(service_token: str, client_tokens: "dict[str, str]") -> "str | None":
    """(passe 8, B3) Des jetons CLIENTS sans jeton de SERVICE armeraient le
    vérificateur alors que le client de l'app n'envoie de Bearer que si
    ``LOCAL_MCP_TOKEN`` est posé → 401 pour TOUS les comptes, sans message.
    Configuration refusée explicitement."""
    if client_tokens and not service_token:
        return ("LOCAL_MCP_CLIENT_TOKENS est posé sans LOCAL_MCP_TOKEN : l'app "
                "elle-même serait rejetée (401). Posez aussi le jeton de service.")
    return None


# ── Clients opencode : le jeton elpis-remote (``pcr_…``) vaut Bearer ────────
# (2026-09-03) Un seul identifiant par compte pour opencode : le jeton du
# plugin /remote (table ``code_remote_tokens``, minté par ``/api/code/config``)
# est accepté ici aussi. L'identité vient de la BASE (user_id → username), le
# ``meta`` est ignoré (``trusted_meta`` faux), et ``client_kind=opencode``
# déclenche le masquage des familles inutiles là-bas (cf. OpencodeFamilyFilter).
OPENCODE_TOKEN_PREFIX = "pcr_"
OPENCODE_CLIENT_PREFIX = "opencode:"
_REMOTE_TOKEN_TTL_S = 15.0          # rotation prise en compte sous 15 s
_REMOTE_TOKEN_NEG_TTL_S = 5.0       # jeton inconnu : pas de martèlement de la base
_remote_token_cache: "dict[str, tuple[str | None, float]]" = {}


def remote_token_lookup(token: str) -> "str | None":
    """``pcr_…`` → username du compte lié, ou ``None``. Lecture directe de la
    base de l'application (ce process n'a pas l'app) par le pool commun de
    ``shared_infra.db`` ; refuse tout si la fonctionnalité opencode est
    désactivée par l'administrateur."""
    if not token or not token.startswith(OPENCODE_TOKEN_PREFIX):
        return None
    try:
        from shared_infra.config import feature_enabled
        from shared_infra.db._connection import db_conn
        if not feature_enabled("opencode"):
            return None
        with db_conn() as c:
            row = c.execute(
                "SELECT u.username FROM code_remote_tokens t JOIN users u ON u.id = t.user_id "
                "WHERE t.token = ?", (token,)).fetchone()
        return str(row[0]) if row and row[0] else None
    except Exception as e:                                        # noqa: BLE001
        print(f"WARN: vérification du jeton elpis-remote impossible : {e!r}", flush=True)
        return None


def _remote_token_cached(token: str) -> "str | None":
    import time as _time
    now = _time.monotonic()
    ent = _remote_token_cache.get(token)
    if ent and ent[1] > now:
        return ent[0]
    user = remote_token_lookup(token)
    _remote_token_cache[token] = (user, now + (_REMOTE_TOKEN_TTL_S if user else _REMOTE_TOKEN_NEG_TTL_S))
    if len(_remote_token_cache) > 512:
        for k in [k for k, v in _remote_token_cache.items() if v[1] <= now][:256]:
            _remote_token_cache.pop(k, None)
    return user


def _make_verifier(table: "dict[str, dict]"):
    from fastmcp.server.auth.auth import AccessToken
    from fastmcp.server.auth.providers.jwt import StaticTokenVerifier

    class AppTokenVerifier(StaticTokenVerifier):
        """Table statique (service + clients configurés) PUIS jetons
        elpis-remote en base — l'identité de ces derniers est celle du compte."""

        async def verify_token(self, token: str):
            found = await super().verify_token(token)
            if found is not None or not token or not token.startswith(OPENCODE_TOKEN_PREFIX):
                return found
            import asyncio as _aio
            user = await _aio.to_thread(_remote_token_cached, token)
            if not user:
                # (2026-09-11, P4) hôte d'outils DISTANT : la base locale ne
                # connaît pas ce jeton → introspection auprès de l'app.
                try:
                    from shared_infra.toolhost import client as _thc
                    if _thc.enabled():
                        d = await _aio.to_thread(_thc.introspect_token, token)
                        user = str(d["username"]) if d else None
                except Exception:                                # noqa: BLE001
                    user = None
            if not user:
                return None
            return AccessToken(
                token=token, client_id=f"{OPENCODE_CLIENT_PREFIX}{user}",
                scopes=[SCOPE_LOCAL_TOOLS], expires_at=None,
                claims={"username": user, "trusted_meta": False,
                        "client_kind": "opencode", "scopes": [SCOPE_LOCAL_TOOLS]})

    return AppTokenVerifier(tokens=table, required_scopes=[SCOPE_LOCAL_TOOLS])


def _auth_provider():
    """Vérificateur Bearer sur les transports HTTP dès que le jeton de
    SERVICE est configuré (table statique + jetons elpis-remote en base) ;
    ``None`` sinon (stdio = sous-process local par worker, aucun réseau ;
    HTTP sans jeton = loopback seul, cf. ``bind_allowed``)."""
    if not _IS_HTTP_TRANSPORT:
        return None
    svc, clients = _load_tokens()
    _err = token_config_error(svc, clients)
    if _err:
        print(f"[local_mcp_server] REFUS : {_err}", flush=True)
        # (2026-09-12, P4) importé par l'app (MCP interne ``elpis-app``) ou par
        # l'hôte d'outils : on ne tue que le SCRIPT lancé tel quel.
        if __name__ == "__main__":
            sys.exit(2)
        return None
    table = build_token_table(svc, clients)
    if not table:
        return None
    return _make_verifier(table)

# Racine des sandboxes. On résout via backend.config.SANDBOX_DIR (chemin
# ABSOLU, indépendant du CWD) plutôt que ``./user_sandboxes`` relatif au CWD
# de CE process — sinon, ce service SSE étant lancé séparément (CWD parfois
# différent du backend), les outils écrivaient ailleurs que là où le backend
# (arbo du front) lit. ``MCP_SANDBOX_ROOT`` reste un override explicite.
def _resolve_sandbox_root() -> Path:
    env = os.environ.get("MCP_SANDBOX_ROOT")
    if env:
        root = Path(env).resolve()
        # (2026-09-11, P2 — A26) ``MCP_SANDBOX_ROOT`` était INERTE pour les
        # familles qui relisent ``APP_SANDBOX_DIR`` (fs/shell/git/skill…) :
        # une seule source, propagée à l'environnement de CE process.
        os.environ["APP_SANDBOX_DIR"] = str(root)
        return root
    try:
        from shared_infra.config import SANDBOX_DIR as _SBX
        return Path(_SBX).resolve()
    except Exception:
        return Path("./user_sandboxes").resolve()

SANDBOX_ROOT = _resolve_sandbox_root()

def _materialize_annotations(fn) -> None:
    """Résout les annotations-CHAÎNES d'un outil (``from __future__ import
    annotations``) dans l'espace de noms de SON module + ses variables de
    fermeture, AVANT que FastMCP/pydantic ne les évalue.

    (2026-09-02) Les outils sont des closures définies dans ``register()`` ;
    selon les versions de pydantic/fastmcp, l'évaluation des annotations d'une
    fonction imbriquée ne reçoit pas le ``globals`` du module → ``NameError:
    name 'List' is not defined`` sur le PREMIER outil typé ``List``/``Optional``
    (piège documenté ; jusqu'ici contourné par un FakeMCP dans les tests).
    Avec des annotations déjà matérialisées, plus rien à évaluer. Best-effort :
    si la résolution échoue, on laisse FastMCP faire comme avant."""
    raw = getattr(fn, "__annotations__", None)
    if not raw or not any(isinstance(v, str) for v in raw.values()):
        return
    import typing
    mod = sys.modules.get(getattr(fn, "__module__", "") or "")
    globalns = dict(vars(mod)) if mod is not None else {}
    localns = {}
    closure = getattr(fn, "__closure__", None)
    if closure:
        for name, cell in zip(fn.__code__.co_freevars, closure):
            try:
                localns[name] = cell.cell_contents
            except ValueError:
                pass
    try:
        hints = typing.get_type_hints(fn, globalns=globalns, localns=localns,
                                      include_extras=True)
    except Exception:
        return
    fn.__annotations__ = {k: hints.get(k, v) for k, v in raw.items()}


# Famille de CHAQUE outil enregistré (nom d'outil → famille), posée au passage
# du décorateur pendant ``_register_family`` : c'est la clé du masquage par
# client (OpencodeFamilyFilter) — sans dépendre des tags que chaque module
# choisit (ou non) de poser.
_CURRENT_FAMILY: "list[str | None]" = [None]
TOOL_FAMILY_OF: "dict[str, str]" = {}


def _note_family(tool_obj, fn, kwargs) -> None:
    fam = _CURRENT_FAMILY[0]
    if not fam:
        return
    name = getattr(tool_obj, "name", None) or kwargs.get("name") or getattr(fn, "__name__", "")
    if name:
        TOOL_FAMILY_OF[str(name)] = fam


class LocalToolsMCP(FastMCP):
    """FastMCP dont ``@mcp.tool`` matérialise d'abord les annotations et note
    la famille de l'outil."""

    def tool(self, name_or_fn=None, *args, **kwargs):
        if callable(name_or_fn):
            _materialize_annotations(name_or_fn)
            res = super().tool(name_or_fn, *args, **kwargs)
            _note_family(res, name_or_fn, kwargs)
            return res
        deco = super().tool(name_or_fn, *args, **kwargs)

        def _wrap(fn):
            _materialize_annotations(fn)
            res = deco(fn)
            _note_family(res, fn, kwargs)
            return res
        return _wrap


_AUTH = _auth_provider()
mcp = LocalToolsMCP(MCP_NAME, auth=_AUTH)

# Conformité MCP (cf. docs/mcp-compliance-2026-06-05.md). Middlewares ajoutés
# UNE fois, ici, au niveau du serveur → couvrent tous les tools et transports.
# Ordre : rate-limit d'abord (fail-fast avant d'exécuter le tool), puis le flag
# d'erreur, puis le remplissage de titre (ne touche que list_tools).
#   #2 ToolRateLimit    — rate-limit des invocations (Servers MUST).
#   #1 OkFalseAsIsError — arme isError:true sur {ok:false} (enveloppe conservée).
#   #3 TitleFiller      — remplit le title d'affichage manquant.
from llm_core.tools._mcp_error_middleware import OkFalseAsIsError
from llm_core.tools._mcp_compliance_middleware import ToolRateLimit, TitleFiller


from fastmcp.server.middleware import Middleware as _FmcpMiddleware


class IdentityCapture(_FmcpMiddleware):
    """(2026-09-11, P4) Pose l'identité portée par le ``_meta`` de l'appel
    (``username``, ``user_id``, ``chat_id``, ``network_profile_id``) dans le
    ``ContextVar`` de ``shared_infra.accounts.identity`` pour la durée de
    l'appel — les familles d'outils et les chemins sandbox la lisent AVANT la
    base des comptes (un hôte d'outils distant n'en a pas). Un jeton CLIENT
    (identité liée au jeton) prime sur le meta, comme pour ``get_username``.
    ``user_id`` absent du meta → rappel vers l'app (``toolhost.client``) si
    configuré, sinon 0 (les chemins par username restent corrects)."""

    async def on_call_tool(self, context, call_next):
        from shared_infra.accounts import identity as _ident
        ident = None
        try:
            fctx = getattr(context, "fastmcp_context", None)
            rc = getattr(fctx, "request_context", None)
            meta = getattr(rc, "meta", None) if rc is not None else None
            ident = _ident.from_meta(meta)
            try:
                from llm_core.tools._toolkit import _token_identity
                tid = _token_identity()
            except Exception:                                    # noqa: BLE001
                tid = None
            if tid and (ident is None or ident.username != tid):
                ident = _ident.Identity(user_id=0, username=str(tid))
            if ident is not None and not ident.user_id:
                try:
                    from shared_infra.toolhost import client as _thc
                    if _thc.enabled():
                        d = _thc.identity_for_username(ident.username)
                        if d:
                            ident = _ident.Identity(user_id=int(d["user_id"]), username=ident.username,
                                                    network_profile_id=ident.network_profile_id or str(d.get("network_profile_id") or ""),
                                                    chat_id=ident.chat_id, is_admin=bool(d.get("is_admin")))
                except Exception:                                # noqa: BLE001
                    pass
        except Exception:                                        # noqa: BLE001
            ident = None
        if ident is None:
            return await call_next(context)
        tok = _ident.set_current(ident)
        try:
            return await call_next(context)
        finally:
            _ident.reset_current(tok)


class ServerLoopCapture(_FmcpMiddleware):
    """Enregistre la loop asyncio du serveur auprès du bridge exec.

    Les notifications live shell (``ctx.info`` planifié depuis le thread
    sync d'un tool ou la loop du bridge) doivent atterrir sur LA loop où vit
    la session MCP — celle-ci. Idempotent, revalidé à chaque tool call.
    """

    async def on_call_tool(self, context, call_next):
        import asyncio as _aio
        from llm_core.tools._exec_bridge import register_server_loop
        register_server_loop(_aio.get_running_loop())
        return await call_next(context)


# (2026-09-03) opencode voit désormais UNE ENTRÉE MCP PAR FAMILLE (une bascule
# chacune dans son TUI, cf. docs/mcp-familles-opencode-design-2026-09-03.md).
# Deux réglages composés : la liste d'INCLUSION ``LOCAL_MCP_OPENCODE_FAMILIES``
# (défaut ``git,browser,desktop`` — le reste, opencode le fait déjà) moins
# ``LOCAL_MCP_OPENCODE_EXCLUDE_FAMILIES`` (fs/shell, jamais exposés là-bas).
OPENCODE_FAMILIES: "set[str]" = set(_opencode_families(warn=_warn))
OPENCODE_EXCLUDED_FAMILIES: "set[str]" = set(_FAMILY_NAMES) - OPENCODE_FAMILIES


# ── Portée par CHEMIN : ``/mcp/<famille>`` ──────────────────────────────────
# Une entrée MCP par famille dans opencode = une URL par famille (répéter la
# même URL renverrait N fois les mêmes outils). Le middleware ASGI ci-dessous
# retire le segment, remet le chemin monté attendu par FastMCP et pose la
# famille dans un ContextVar lu par ``FamilyVisibility``. Vérifié (fastmcp
# 2.14.4, streamable-http) : le ContextVar traverse jusqu'à ``on_list_tools``,
# ``on_call_tool`` et le corps de l'outil, et trois sessions concurrentes
# (``/mcp/git``, ``/mcp/chart``, ``/mcp``) ne se contaminent pas.
import contextvars                                                   # noqa: E402

_REQ_FAMILY: "contextvars.ContextVar[str | None]" = contextvars.ContextVar(
    "elpis_mcp_path_family", default=None)

# Chemin monté par FastMCP selon le transport (``/sse`` a un endpoint POST
# distinct — ``/messages/`` — mais la session naît sur le GET, qui porte donc
# la famille pour toute sa durée).
MOUNT_PATH = "/sse" if _TRANSPORT == "sse" else "/mcp"
# (2026-09-12) L'hôte d'outils sert les DEUX transports réseau en même temps :
# ``/mcp[/<famille>]`` (HTTP streamable) et ``/sse[/<famille>]`` (SSE, messages
# sur ``/messages/``). ``MOUNT_PATH`` ne décrit plus que le montage du lancement
# historique ``python server/local_mcp_server.py``.
HTTP_MOUNT_PATH = "/mcp"
SSE_MOUNT_PATH = "/sse"


class FamilyScopeASGI:
    """``<montage>/<famille>`` → requête portée à cette seule famille.

    Le chemin sans suffixe reste l'endpoint « tout » (celui de l'app). Une
    famille inconnue répond 404 : sans ça, une URL mal tapée dans un
    ``opencode.json`` aurait silencieusement rendu TOUS les outils.

    Plusieurs bases (2026-09-12) : le même middleware porte ``/mcp/<famille>``
    ET ``/sse/<famille>``. En SSE la session naît sur le GET du flux — c'est
    donc bien cette requête qui fixe la famille pour toute sa durée, y compris
    pour les messages postés ensuite sur ``/messages/``."""

    def __init__(self, app, base_path: str = "/mcp", bases=None):
        self.app = app
        raw = list(bases) if bases else [base_path or "/mcp"]
        self.bases = tuple((b or "/mcp").rstrip("/") or "/mcp" for b in raw)

    @property
    def base(self) -> str:
        return self.bases[0]

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            return await self.app(scope, receive, send)
        path = scope.get("path", "") or ""
        for base in self.bases:
            prefix = base + "/"
            if not path.startswith(prefix):
                continue
            fam = path[len(prefix):].strip("/").lower()
            if not fam:
                break
            if fam not in _FAMILY_NAMES:
                return await self._not_found(send, fam)
            scope["path"] = base
            scope["raw_path"] = base.encode("utf-8")
            _REQ_FAMILY.set(fam)
            break
        return await self.app(scope, receive, send)

    @staticmethod
    async def _not_found(send, fam: str) -> None:
        import json as _json
        body = _json.dumps({"error": f"famille d'outils inconnue : {fam}"},
                           ensure_ascii=False).encode("utf-8")
        await send({"type": "http.response.start", "status": 404,
                    "headers": [(b"content-type", b"application/json; charset=utf-8"),
                                (b"content-length", str(len(body)).encode("ascii"))]})
        await send({"type": "http.response.body", "body": body})


def path_family() -> "str | None":
    """Famille demandée par l'URL de la requête en cours (``None`` = toutes)."""
    return _REQ_FAMILY.get()


def hidden_families_for_current_client() -> "set[str]":
    """Familles à cacher pour la requête EN COURS — deux causes qui se cumulent :

    * le CLIENT : un jeton elpis-remote (``client_kind=opencode``) ne voit que
      ``OPENCODE_FAMILIES`` ; l'app (jeton de service) et les clients
      configurés à la main voient tout ce qui est enregistré ;
    * l'URL : ``…/mcp/<famille>`` restreint la requête à cette famille (une
      entrée MCP par famille côté opencode). La portée ne fait que RESTREINDRE
      — elle ne rend jamais visible ce que le client n'a pas le droit de voir.
    """
    hidden: "set[str]" = set()
    try:
        from fastmcp.server.dependencies import get_access_token
        tok = get_access_token()
    except Exception:
        tok = None
    claims = getattr(tok, "claims", None) or {} if tok is not None else {}
    if claims.get("client_kind") == "opencode":
        hidden |= set(_FAMILY_NAMES) - OPENCODE_FAMILIES
    _allowed = claims.get("families")
    if isinstance(_allowed, (list, tuple, set)) and _allowed:
        hidden |= set(_FAMILY_NAMES) - {str(f) for f in _allowed}
    fam = path_family()
    if fam:
        hidden |= set(_FAMILY_NAMES) - {fam}
    return hidden


class FamilyVisibility(_FmcpMiddleware):
    """(2026-09-03) Politique CÔTÉ SERVEUR : ``list_tools`` filtré ET
    ``call_tool`` refusé pour toute famille cachée au client de la requête
    (jeton opencode et/ou portée par l'URL) — pas un masquage d'affichage."""

    async def on_list_tools(self, context, call_next):
        tools = await call_next(context)
        hidden = hidden_families_for_current_client()
        if not hidden:
            return tools
        return [t for t in tools
                if TOOL_FAMILY_OF.get(str(getattr(t, "name", "") or "")) not in hidden]

    async def on_call_tool(self, context, call_next):
        hidden = hidden_families_for_current_client()
        if hidden:
            name = str(getattr(getattr(context, "message", None), "name", "") or "")
            fam = TOOL_FAMILY_OF.get(name)
            if fam in hidden:
                from fastmcp.exceptions import ToolError
                raise ToolError(f"outil {name!r} non exposé à ce client (famille {fam!r})")
        return await call_next(context)


# Nom historique (la politique ne concerne plus seulement opencode).
OpencodeFamilyFilter = FamilyVisibility


mcp.add_middleware(ServerLoopCapture())
mcp.add_middleware(IdentityCapture())
mcp.add_middleware(FamilyVisibility())
mcp.add_middleware(ToolRateLimit())
mcp.add_middleware(OkFalseAsIsError())
mcp.add_middleware(TitleFiller())

# Chaque ``ctx.info`` du live shell est aussi miroité au logger Python du
# serveur au niveau INFO — sans ce garde-fou, un exec verbeux imprimerait une
# ligne de log par flush (~7/s) dans le process MCP.
import logging as _logging
_logging.getLogger("fastmcp.server.context.to_client").setLevel(_logging.WARNING)


def _memory_root() -> Path:
    """Racine du magasin MÉMOIRE (liée au compte, ``config.MEMORY_DIR``) —
    défaut = racine des sandboxes (disposition historique)."""
    env = os.environ.get("MCP_MEMORY_ROOT")
    if env:
        return Path(env).resolve()
    try:
        from shared_infra.config import MEMORY_DIR as _MD
        return Path(_MD).resolve()
    except Exception:
        return SANDBOX_ROOT


def register_family_on(target: FastMCP, name: str, module: str, wants_root: bool) -> bool:
    """Importe et enregistre UNE famille sur ``target`` (2026-09-12, P4 : le
    MCP interne de l'app en construit un second). Toute exception (dépendance
    absente, config indisponible, erreur d'enregistrement) → famille absente,
    avec un avertissement — jamais un crash du service."""
    _CURRENT_FAMILY[0] = name
    try:
        import importlib
        reg = getattr(importlib.import_module(module), _FAMILY_REGISTER_FN.get(name, "register"))
        if wants_root:
            reg(target, _memory_root() if name == "memory" else SANDBOX_ROOT)
        else:
            reg(target)
        return True
    except Exception as e:                                        # noqa: BLE001
        print(f"WARN: famille d'outils {name!r} indisponible ({module}) : {e!r}",
              flush=True)
        return False
    finally:
        _CURRENT_FAMILY[0] = None


def _register_family(name: str, module: str, wants_root: bool) -> bool:
    return register_family_on(mcp, name, module, wants_root)


def apply_config_disables(target: FastMCP) -> "list[str]":
    """Retire de ``target`` les outils que la configuration déclare éteints,
    AVEC LE MÉCANISME NATIF de FastMCP.

    ``server.disable(names=…)`` pose un transform de visibilité : l'outil
    disparaît de ``tools/list`` ET son appel est refusé (« Unknown tool »).
    C'est une barrière, pas un masquage — et elle vaut pour TOUS les clients
    (l'app, opencode, la suite standalone), là où le filtre côté boucle de chat
    (``context_config.tool_enabled`` dans ``_gated_out``) ne protégeait que
    l'app. Ce filtre-là RESTE utile : lui seul couvre les outils des serveurs
    MCP tiers, qu'on ne peut pas désactiver ici.

    ⚠ ``server.disable`` est CUMULATIF : chaque appel empile un transform
    rejoué à CHAQUE ``list_tools``, sans API publique de retrait (mesuré sur 56
    outils : 2 ms à vide, 12,5 ms avec 100 transforms). D'où un appel UNIQUE,
    avec tous les noms d'un coup, idempotent par instance.

    ⚠ ``Component.disable()`` (sur l'objet outil) a été retiré en FastMCP 3.0 :
    c'est bien ``server.disable(names=…)`` qui le remplace.
    """
    from llm_core.context_config import CTX
    voulus = CTX.disabled_tools()
    # On retient ce qui a DÉJÀ été éteint sur cette instance : les familles
    # peuvent arriver en plusieurs vagues (hôte d'outils recomposé, tests), et
    # un simple drapeau « déjà fait » laisserait la seconde vague allumée.
    deja: set = getattr(target, "_elpis_disabled", None) or set()
    noms = {n for n in voulus if n in TOOL_FAMILY_OF} - deja
    if noms:
        target.disable(names=set(noms), components={"tool"})
        try:
            target._elpis_disabled = deja | noms
        except Exception:
            pass
    inconnus = voulus - {n for n in voulus if n in TOOL_FAMILY_OF}
    if inconnus and not getattr(target, "_elpis_disable_warned", False):
        # Un nom mal orthographié ne doit pas passer pour une extinction
        # effective : il ne correspond à AUCUN outil enregistré ici.
        print(f"WARN: tools.<nom>.enabled=false sur des outils inconnus : "
              f"{', '.join(sorted(inconnus))}", file=sys.stderr, flush=True)
        try:
            target._elpis_disable_warned = True
        except Exception:
            pass
    return sorted(noms)


def register_families_on(target: FastMCP, families: "list[str]") -> "list[str]":
    """Enregistre ``families`` sur une instance FastMCP donnée (MCP interne de
    l'app) — idempotent par famille via ``TOOL_FAMILY_OF``."""
    wanted = set(families or ())
    # Idempotence PAR INSTANCE (``TOOL_FAMILY_OF`` est la carte GLOBALE outil →
    # famille, partagée par le service et le MCP interne de l'app).
    done: set = getattr(target, "_elpis_families", None) or set()
    loaded = []
    for (name, module, wants_root) in TOOL_FAMILIES:
        if name not in wanted:
            continue
        if name in done or register_family_on(target, name, module, wants_root):
            done.add(name)
            loaded.append(name)
    try:
        target._elpis_families = done
    except Exception:
        pass
    # Kill-switch natif, une fois l'instance peuplée : les outils éteints par
    # la configuration n'existent pour personne (cf. apply_config_disables).
    apply_config_disables(target)
    return loaded


def register_all_tools(families: "list[str] | None" = None) -> FastMCP:
    """Register the selected tool families on the raw FastMCP instance.

    No wrapper, no manifest dump. Each ``register`` call wires its tools
    with their own ``tags`` / ``meta`` so the category is carried in the
    protocol. ``families`` : sélection explicite (tests) ; sinon
    ``LOCAL_MCP_TOOL_FAMILIES``.
    """
    if families is None:
        raw = os.environ.get("LOCAL_MCP_TOOL_FAMILIES")
        if raw is None:
            # (2026-09-11) Manifeste ``mcp.json`` : ``x-elpis.families`` de
            # l'entrée toolhost (sans fichier : synthèse = config héritée).
            try:
                from shared_infra.mcp import manifest as _mf
                families = list(_mf.load().families())
            except Exception:
                families = None
        if families is None:
            if raw is None:
                try:
                    from shared_infra.config import LOCAL_MCP_TOOL_FAMILIES as _lf
                    raw = _lf
                except Exception:
                    raw = "all"
            families = selected_families(raw)
    # Idempotent PAR FAMILLE (2026-09-12) : ``mcp`` est un singleton de module ;
    # une famille déjà enregistrée (tests, hôte d'outils recomposé) n'est pas
    # ré-enregistrée — FastMCP refuserait ou dupliquerait ses outils.
    loaded = register_families_on(mcp, list(families))
    # ⚠ SUR STDERR, jamais stdout : en transport stdio la sortie standard EST le
    # canal JSON-RPC (``python -m toolhost --stdio`` est un endpoint à part
    # entière depuis 2026-09-12). Une ligne de diagnostic sur stdout arrivait au
    # client comme un message illisible — un client strict aurait coupé.
    print(f"[local_mcp_server] familles actives : {', '.join(loaded) or '(aucune)'}",
          file=sys.stderr, flush=True)
    _oc = [n for n in loaded if n in OPENCODE_FAMILIES]
    print("[local_mcp_server] clients opencode : "
          + (f"{', '.join(_oc)} (une entrée MCP par famille, {HTTP_MOUNT_PATH}/<famille>)"
             if _oc else "aucune famille exposée"), file=sys.stderr, flush=True)
    return mcp


if __name__ == "__main__":
    SANDBOX_ROOT.mkdir(parents=True, exist_ok=True)
    register_all_tools()

    # AX-memory tables must exist in THIS process too. The FastAPI app
    # calls init_db() at its own startup, but the MCP server is a
    # SEPARATE process: without this call, record_action()/record_inspection()
    # invoked from tools/firefox_tools.py hit "no such table" and fail
    # silently (the exception is swallowed and only log.warning'd).
    # Combined with the cwd-independent path resolution in
    # backend/ax_memory/_connection.py, this guarantees the recorder and
    # the renderer operate on the exact same SQLite file.
    try:
        from shared_infra.memory.ax import init_db as _init_ax_db
        _init_ax_db()
    except Exception as _ax_e:
        print(f"WARN: ax_memory init_db failed in MCP server: {_ax_e!r}", file=sys.stderr)

    # ── Mode transport ──────────────────────────────────────────────────────
    # Par défaut : stdio (lancé en sous-process par chaque worker — comportement
    # legacy). Si ``LOCAL_MCP_TRANSPORT`` vaut sse/http/streamable-http, on
    # démarre un SERVICE réseau persistant et partagé : un seul process, chaud,
    # auquel tous les workers/utilisateurs se connectent (cf. LOCAL_MCP_URL côté
    # client). On bind par défaut sur 127.0.0.1 — ces outils (fs/shell/git) ne
    # doivent JAMAIS être exposés hors de l'hôte ; l'isolation par utilisateur
    # se fait via le ``meta`` (username/chat_id) transmis à chaque appel.
    _transport = _TRANSPORT
    if _IS_HTTP_TRANSPORT:
        _host, _port = _HOST, _PORT
        # (2026-09-02) Auth Bearer VÉRIFIÉE (StaticTokenVerifier) dès qu'un
        # jeton est configuré ; sans jeton, le loopback est la seule frontière
        # acceptable — on refuse de se lier ailleurs.
        if not bind_allowed(_host, _AUTH is not None):
            print(f"[local_mcp_server] REFUS : bind {_host}:{_port} hors loopback sans "
                  "aucun jeton (LOCAL_MCP_TOKEN / LOCAL_MCP_CLIENT_TOKENS) — "
                  "l'identité serait auto-déclarée par tout client.", flush=True)
            sys.exit(2)
        print(f"[local_mcp_server] Service partagé démarré : transport={_transport} "
              f"bind={_host}:{_port} auth={'bearer' if _AUTH is not None else 'aucune (loopback)'}",
              flush=True)
        # Portée par chemin (``<montage>/<famille>``) : middleware ASGI, donc
        # AVANT le routage de FastMCP. ``run`` relaie ``middleware`` à
        # ``http_app`` — pas besoin de reconstruire l'app ni ses lifespans.
        from starlette.middleware import Middleware as _ASGIMiddleware
        mcp.run(transport=_transport, host=_host, port=_port, show_banner=False,
                middleware=[_ASGIMiddleware(FamilyScopeASGI, base_path=MOUNT_PATH)])
    else:
        # ``show_banner=False`` au point d'appel : depuis fastmcp 2.13 le réglage
        # d'environnement ne pilote plus que la bannière de la CLI (``fastmcp run``),
        # que nous n'utilisons pas. Seul l'argument coupe la bannière du serveur.
        mcp.run(show_banner=False)
