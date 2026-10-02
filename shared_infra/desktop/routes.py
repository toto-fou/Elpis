# SPDX-License-Identifier: MIT
"""
shared_infra.desktop.routes — endpoints for the computer-use / Annotation
Studio feature.

  GET  /api/desktop/targets      list configured control targets (NO secrets)
  POST /api/desktop/capture      manual capture+annotate for the Studio button
  GET  /api/desktop/frame/{token} serve a saved frame PNG (ownership-scoped)

Frames are LOCAL files in ``DESKTOP_SCREENS_DIR`` written by the desktop tools /
the capture endpoint (shared /tmp). Unlike the Playwright route there is no
sidecar to proxy — we read the file directly. Ownership is soft (like the pw
route) so a cross-worker fetch still works (the file is on shared disk); a frame
is served repeatably and aged out by ``prune_frames`` rather than deleted on
first read, so the chat panel and the Studio can both display it.
"""
from __future__ import annotations

import logging
import os
import time

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse, Response
from starlette.concurrency import run_in_threadpool

import shared_infra.config as _cfg
from llm_core._desktop_session import (
    _TOKEN_RE,
    desktop_frame_path,
    get_desktop_frame_owner,
    register_desktop_frame_owner,
)
from shared_infra.routes._state import router
from shared_infra.security.deps import require_user_id

logger = logging.getLogger("uvicorn.error")


def _username_for(user_id) -> str:
    """Same soft lookup as routes/tools.py — must match ``get_username(ctx)``
    used by the chat loop so frame ownership compares equal."""
    try:
        from shared_infra.accounts.identity import resolve_username as _ident_name
        _n = _ident_name(user_id)
        if _n:
            return _n
        from shared_infra.accounts.users import get_username_by_id as _gub
        return _gub(user_id) or f"user_{user_id}"
    except Exception:
        return f"user_{user_id}"


def _frame_fields(res: dict, username: str, target: str) -> dict:
    """Champs de frame communs à toutes les réponses desktop (capture/act/launch/
    wait, et les avertissements ``type_no_effect``/``stale_frame``) : enregistre la
    propriété du token et renvoie l'URL + dimensions + signature. Évite la 6e copie
    du même bloc."""
    token = res.get("frame_token")
    if token:
        register_desktop_frame_owner(token, username)
    ts = int(time.time() * 1000)
    return {
        "image_url": f"/api/desktop/frame/{token}?t={ts}" if token else "",
        "img_w": res.get("img_w") or 0, "img_h": res.get("img_h") or 0,
        "target": res.get("target") or target, "sig": res.get("sig") or "", "ts": ts,
    }


@router.get("/api/desktop/targets")
async def api_desktop_targets(request: Request):
    """List the configured desktop/VM control targets for the Studio selector.
    Returns only name/os/default — never the agent URL or token."""
    user_id = require_user_id(request)
    try:
        _cfg.reload_desktop_config_from_disk()
    except Exception:
        pass
    from shared_infra.desktop.access import allowed_targets
    targets = allowed_targets(_cfg.get_desktop_targets(reload=False), _username_for(user_id))
    safe = [{"name": t["name"], "os": t.get("os", "linux"), "default": bool(t.get("default"))}
            for t in targets]
    return JSONResponse({"targets": safe, "count": len(safe)})


@router.get("/api/desktop/active-target")
async def api_desktop_active_target_get(request: Request):
    """Cible active choisie par l'utilisateur (sélecteur UI) ; '' si aucune."""
    user_id = require_user_id(request)
    from llm_core._desktop_session import get_active_target
    return JSONResponse({"target": get_active_target(_username_for(user_id))})


@router.post("/api/desktop/active-target")
async def api_desktop_active_target_set(request: Request):
    """Définit la cible active de l'utilisateur (chaîne vide = effacer). Valide
    que la cible existe dans le registre admin."""
    user_id = require_user_id(request)
    try:
        body = await request.json()
    except Exception:
        body = {}
    target = str(body.get("target") or "").strip() if isinstance(body, dict) else ""
    from shared_infra.desktop.access import allowed_targets
    if target and target not in {t["name"] for t in allowed_targets(
            _cfg.get_desktop_targets(), _username_for(user_id))}:
        raise HTTPException(400, f"cible inconnue : {target}")
    from llm_core._desktop_session import set_active_target
    set_active_target(_username_for(user_id), target)
    return JSONResponse({"ok": True, "target": target})


@router.get("/api/desktop/monitors")
async def api_desktop_monitors(request: Request, target: str = ""):
    """Liste les écrans de la cible + l'écran capturé courant (sélecteur Studio)."""
    user_id = require_user_id(request)
    username = _username_for(user_id)
    try:
        from llm_core.tools.desktop_tools import list_monitors_core
    except Exception as e:  # pragma: no cover
        raise HTTPException(500, f"desktop tools unavailable: {e}")
    res = await run_in_threadpool(list_monitors_core, username, target)
    if not isinstance(res, dict) or res.get("ok") is False:
        return JSONResponse(
            {"ok": False,
             "error": (res or {}).get("error", "monitors_failed") if isinstance(res, dict) else "monitors_failed",
             "message": (res or {}).get("message") if isinstance(res, dict) else None},
            status_code=400)
    return JSONResponse({"ok": True, "monitors": res.get("monitors") or [], "selected": res.get("selected", 1)})


@router.post("/api/desktop/select-monitor")
async def api_desktop_select_monitor(request: Request):
    """Choisit l'écran capturé/piloté sur la cible (0=tous, 1=primaire, N=écran N)."""
    user_id = require_user_id(request)
    username = _username_for(user_id)
    try:
        body = await request.json()
    except Exception:
        body = {}
    target = str(body.get("target") or "").strip() if isinstance(body, dict) else ""
    try:
        monitor = int(body.get("monitor", 1)) if isinstance(body, dict) else 1
    except (TypeError, ValueError):
        monitor = 1
    try:
        from llm_core.tools.desktop_tools import select_monitor_core
    except Exception as e:  # pragma: no cover
        raise HTTPException(500, f"desktop tools unavailable: {e}")
    res = await run_in_threadpool(select_monitor_core, username, target, monitor)
    if not isinstance(res, dict) or res.get("ok") is False:
        return JSONResponse(
            {"ok": False,
             "error": (res or {}).get("error", "select_failed") if isinstance(res, dict) else "select_failed"},
            status_code=400)
    return JSONResponse({"ok": True, "selected": res.get("selected", monitor)})


