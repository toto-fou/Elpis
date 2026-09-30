# SPDX-License-Identifier: MIT
"""toolhost/app.py — composition de l'hôte d'outils (2026-09-11, P4 ;
endpoints par famille 2026-09-12).

UN processus, UN port, TROIS transports pour les mêmes outils :

* ``/mcp`` et ``/mcp/<famille>`` — MCP « HTTP streamable » ;
* ``/sse`` et ``/sse/<famille>`` — MCP SSE (messages sur ``/messages/``) ;
* ``python -m toolhost --stdio --families <famille>`` — MCP stdio (hors service).

Le segment de famille porte la requête à cette seule famille : une entrée
``mcp.json`` par famille = un endpoint par famille, et retirer l'entrée suffit à
retirer les outils. Sans segment, l'endpoint sert toutes les familles
enregistrées.

S'y ajoutent, aux MÊMES chemins que dans l'app (le relais les retransmet tels
quels) et derrière ``toolhost/auth.py`` : ``/api/sandbox/*``, ``/api/terminal/*``,
``/ws/terminal``, ``/api/playwright/screenshot/*``, ``/api/desktop/frame/*``,
``/api/memory/ax*``, plus ``/health`` (ouvert) et ``/manifest``
(auto-description : un bloc ``mcpServers`` prêt à coller dans un autre
applicatif).

L'état propre de l'hôte (sessions de terminal, mémoire AX, audit) vit dans SA
base (``toolhost.json › db_path``), jamais dans celle de l'app.
"""
from __future__ import annotations

import contextlib
import logging
import time
from typing import Any, Dict, List, Optional

# Au niveau module : ``from __future__ import annotations`` rend les annotations
# des handlers des CHAÎNES résolues dans les globals — un ``Request`` importé
# localement serait pris pour un paramètre de requête (422).
from fastapi import FastAPI, Request

from toolhost.config import ToolhostConfig, apply_environment, load as load_config

logger = logging.getLogger("uvicorn.error")

SERVED_PREFIXES = (
    "/api/sandbox/", "/api/terminal/", "/ws/terminal",
    "/api/playwright/screenshot/", "/api/desktop/frame/", "/api/memory/ax",
)
# Chemins servis par le transport SSE (le POST des messages est un chemin à part
# du GET du flux — il porte l'identifiant de session, pas la famille).
SSE_PREFIXES = ("/sse", "/messages")
_STARTED_AT = time.time()


class TransportSplitASGI:
    """Aiguille ``/sse*`` et ``/messages/*`` vers l'application SSE, le reste
    vers l'application principale (API sandbox + montage HTTP streamable).

    Pourquoi un aiguilleur et non deux montages : chaque application produite
    par fastmcp porte SA pile de middlewares (``RequestContextMiddleware``,
    vérificateur Bearer). Recopier seulement leurs routes dans un même routeur
    perdrait cette pile ; les monter toutes les deux à la racine se
    recouvrirait. L'aiguilleur garde les deux piles intactes."""

    def __init__(self, app: Any, sse_app: Any, prefixes=SSE_PREFIXES) -> None:
        self.app = app
        self.sse_app = sse_app
        self.prefixes = tuple(prefixes)

    async def __call__(self, scope, receive, send):
        if self.sse_app is not None and scope.get("type") == "http" \
                and str(scope.get("path") or "").startswith(self.prefixes):
            return await self.sse_app(scope, receive, send)
        return await self.app(scope, receive, send)


def _import_route_modules() -> None:
    """Importe les modules de routes servis ici — ils s'enregistrent sur le
    routeur partagé à l'import (comme le fait ``shared_infra/routes/__init__``
    dans l'app). L'ordre reste celui du chef d'orchestre pour ces modules."""
    from shared_infra.routes import _state, _helpers  # noqa: F401
    from shared_infra.terminal import pty  # noqa: F401
    from shared_infra.sandbox import routes_snapshots, routes_lifecycle  # noqa: F401
    from shared_infra.memory import routes_ax  # noqa: F401
    from shared_infra.routes import tools  # noqa: F401 — /api/playwright/screenshot
    from shared_infra.desktop import routes as desktop_routes  # noqa: F401 — /api/desktop/frame
    from shared_infra.terminal import routes as terminal_routes  # noqa: F401
    from shared_infra.sandbox import routes_files, routes_git  # noqa: F401
    from shared_infra.sandbox import routes_office  # noqa: F401 — aperçus Office/PDF de l'éditeur


