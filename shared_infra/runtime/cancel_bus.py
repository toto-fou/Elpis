# SPDX-License-Identifier: MIT
"""shared_infra.runtime.cancel_bus — propagation des annulations de chat entre workers.

Pourquoi ce module
------------------
``_cancelled_chats`` et ``_active_chat_tasks`` (shared_infra/routes/_state.py)
sont des structures **module-level**, donc PAR PROCESS. L'app tourne sous
gunicorn avec plusieurs workers et ``reuse_port`` : la génération vit dans le
worker qui tient la connexion longue du stream, alors que ``POST
/api/chat/cancel`` est une requête indépendante, distribuée par le noyau **sans
aucune affinité**. Avec N workers, le Stop de l'utilisateur atterrissait donc
(N-1)/N fois sur un process qui n'exécute rien : le flag était posé dans le
mauvais registre, ``get_active_chat_task`` renvoyait ``None``, l'endpoint
répondait quand même ``{"status": "cancelled"}`` — et la génération continuait
à décoder, à appeler des outils, puis persistait le tour complet. L'UI affichait
« annulé » pendant que le chat se remplissait tout seul.

Fonctionnement
--------------
Même patron éprouvé que ``shared_infra/observability/metrics/broadcast.py`` : un fichier JSONL
partagé dans /tmp, écrit sous verrou ``fcntl`` et suivi (« tail ») par chaque
worker. Une demande d'annulation est diffusée à tous les process ; chacun
l'applique **localement** (flag + ``task.cancel()`` sur sa propre task si elle
est chez lui). Le worker émetteur applique l'annulation immédiatement en direct,
sans attendre son propre écho — le bus ne sert qu'à joindre les autres.

Pas de Redis, pas de HTTP loopback : aucun démon ni surface d'auth en plus, et
un worker qui meurt ne bloque personne (le fichier reste lisible).

Ce qu'on ne fait PAS
--------------------
Réutiliser le bus ``system_events`` de ``metrics/broadcast``. Celui-ci diffuse à
**tout utilisateur authentifié** ; y faire transiter une annulation exposerait
le ``chat_id`` et le ``user_id`` d'un utilisateur aux navigateurs de tous les
autres. Ce canal-ci reste strictement serveur-à-serveur.

Modes de défaillance
--------------------
  • /tmp plein ou non inscriptible → ``publish_cancel`` avale l'erreur : le
    worker local a de toute façon déjà appliqué l'annulation en direct, on perd
    seulement la propagation cross-worker (comportement d'avant ce module).
  • Rotation du fichier (cap 2 Mo) : les demandes en vol au moment de la
    troncature sont perdues, mais la mémoire et le disque restent bornés.
  • Un worker qui démarre se positionne en fin de fichier : il ne rejoue jamais
    d'annulations passées (elles concernent des générations déjà mortes).
"""
from __future__ import annotations

import asyncio
import fcntl
import json
import logging
import os
import time
from typing import Callable, Optional

logger = logging.getLogger("uvicorn.error")

# AUDIT 2026-08-22 (D8) — chemin dérivé de la racine commune
# (``shared_infra.runtime.runtime_dir``) au lieu d'un ``/tmp`` en dur : c'était le seul
# des quatre canaux inter-process sans surcharge possible, donc le seul qu'un
# déploiement ne pouvait pas déplacer — et ``/tmp`` est partagé par tous les
# comptes de la machine.
from shared_infra.runtime.runtime_dir import (  # noqa: E402
    ensure_runtime_dir as _ensure_runtime_dir,
    file_is_safe as _file_is_safe,
    runtime_path as _runtime_path,
)

CANCEL_FILE = _runtime_path("chat_cancel.jsonl", "ELPIS_CANCEL_FILE",
                            "/tmp/elpis_chat_cancel.jsonl")
_MAX_FILE_SIZE_BYTES = 2_000_000
_TAIL_POLL_SEC = 0.1


def publish_cancel(user_id: int, chat_id: str, ts: Optional[float] = None) -> float:
    """Diffuse une demande d'annulation à tous les workers.

    Retourne l'horodatage porté par la demande — l'appelant s'en sert pour
    dater l'application locale et écarter son propre écho.
    """
    stamp = float(ts if ts is not None else time.time())
    line = json.dumps({"uid": int(user_id), "cid": str(chat_id), "ts": stamp}) + "\n"
    _append(line)
    return stamp