@router.post("/api/desktop/capture")
async def api_desktop_capture(request: Request):
    """Capture + annotate a target on demand (the Studio's "Capture & annotate"
    button). Returns the same shape as the ``annotation_frame`` SSE event."""
    user_id = require_user_id(request)
    username = _username_for(user_id)
    try:
        body = await request.json()
    except Exception:
        body = {}
    target = ""
    prompt = ""
    scope = ""
    raw = False
    use_vision = use_tree = True
    settle = False
    settle_timeout_ms = 4000
    if isinstance(body, dict):
        target = str(body.get("target") or "").strip()
        prompt = str(body.get("prompt") or "").strip()
        # ``raw`` = capture brute (sans modèle) : screenshot seul, 0 box, rapide.
        # ``use_vision``/``use_tree`` explicites priment sinon.
        raw = bool(body.get("raw"))
        # SEULE la VISION (modèle d'annotation) est gatée par « Brut » / sans-LLM.
        # L'arbre a11y/UIA est LOCAL, rapide et indépendant du modèle : on le
        # récupère TOUJOURS (sauf override explicite) → l'inspecteur d'éléments
        # (boxes cliquables) marche AUSSI en mode sans vision.
        use_vision = bool(body.get("use_vision", not raw))
        use_tree = bool(body.get("use_tree", True))
        # ``settle`` : attendre que l'écran se stabilise AVANT d'observer — sert à
        # l'enregistrement (après une action, laisser l'app finir d'ouvrir) pour
        # diffuser un état figé et calculer le diff « nouveaux éléments ».
        settle = bool(body.get("settle"))
        try:
            settle_timeout_ms = max(500, min(15000, int(body.get("settle_timeout_ms") or 4000)))
        except (TypeError, ValueError):
            settle_timeout_ms = 4000
        scope = str(body.get("scope") or "").strip().lower()

    # Le Studio est un outil d'annotation PLEIN ÉCRAN → défaut MONITOR (toutes les
    # fenêtres de l'écran capturé), surtout PAS le `focus` du chat (qui ne montre que
    # la fenêtre au 1er plan, ~9× moins d'éléments — d'où la « perte de précision »).
    # Le sélecteur de scope du Studio peut envoyer focus/desktop explicitement.
    if scope not in ("focus", "monitor", "desktop"):
        scope = "monitor"

    # Le Studio est un outil de DÉVELOPPEMENT : il doit descendre jusqu'aux
    # feuilles de ce que l'humain voit (le chat, lui, garde son plafond de tokens).
    # ``desktop.studio_max_nodes`` (défaut 2000) ; ``max_nodes`` explicite du corps
    # prime, borné.
    from shared_infra import config as _cfg
    max_nodes = int(getattr(_cfg, "DESKTOP_STUDIO_MAX_NODES", 2000) or 2000)
    if isinstance(body, dict) and body.get("max_nodes") is not None:
        try:
            max_nodes = max(100, min(5000, int(body.get("max_nodes"))))
        except (TypeError, ValueError):
            pass

    try:
        from llm_core.tools.desktop_tools import observe_core
    except Exception as e:  # pragma: no cover
        raise HTTPException(500, f"desktop tools unavailable: {e}")

    # observe_core is sync (requests + detection) → offload off the event loop.
    def _capture():
        if settle:
            try:
                from llm_core._desktop_replay import wait_stable
                wait_stable(username, target, timeout_ms=settle_timeout_ms)
            except Exception:
                pass
        return observe_core(username, target, prompt, use_vision=use_vision, use_tree=use_tree,
                            scope=scope, max_nodes=max_nodes)
    res = await run_in_threadpool(_capture)
    if not isinstance(res, dict) or res.get("ok") is False:
        logger.warning("[desktop_capture] échec user=%s target=%r → %s : %s",
                       username, target or "(défaut)",
                       (res or {}).get("error") if isinstance(res, dict) else "non_dict",
                       (res or {}).get("message") if isinstance(res, dict) else "")
        return JSONResponse(
            {"ok": False,
             "error": (res or {}).get("error", "capture_failed") if isinstance(res, dict) else "capture_failed",
             "message": (res or {}).get("message", "capture failed") if isinstance(res, dict) else "capture failed",
             "fix": (res or {}).get("fix") if isinstance(res, dict) else None},
            status_code=400,
        )

    token = res.get("frame_token")
    if token:
        register_desktop_frame_owner(token, username)
    ts = int(time.time() * 1000)
    return JSONResponse({
        "ok": True,
        "image_url": f"/api/desktop/frame/{token}?t={ts}" if token else "",
        "img_w": res.get("img_w") or 0,
        "img_h": res.get("img_h") or 0,
        "boxes": res.get("elements") or [],
        "target": res.get("target") or target,
        "sig": res.get("sig") or "",
        "ts": ts,
        "note": res.get("note"),
        "tree_nodes": res.get("tree_nodes") or 0,
        "tree_capped": bool(res.get("tree_capped")),
    })


@router.post("/api/desktop/read")
async def api_desktop_read(request: Request):
    """OCR à la demande (bouton « Lire » du Studio) : transcrit le texte
    visible sur la cible — ce que l'arbre d'accessibilité n'expose pas
    (journal, étiquettes canvas). `region`/`element_id`/`query` ciblent une
    zone ; sinon plein écran."""
    user_id = require_user_id(request)
    username = _username_for(user_id)
    try:
        body = await request.json()
    except Exception:
        body = {}
    target = query = element_id = ""
    region = None
    if isinstance(body, dict):
        target = str(body.get("target") or "").strip()
        query = str(body.get("query") or "").strip()
        element_id = str(body.get("element_id") or "").strip()
        if isinstance(body.get("region"), (list, tuple)) and len(body["region"]) >= 4:
            region = body["region"]

    try:
        from llm_core.tools.desktop_tools import read_text_core
    except Exception as e:  # pragma: no cover
        raise HTTPException(500, f"desktop tools unavailable: {e}")

    res = await run_in_threadpool(read_text_core, username, target, query, element_id, region)
    if not isinstance(res, dict) or res.get("ok") is False:
        return JSONResponse(
            {"ok": False,
             "error": (res or {}).get("error", "read_failed") if isinstance(res, dict) else "read_failed",
             "message": (res or {}).get("message", "read failed") if isinstance(res, dict) else "read failed",
             "fix": (res or {}).get("fix") if isinstance(res, dict) else None},
            status_code=400,
        )
    return JSONResponse({
        "ok": True,
        "text": res.get("text") or "",
        "region": res.get("region"),
        "box": res.get("box"),
        "chars": res.get("chars") or 0,
    })


