# SPDX-License-Identifier: MIT
"""
shared_infra.mcp.panel — Custom MCP servers management & pool control.

Endpoints
---------
Custom server CRUD (any authenticated user)
- GET    /api/mcp/custom-servers          — list installed custom servers
- POST   /api/mcp/upload                  — upload a folder as a new server
- DELETE /api/mcp/custom-servers/{name}   — remove a server folder

Category discovery (any authenticated user)
- GET    /api/mcp/categories              — auto-discovered categories
                                             (used by the chat side panel
                                             to render dynamic toggles)

Shared MCP library (read: any authenticated user — write: admin)
- GET    /api/mcp/shared-servers          — the library published by the admin
- POST   /api/mcp/shared-servers          — publish one (admin)
- PUT    /api/mcp/shared-servers/{id}     — edit one (admin)
- DELETE /api/mcp/shared-servers/{id}     — unpublish one (admin)
  Auth secrets are encrypted at rest and NEVER serialized back to the browser;
  the full config is resolved server-side at chat time.

Module-level helpers
--------------------
- ``_detect_mcp_command(folder)`` — heuristic that infers the shell command
  needed to launch a freshly-uploaded MCP server (npm start, python entry,
  start.sh, etc.). Used by the ``upload`` and ``list`` endpoints.
- ``prewarm_mcp_pool()`` — coroutine called from the FastAPI lifespan to
  pre-spawn the local MCP subprocess at app startup. Uses a process-wide
  flock so only ONE gunicorn worker actually pre-warms (others lazy-spawn
  on first chat).
- ``shutdown_mcp_pool()`` — coroutine called from the FastAPI lifespan to
  cleanly close the pool *and* the shared LLM HTTP client at app shutdown.

Removed (was here previously, now intentionally absent)
-------------------------------------------------------
The admin-side per-tool hide and per-category visibility management
(``hidden_tools.json`` + ``mcp_categories_overrides.json``) was removed
because the operator preferred a simpler workflow:

  • To remove a tool category from the user UI: comment out its
    ``register_*_tools(mcp, ...)`` line in ``local_mcp_server.py`` and
    restart. The MCP subprocess no longer registers those tools, so
    they don't appear in ``list_tools`` and the category drops out of
    ``/api/mcp/categories`` on the next AST scan.

  • To add a new category: drop a ``tools/foo_tools.py`` with a
    ``CATEGORY = {…}`` literal, register it in ``local_mcp_server.py``,
    restart. AST-discovery picks it up automatically.

This keeps the user-facing dynamic registration but removes the admin
tab and its associated state files entirely.
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import time
import zipfile  # noqa: F401 — kept here for backup symmetry; see _legacy
from pathlib import Path
from typing import List

from fastapi import File, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse

from shared_infra.config import MCP_SERVERS_DIR
from shared_infra.mcp import servers as _mcp_shared
from shared_infra.accounts.users import get_user_by_id
from shared_infra.security.deps import require_user_id
from shared_infra.security.encryption import EncryptionUnavailable
from shared_infra.routes._helpers import _path_inside
from llm_core._mcp_pool import mcp_pool
from llm_core._mcp_wrappers import _resolve_mcp_client
from llm_core import _mcp_categories as _mcp_cats
from shared_infra.routes._state import router
# Admin-only endpoints live on the admin router so they only mount on the
# admin process (APP_MODE=admin / full).
from shared_infra.routes.admin._state import admin_router

# ``_require_admin`` is defined in ``_legacy`` and re-exported by the package
# façade. Kept on the admin handlers as defense-in-depth
# (in APP_MODE=full, admin_router is mounted on the same port as router).
from shared_infra.routes._legacy import _require_admin


_LOCAL_MCP_CFG = {
    "type": "stdio",
    "name": "Outils Locaux (admin scan)",
    "command": "DEFAULT_LOCAL_PYTHON",
}


def _builtin_prewarm_cfgs():
    """Les configs à pré-chauffer : UNE par entrée intégrée du manifeste
    (2026-09-12 — une famille = une entrée = un endpoint). Pré-chauffer la
    seule sentinelle nue ne remplirait plus que la première famille, et le
    registre de catégories partagé serait amputé du reste."""
    try:
        from shared_infra.mcp.manifest import builtin_client_cfgs
        cfgs = builtin_client_cfgs(None)
    except Exception:                                            # noqa: BLE001
        cfgs = []
    return cfgs or [dict(_LOCAL_MCP_CFG)]


# ─────────────────────────────────────────────────────────────────────────────
#  HELPERS
# ─────────────────────────────────────────────────────────────────────────────
def _detect_mcp_command(folder_path: Path) -> str:
    """Infer how to launch the server in ``folder_path``.

    Order of probes:
        1. ``package.json`` with a ``scripts.start`` → ``npm start``
        2. A literal ``start`` / ``start.txt`` / ``start.sh`` / ``start.bat``
           file: read its first non-comment line verbatim
        3. A conventional entry point (``main.py``, ``server.py``,
           ``__main__.py``, ``index.js``, ``server.js``, ``app.py``,
           ``app.js``) → ``python <rel>`` or ``node <rel>``

    Returns ``""`` if nothing matches — the UI then asks the operator to
    type the command by hand.
    """
    pkg_json = folder_path / "package.json"
    if pkg_json.exists():
        try:
            data = json.loads(pkg_json.read_text(encoding="utf-8"))
            if "scripts" in data and "start" in data["scripts"]:
                return "npm start"
        except Exception:
            pass

    for root, _, files in os.walk(folder_path):
        files_lower = {f.lower(): f for f in files}
        for fname in ["start", "start.txt", "start.sh", "start.bat"]:
            if fname in files_lower:
                fpath = Path(root) / files_lower[fname]
                try:
                    raw = fpath.read_bytes()
                    content = raw.decode("utf-8-sig") if raw.startswith(b'\xef\xbb\xbf') else raw.decode("utf-8", errors="ignore")
                    for line in content.splitlines():
                        line = line.strip()
                        if line and not line.startswith("#"):
                            return line
                except Exception:
                    pass

    for root, _, files in os.walk(folder_path):
        files_lower = {f.lower(): f for f in files}
        for script_name in ["main.py", "server.py", "__main__.py", "index.js", "server.js", "app.py", "app.js"]:
            if script_name in files_lower:
                fpath = Path(root) / files_lower[script_name]
                if "node_modules" in fpath.parts:
                    continue
                try:
                    rel_path = fpath.relative_to(folder_path).as_posix()
                    if script_name.endswith('.py'):
                        return f"python {rel_path}"
                    elif script_name.endswith('.js'):
                        return f"node {rel_path}"
                except ValueError:
                    pass
    return ""


# ─────────────────────────────────────────────────────────────────────────────
#  CUSTOM SERVERS
# ─────────────────────────────────────────────────────────────────────────────
@router.get("/api/mcp/custom-servers")
def api_list_custom_mcp_servers(request: Request):
    require_user_id(request)
    items = []
    if MCP_SERVERS_DIR.exists():
        for entry in os.scandir(MCP_SERVERS_DIR):
            if entry.is_dir():
                cmd = _detect_mcp_command(Path(entry.path))
                items.append({"name": entry.name, "path": entry.path, "suggested_cmd": cmd})
    return {"servers": items, "root_path": str(MCP_SERVERS_DIR)}


@router.post("/api/mcp/upload")
async def api_upload_mcp_server(
    request: Request,
    files: List[UploadFile] = File(...),
    paths: List[str] = Form(...)
):
    # SECURITY FIX #J (P0) — l'upload de serveurs MCP est désormais
    # réservé aux administrateurs. Les fichiers déposés dans
    # ``MCP_SERVERS_DIR`` sont chargés et exécutés en tant que
    # serveurs MCP par le pool (cf. backend.services._mcp_pool). Permettre
    # à n'importe quel user authentifié d'uploader revenait à offrir une
    # primitive d'exécution de code arbitraire à tous les comptes. Les
    # users non-admins gardent l'accès à /api/mcp/custom-servers (GET)
    # pour choisir et activer un serveur de la liste existante.
    _require_admin(request)

    if not files or not paths or len(files) != len(paths):
        raise HTTPException(400, "Données invalides")

    first_p = Path(paths[0])
    folder_name = first_p.parts[0] if len(first_p.parts) > 1 else "mcp_server"
    folder_name = "".join([c for c in folder_name if c.isalnum() or c in ('-', '_')])
    if not folder_name:
        folder_name = f"mcp_{int(time.time())}"

    target_dir = MCP_SERVERS_DIR / folder_name
    if target_dir.exists():
        folder_name = f"{folder_name}_{int(time.time())}"
        target_dir = MCP_SERVERS_DIR / folder_name

    # SECURITY FIX #J (P0) — Path traversal :
    # Avant ce fix, ``rel_path = Path(*p.parts[1:])`` construisait un
    # chemin relatif SANS aucune validation. Un client envoyant
    # ``paths=["foo/../../../etc/cron.d/x"]`` produisait un
    # ``final_path`` résolu en dehors de ``target_dir`` — écriture
    # arbitraire sur le filesystem avec les droits du process gunicorn.
    #
    # Maintenant : on résout chaque ``final_path`` puis on vérifie via
    # ``_path_inside`` qu'il reste sous ``target_dir`` résolu. Tout
    # path échappant déclenche un 403 et un cleanup complet du dossier
    # (on ne livre PAS un upload partiel — un serveur MCP corrompu
    # casserait le pool au prochain démarrage).
    target_dir_resolved = target_dir.resolve()

    from shared_infra.files.uploads import read_upload_bounded
    from shared_infra.config import MAX_UPLOAD_BYTES
    try:
        target_dir.mkdir(parents=True, exist_ok=True)
        for file, path_str in zip(files, paths):
            p = Path(path_str)
            if p.is_absolute():
                raise HTTPException(403, "Chemin absolu refusé")
            rel_path = Path(*p.parts[1:]) if len(p.parts) > 1 else Path(p.parts[0])
            if not str(rel_path) or str(rel_path) == ".":
                continue
            if ".." in rel_path.parts:
                raise HTTPException(403, "Composant '..' refusé dans le chemin")

            final_path = (target_dir / rel_path).resolve()
            if not _path_inside(final_path, target_dir_resolved):
                raise HTTPException(403, f"Chemin hors du dossier MCP: {rel_path}")
            final_path.parent.mkdir(parents=True, exist_ok=True)
            content = await read_upload_bounded(file, MAX_UPLOAD_BYTES)
            await asyncio.to_thread(final_path.write_bytes, content)

        detected_cmd = _detect_mcp_command(target_dir)
        return {"ok": True, "server_name": folder_name, "path": str(target_dir), "suggested_cmd": detected_cmd}
    except HTTPException:
        if target_dir.exists():
            try:
                await asyncio.to_thread(shutil.rmtree, target_dir)
            except Exception:
                pass
        raise
    except Exception as e:
        if target_dir.exists():
            try:
                await asyncio.to_thread(shutil.rmtree, target_dir)
            except Exception:
                pass
        raise HTTPException(500, str(e))


@router.delete("/api/mcp/custom-servers/{name}")
def api_delete_custom_mcp_server(name: str, request: Request):
    # SECURITY FIX #J (P1) — La suppression d'un serveur MCP est aussi
    # privilégiée : elle impacte tous les users qui l'avaient activé
    # via /api/settings. Permettre à n'importe quel user d'en supprimer
    # un est trivialement abusé (vandalisme inter-comptes). Alignement
    # avec l'upload : admin-only.
    _require_admin(request)
    # SECURITY FIX #J — Path resolution robuste : l'ancien check
    # ``".." in name or "/" in name`` ratait les encodages alternatifs
    # (\\, %2e%2e, …). On vérifie via _path_inside.
    if not name or any(ch in name for ch in ("..", "/", "\\", "\x00")):
        raise HTTPException(400, "Nom invalide")
    try:
        base = MCP_SERVERS_DIR.resolve()
        target = (MCP_SERVERS_DIR / name).resolve()
    except (OSError, RuntimeError):
        raise HTTPException(400, "Nom invalide")
    if not _path_inside(target, base) or target == base:
        raise HTTPException(400, "Nom invalide")
    if not target.exists():
        raise HTTPException(404, "Serveur introuvable")
    try:
        shutil.rmtree(target)
        return {"ok": True}
    except Exception as e:
        raise HTTPException(500, f"Erreur suppression: {str(e)}")


# ─────────────────────────────────────────────────────────────────────────────
#  CATEGORY DISCOVERY (public)
# ─────────────────────────────────────────────────────────────────────────────
@router.get("/api/mcp/categories")
def api_mcp_categories(request: Request):
    """List the user-facing MCP tool categories.

    Public to authenticated users — the chat side panel calls this on
    every panel-open to render its dynamic toggle list.

    Source: the LIVE registry — each tool carries its category in the MCP
    protocol (``tags`` + ``meta``), ingested by the pool at every connection
    and shared between workers through the on-disk cache. No hand-maintained
    allow-list, and no side-car manifest any more (the old
    ``tools/.tool_manifest.json`` path is gone) — see
    ``llm_core._mcp_categories``. A worker that has not connected the pool
    yet falls back to that cache, then to the static display metadata.

    Hidden categories (``hidden: true`` in their descriptor — e.g. the
    ``task`` category holding ``todowrite``) are EXCLUDED here: they are
    model-side aids, never user-facing. ``get_categories()`` filters them
    out by default.

    (2026-09-12) La liste ``tools`` de chaque catégorie n'est plus retirée :
    le panneau coche les outils UN PAR UN. Chaque entrée porte son nom, son
    titre lisible et sa description courte (déjà bornée à 220 caractères par le
    registre) — de quoi rendre une case à cocher sans second aller-retour.
    Poids : ~12 Ko pour 56 outils, chargés UNE fois au montage.
    """
    require_user_id(request)
    cats = _mcp_cats.get_categories()  # include_hidden=False by default
    out = []
    for c in cats:
        d = {k: v for k, v in c.items() if k != "tools"}
        d["tools"] = [_mcp_cats.tool_info(n) for n in (c.get("tools") or [])]
        out.append(d)
    return {"ok": True, "categories": out}


# ─────────────────────────────────────────────────────────────────────────────
#  MANIFESTE mcp.json (2026-09-11)
# ─────────────────────────────────────────────────────────────────────────────
@router.get("/api/mcp/manifest-servers")
def api_mcp_manifest_servers(request: Request):
    """Serveurs EXTERNES déclarés dans ``mcp.json`` (activés), tels que le
    panneau d'outils les propose : nom, description, pré-coché par défaut.
    Ni URL ni en-têtes : le navigateur ne renvoie que le NOM, le serveur
    résout (``resolve_external_cfg``)."""
    require_user_id(request)
    from shared_infra.mcp import manifest as _mf
    m = _mf.load()
    return {"ok": True, "servers": [
        {"name": e.name, "description": e.description, "type": e.type,
         "default_on": bool(e.default_on_self)}
        for e in m.externals()
    ]}


@admin_router.get("/api/admin/mcp/manifest")
def api_admin_mcp_manifest(request: Request):
    """Vue d'administration du manifeste : entrées, rôles, familles, état de
    joignabilité (sonde TCP brève sur les URL réseau), avertissements et
    erreurs de schéma. Jetons masqués."""
    _require_admin(request)
    from shared_infra.mcp import manifest as _mf
    from llm_core._mcp_wrappers import _shared_service_reachable
    m = _mf.load()
    view = m.to_public_dict()
    for row in view["servers"]:
        row["reachable"] = (_shared_service_reachable(row["url"], timeout=0.4)
                            if row.get("url") and row["type"] in ("http", "sse") else None)
    try:
        live = _mcp_cats.get_tool_categories_dict()
        view["live_categories"] = {k: len(v) for k, v in live.items() if v}
    except Exception:
        view["live_categories"] = {}
    view["manifest_path"] = str(_mf.manifest_path())
    view["schema_path"] = str(_mf.schema_path())
    return {"ok": True, "manifest": view}


@admin_router.get("/api/admin/mcp/manifest/export")
def api_admin_mcp_manifest_export(request: Request, transport: str = "http",
                                  base_url: str = "", scope: str = "toolhost",
                                  with_token: int = 0, prefix: str = ""):
    """Bloc ``mcpServers`` PRÊT À COLLER dans un autre applicatif (Claude
    Desktop, Cursor, LibreChat, VS Code, opencode…).

    Une entrée par famille, sur le transport demandé (``http``, ``sse``,
    ``stdio``). ``scope=all`` ajoute les familles liées au compte : leurs outils
    écrivent dans la base de l'app, donc ils ne sont joignables par un tiers que
    si l'hôte d'outils tourne sur la même machine qu'elle. Le jeton de service
    n'est inséré que sur demande explicite (``with_token=1``)."""
    _require_admin(request)
    from shared_infra.mcp import manifest as _mf
    m = _mf.load()
    entries = m.toolhosts() if str(scope) != "all" else m.builtins()
    base = str(base_url or "").strip() or m.host_base_url()
    token = m.host_token() if int(with_token or 0) else ""
    doc = _mf.export_servers(entries, base_url=base, transport=str(transport),
                             token=token, prefix=str(prefix or ""))
    return {"ok": True, "transport": str(transport), "base_url": base,
            "with_token": bool(token), **doc}