def served_routes() -> List[Any]:
    from shared_infra.routes._state import router
    out = []
    for r in router.routes:
        path = getattr(r, "path", "") or ""
        if path.startswith(SERVED_PREFIXES):
            out.append(r)
    return out


def _families_live() -> List[str]:
    """Familles réellement enregistrées sur le service, ordre canonique."""
    import server.local_mcp_server as S
    from shared_infra.mcp.families import FAMILY_NAMES
    live = {f for f in S.TOOL_FAMILY_OF.values() if f}
    return [f for f in FAMILY_NAMES if f in live]


def endpoints_view(tc: ToolhostConfig, base_url: str = "") -> Dict[str, Any]:
    """``{famille: {http, sse, stdio}}`` — comment joindre chaque famille depuis
    un applicatif tiers. ``base_url`` : origine publique de l'hôte (défaut :
    celle du bind, utile telle quelle en local)."""
    import server.local_mcp_server as S
    import sys
    base = (base_url or f"http://{tc.host}:{tc.port}").rstrip("/")
    out: Dict[str, Any] = {}
    for fam in _families_live():
        row: Dict[str, Any] = {}
        if "http" in tc.transports:
            row["http"] = f"{base}{S.HTTP_MOUNT_PATH}/{fam}"
        if "sse" in tc.transports:
            row["sse"] = f"{base}{S.SSE_MOUNT_PATH}/{fam}"
        row["stdio"] = {"command": sys.executable or "python3",
                        "args": ["-m", "toolhost", "--stdio", "--families", fam]}
        out[fam] = row
    return out


def export_mcp_servers(tc: ToolhostConfig, *, transport: str = "http",
                       base_url: str = "", prefix: str = "elpis-") -> Dict[str, Any]:
    """Bloc ``mcpServers`` prêt à coller dans la configuration d'un AUTRE
    applicatif (Claude Desktop, Cursor, LibreChat, VS Code, opencode…) — une
    entrée par famille, sur le transport demandé. Le jeton n'est jamais inclus
    ici : l'hôte ne renvoie pas son propre secret."""
    transport = (transport or "http").strip().lower()
    if transport in ("streamable-http", "streamable_http", "remote"):
        transport = "http"
    servers: Dict[str, Any] = {}
    for fam, eps in endpoints_view(tc, base_url).items():
        name = f"{prefix}{fam.replace('_', '-')}"
        if transport == "stdio":
            st = eps["stdio"]
            servers[name] = {"type": "stdio", "command": st["command"],
                             "args": list(st["args"]),
                             "env": {"LOCAL_MCP_TRANSPORT": "stdio"}}
        elif eps.get(transport):
            servers[name] = {"type": transport, "url": eps[transport],
                             "headers": {"Authorization": "Bearer <jeton de service>"}}
    return {"mcpServers": servers}