@router.post("/api/desktop/act")
async def api_desktop_act(request: Request):
    """Direct action on a target (Studio click-to-act / replay). Same code path
    as the ``desktop_act`` tool (``act_core``) so chat-driven, direct-click and
    replayed actions are identical. Returns the post-action frame so the Studio
    refreshes the stage and the recorder can capture the step."""
    user_id = require_user_id(request)
    username = _username_for(user_id)
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    target = str(body.get("target") or "").strip()
    op = str(body.get("op") or "").strip()
    if not op:
        raise HTTPException(400, "op required")

    # Coercion numérique TOLÉRANTE : un payload malformé (clicks:"x", dy:{}) ne
    # doit pas faire un 500 non gardé — on retombe sur le défaut, comme les
    # autres endpoints int() de ce module (select-monitor, capture, launch).
    def _opt_int(v, default):
        try:
            return int(v) if v not in (None, "") else default
        except (TypeError, ValueError):
            return default

    # Le Studio regarde l'écran APRÈS effet : on laisse l'UI se stabiliser (borne
    # ``desktop.studio_act_settle_ms``, adaptatif) avant la capture d'après-action,
    # puis on RENVOIE l'arbre a11y avec le frame (sinon les boxes disparaissent et
    # l'utilisateur recapture pour rien après chaque action).
    from shared_infra import config as _cfg
    settle_ms = int(getattr(_cfg, "DESKTOP_STUDIO_ACT_SETTLE_MS", 1500) or 0)
    if body.get("settle_ms") is not None:
        try:
            settle_ms = max(0, min(10000, int(body.get("settle_ms"))))
        except (TypeError, ValueError):
            pass
    observe_after = bool(body.get("observe_after", True))
    scope = str(body.get("scope") or "").strip().lower()
    if scope not in ("focus", "monitor", "desktop"):
        scope = "monitor"
    kw = dict(
        op=op,
        settle_ms=settle_ms,
        element_id=str(body.get("element_id") or ""),
        query=str(body.get("query") or ""),
        auto_id=str(body.get("auto_id") or ""),
        name=str(body.get("name") or ""),
        control_type=str(body.get("control_type") or ""),
        x=_opt_int(body.get("x"), None), y=_opt_int(body.get("y"), None),
        x2=_opt_int(body.get("x2"), None), y2=_opt_int(body.get("y2"), None),
        text=str(body.get("text") or ""),
        keys=str(body.get("keys") or ""),
        button=str(body.get("button") or "left"),
        clicks=_opt_int(body.get("clicks"), 1),
        dy=_opt_int(body.get("dy"), 0),
        modifiers=str(body.get("modifiers") or ""),
        observe_after=observe_after,
        # Active la garde « type sans effet » (``type_no_effect`` d'``act_core``)
        # sur le chemin Studio direct, comme le rejeu (``_desktop_replay``) : une
        # frappe substantielle qui ne change RIEN à l'écran (focus non posé) est
        # signalée au lieu d'un faux succès.
        semantic_click=(op in ("type", "paste")),
        # Signature du frame que l'utilisateur a cliqué : garde de fraîcheur
        # des actes par coordonnées (refus si l'écran a changé depuis).
        expect_sig=str(body.get("expect_sig") or ""),
    )
    try:
        from llm_core.tools.desktop_tools import act_core, probe_tree_core
    except Exception as e:  # pragma: no cover
        raise HTTPException(500, f"desktop tools unavailable: {e}")

    res = await run_in_threadpool(lambda: act_core(username, target, **kw))

    # Éléments d'après-action : sonde ARBRE SEUL (pas de second screenshot), au
    # plafond du Studio. Échec de sonde → boxes vides, le frame reste utile.
    async def _tree_fields() -> dict:
        if not observe_after or op == "copy":
            return {}
        probe = await run_in_threadpool(
            lambda: probe_tree_core(username, target, scope=scope,
                                    max_nodes=int(getattr(_cfg, "DESKTOP_STUDIO_MAX_NODES", 2000) or 0)))
        if not isinstance(probe, dict) or probe.get("ok") is False or probe.get("error"):
            return {"boxes": [], "tree_nodes": 0, "tree_capped": False}
        return {"boxes": probe.get("elements") or [],
                "tree_nodes": int(probe.get("tree_nodes") or 0),
                "tree_capped": bool(probe.get("tree_capped"))}
    # « Type sans effet » : la frappe A ÉTÉ émise (le pas doit s'enregistrer),
    # mais l'écran n'a pas bougé → on AVERTIT (200 + warning) sans casser le flux,
    # plutôt que le 400 générique. Le frame frais accompagne la réponse.
    if isinstance(res, dict) and res.get("error") == "type_no_effect":
        return JSONResponse({
            "ok": True, "warning": "type_no_effect",
            "message": res.get("message") or "la saisie n'a peut-être pas atteint le champ",
            "op": op, "method": res.get("method"),
            **_frame_fields(res, username, target),
            **(await _tree_fields()),
        })
    # Écran périmé : l'acte par coordonnées n'a PAS été exécuté (la cible a
    # bougé) → 409 + frame frais pour que le Studio rafraîchisse et l'user reclique.
    if isinstance(res, dict) and res.get("error") == "stale_frame":
        return JSONResponse({
            "ok": False, "error": "stale_frame",
            "message": res.get("message") or "l'écran a changé depuis la capture",
            **_frame_fields(res, username, target),
            **(await _tree_fields()),
        }, status_code=409)
    if not isinstance(res, dict) or res.get("ok") is False:
        logger.warning("[desktop_act] échec user=%s target=%r op=%s → %s : %s",
                       username, target or "(défaut)", op,
                       (res or {}).get("error") if isinstance(res, dict) else "non_dict",
                       (res or {}).get("message") if isinstance(res, dict) else "")
        return JSONResponse(
            {"ok": False,
             "error": (res or {}).get("error", "act_failed") if isinstance(res, dict) else "act_failed",
             "message": (res or {}).get("message", "action failed") if isinstance(res, dict) else "action failed",
             "fix": (res or {}).get("fix") if isinstance(res, dict) else None},
            status_code=400,
        )
    return JSONResponse({
        "ok": True,
        "op": res.get("op") or op,
        "point": res.get("point"),
        "text": res.get("text"),
        "method": res.get("method"),     # invoke|click_input|coords|type… (diagnostic)
        "settle_ms": res.get("settle_ms"),
        **_frame_fields(res, username, target),
        **(await _tree_fields()),
    })


@router.post("/api/desktop/launch")
async def api_desktop_launch(request: Request):
    """Lance un programme/raccourci sur la cible et attend son initialisation
    (WaitForInputIdle). Renvoie la fenêtre apparue + un frame frais."""
    user_id = require_user_id(request)
    username = _username_for(user_id)
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    target = str(body.get("target") or "").strip()
    app = str(body.get("app") or body.get("path") or "").strip()
    if not app:
        raise HTTPException(400, "app required")
    args = str(body.get("args") or "")
    try:
        timeout_ms = max(1000, min(120000, int(body.get("timeout_ms") or 15000)))
    except (TypeError, ValueError):
        timeout_ms = 15000
    try:
        from llm_core.tools.desktop_tools import launch_core
    except Exception as e:  # pragma: no cover
        raise HTTPException(500, f"desktop tools unavailable: {e}")
    res = await run_in_threadpool(
        lambda: launch_core(username, target, app=app, args=args, timeout_ms=timeout_ms))
    if not isinstance(res, dict) or res.get("ok") is False:
        logger.warning("[desktop_launch] échec user=%s target=%r app=%r → %s",
                       username, target or "(défaut)", app,
                       (res or {}).get("error") if isinstance(res, dict) else "non_dict")
        return JSONResponse(
            {"ok": False,
             "error": (res or {}).get("error", "launch_failed") if isinstance(res, dict) else "launch_failed",
             "message": (res or {}).get("message") if isinstance(res, dict) else None},
            status_code=400)
    token = res.get("frame_token")
    if token:
        register_desktop_frame_owner(token, username)
    ts = int(time.time() * 1000)
    return JSONResponse({
        "ok": True, "launched": res.get("launched"), "found": bool(res.get("found")),
        "title": res.get("title"), "auto_id": res.get("auto_id"),
        "interaction_state": res.get("interaction_state"),
        "image_url": f"/api/desktop/frame/{token}?t={ts}" if token else "",
        "img_w": res.get("img_w") or 0, "img_h": res.get("img_h") or 0,
        "target": res.get("target") or target, "sig": res.get("sig") or "", "ts": ts,
    })


@router.post("/api/desktop/wait-window")
async def api_desktop_wait_window(request: Request):
    """Attend (UIA) qu'une fenêtre matche ET soit prête à l'interaction."""
    user_id = require_user_id(request)
    username = _username_for(user_id)
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    target = str(body.get("target") or "").strip()
    title_re = str(body.get("title_re") or "")
    auto_id = str(body.get("auto_id") or "")
    class_name = str(body.get("class_name") or "")
    ready = bool(body.get("ready", True))
    if not (title_re or auto_id or class_name):
        raise HTTPException(400, "title_re/auto_id/class_name required")
    try:
        timeout_ms = max(1000, min(300000, int(body.get("timeout_ms") or 15000)))
    except (TypeError, ValueError):
        timeout_ms = 15000
    try:
        from llm_core.tools.desktop_tools import wait_window_core
    except Exception as e:  # pragma: no cover
        raise HTTPException(500, f"desktop tools unavailable: {e}")
    res = await run_in_threadpool(lambda: wait_window_core(
        username, target, title_re=title_re, auto_id=auto_id, class_name=class_name,
        ready=ready, timeout_ms=timeout_ms))
    if not isinstance(res, dict) or res.get("ok") is False:
        return JSONResponse(
            {"ok": False,
             "error": (res or {}).get("error", "wait_failed") if isinstance(res, dict) else "wait_failed"},
            status_code=400)
    return JSONResponse({"ok": True, "found": bool(res.get("found")),
                         "interaction_state": res.get("interaction_state") or "",
                         "title": res.get("title") or "", "auto_id": res.get("auto_id") or ""})