@admin_router.post("/api/admin/mcp/manifest/reload")
async def api_admin_mcp_manifest_reload(request: Request):
    """Relecture forcée de ``mcp.json`` + invalidation du pool d'outils (les
    prochaines connexions repartent des nouvelles entrées). Sans redémarrage."""
    _require_admin(request)
    from shared_infra.mcp import manifest as _mf
    m = _mf.reload()
    try:
        await mcp_pool.close_all()
    except Exception:
        pass
    return {"ok": True, "source": m.source, "errors": list(m.errors),
            "warnings": list(m.warnings), "servers": list(m.servers)}


# ─────────────────────────────────────────────────────────────────────────────
#  BIBLIOTHÈQUE MCP PARTAGÉE (lecture publique / écriture admin)
# ─────────────────────────────────────────────────────────────────────────────
#
# ``settings.mcp_servers`` reste la liste PERSO de chaque compte. Ici vit la
# liste COMMUNE : l'admin publie une fois, tous les comptes la voient et
# choisissent lesquels afficher (``settings.shared_mcp_visible``, vide par
# défaut ⇒ rien n'apparaît sans geste explicite).
#
# Le secret d'auth ne sort JAMAIS : les réponses ci-dessous portent ``has_auth``,
# et la config complète (URL + en-tête) est reconstruite côté serveur au moment
# du tour de chat (``mcp_servers.resolve_many``, appelé par routes/chats.py).