def publish_child_cancel(username: str, child_id: str,
                         ts: Optional[float] = None) -> float:
    """Diffuse l'annulation d'UN SOUS-AGENT (outil ``task``) à tous les workers.

    Même canal, ``kind="child"`` : un enfant n'est PAS un chat — il ne faut
    surtout pas que cette demande atterrisse dans ``_cancelled_chats`` et tue
    le tour parent (tout l'intérêt du ✕ par-agent est que le parent survive).

    Sans cette diffusion, ``POST /api/chat/task-cancel`` ne posait son flag que
    dans le worker qui reçoit la requête — alors que l'enfant tourne dans celui
    qui tient le stream. Avec N workers gunicorn le ✕ n'avait donc qu'une
    chance sur N d'agir, l'API répondant malgré tout ``{"status": "cancelled"}``.
    """
    stamp = float(ts if ts is not None else time.time())
    line = json.dumps({"kind": "child", "user": str(username),
                       "child": str(child_id), "ts": stamp}) + "\n"
    _append(line)
    return stamp


# AUDIT 2026-09-01 (passe 5, B12) — ``publish_*`` reste SYNCHRONE (contrat :
# la ligne est durablement écrite au retour, les tailers démarrés ensuite ne
# la rejouent pas). Le déport hors boucle se fait AUX SITES APPELANTS async
# (``_state._publish_cancel`` → exécuteur ; route task-cancel → to_thread).
def _append(line: str) -> None:
    """Écrit une ligne sur le bus sous verrou, avec rotation. Best-effort :
    jamais d'exception sur un chemin d'annulation (le worker local a déjà agi,
    seule la propagation aux autres est perdue)."""
    try:
        _ensure_runtime_dir()
        if not _file_is_safe(CANCEL_FILE):
            # Fichier préexistant qui n'est pas à nous (ou lisible/écrivable
            # par d'autres comptes) : écrire dedans reviendrait à accepter que
            # n'importe qui y dépose des demandes d'annulation, c'est-à-dire
            # tue les générations des utilisateurs. On renonce à la
            # propagation ; le worker local, lui, a déjà agi.
            logger.error("[cancel_bus] %s n'est pas un fichier sûr — "
                         "propagation cross-worker DÉSACTIVÉE", CANCEL_FILE)
            return
        fd = os.open(str(CANCEL_FILE),
                     os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            try:
                os.write(fd, line.encode("utf-8"))
            finally:
                fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)

        try:
            if CANCEL_FILE.stat().st_size > _MAX_FILE_SIZE_BYTES:
                fd = os.open(str(CANCEL_FILE), os.O_WRONLY)
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX)
                    try:
                        os.ftruncate(fd, 0)
                    finally:
                        fcntl.flock(fd, fcntl.LOCK_UN)
                finally:
                    os.close(fd)
        except OSError:
            pass
    except OSError as exc:
        # Jamais d'exception sur un chemin d'annulation : le worker local a
        # déjà agi, seule la propagation aux autres est perdue.
        logger.warning("[cancel_bus] publish échoué (%r) — annulation locale seule", exc)


# ─────────────────────────────────────────────────────────────────────
#  TAILER — applique les annulations émises par les autres workers
# ─────────────────────────────────────────────────────────────────────

_tailer_task: Optional[asyncio.Task] = None