@router.get("/api/desktop/frame/{token}")
async def api_desktop_frame(request: Request, token: str):
    """Serve a saved frame PNG, scoped to its owner.

    La propriété est partagée cross-process via un sidecar disque
    (``get_desktop_frame_owner`` lit la mémoire PUIS le sidecar). En mode STRICT
    (défaut ``DESKTOP_FRAME_STRICT_OWNER``), un propriétaire INCONNU → 404 (les
    frames légitimes portent un sidecar) ; l'échappatoire config rétablit le
    soft-pass en cas de besoin opérateur."""
    user_id = require_user_id(request)
    if not token or not _TOKEN_RE.fullmatch(token):
        raise HTTPException(400, "Invalid frame token")

    owner = get_desktop_frame_owner(token)
    expected = _username_for(user_id)
    if owner is not None and owner != expected:
        logger.warning("[desktop_frame] DENIED user=%s token owned by=%s", expected, owner)
        raise HTTPException(403, "Access denied: not your frame")
    if owner is None and bool(getattr(_cfg, "DESKTOP_FRAME_STRICT_OWNER", True)):
        # Propriétaire inconnu en mode strict → refus (pas d'oracle de jeton).
        raise HTTPException(404, "Frame not available")
    # owner is None + strict OFF → soft pass (échappatoire) ; le fichier gate.

    path = desktop_frame_path(token)
    if not os.path.isfile(path):
        raise HTTPException(404, "Frame not available")
    def _read_frame() -> bytes:
        with open(path, "rb") as f:
            return f.read()
    try:
        # Lecture du PNG complet hors boucle : ne pas bloquer l'event loop sur le disque.
        content = await run_in_threadpool(_read_frame)
    except Exception as e:
        raise HTTPException(503, f"Frame unreadable: {e}")
    # Le nom de fichier est opaque (.png) mais le CONTENU peut être JPEG (config
    # screenshot) → sniffer les magic bytes pour le bon media_type (helper partagé).
    from llm_core._detection_client import _sniff_mime
    return Response(
        content=content,
        media_type=_sniff_mime(content),
        headers={"Cache-Control": "no-store, no-cache, must-revalidate", "Pragma": "no-cache"},
    )


@router.get("/api/desktop/agent-bundle")
def api_desktop_agent_bundle():
    """Zip the ``desktop-agent/`` sources so an operator can drop the bundle on a
    target machine and run it directly (no build step). PUBLIC (no auth) so the
    install one-liners can fetch it from a target without a session cookie — the
    bundle is only the generic agent code (no secrets)."""
    import io
    import os
    import zipfile

    base = (_cfg.PROJECT_ROOT / "desktop-agent")
    if not base.is_dir():
        raise HTTPException(404, "desktop-agent sources not found on server")

    EXCLUDE = {".venv", "venv", "__pycache__", ".git", ".pytest_cache",
               "node_modules", ".mypy_cache", ".ruff_cache"}
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for root, dirs, files in os.walk(base):
            dirs[:] = [d for d in dirs if d not in EXCLUDE]
            for fn in files:
                if fn.endswith((".pyc", ".pyo")):
                    continue
                full = os.path.join(root, fn)
                arc = os.path.join("desktop-agent", os.path.relpath(full, base))
                z.write(full, arc)
    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="desktop-agent.zip"'},
    )


# ── Bundle d'un script d'automatisation (Studio) ─────────────────────────────
_BUNDLE_RUNTIME_DIRS = ("elpis_auto", "backends")
_BUNDLE_RUNTIME_FILES = ("normalize.py",)
_BUNDLE_SERVER_ONLY = ("fastapi", "uvicorn")     # dépendances du SERVEUR de l'agent, inutiles au script


def _bundle_slug(name: str) -> str:
    import re as _re
    slug = _re.sub(r"[^a-z0-9_-]+", "-", str(name or "").strip().lower()).strip("-")
    return (slug or "automatisation")[:64]


def _runtime_requirements(base, os_name: str) -> str:
    """``requirements-<os>.txt`` de l'agent SANS les paquets du serveur HTTP
    (le script tourne en process, sans FastAPI). Reste synchro avec l'agent."""
    fn = base / f"requirements-{'linux' if os_name == 'linux' else 'windows'}.txt"
    try:
        raw = fn.read_text(encoding="utf-8")
    except OSError:
        raw = "Pillow\nmss\npyscreeze\npytweening\npyperclip\n" + (
            "python-xlib\nPyGObject\n" if os_name == "linux" else "pygetwindow\npyrect\npywinauto\n")
    out = []
    for line in raw.splitlines():
        pkg = line.split("#", 1)[0].strip().lower()
        if pkg and any(pkg.startswith(x) for x in _BUNDLE_SERVER_ONLY):
            continue
        out.append(line)
    return "\n".join(out).rstrip() + "\n"


def _runtime_requirements_nodeps(base, os_name: str) -> str:
    """``requirements-<os>-nodeps.txt`` : paquets installés en ``--no-deps``
    (pyautogui, dont mouseinfo/pymsgbox sont GPL et optionnels)."""
    fn = base / f"requirements-{'linux' if os_name == 'linux' else 'windows'}-nodeps.txt"
    try:
        return fn.read_text(encoding="utf-8")
    except OSError:
        return "pyautogui==0.9.54\n"


def _bundle_run_bat(slug: str) -> str:
    # ⚠ cmd.exe : AUCUNE parenthèse dans les ``echo`` d'un bloc ``if (...)`` —
    # une « ) » ferme le bloc et le lanceur meurt sur « ... était inattendu »
    # AVANT d'installer quoi que ce soit.
    return (
        "@echo off\r\n"
        f"rem run.bat [--param=valeur ...] - execute {slug}.py avec un venv local.\r\n"
        "rem 1er lancement : creation du venv + installation des dependances, depuis\r\n"
        "rem wheels\\windows (hors ligne) s'il existe, sinon depuis pip. Si l'agent\r\n"
        "rem Elpis est deja installe sur la machine, run-script.bat de l'agent suffit.\r\n"
        "setlocal\r\n"
        "set HERE=%~dp0\r\n"
        "set PY=%HERE%.venv\\Scripts\\python.exe\r\n"
        "rem Console en UTF-8 le temps du script - coches, fleches et accents du rapport\r\n"
        "rem lisibles - puis page de codes d'origine rendue a la sortie.\r\n"
        "for /f \"tokens=2 delims=:\" %%a in ('chcp') do set OLDCP=%%a\r\n"
        "chcp 65001 >nul\r\n"
        "set PYTHONUTF8=1\r\n"
        "if exist \"%PY%\" goto deps\r\n"
        "echo Creation du venv...\r\n"
        "rem Python : python-win\\ de l'agent (3.11, celui des wheels) s'il est a cote, sinon py/python.\r\n"
        "if exist \"%HERE%python-win\\python.exe\" (\r\n"
        "    \"%HERE%python-win\\python.exe\" -m venv \"%HERE%.venv\" || goto die\r\n"
        "    goto deps\r\n"
        ")\r\n"
        "py -3.11 -m venv \"%HERE%.venv\" 2>nul && goto deps\r\n"
        "py -3 -m venv \"%HERE%.venv\" 2>nul && goto deps\r\n"
        "python -m venv \"%HERE%.venv\" || goto die\r\n"
        ":deps\r\n"
        "if exist \"%HERE%.venv\\deps-ok\" goto run\r\n"
        "echo Installation des dependances - une seule fois...\r\n"
        "if exist \"%HERE%wheels\\windows\" (\r\n"
        "    \"%PY%\" -m pip install --no-index --find-links \"%HERE%wheels\\windows\" -r \"%HERE%requirements.txt\" && \"%PY%\" -m pip install --no-index --find-links \"%HERE%wheels\\windows\" --no-deps -r \"%HERE%requirements-nodeps.txt\" && goto depsok\r\n"
        "    echo Wheels hors ligne inutilisables avec ce Python - les wheels sont cp311 - essai en ligne...\r\n"
        ")\r\n"
        "\"%PY%\" -m pip install -r \"%HERE%requirements.txt\" || (\r\n"
        "    echo Installation impossible. Avec un Python 3.11 - ou python-win\\ de l'agent - les wheels hors ligne suffisent.\r\n"
        "    goto die\r\n"
        ")\r\n"
        "rem pyautogui sans ses dependances : mouseinfo et pymsgbox - GPL, optionnels - ecartes.\r\n"
        "\"%PY%\" -m pip install --no-deps -r \"%HERE%requirements-nodeps.txt\" || goto die\r\n"
        ":depsok\r\n"
        "rem pywin32 dans un venv : ses DLL doivent etre a cote de python.exe (sinon import win32api KO).\r\n"
        "if exist \"%HERE%.venv\\Lib\\site-packages\\pywin32_system32\" copy /y \"%HERE%.venv\\Lib\\site-packages\\pywin32_system32\\*.dll\" \"%HERE%.venv\\Scripts\\\" >nul\r\n"
        "echo ok> \"%HERE%.venv\\deps-ok\"\r\n"
        ":run\r\n"
        f"\"%PY%\" -m elpis_auto \"%HERE%{slug}.py\" %*\r\n"
        "set RC=%ERRORLEVEL%\r\n"
        "rem Lance par double-clic - pas de console parente : la fenetre resterait\r\n"
        "rem ouverte le temps de lire le resultat, sinon elle disparait comme un crash.\r\n"
        "echo %CMDCMDLINE% | find /i \"%~nx0\" >nul && pause\r\n"
        "if defined OLDCP chcp %OLDCP% >nul\r\n"
        "exit /b %RC%\r\n"
        ":die\r\n"
        "echo %CMDCMDLINE% | find /i \"%~nx0\" >nul && pause\r\n"
        "if defined OLDCP chcp %OLDCP% >nul\r\n"
        "exit /b 2\r\n"
    )