def _shared_payload(data: dict) -> dict:
    """Valide/normalise le corps d'un POST/PUT de serveur partagé."""
    name = str(data.get("name") or "").strip()[:120]
    stype = str(data.get("type") or "sse").strip().lower()
    if stype not in _mcp_shared.SERVER_TYPES:
        raise HTTPException(400, "type doit être 'sse', 'http' ou 'stdio'")
    url = str(data.get("url") or "").strip()[:2000]
    command = str(data.get("command") or "").strip()[:2000]
    if stype in _mcp_shared.HTTP_TYPES and not url:
        raise HTTPException(400, "URL requise pour un serveur SSE/HTTP")
    if stype == "stdio" and not command:
        raise HTTPException(400, "Commande requise pour un serveur stdio")
    mode = str(data.get("auth_mode") or "").strip().lower()
    if mode not in _mcp_shared.AUTH_MODES:
        raise HTTPException(
            400, "auth_mode doit être '', 'basic', 'bearer', 'raw' ou 'header'")
    auth_user = str(data.get("auth_user") or "").strip()[:200]
    if mode == "header":
        # Le nom de l'en-tête EST la moitié du créneau : un nom invalide ferait
        # lever httpx AVANT tout envoi. Ici on peut répondre 400 (contrairement
        # à la fusion perso, qui ne doit jamais rejeter un blob de réglages).
        auth_user = auth_user or _mcp_shared.DEFAULT_HEADER_NAME
        if not _mcp_shared.header_name_ok(auth_user):
            raise HTTPException(400, f"Nom d'en-tête invalide : {auth_user}")

    # Créneaux supplémentaires. Cumulables avec le mode d'auth : un service
    # peut demander un jeton de transport ET une clé applicative.
    try:
        headers = _mcp_shared.sanitize_pairs(
            data.get("headers"), kind="headers", strict=True)
        env = _mcp_shared.sanitize_pairs(
            data.get("env"), kind="env", strict=True)
    except _mcp_shared.InvalidPair as e:
        raise HTTPException(400, f"Nom refusé (réservé ou mal formé) : {e}")

    return {
        "name": name,
        "type": stype,
        "url": url,
        "command": command,
        "auth_mode": mode,
        "auth_user": auth_user,
        "auth_secret": str(data.get("auth_secret") or ""),
        "headers": headers,
        "env": env,
        "enabled": bool(data.get("enabled", True)),
    }