async def _tail_loop(apply_fn: Callable[[int, str, float], None],
                     child_apply_fn: Optional[Callable[[str, str, float], None]] = None) -> None:
    """Suit le fichier depuis sa fin et applique chaque demande localement.

    ``apply_fn(user_id, chat_id, ts)`` est fourni par ``routes/_state`` : il
    pose le flag et annule la task si elle vit dans CE worker. Il est appelé
    pour toutes les lignes, y compris celles écrites par ce process — c'est
    idempotent, et ``_state`` écarte de lui-même les échos périmés.

    ``child_apply_fn(username, child_id, ts)`` traite les lignes
    ``kind="child"`` (annulation d'UN sous-agent). Aiguillage STRICT : une
    ligne enfant ne doit jamais passer par ``apply_fn``, qui tuerait le tour
    parent — l'inverse exact de ce que le ✕ par-agent doit faire.
    """
    read_pos = 0
    try:
        if CANCEL_FILE.exists():
            read_pos = CANCEL_FILE.stat().st_size
    except OSError:
        read_pos = 0

    # AUDIT 2026-09-01 (passe 5, B12) — même portage que le bus métriques
    # (B6) : stat + open/seek/read à 10 Hz tournaient SUR la boucle. L'I/O
    # part en thread ; l'application des annulations reste sur la boucle
    # (elle touche les registres per-worker et cancel() des tasks).
    def _read_new(pos: int):
        if not CANCEL_FILE.exists():
            return pos, ""
        cur_size = CANCEL_FILE.stat().st_size
        if cur_size < pos:
            pos = 0               # fichier tronqué (rotation)
        if cur_size <= pos:
            return pos, ""
        # errors="replace" (audit 2026-08-02, E9) : un octet
        # corrompu ne doit jamais lever, sinon read_pos n'avance
        # plus (même ligne retentée à l'infini) — la ligne
        # mojibake échouera en JSON et sera sautée.
        with open(CANCEL_FILE, "r", encoding="utf-8", errors="replace") as f:
            f.seek(pos)
            data = f.read()
            return f.tell(), data

    while True:
        try:
            read_pos, new_data = await asyncio.to_thread(_read_new, read_pos)
            for raw in (new_data or "").splitlines():
                line = raw.strip()
                if not line:
                    continue
                uid: Optional[int] = None
                cid: Optional[str] = None
                _who: Optional[str] = None
                _child: Optional[str] = None
                try:
                    payload = json.loads(line)
                    ts = float(payload.get("ts") or 0.0)
                    if payload.get("kind") == "child":
                        _who = str(payload["user"])
                        _child = str(payload["child"])
                    else:
                        uid = int(payload["uid"])
                        cid = str(payload["cid"])
                except (json.JSONDecodeError, KeyError, TypeError, ValueError):
                    continue
                try:
                    if _child is not None:
                        if child_apply_fn is not None and _who is not None:
                            child_apply_fn(_who, _child, ts)
                    elif uid is not None and cid is not None:
                        apply_fn(uid, cid, ts)
                except Exception as exc:
                    logger.warning("[cancel_bus] application échouée: %r", exc)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            # AUDIT 2026-08-02 (E9) — ``except OSError`` seul laissait toute
            # autre exception (ValueError…) s'échapper de la boucle : le
            # tailer mourait DÉFINITIVEMENT (start_cancel_tailer n'est appelé
            # qu'au lifespan, rien ne le relance) et le bouton Stop cessait
            # de fonctionner cross-worker, sans le moindre log d'erreur.
            # WARNING (pas debug) pour rendre l'incident visible.
            logger.warning("[cancel_bus] itération tail échouée: %r", exc)
        await asyncio.sleep(_TAIL_POLL_SEC)


def start_cancel_tailer(
    apply_fn: Callable[[int, str, float], None],
    child_apply_fn: Optional[Callable[[str, str, float], None]] = None,
) -> None:
    """Démarre le tailer sur la boucle courante. Idempotent.

    Appelé une fois par worker depuis le lifespan de server/app.py — et NON
    via ``@app.on_event("startup")``, que Starlette ignore silencieusement
    quand l'app est construite avec ``lifespan=…`` (cf. le même piège
    documenté dans metrics/broadcast.py).

    ``child_apply_fn`` (optionnel) traite les annulations de SOUS-AGENTS ;
    omis, ces lignes sont ignorées (comportement d'avant leur existence).
    """
    global _tailer_task
    if _tailer_task is not None and not _tailer_task.done():
        return
    try:
        _tailer_task = asyncio.get_event_loop().create_task(
            _tail_loop(apply_fn, child_apply_fn))
        logger.info("[cancel_bus] tailer démarré, file=%s pid=%d",
                    CANCEL_FILE, os.getpid())
    except RuntimeError as exc:
        logger.warning("[cancel_bus] pas de boucle d'événements: %r", exc)