def _bundle_run_sh(slug: str) -> str:
    return (
        "#!/usr/bin/env bash\n"
        f"# run.sh [--param=valeur ...] — exécute {slug}.py avec un venv local.\n"
        "# 1er lancement : venv + dépendances, depuis wheels/linux (hors ligne) s'il\n"
        "# existe, sinon depuis pip.\n"
        "HERE=\"$(cd \"$(dirname \"${BASH_SOURCE[0]}\")\" && pwd)\"\n"
        "PY=\"$HERE/.venv/bin/python\"\n"
        "if [ ! -x \"$PY\" ]; then\n"
        "    echo \"Création du venv...\"\n"
        "    python3 -m venv \"$HERE/.venv\" || exit 2\n"
        "fi\n"
        "if [ ! -f \"$HERE/.venv/deps-ok\" ]; then\n"
        "    echo \"Installation des dépendances (une seule fois)...\"\n"
        "    ok=\n"
        "    if [ -d \"$HERE/wheels/linux\" ]; then\n"
        "        \"$PY\" -m pip install --no-index --find-links \"$HERE/wheels/linux\" -r \"$HERE/requirements.txt\" \\\n"
        "            && \"$PY\" -m pip install --no-index --find-links \"$HERE/wheels/linux\" --no-deps -r \"$HERE/requirements-nodeps.txt\" && ok=1\n"
        "        [ -n \"$ok\" ] || echo \"Wheels hors ligne inutilisables avec ce Python (cp311) : essai en ligne...\"\n"
        "    fi\n"
        "    # pyautogui sans ses dépendances : mouseinfo et pymsgbox (GPL, optionnels) écartés.\n"
        "    [ -n \"$ok\" ] || { \"$PY\" -m pip install -r \"$HERE/requirements.txt\" \\\n"
        "        && \"$PY\" -m pip install --no-deps -r \"$HERE/requirements-nodeps.txt\"; } || exit 2\n"
        "    echo ok > \"$HERE/.venv/deps-ok\"\n"
        "fi\n"
        f"cd \"$HERE\" && exec \"$PY\" -m elpis_auto \"$HERE/{slug}.py\" \"$@\"\n"
    )


def _bundle_readme(slug: str, os_name: str, with_wheels: bool = False) -> str:
    return (
        f"{slug} — script d'automatisation généré par Elpis Studio\n"
        "=" * 60 + "\n\n"
        "Contenu\n"
        f"  {slug}.py            le script (éditable)\n"
        "  elpis_auto/          le runtime (Session, cibles, attentes, rapport)\n"
        "  backends/, normalize.py   accès à l'écran (UIA Windows / AT-SPI Linux)\n"
        "  requirements.txt     dépendances Python du runtime\n"
        "  run.bat / run.sh     lanceurs : venv local créé au premier lancement\n"
        + (f"  wheels/{os_name}/      dépendances HORS LIGNE (Python 3.11 : wheels cp311)\n" if with_wheels else "")
        + "\n"
        "Exécuter (sur la machine à piloter)\n"
        f"  Windows :  run.bat --param=valeur\n"
        f"  Linux   :  ./run.sh --param=valeur\n"
        "  ou, avec un Python où requirements.txt est installé :\n"
        f"             python -m elpis_auto {slug}.py\n\n"
        "Si l'agent Elpis est déjà installé sur la machine, le runtime y est :\n"
        f"  copiez seulement {slug}.py à côté de l'agent et lancez run-script.bat {slug}.py\n\n"
        "Codes de sortie : 0 ok · 1 une vérification a échoué · 2 erreur d'exécution.\n"
        "Rapport : rapports/<script>-<horodatage>/rapport.html (+ json, captures d'échec).\n"
        "Paramètres : --cle=valeur, ou ELPIS_PARAM_CLE en variable d'environnement.\n"
        "Options (avant le nom du script) : --dry-run (vol à blanc, rien n'est envoyé),\n"
        "  --trace (capture + arbre à chaque étape, visualiseur dans rapport.html),\n"
        "  --repeat N (stabilité : stabilite.html), --data jeu.csv (une exécution par ligne).\n\n"
        "Dépendances : le lanceur installe depuis wheels/ (hors ligne) si le dossier est\n"
        "là et que le Python est compatible (wheels cp311 → Python 3.11, ou python-win\\\n"
        "de l'agent copié à côté), sinon depuis pip (internet). Un autre Python (3.12+)\n"
        "marche en ligne. Pour forcer une réinstallation : effacer .venv\\deps-ok.\n\n"
        "À SAVOIR\n"
        "  • Lancez le script DEPUIS LE BUREAU de la machine (session ouverte, application\n"
        "    visible) : dans une session SSH, un service ou une session verrouillée,\n"
        "    l'arbre d'accessibilité est vide et chaque cible est « introuvable ».\n"
        "  • run.bat lancé par double-clic garde sa console ouverte le temps de lire le\n"
        "    résultat (touche pour fermer) ; depuis une console, il rend la main.\n"
        "  • Attentes : timeout (15 s) = délai SANS activité à l'écran. Tant que quelque\n"
        "    chose bouge (application qui se lance, chargement), l'attente se prolonge,\n"
        "    jusqu'à patience (120 s, ELPIS_PATIENCE). Session(timeout=…, patience=…).\n"
        "  • window=\"Titre\" sur une action = fenêtre au premier plan si possible (le bureau\n"
        "    « Program Manager » compris), jamais une panne : la cible est cherchée partout.\n"
        "  • Windows : sans le Visual C++ Redistributable (mfc140u.dll), pywinauto est muet ;\n"
        "    le runtime joue alors Toggle/Select/Invoke par UIA directement (comtypes) et\n"
        "    clique pour de vrai sur les menus et pour les double-clics.\n"
        "  • Un abandon (cible introuvable, vérification fausse) écrit quand même le rapport ;\n"
        "    ELPIS_TRACE=1 affiche la trace complète.\n"
        + ("\nLinux : l'arbre d'accessibilité demande PyGObject + AT-SPI (paquets système,\n"
           "voir requirements.txt).\n" if os_name == "linux" else "")
    )