@router.get("/api/mcp/shared-servers")
def api_list_shared_mcp_servers(request: Request):
    """Bibliothèque publiée — lisible par TOUT compte authentifié.

    C'est ce qui manquait : un serveur enregistré côté admin n'apparaissait
    nulle part chez les autres, qui devaient le re-saisir (URL + token compris).
    """
    uid = require_user_id(request)
    # Vue d'ADMIN (champs d'édition + entrées désactivées) seulement pour un
    # admin : un compte ordinaire n'a besoin que du nom et du type pour cocher
    # l'œil. Cf. mcp_servers._USER_COLS.
    # ``== 1`` : un modérateur (2) n'est pas admin (audit 2026-09-22, M1) — il
    # recevait les champs d'édition (URL, en-têtes) et le bouton publier.
    me = get_user_by_id(uid)
    is_admin = bool(me and me["is_admin"] == 1)
    return {"ok": True, "servers": _mcp_shared.list_shared(admin=is_admin),
            "can_publish": is_admin}


@router.post("/api/mcp/shared-servers")
async def api_create_shared_mcp_server(request: Request):
    _require_admin(request)
    data = await request.json()
    if not isinstance(data, dict):
        raise HTTPException(400, "Le payload doit être un objet JSON.")
    p = _shared_payload(data)
    if not p["name"]:
        raise HTTPException(400, "Nom requis")
    try:
        new_id = _mcp_shared.create_shared(**p)
    except EncryptionUnavailable:
        raise HTTPException(
            503, "Clé de chiffrement indisponible : impossible d'enregistrer "
                 "un identifiant. Configurez APP_ENCRYPTION_KEY.")
    return {"ok": True, "server": _mcp_shared.get_shared(new_id, admin=True)}