def build_app(tc: Optional[ToolhostConfig] = None):
    tc = tc or load_config()
    apply_environment(tc)
    for w in tc.warnings:
        logger.warning("[toolhost] %s", w)

    # Base LOCALE de l'hôte (sessions de terminal, AX, audit) — jamais app.db
    # quand ``db_path`` est posé (toolhost.json) ; en mode local (aucun fichier)
    # l'hôte partage la base de la machine comme le service MCP historique.
    from shared_infra.db._connection import init_db
    try:
        init_db()
    except Exception as e:                                        # noqa: BLE001
        logger.warning("[toolhost] init_db : %r", e)

    import server.local_mcp_server as S
    S.SANDBOX_ROOT.mkdir(parents=True, exist_ok=True)
    S.register_all_tools(families=list(tc.families))
    try:
        from shared_infra.memory.ax import init_db as _init_ax_db
        _init_ax_db()
    except Exception as e:                                        # noqa: BLE001
        logger.warning("[toolhost] ax init_db : %r", e)

    from toolhost.auth import ToolhostAuthASGI

    # Les DEUX transports réseau, sur le même serveur d'outils. La portée par
    # famille est posée PLUS HAUT (middleware de l'app), pour couvrir les deux
    # bases d'un seul geste.
    mcp_app = S.mcp.http_app(path=S.HTTP_MOUNT_PATH, transport="http")
    sse_app = (S.mcp.http_app(path=S.SSE_MOUNT_PATH, transport="sse")
               if "sse" in tc.transports else None)

    async def _sweep_loop():
        """Entretien des sandboxes SERVIES PAR CET HÔTE (2026-09-17).

        Le balayage des tmp d'upload abandonnés (``*.elpis-upload.part`` de plus
        de 24 h) vivait uniquement dans l'entretien quotidien de l'app. Quand
        les sandboxes sont sur un hôte d'outils DISTANT, l'app ne voit pas ces
        fichiers : ils restaient à vie, comptés dans le quota et invisibles dans
        l'explorateur (« quota dépassé » sans fichier à supprimer). L'hôte fait
        donc son propre ménage. Best-effort, jamais bloquant.
        """
        import asyncio as _a
        from shared_infra.ops.maintenance import _sweep_orphan_part_files
        while True:
            try:
                n = await _a.to_thread(_sweep_orphan_part_files)
                if n:
                    logger.info("[toolhost] %d tmp d'upload abandonnés supprimés", n)
            except Exception:                                    # noqa: BLE001
                logger.debug("[toolhost] balayage des tmp d'upload échoué", exc_info=True)
            await _a.sleep(6 * 3600)

    @contextlib.asynccontextmanager
    async def _lifespan(app):
        # ``FastMCP._lifespan_manager`` est compté par référence : entrer les
        # deux cycles de vie n'exécute qu'une fois le démarrage du serveur.
        import asyncio as _a
        async with contextlib.AsyncExitStack() as stack:
            await stack.enter_async_context(mcp_app.lifespan(app))
            if sse_app is not None:
                await stack.enter_async_context(sse_app.lifespan(app))
            _sweeper = _a.create_task(_sweep_loop())
            try:
                yield
            finally:
                _sweeper.cancel()
                with contextlib.suppress(BaseException):
                    await _sweeper

    _import_route_modules()
    app = FastAPI(title="Elpis tool host", lifespan=_lifespan, docs_url=None, redoc_url=None)
    # Ordre des couches (la DERNIÈRE ajoutée est la plus EXTERNE) :
    #   auth → portée par famille → aiguillage de transport → routeur.
    # L'authentification voit donc le chemin d'origine (``/mcp/git``), et
    # l'aiguillage le chemin déjà réécrit (``/mcp``, ``/sse``).
    app.add_middleware(TransportSplitASGI, sse_app=sse_app)
    app.add_middleware(S.FamilyScopeASGI, bases=(S.HTTP_MOUNT_PATH, S.SSE_MOUNT_PATH))
    app.add_middleware(ToolhostAuthASGI, token=tc.token, max_skew_s=tc.identity_max_skew_s,
                       mcp_prefixes=(S.HTTP_MOUNT_PATH,) + SSE_PREFIXES)
    for r in served_routes():
        app.router.routes.append(r)

    @app.get("/health")
    def health():
        fams = _families_live()
        return {"ok": True, "service": "elpis-toolhost", "uptime_s": round(time.time() - _STARTED_AT, 1),
                "families": fams, "tools": len(S.TOOL_FAMILY_OF),
                "mcp_path": S.HTTP_MOUNT_PATH,
                "sse_path": (S.SSE_MOUNT_PATH if sse_app is not None else ""),
                "transports": list(tc.transports),
                "auth": bool(tc.token)}

    @app.get("/manifest")
    def manifest(request: Request, transport: str = "http", base_url: str = ""):
        # derrière ToolhostAuthASGI (jeton + identité)
        by_fam: Dict[str, int] = {}
        for _n, f in S.TOOL_FAMILY_OF.items():
            by_fam[f] = by_fam.get(f, 0) + 1
        return {"ok": True, "config": tc.public_dict(), "families": by_fam,
                "served_prefixes": list(SERVED_PREFIXES),
                "mcp_path": S.HTTP_MOUNT_PATH,
                "sse_path": (S.SSE_MOUNT_PATH if sse_app is not None else ""),
                "transports": list(tc.transports),
                "endpoints": endpoints_view(tc, base_url),
                **export_mcp_servers(tc, transport=transport, base_url=base_url)}

    # Le service MCP en dernier : ``Mount("/")`` attrape ce qui n'est pas une
    # route de l'API sandbox (``/mcp``, ``/mcp/<famille>``).
    app.mount("/", mcp_app)
    app.state.toolhost_config = tc
    app.state.sse_app = sse_app
    return app