# ── Exécution d'un script SUR la VM depuis le Studio ─────────────────────────
def _int_or(v, default: int) -> int:
    """Entier tolérant : ``"x"`` ou ``{}`` dans le corps → défaut, pas un 500."""
    try:
        return int(v) if v not in (None, "") else default
    except (TypeError, ValueError):
        return default


def _vision_credentials(request: Request, body: dict) -> "tuple[str, str]":
    """La vision d'Elpis pour ``describe=`` : l'URL de cette instance + un jeton
    de VISION du compte (``evt_``, 12 h, valable seulement pour
    ``/api/desktop/locate``) — pas le jeton elpis-remote complet, inutilement large.
    Le script tourne sur la VM, sans cookie. ``vision: false`` dans le corps →
    rien. Partagé par l'exécution simple et la matrice."""
    if not body.get("vision", True):
        return "", ""
    try:
        # ``routes_cli`` importé à l'appel : il importe ``routes._state``, dont le paquet charge ce module (cycle)
        from shared_infra.accounts import tokens as _tokens
        from shared_infra.opencode.routes_cli import _base_url
        tok, _row = _tokens.create(int(require_user_id(request)), "vision", "vision")
        return _base_url(request), tok
    except Exception:
        logger.warning("[desktop] jeton de vision non créé", exc_info=True)
        return "", ""


@router.post("/api/desktop/run-automation")
async def api_desktop_run_automation(request: Request):
    """Pousse le script (+ lib/, assets/) sur l'agent de la cible et le lance
    dans la session interactive. ``{target, name, code, libs, assets, dry_run,
    trace, repeat, args}`` → ``{run_id}`` ; suivre par /status."""
    user_id = require_user_id(request)
    username = _username_for(user_id)
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    name = str(body.get("name") or "automatisation")
    code = str(body.get("code") or "")
    if not code.strip():
        raise HTTPException(400, "code required")
    target = str(body.get("target") or "").strip()
    from llm_core.tools.desktop_tools import push_automation_core, start_automation_core
    libs = body.get("libs") if isinstance(body.get("libs"), dict) else {}
    assets = body.get("assets") if isinstance(body.get("assets"), dict) else {}
    args = [a for a in (body.get("args") or []) if isinstance(a, str)] if isinstance(body.get("args"), list) else []
    elpis_url, elpis_token = _vision_credentials(request, body)
    push = await run_in_threadpool(lambda: push_automation_core(username, target, name, code, libs, assets))
    if push.get("error"):
        return JSONResponse({"ok": False, "error": push.get("error"), "message": push.get("message")}, status_code=400)
    st = await run_in_threadpool(lambda: start_automation_core(
        username, target, name, dry_run=bool(body.get("dry_run")), trace=bool(body.get("trace")),
        repeat=_int_or(body.get("repeat"), 0), args=args, elpis_url=elpis_url, elpis_token=elpis_token))
    if st.get("error"):
        return JSONResponse({"ok": False, "error": st.get("error"), "message": st.get("message")}, status_code=400)
    return JSONResponse({"ok": True, "run_id": st.get("run_id"), "target": st.get("target"), "name": st.get("name"),
                         "push_errors": push.get("push_errors") or []})


@router.get("/api/desktop/run-automation/status")
async def api_desktop_run_automation_status(request: Request, target: str = "", run_id: str = ""):
    user_id = require_user_id(request)
    username = _username_for(user_id)
    if not run_id:
        raise HTTPException(400, "run_id required")
    from llm_core.tools.desktop_tools import automation_status_core
    st = await run_in_threadpool(lambda: automation_status_core(username, target, run_id))
    if st.get("error"):
        return JSONResponse({"ok": False, "error": st.get("error"), "message": st.get("message")}, status_code=400)
    return JSONResponse(st)


@router.post("/api/desktop/run-automation/stop")
async def api_desktop_run_automation_stop(request: Request):
    user_id = require_user_id(request)
    username = _username_for(user_id)
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    from llm_core.tools.desktop_tools import _agent_req, _resolve_target_strict
    # Nom explicite inconnu : refus. Ne pas retomber sur la cible par défaut :
    # on arrêterait le run_id sur une AUTRE machine.
    tgt = _resolve_target_strict(str(body.get("target") or ""), username)
    if not tgt:
        raise HTTPException(400, "cible inconnue")
    r = await run_in_threadpool(lambda: _agent_req(tgt, "/run_stop", {"run_id": str(body.get("run_id") or "")}))
    return JSONResponse(r if isinstance(r, dict) else {"ok": False})


@router.get("/api/desktop/run-file")
async def api_desktop_run_file(request: Request, target: str = "", path: str = ""):
    """Fichier d'un rapport sur la cible (capture PNG, etape-NN.json…), relayé tel quel."""
    user_id = require_user_id(request)
    username = _username_for(user_id)
    # Segment « .. » refusé ; un NOM contenant « ... » (capture « clic-Enregistrer-sous...-menuitem »)
    # est légitime — ne pas tester par sous-chaîne : ces captures d'échec deviendraient introuvables.
    segs = [x for x in str(path or "").replace("\\", "/").split("/")]
    if not path or any(x == ".." for x in segs) or str(path).startswith(("/", "\\")) or ":" in segs[0]:
        raise HTTPException(400, "path invalide")
    from llm_core.tools.desktop_tools import automation_file_core
    r = await run_in_threadpool(lambda: automation_file_core(username, target, path))
    if not isinstance(r, dict) or r.get("error") or not r.get("content_b64"):
        raise HTTPException(404, (r or {}).get("message") or "fichier introuvable")
    import base64 as _b64
    data = _b64.b64decode(r["content_b64"])
    ext = path.rsplit(".", 1)[-1].lower()
    # Servis EN LIGNE : images et JSON seulement. Un .html (rapport, ou fichier déposé
    # dans assets/ par un autre compte sur une cible partagée) s'exécuterait sous
    # l'origine de l'application avec la session de celui qui l'ouvre : il part en
    # téléchargement, dans un bac à sable sans script.
    inline = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "json": "application/json"}
    headers = {"X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox; default-src 'none'; img-src data:"}
    if ext in inline:
        return Response(content=data, media_type=inline[ext], headers=headers)
    fname = (path.replace("\\", "/").rsplit("/", 1)[-1] or "fichier").replace('"', "")
    headers["Content-Disposition"] = f'attachment; filename="{fname}"'
    return Response(content=data, media_type="application/octet-stream", headers=headers)


@router.post("/api/desktop/run-automation-matrix")
async def api_desktop_run_automation_matrix(request: Request):
    """Le même script sur PLUSIEURS cibles, en séquence, jusqu'au bout (borne par
    cible) ; résultats agrégés + notification. Long : à appeler en connaissance."""
    user_id = require_user_id(request)
    username = _username_for(user_id)
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    code = str(body.get("code") or "")
    targets = [str(t) for t in (body.get("targets") or []) if str(t or "").strip()] if isinstance(body.get("targets"), list) else []
    if not code.strip() or not targets:
        raise HTTPException(400, "code et targets requis")
    from llm_core.tools.desktop_tools import run_automation_core
    libs = body.get("libs") if isinstance(body.get("libs"), dict) else {}
    assets = body.get("assets") if isinstance(body.get("assets"), dict) else {}
    elpis_url, elpis_token = _vision_credentials(request, body)
    # Budget PAR cible, borné [30, 3600] ; ``"abc"`` → 600 (pas un 500).
    timeout_s = max(30, min(3600, _int_or(body.get("timeout_s"), 600)))
    doc = await run_in_threadpool(lambda: run_automation_core(
        username, targets, str(body.get("name") or "automatisation"), code,
        dry_run=bool(body.get("dry_run")), trace=bool(body.get("trace")),
        timeout_s=timeout_s, libs=libs, assets=assets,
        notify_user_id=int(user_id), elpis_url=elpis_url, elpis_token=elpis_token))
    return JSONResponse(doc)