@router.put("/api/mcp/shared-servers/{server_id}")
async def api_update_shared_mcp_server(server_id: str, request: Request):
    _require_admin(request)
    rid = _mcp_shared.shared_id(server_id)
    if rid is None:
        raise HTTPException(400, "Identifiant invalide")
    data = await request.json()
    if not isinstance(data, dict):
        raise HTTPException(400, "Le payload doit être un objet JSON.")
    p = _shared_payload(data)
    if not p["name"]:
        raise HTTPException(400, "Nom requis")
    try:
        ok = _mcp_shared.update_shared(rid, **p)
    except EncryptionUnavailable:
        raise HTTPException(
            503, "Clé de chiffrement indisponible : impossible d'enregistrer "
                 "un identifiant. Configurez APP_ENCRYPTION_KEY.")
    if not ok:
        raise HTTPException(404, "Serveur introuvable")
    return {"ok": True, "server": _mcp_shared.get_shared(rid, admin=True)}


# ── Bouton « Tester » ────────────────────────────────────────────────────────
# ``_friendly_mcp_error`` vit désormais dans ``llm_core._mcp_wrappers`` : la
# boucle de chat en a besoin elle aussi (elle affichait la trace brute du task
# group au lieu de « HTTP 401 »), et elle ne peut pas importer une route.
# Ré-exporté ici sous son nom historique.
from llm_core._mcp_wrappers import (  # noqa: E402
    friendly_mcp_error as _friendly_mcp_error,
)


