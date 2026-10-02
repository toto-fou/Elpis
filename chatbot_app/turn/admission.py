# SPDX-License-Identifier: MIT
"""
chatbot_app.turn.admission — gardes d'entrée d'un tour : verrou de
présence (« une génération à la fois par conversation », valable pour tous
les workers) et compactions manuelles en vol.

Le verrou est pris par le handler, dernier point où l'on peut encore
répondre 409, puis réservé ici jusqu'à ce que ``run_turn`` le réclame ;
une réservation jamais réclamée (client parti avant le premier octet) est
relâchée par un filet ou par le balayage suivant.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Optional

from fastapi import HTTPException

from shared_infra.routes._state import is_chat_cancelled

logger = logging.getLogger("uvicorn.error")


# ── Verrous de présence RÉSERVÉS par le handler, pas encore réclamés ────────
# La garde « une seule génération par chat » doit être
# posée DANS LE HANDLER (c'est le seul endroit qui peut encore répondre 409),
# alors que le verrou est relâché par ``unregister_chat_task``, à la fin de
# ``run_turn``. Entre les deux, une fenêtre : si le client se déconnecte avant la
# PREMIÈRE itération du générateur, son corps n'est jamais exécuté (fermer un
# générateur non démarré ne déroule aucun ``finally``) et le fd resterait
# ouvert pour la vie du process — le chat répondrait 409 pour toujours.
# On garde donc les fd réservés ici ; ``run_turn`` les RÉCLAME à son entrée, et
# tout ce qui n'a pas été réclamé au bout du TTL est relâché (balayage
# opportuniste à chaque nouvelle requête de flux, pas de reaper dédié).
_pending_gen_locks: "dict[tuple, tuple]" = {}
_PENDING_GEN_LOCK_TTL_S = 120.0
# Attente max d'une PASSATION : « éditer un message puis régénérer » envoie un
# Stop et re-POSTe dans la foulée, pendant que le run stoppé déroule encore son
# annulation (il tient le verrou). Répondre 409 là-dessus casserait un geste
# parfaitement normal — on attend donc l'unwind, mais seulement si un Stop a
# bien été demandé sur ce chat, et jamais indéfiniment.
_HANDOVER_WAIT_S = 12.0


# Délai du filet par verrou réservé : ``run_turn`` démarre en
# quelques millisecondes quand le client est là ; au-delà, personne ne le
# réclamera plus.
_PENDING_GEN_LOCK_WATCHDOG_S = 30.0


def _release_unclaimed_gen_lock(key: tuple, entry: tuple) -> None:
    """Relâche CE verrou réservé s'il n'a toujours pas été réclamé (même
    entrée : une réservation plus récente pour le même chat n'est pas
    touchée)."""
    if _pending_gen_locks.get(key) is not entry:
        return
    _pending_gen_locks.pop(key, None)
    try:
        from shared_infra.runtime import chat_locks as _cl
        _cl.release(entry[0])
    except Exception:  # noqa: BLE001 — relâche au mieux, l'entrée est déjà retirée
        pass
    logger.warning(
        "[chat_stream] verrou de présence réservé jamais réclamé (client "
        "parti avant le flux) — relâché par le filet : %r", key)


def _sweep_pending_gen_locks() -> None:
    """Relâche les verrous réservés que ``run_turn`` n'a jamais réclamés."""
    if not _pending_gen_locks:
        return
    import time as _t
    now = _t.monotonic()
    for _k, (_fd, _ts) in list(_pending_gen_locks.items()):
        if now - _ts > _PENDING_GEN_LOCK_TTL_S:
            _pending_gen_locks.pop(_k, None)
            try:
                from shared_infra.runtime import chat_locks as _cl
                _cl.release(_fd)
            except Exception:  # noqa: BLE001 — relâche au mieux, l'entrée est déjà retirée
                pass
            logger.warning(
                "[chat_stream] verrou de présence réservé jamais réclamé "
                "(client déconnecté avant le flux) — relâché : %r", _k)


def _handover_rebaseline_ok(old, fresh) -> bool:
    """Le chat relu après une passation ne diffère-t-il de la base lue que
    par le PARTIEL du run stoppé ? Accepté : identique, un assistant tronqué
    (``isTruncated``) ajouté en queue, ou le dernier assistant remplacé par
    un tronqué (Stop pendant un « Continuer »)."""
    old = old if isinstance(old, list) else []
    fresh = fresh if isinstance(fresh, list) else []
    if fresh == old:
        return True

    def _trunc(m) -> bool:
        return (isinstance(m, dict) and m.get("role") == "assistant"
                and bool(m.get("isTruncated")))

    if not fresh or not _trunc(fresh[-1]):
        return False
    if len(fresh) == len(old) + 1:
        return fresh[:-1] == old
    if len(fresh) == len(old) and old and (old[-1] or {}).get("role") == "assistant":
        return fresh[:-1] == old[:-1]
    return False