@router.post("/api/desktop/locate")
async def api_desktop_locate(request: Request):
    """Vision d'Elpis au service d'un script en cours d'exécution sur la VM :
    ``{image_b64, describe}`` → la boîte de l'élément décrit (« le bouton vert
    d'exécution »), en px de l'image. Cible ``describe=`` du runtime elpis_auto.
    Auth : session web OU ``Authorization: Bearer evt_…`` (jeton de vision remis
    au script, qui tourne sur la VM sans cookie) ; ``pcr_…`` (jeton opencode)
    reste accepté pour les scripts qui l'ont reçu à leur lancement."""
    uid = None
    try:
        uid = require_user_id(request)                 # session web
    except HTTPException:
        # import à l'appel : ``routes_cli`` importe ``routes._state``, dont le paquet charge ce module (cycle)
        from shared_infra.opencode.routes_cli import _client_identity
        _tok, uid = _client_identity(request, kinds=("vision", "opencode"))
        if _tok is None:
            uid = None
    if uid is None:
        raise HTTPException(401, "auth requise (session ou jeton de vision)")
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    describe = str(body.get("describe") or "").strip()
    img_b64 = body.get("image_b64")
    if not describe or not isinstance(img_b64, str) or not img_b64:
        raise HTTPException(400, "describe et image_b64 requis")
    import base64 as _b64
    try:
        png = _b64.b64decode(img_b64, validate=True)
    except Exception:
        raise HTTPException(400, "image_b64 invalide")
    if len(png) > 16 * 1024 * 1024:
        raise HTTPException(413, "image trop volumineuse")
    if not getattr(_cfg, "VISION_ENDPOINT_URL", ""):
        return JSONResponse({"ok": False, "error": "no_vision", "message": "aucun modèle de vision configuré (Admin → Vision & Desktop)"}, status_code=503)
    from llm_core._detection_client import detect
    from llm_core.tools.desktop_tools import _png_size

    def _run():
        w, h = _png_size(png)
        boxes = detect(png, endpoint=_cfg.VISION_ENDPOINT_URL, fmt=_cfg.VISION_FORMAT, prompt=describe,
                       model=getattr(_cfg, "VISION_MODEL", ""), response_map=_cfg.VISION_RESPONSE_MAP,
                       timeout=_cfg.VISION_TIMEOUT_SEC, native_w=w, native_h=h,
                       passes=1)
        return boxes or []
    boxes = await run_in_threadpool(_run)
    best = None
    for b in boxes:
        box = b.get("box") if isinstance(b, dict) else None
        if not isinstance(box, (list, tuple)) or len(box) < 4:
            continue
        conf = float(b.get("confidence") or 0)
        if best is None or conf > best[1]:
            best = ([int(round(float(v))) for v in box[:4]], conf, str(b.get("label") or ""))
    if best is None:
        return JSONResponse({"ok": False, "error": "not_found", "message": f"« {describe} » introuvable par la vision"}, status_code=404)
    return JSONResponse({"ok": True, "box": best[0], "confidence": round(best[1], 3), "label": best[2]})


@router.post("/api/desktop/automation-bundle")
async def api_desktop_automation_bundle(request: Request):
    """Zip « prêt à tourner » d'un script du Studio : le .py + le runtime
    ``elpis_auto`` (avec ses backends) + ``requirements.txt`` + lanceurs + README.
    Pour une machine SANS l'agent Elpis, ou un projet à part. Le script seul se
    télécharge côté client (Blob) quand le runtime est déjà sur place."""
    import io
    import zipfile

    require_user_id(request)
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    code = str(body.get("code") or "")
    if not code.strip():
        raise HTTPException(400, "code required")
    slug = _bundle_slug(body.get("name") or "")
    os_name = str(body.get("os") or "").strip().lower()
    os_name = "linux" if os_name.startswith("lin") else "windows"
    include_wheels = bool(body.get("include_wheels"))    # dépendances hors ligne (wheels/<os>, ~18 Mo)
    libs = body.get("libs") if isinstance(body.get("libs"), dict) else {}        # {"lib/x.py": code}
    assets = body.get("assets") if isinstance(body.get("assets"), dict) else {}  # {"assets/a.png": base64}

    base = _cfg.PROJECT_ROOT / "desktop-agent"
    if not (base / "elpis_auto").is_dir():
        raise HTTPException(404, "runtime elpis_auto introuvable sur le serveur")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(f"{slug}/{slug}.py", code)
        for d in _BUNDLE_RUNTIME_DIRS:
            for fp in sorted((base / d).glob("*.py")):
                z.write(fp, f"{slug}/{d}/{fp.name}")
        for fn in _BUNDLE_RUNTIME_FILES:
            fp = base / fn
            if fp.is_file():
                z.write(fp, f"{slug}/{fn}")
        import base64 as _b64
        import re as _re2
        _safe = _re2.compile(r"^(lib|assets)/[\w.\-/]+$")
        for rel, text in libs.items():
            if _safe.match(str(rel)) and ".." not in str(rel) and isinstance(text, str):
                z.writestr(f"{slug}/{rel}", text)
        if libs and not any(str(r) == "lib/__init__.py" for r in libs):
            z.writestr(f"{slug}/lib/__init__.py", "")
        for rel, b64 in assets.items():
            if _safe.match(str(rel)) and ".." not in str(rel) and isinstance(b64, str):
                try:
                    raw = _b64.b64decode(b64, validate=True)
                except Exception:
                    continue
                if raw:
                    z.writestr(f"{slug}/{rel}", raw, compress_type=zipfile.ZIP_STORED)
        z.writestr(f"{slug}/requirements.txt", _runtime_requirements(base, os_name))
        z.writestr(f"{slug}/requirements-nodeps.txt", _runtime_requirements_nodeps(base, os_name))
        z.writestr(f"{slug}/run.bat", _bundle_run_bat(slug))
        info = zipfile.ZipInfo(f"{slug}/run.sh")
        info.external_attr = 0o755 << 16          # exécutable une fois dézippé sous Linux
        z.writestr(info, _bundle_run_sh(slug))
        wheels_dir = base / "wheels" / os_name
        with_wheels = include_wheels and wheels_dir.is_dir()
        if with_wheels:
            for fp in sorted(wheels_dir.glob("*.whl")):
                z.write(fp, f"{slug}/wheels/{os_name}/{fp.name}", compress_type=zipfile.ZIP_STORED)   # déjà compressées
        z.writestr(f"{slug}/README.txt", _bundle_readme(slug, os_name, with_wheels))
    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{slug}.zip"'},
    )