async def _probe_mcp(cfg: dict) -> dict:
    """Ouvre une connexion JETABLE et liste les outils.

    Hors pool volontairement : un essai raté ne doit pas laisser d'entrée
    boiteuse derrière lui, ni un essai réussi masquer un vrai problème au
    tour de chat suivant.
    """
    client = _resolve_mcp_client(cfg)
    if client is None:
        return {"ok": False, "error": "Configuration incomplète (type ou URL/commande)."}

    async def _run():
        async with client as sess:
            return [getattr(t, "name", "?") for t in await sess.list_tools()]

    t0 = time.time()
    try:
        names = await asyncio.wait_for(_run(), timeout=20)
    except asyncio.TimeoutError:
        return {"ok": False, "error": "Délai dépassé (20 s) : serveur injoignable ?"}
    except BaseException as e:                      # noqa: BLE001 — cf. _friendly
        return {"ok": False, "error": _friendly_mcp_error(e)}
    return {"ok": True, "tools": names, "ms": round((time.time() - t0) * 1000)}


@router.post("/api/mcp/test")
async def api_test_mcp_server(request: Request):
    """Éprouve une config MCP telle qu'elle est saisie dans le formulaire.

    Secret laissé vide = celui DÉJÀ stocké (même contrat que l'enregistrement) :
    on peut donc tester une entrée existante sans re-saisir le jeton.

    Droits : calqués sur ceux de l'enregistrement — publier/éditer un serveur
    PARTAGÉ reste réservé à l'admin, un serveur PERSO reste ouvert à son
    propriétaire. L'essai n'ouvre donc aucune connexion qu'enregistrer puis
    lancer un tour de chat n'aurait pas ouverte.
    """
    uid = require_user_id(request)
    data = await request.json()
    if not isinstance(data, dict):
        raise HTTPException(400, "Le payload doit être un objet JSON.")

    rid = _mcp_shared.shared_id(data.get("id"))
    is_shared = rid is not None or bool(data.get("shared"))

    if is_shared:
        _require_admin(request)
        _allow_stdio = True            # administrateur plein (``_require_admin``)
        p = _shared_payload(data)
        stored = _mcp_shared.raw_shared(rid) if rid is not None else None
        old = [{**stored, "id": "t"}] if stored else []
        draft = {**p, "id": "t"}
    else:
        from shared_infra.accounts.users import get_user_settings
        settings = get_user_settings(uid) or {}
        sid = str(data.get("id") or "")
        stored = next((s for s in (settings.get("mcp_servers") or [])
                       if isinstance(s, dict) and str(s.get("id")) == sid), None)
        old = [{**stored, "id": "t"}] if stored else []
        draft = {**data, "id": "t"}
        # Éprouver un ``stdio`` = exécuter sa commande sur l'hôte : même
        # règle qu'à l'enregistrement, administrateur plein seulement.
        _me = get_user_by_id(uid)
        _allow_stdio = bool(_me and _me["is_admin"] == 1)
        if str(draft.get("type") or "").strip().lower() == "stdio":
            if not _allow_stdio:
                raise HTTPException(
                    403, "Serveur MCP « Local » (commande exécutée sur le "
                         "serveur) réservé aux administrateurs.")

    try:
        merged = _mcp_shared.merge_personal_mcp(old, [draft], allow_stdio=_allow_stdio)
    except _mcp_shared.StdioNotAllowed as exc:
        raise HTTPException(403, str(exc))
    except EncryptionUnavailable:
        raise HTTPException(
            503, "Clé de chiffrement indisponible : impossible d'éprouver un "
                 "identifiant. Configurez APP_ENCRYPTION_KEY.")
    if not merged:
        raise HTTPException(400, "Configuration vide")
    return JSONResponse(await _probe_mcp(
        _mcp_shared.personal_to_config(merged[0], allow_stdio=_allow_stdio)))


