# SPDX-License-Identifier: MIT
"""
backend.services._pw_session — Playwright session ownership & screenshot helpers.

Multi-user safety layer for Playwright browser sessions:

- Each ``pw_session(action="start")`` tool call returns a ``session_id``. We
  map it to the requesting username so other users can't fetch screenshots
  belonging to that session.
- Mapping is cleared on ``stop`` / ``cleanup`` actions, by the TTL reaper,
  and on shutdown.
- :func:`_extract_pw_screenshot_url` walks a tool call's result and emits a
  fresh screenshot URL when the Node-side ``autoSnapshot`` middleware has
  injected a ``screenshot_step``. Pure function — no server-side counter.

Public API (re-exported via ``backend.services``):
    register_pw_session_owner, unregister_pw_session_owner, get_pw_session_owner

Private helpers used by chat orchestration:
    _track_pw_session_ownership, _extract_pw_screenshot_url, _pw_verb_of
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re as _re
import time
from typing import Any, Dict, Optional

logger = logging.getLogger("uvicorn.error")


# ─────────────────────────────────────────────────────────────────────────────
# Ownership registry
# ─────────────────────────────────────────────────────────────────────────────
# Mapping session_id → username. Used to scope Playwright screenshot access:
# a PNG is only readable by the user who owns its session_id. Cleanup
# happens on pw_session(action='stop'), via the TTL reaper, and at shutdown.
_pw_session_owners: Dict[str, str] = {}
_pw_session_owners_lock = asyncio.Lock()
# BUG FIX — borne dure du registre. La docstring du module évoque un
# « TTL reaper » qui n'a jamais existé : un ``pw_session(action="start")``
# sans ``stop``/``cleanup`` correspondant (LLM qui oublie, chat interrompu,
# onglet fermé) laissait une entrée ``session_id → username`` indéfiniment
# → croissance non bornée. On plafonne le dict par éviction FIFO : les
# entrées les plus anciennes (ordre d'insertion préservé par dict 3.7+)
# sont les sessions abandonnées les plus probables. 500 est très au-dessus
# de tout nombre réaliste de sessions Playwright simultanées.
_PW_OWNERS_MAX = 500


async def register_pw_session_owner(session_id: str, username: str) -> None:
    """Enregistre un session_id Playwright comme propriété de cet user."""
    if not session_id or not username:
        return
    _write_pw_owner_sidecar(session_id, username)
    async with _pw_session_owners_lock:
        _pw_session_owners[session_id] = username
        # Éviction FIFO si le registre dépasse la borne (cf. _PW_OWNERS_MAX).
        if len(_pw_session_owners) > _PW_OWNERS_MAX:
            for _old_sid in list(_pw_session_owners.keys())[:-_PW_OWNERS_MAX]:
                _pw_session_owners.pop(_old_sid, None)
        logger.info("[pw_owner] Session %s → user %s", session_id[:8], username)


def record_pw_session_owner(session_id: str, username: str) -> None:
    """Variante SYNCHRONE de ``register_pw_session_owner`` pour le THREAD d'un
    outil (2026-09-11, P4) : sur un hôte d'outils, c'est l'outil ``pw_session``
    lui-même qui pose la propriété (la boucle de chat vit sur une autre
    machine). ``dict[k] = v`` est atomique ; sidecar disque pour les autres
    process/workers."""
    if not session_id or not username:
        return
    _write_pw_owner_sidecar(session_id, username)
    _pw_session_owners[session_id] = username
    if len(_pw_session_owners) > _PW_OWNERS_MAX:
        for _old_sid in list(_pw_session_owners.keys())[:-_PW_OWNERS_MAX]:
            _pw_session_owners.pop(_old_sid, None)


async def unregister_pw_session_owner(session_id: str) -> None:
    """Retire un session_id du registre (à appeler sur stop/cleanup)."""
    if not session_id:
        return
    async with _pw_session_owners_lock:
        _pw_session_owners.pop(session_id, None)
    _drop_pw_owner_sidecar(session_id)


# ── Sidecar disque de propriété (cf. get_pw_session_owner) ─────────────────
# Dossier PARTAGÉ par tous les workers, comme celui des frames desktop.
PW_OWNERS_DIR = os.environ.get("PW_OWNERS_DIR", "/tmp/elpis_pw_owners")
_PW_SID_RE = _re.compile(r"^[A-Za-z0-9\-]{8,64}$")


def _pw_owner_path(session_id: str) -> Optional[str]:
    if not _PW_SID_RE.fullmatch(str(session_id or "")):
        return None                       # défense : pas de traversée par le sid
    return os.path.join(PW_OWNERS_DIR, f"{session_id}.owner")


# Âge au-delà duquel un sidecar est considéré comme abandonné (session jamais
# arrêtée : le modèle a oublié le ``stop``, le chat a été interrompu…).
_PW_OWNER_TTL_S = 24 * 3600


def _prune_pw_owner_sidecars() -> None:
    """Balayage opportuniste (à l'écriture) — pas de reaper dédié."""
    try:
        now = time.time()
        with os.scandir(PW_OWNERS_DIR) as it:
            for ent in it:
                if not ent.name.endswith(".owner"):
                    continue
                try:
                    if now - ent.stat().st_mtime > _PW_OWNER_TTL_S:
                        os.unlink(ent.path)
                except OSError:
                    continue
    except Exception:                                           # noqa: BLE001
        pass


def _write_pw_owner_sidecar(session_id: str, username: str) -> None:
    path = _pw_owner_path(session_id)
    if not path:
        return
    try:
        os.makedirs(PW_OWNERS_DIR, mode=0o700, exist_ok=True)
        _prune_pw_owner_sidecars()
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(str(username))
        os.replace(tmp, path)             # publication atomique
    except Exception as e:                                      # noqa: BLE001
        logger.warning("[pw_owner] sidecar non écrit (%s) : %s", session_id[:8], e)


def _read_pw_owner_sidecar(session_id: str) -> Optional[str]:
    path = _pw_owner_path(session_id)
    if not path:
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            owner = (f.read() or "").strip()
    except Exception:                                           # noqa: BLE001
        return None
    return owner or None


def _drop_pw_owner_sidecar(session_id: str) -> None:
    path = _pw_owner_path(session_id)
    if not path:
        return
    try:
        os.unlink(path)
    except Exception:                                           # noqa: BLE001
        pass


def get_pw_session_owner(session_id: str) -> Optional[str]:
    """Retourne le username propriétaire d'une session Playwright, ou None.
    Lecture sync : safe car une dict.get() est atomique en Python.

    AUDIT 2026-08-22 (D7) — repli sur le SIDECAR DISQUE. Le registre mémoire
    n'existe que dans le worker qui a exécuté ``pw_session(action="start")` ;
    or les requêtes de capture n'ont aucune affinité de worker (SO_REUSEPORT) :
    sur trois workers, deux requêtes sur trois tombaient sur un process qui
    n'avait jamais vu la session, et le contrôle de propriété se contentait
    alors de LAISSER PASSER. Le sidecar rend la propriété visible à tous les
    process — même remède que celui appliqué aux frames desktop.
    """
    if not session_id:
        return None
    owner = _pw_session_owners.get(session_id)
    if owner is not None:
        return owner
    owner = _read_pw_owner_sidecar(session_id)
    if owner:
        _pw_session_owners[session_id] = owner
    return owner


def _pw_verb_of(tool_name: str, tool_args: Any) -> str:
    """Verbe effectif d'un appel ``pw_*``, synonymes résolus (action|op|do…).

    Les hooks du harnais (propriété de session, injection de capture vision)
    inspectent les arguments BRUTS du tool call. Depuis l'harmonisation des
    noms (2026-08-08), lire une clé en dur les rendrait aveugles à la forme
    désormais documentée : ``pw_session(op='stop')`` fermerait la session
    sans dépublier son propriétaire, ``pw_page(action='inspect')``
    n'injecterait plus la capture. Import paresseux : le harnais doit rester
    utilisable même si la catégorie navigateur n'est pas installée.
    """
    if not isinstance(tool_args, dict):
        return ""
    try:
        from llm_core.tools.firefox_tools import pw_verb
        return pw_verb(tool_name, tool_args)
    except Exception:
        v = tool_args.get("action")
        return v.strip() if isinstance(v, str) else ""


async def _track_pw_session_ownership(tool_name: str, tool_args: Dict,
                                      result_json: str, username: str) -> None:
    """Suit le cycle de vie des sessions Playwright pour multi-user safety.
    - pw_session(action='start') → enregistre session_id retourné comme propriété de username
    - pw_session(action='stop') → retire le mapping
    - pw_session(action='cleanup') → vide tous les mappings de cet user
    """
    if tool_name != "pw_session":
        return
    if not isinstance(tool_args, dict):
        return
    action = _pw_verb_of("pw_session", tool_args)
    if not action:
        return
    try:
        data = json.loads(result_json) if result_json else {}
    except Exception:
        data = {}
    if not isinstance(data, dict):
        return

    if action == "start":
        sid = data.get("session_id") or data.get("sid")
        if sid and isinstance(sid, str):
            await register_pw_session_owner(sid, username)
    elif action == "stop":
        sid = tool_args.get("session_id")
        if sid:
            await unregister_pw_session_owner(sid)
    elif action == "cleanup":
        # Vide les mappings de cet user (pas tous, sinon on casse les autres)
        async with _pw_session_owners_lock:
            to_remove = [s for s, u in _pw_session_owners.items() if u == username]
            for s in to_remove:
                _pw_session_owners.pop(s, None)
            if to_remove:
                logger.info("[pw_owner] Cleanup user %s: %d sessions retirées", username, len(to_remove))


def _extract_pw_screenshot_url(tool_name: str, tool_args: Any,
                               result_json: str) -> Optional[Dict[str, Any]]:
    """Si c'est un outil Playwright (`pw_*`), que les args contiennent un
    `session_id` valide ET que le résultat contient `screenshot_step`
    (injecté par le middleware `autoSnapshot` de server.js), renvoyer:
        {"url": "/api/playwright/screenshot/step_<sid>_<N>.png?t=...",
         "step": N,
         "session_id": sid}
    Sinon None. Jamais de compteur maintenu côté Python → zéro désync possible.
    """
    if not tool_name or not tool_name.startswith("pw_"):
        return None
    if not isinstance(tool_args, dict):
        return None
    sid = tool_args.get("session_id") or tool_args.get("sid")
    if not sid or not isinstance(sid, str):
        return None
    if not _re.fullmatch(r"[A-Za-z0-9_\-]{8,64}", sid):
        return None
    if not result_json:
        return None
    try:
        data = json.loads(result_json)
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    step = data.get("screenshot_step")
    if not isinstance(step, int) or step <= 0:
        return None
    ts = int(time.time() * 1000)
    return {
        "url": f"/api/playwright/screenshot/step_{sid}_{step}.png?t={ts}",
        "step": step,
        "session_id": sid,
    }