@router.get("/api/desktop/install.sh")
def api_desktop_install_sh(request: Request):
    """One-command Linux/macOS installer: download the bundle, build a venv,
    install deps, and launch the agent. PUBLIC (runs on a cookie-less target).
    The base URL is taken from the validated Host (see ``routes_cli._base_url``).

    Amorçage EN CLAIR : Caddy sert aussi cette route en http sur :80
    (deploy/caddy › ``@bootstrap``), donc ``$BASE`` est en http et le bloc TLS
    ci-dessous ne s'exécute même pas. Il ne subsiste que pour la commande
    « historique » en https (cert LAN auto-signé)."""
    # import à l'appel : ``routes_cli`` importe ``routes._state``, dont le paquet charge ce module (cycle)
    from shared_infra.opencode.routes_cli import _base_url
    base = _base_url(request)
    from fastapi.responses import PlainTextResponse
    script = f"""#!/usr/bin/env bash
set -euo pipefail
# Installeur desktop-agent — servi par {base} (réseau local, sans auth).
BASE="{base}"
DIR="${{DESKTOP_AGENT_DIR:-$PWD/desktop-agent}}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
# HTTPS (frontal Caddy, cert LAN auto-signé) : vérif normale → CA locale → repli
# -k. DEUX sources pour la CA : Caddy la publie en clair sur :80, mais ce chemin
# n'existe pas sur un déploiement en https direct (ou :80 filtré) — l'app la sert
# donc aussi elle-même sur /api/cli/ca.crt. Sans cette seconde source on tombait
# en « -k » définitif alors qu'une vérification réelle était possible.
CURL_TLS=""
if [ "${{BASE#https://}}" != "$BASE" ]; then
  HOST="${{BASE#https://}}"; HOST="${{HOST%%[:/]*}}"
  if curl -fsS -m 5 --head "$BASE/api/desktop/install.sh" >/dev/null 2>&1; then
    :      # certificat déjà reconnu par le poste (CA installée) — rien à faire
  else
    for CA_URL in "http://$HOST/ca.crt" "$BASE/api/cli/ca.crt"; do
      if curl -fsSk -m 5 "$CA_URL" -o "$TMP/ca.crt" 2>/dev/null \\
         && grep -q 'BEGIN CERTIFICATE' "$TMP/ca.crt" 2>/dev/null \\
         && curl -fsS -m 5 --cacert "$TMP/ca.crt" --head "$BASE/api/desktop/install.sh" >/dev/null 2>&1; then
        CURL_TLS="--cacert $TMP/ca.crt"
        echo "CA locale récupérée ($CA_URL) — téléchargement https vérifié."
        break
      fi
    done
    if [ -z "$CURL_TLS" ]; then
      CURL_TLS="-k"
      echo "AVERTISSEMENT : certificat https non vérifiable — téléchargement en mode non vérifié (-k)."
      echo "  Installez la CA de l'app sur ce poste ($BASE/api/cli/ca.crt) pour y remédier."
    fi
  fi
fi
echo "-> Téléchargement de l'agent depuis $BASE ..."
curl -fSL $CURL_TLS "$BASE/api/desktop/agent-bundle" -o "$TMP/desktop-agent.zip"
PARENT="$(dirname "$DIR")"; mkdir -p "$PARENT"
rm -rf "$DIR"
python3 -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "$TMP/desktop-agent.zip" "$PARENT"
cd "$DIR"
chmod +x install_agent.sh 2>/dev/null || true
# Délègue à l'installeur embarqué : venv + deps (HORS-LIGNE si wheels embarquées)
# + choix d'auto-démarrage. Piped => non-interactif (DESKTOP_SERVICE=1 = service).
exec bash install_agent.sh
"""
    return PlainTextResponse(script, media_type="text/x-shellscript; charset=utf-8")


@router.get("/api/desktop/install.ps1")
def api_desktop_install_ps1(request: Request):
    """One-command Windows installer (PowerShell). PUBLIC, same rationale."""
    # import à l'appel : ``routes_cli`` importe ``routes._state``, dont le paquet charge ce module (cycle)
    from shared_infra.opencode.routes_cli import _base_url
    base = _base_url(request)
    from fastapi.responses import PlainTextResponse
    # NOTE : le script genere doit rester 100% ASCII — PowerShell 5.1 lit les
    # scripts sans BOM en ANSI et un tiret cadratin/guillemet courbe mal
    # decode peut casser le parsing (cf. desktop-agent/install_agent.ps1).
    script = rf"""# Installeur desktop-agent -- servi par {base} (reseau local, sans auth).
$ErrorActionPreference = 'Stop'
$Base = '{base}'
# HTTPS (frontal Caddy, cert LAN auto-signe) : si la verification echoue, on la
# desactive POUR CE SCRIPT (PS7 : SkipCertificateCheck ; PS5.1 : callback).
if ($Base -like 'https://*') {{
  if ($PSVersionTable.PSVersion.Major -lt 6) {{
    # .NET Framework peut demarrer SANS TLS 1.2 alors que Caddy exige TLS >= 1.2
    # ("The underlying connection was closed") -- on l'ajoute AVANT tout appel.
    # 3072 = Tls12 (valeur numerique : l'enum manque sur les vieux .NET).
    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072
  }}
  try {{ Invoke-WebRequest -UseBasicParsing -Method Head -Uri "$Base/api/desktop/install.ps1" -TimeoutSec 5 | Out-Null }}
  catch {{
    if ($PSVersionTable.PSVersion.Major -ge 6) {{
      $PSDefaultParameterValues['Invoke-WebRequest:SkipCertificateCheck'] = $true
    }} else {{
      # PAS de scriptblock {{ $true }} : .NET peut invoquer le callback sur un
      # thread SANS runspace PowerShell -> handshake avorte ("The underlying
      # connection was closed"). Callback C# COMPILE (Add-Type) = thread-safe.
      if (-not ('ElpisTrustAll' -as [type])) {{
        Add-Type 'using System.Net;public class ElpisTrustAll{{public static void Go(){{ServicePointManager.ServerCertificateValidationCallback=delegate{{return true;}};}}}}'
      }}
      [ElpisTrustAll]::Go()
    }}
    Write-Host "Certificat https non verifiable (CA locale) -- verification desactivee pour ce script."
  }}
}}
$Dir = if ($env:DESKTOP_AGENT_DIR) {{ $env:DESKTOP_AGENT_DIR }} else {{ Join-Path $PWD 'desktop-agent' }}
$Parent = Split-Path -Parent $Dir
$Tmp = (New-Item -ItemType Directory -Force -Path (Join-Path $env:TEMP ('desktop-agent-' + [guid]::NewGuid()))).FullName
$Zip = Join-Path $Tmp 'desktop-agent.zip'
Write-Host "-> Telechargement de l'agent depuis $Base ..."
Invoke-WebRequest -UseBasicParsing -Uri "$Base/api/desktop/agent-bundle" -OutFile $Zip
if (Test-Path $Dir) {{ Remove-Item -Recurse -Force $Dir }}
Expand-Archive -Force -Path $Zip -DestinationPath $Parent
Set-Location $Dir
# Delegue a l'installeur embarque (Python standalone embarque + vrai venv
# hors-ligne via run.ps1 + auto-demarrage). Ensuite : double-clic run.bat.
& powershell -ExecutionPolicy Bypass -File "$Dir\install_agent.ps1"
"""
    if any(ord(c) > 127 for c in script):
        # Garde-fou : un caractere non-ASCII reintroduit ici casserait le
        # parsing PS 5.1 cote cible (lecture ANSI sans BOM).
        logger.warning("install.ps1 contient des caracteres non-ASCII")
    return PlainTextResponse(script, media_type="text/plain; charset=utf-8")


# ── Alias COURTS (chemins affichés par la console admin) ─────────────────────
# `curl -fsSL http://<ip>/agent | bash` / `iex(irm http://<ip>/agent.ps1)`.
# Servis aussi EN CLAIR par Caddy sur :80 (deploy/caddy › ``@bootstrap``) : la
# VM cible n'a alors aucun certificat local à valider pour amorcer, ce qui
# supprime le préambule PowerShell de contournement TLS (long et fragile).
@router.get("/agent")
def api_desktop_install_sh_short(request: Request):
    return api_desktop_install_sh(request)


@router.get("/agent.ps1")
def api_desktop_install_ps1_short(request: Request):
    return api_desktop_install_ps1(request)