@router.delete("/api/mcp/shared-servers/{server_id}")
def api_delete_shared_mcp_server(server_id: str, request: Request):
    _require_admin(request)
    rid = _mcp_shared.shared_id(server_id)
    if rid is None:
        raise HTTPException(400, "Identifiant invalide")
    if not _mcp_shared.delete_shared(rid):
        raise HTTPException(404, "Serveur introuvable")
    return {"ok": True}


# ─────────────────────────────────────────────────────────────────────────────
#  LIFESPAN HOOKS
# ─────────────────────────────────────────────────────────────────────────────

# File-lock used by ``prewarm_mcp_pool`` to SERIALIZE the local-MCP spawn
# across gunicorn workers (anti-stampede at boot).
#
# AUDIT 2026-08-02 (W12) — le fd était gardé À VIE par le premier worker :
# un worker recyclé (max_requests) trouvait le verrou tenu par un worker
# vivant et ne pré-chauffait JAMAIS → chaque « premier message » servi par
# un worker recyclé payait le spawn subprocess + handshake + list_tools
# (~300-800 ms), sans cause visible. Or les pools MCP sont PER-PROCESS :
# le pré-chauffage d'un worker ne sert à rien aux autres — un verrou
# « un seul pré-chauffeur pour toujours » laissait de toute façon N-1
# workers froids même au boot. Le verrou ne sert désormais qu'à SÉRIALISER
# (un spawn à la fois) : chaque worker attend son tour, pré-chauffe SON
# pool, puis RELÂCHE.
_PREWARM_LOCK_PATH = Path(os.environ.get(
    "MCP_PREWARM_LOCK_PATH",
    "/tmp/elpis_mcp_prewarm.lock",
))
_prewarm_lock_fd = None