async def _acquire_gen_presence(user_id: int, chat_id: str,
                                waited_out: Optional[list] = None):
    """Prend le verrou de présence « gen » pour ce chat, ou lève 409.

    Retourne le fd (ou ``None`` si le verrouillage est indisponible —
    fail-open de ``chat_locks``, l'appelant continue sans garde).

    ``waited_out`` : reçoit ``True`` quand le verrou n'a
    été obtenu qu'après une PASSATION (attente de l'unwind d'un run stoppé).
    Ce run a pu persister son partiel pendant l'attente : l'appelant doit
    relire l'état du chat avant sa garde optimiste.
    """
    from shared_infra.runtime import chat_locks as _cl
    # Prises HORS de la boucle : ``acquire`` dort jusqu'à 3 × 2 ms pour
    # distinguer une sonde d'un vrai détenteur.
    fd = await _cl.acquire_async("gen", user_id, chat_id)
    if fd is not None:
        return fd
    # Le fail-open se décide sur l'état du DOSSIER de verrous, jamais sur
    # ``is_held`` : le détenteur peut relâcher entre ``acquire`` et la sonde
    # (ou une sonde occuper le verrou), et « pas tenu » conclurait à tort
    # « verrouillage indisponible » — run lancé SANS verrou. Un ``acquire``
    # refusé sur un dossier sain = verrou tenu.
    _usable = getattr(_cl, "lock_dir_usable", None)
    if (not _usable()) if _usable is not None else (not _cl.is_held("gen", user_id, chat_id)):
        # Verrouillage indisponible (/tmp inutilisable) : fail-open, comme
        # partout ailleurs — on ne bloque pas l'app sur un défaut de spool.
        return None
    # Verrou tenu. PASSATION ? seulement si un Stop a été demandé sur ce chat
    # (le flag est diffusé à tous les workers par le cancel_bus).
    if is_chat_cancelled(user_id, chat_id):
        import time as _t
        _deadline = _t.monotonic() + _HANDOVER_WAIT_S
        while _t.monotonic() < _deadline:
            await asyncio.sleep(0.2)
            fd = await _cl.acquire_async("gen", user_id, chat_id)
            if fd is not None:
                if waited_out is not None:
                    waited_out.append(True)
                return fd
    else:
        # Détenteur qui vient de relâcher (fin de run à l'instant) : une
        # dernière tentative avant de répondre 409.
        fd = await _cl.acquire_async("gen", user_id, chat_id)
        if fd is not None:
            return fd
    raise HTTPException(409, "generation_running")

# Compressions MANUELLES en vol : {(user_id, chat_id)}. Cache LOCAL au worker,
# doublé d'un verrou de présence PARTAGÉ (``shared_infra.runtime.chat_locks``) : le set
# seul est aveugle aux autres workers gunicorn, et un /compact concurrent sur
# le même chat passerait au lieu de répondre 409. La concurrence optimiste
# (``expected_updated_at``) empêcherait la perte de données, mais en
# sacrifiant le tour : conflit au persist → réponse NON sauvegardée. Le
# pré-vol existe exactement pour éviter ça.
_manual_compressions: set = set()
# fd du verrou partagé tant que la compaction tourne, par clé.
_manual_compression_fds: dict = {}

def _manual_compression_active(user_id: int, chat_id: str) -> bool:
    """Une compaction manuelle tourne-t-elle sur ce chat, DANS N'IMPORTE QUEL
    worker ?"""
    if (user_id, chat_id) in _manual_compressions:
        return True
    try:
        from shared_infra.runtime import chat_locks
        return chat_locks.is_held("compact", user_id, chat_id)
    except Exception:  # noqa: BLE001 — verrouillage indisponible : fail-open, comme chat_locks
        return False


def _manual_compression_begin(user_id: int, chat_id: str) -> None:
    """Marque la compaction en vol (local + verrou partagé)."""
    _manual_compressions.add((user_id, chat_id))
    try:
        from shared_infra.runtime import chat_locks
        fd = chat_locks.acquire("compact", user_id, chat_id)
        if fd is not None:
            _manual_compression_fds[(user_id, chat_id)] = fd
    except Exception:  # noqa: BLE001 — verrouillage indisponible : le marqueur local reste
        pass


def _manual_compression_end(user_id: int, chat_id: str) -> None:
    """Fin de compaction : libère le local ET le verrou partagé."""
    _manual_compressions.discard((user_id, chat_id))
    try:
        from shared_infra.runtime import chat_locks
        chat_locks.release(_manual_compression_fds.pop((user_id, chat_id), None))
    except Exception:  # noqa: BLE001 — fin de compaction : le fd quitte le registre quoi qu'il arrive
        _manual_compression_fds.pop((user_id, chat_id), None)