async def _acquire_prewarm_lock(timeout_s: float = 120.0) -> bool:
    """Acquiert le flock de sérialisation (retries non-bloquants + sleep
    async — ne bloque jamais la boucle). True = acquis (ou plateforme sans
    fcntl) ; False = timeout. Le fd est stocké pour ``_release_prewarm_lock``.
    """
    global _prewarm_lock_fd
    try:
        import fcntl  # POSIX only
    except ImportError:
        return True

    try:
        _PREWARM_LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(str(_PREWARM_LOCK_PATH),
                     os.O_RDWR | os.O_CREAT, 0o644)
    except OSError:
        return True

    import time as _time
    deadline = _time.monotonic() + timeout_s
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except (BlockingIOError, OSError):
            if _time.monotonic() >= deadline:
                try:
                    os.close(fd)
                except OSError:
                    pass
                return False
            await asyncio.sleep(1.0)

    try:
        os.ftruncate(fd, 0)
        os.write(fd, f"{os.getpid()}\n".encode())
    except OSError:
        pass

    _prewarm_lock_fd = fd
    return True


def _release_prewarm_lock() -> None:
    """Relâche le flock de sérialisation (W12) — appelé en fin de prewarm."""
    global _prewarm_lock_fd
    fd = _prewarm_lock_fd
    _prewarm_lock_fd = None
    if fd is None:
        return
    try:
        import fcntl
        fcntl.flock(fd, fcntl.LOCK_UN)
    except Exception:
        pass
    try:
        os.close(fd)
    except OSError:
        pass


async def prewarm_mcp_pool() -> None:
    """Pre-spawn the local MCP server at app startup.

    Multi-worker coordination via flock: only one worker pre-warms.
    Opt-out: ``MCP_PREWARM=0`` env var.
    """
    import logging as _logging
    _log = _logging.getLogger("uvicorn.error")

    if os.environ.get("MCP_PREWARM", "1").strip().lower() in ("0", "false", "no", ""):
        _log.info("[STARTUP] MCP pre-warm disabled via MCP_PREWARM env var.")
        return

    if not await _acquire_prewarm_lock():
        _log.info(
            f"[STARTUP] MCP pre-warm skipped — timeout d'attente du verrou "
            f"({_PREWARM_LOCK_PATH}). "
            "This worker will lazy-spawn its own MCP on first chat."
        )
        return

    try:
        total, ok, failed = 0, 0, []
        for cfg in _builtin_prewarm_cfgs():
            name = str(cfg.get("name") or cfg.get("manifest") or "?")
            try:
                _client, tools = await mcp_pool.get_or_connect(
                    cfg, resolve_client_fn=_resolve_mcp_client,
                )
            except Exception as e:                               # noqa: BLE001
                # Une entrée injoignable ne doit pas priver le chat des autres :
                # chaque entrée est un serveur à part entière.
                failed.append(f"{name} ({e})")
                continue
            ok += 1
            total += len(tools)
        _log.info(
            f"[STARTUP] Local MCP pre-warmed (pid={os.getpid()}): "
            f"{ok} entry(ies), {total} tool(s) discovered, pool entries kept alive."
        )
        if failed:
            _log.warning("[STARTUP] entrées d'outils injoignables : %s", "; ".join(failed))
    except Exception as e:
        _log.warning(
            f"[STARTUP] Local MCP pre-warm failed: {e}. "
            "First chat will pay the cold-start cost."
        )
    finally:
        # AUDIT 2026-08-02 (W12) — relâcher le verrou : il ne sérialise que
        # le spawn, il n'élit plus un pré-chauffeur unique à vie.
        _release_prewarm_lock()


async def shutdown_mcp_pool():
    """Appeler au shutdown de l'application (dans le lifespan ou on_shutdown)."""
    await mcp_pool.close_all()
    from llm_core import close_llm_client
    await close_llm_client()
    # Client partagé pour les appels admin/monitoring (introduit avec le
    # /tokenize helper et le refacto de _llama_http). Fermé après le client
    # LLM pour que les éventuels logs de métriques de fermeture passent
    # encore par /metrics.
    try:
        from llm_core._llama_http import close_admin_client
        await close_admin_client()
    except Exception:
        pass
