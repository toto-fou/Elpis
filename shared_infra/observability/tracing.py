# SPDX-License-Identifier: MIT
"""
shared_infra.observability.tracing — Rendre comptables les erreurs qu'on choisit d'ignorer.

Le constat
==========
Sur les 2 072 blocs ``except`` du back, **534 avalent l'erreur en silence**
(corps réduit à ``pass``). Une bonne partie est légitime : un ``ALTER TABLE``
de migration idempotente, un import optionnel, un ``unlink`` de nettoyage. Le
reste — environ 306 cas — dissimule des défaillances réelles dont personne ne
sait si elles se produisent, ni à quelle fréquence.

Le problème n'est pas d'avoir avalé l'erreur : c'est souvent la bonne décision
(une métrique perdue ne doit pas casser une conversation). Le problème est de
l'avoir fait **sans laisser de trace**, ce qui rend impossible la seule
question qui compte : « est-ce que ça arrive ? »

Le parti pris
=============
On instrumente AVANT de trancher. ``swallow`` ne change strictement rien au
flot de contrôle : l'exception reste avalée, exactement comme avant. Elle est
seulement comptée, et journalisée en DEBUG avec sa pile. Le risque de
régression est nul par construction, et on obtient enfin la donnée qui permettra
de requalifier les cas au mérite, un par un.

Usage
=====
Remplacer::

    try:
        conn.execute(...)
    except Exception:
        pass

par::

    with swallow("db.metric_insert"):
        conn.execute(...)

Le tag est libre mais doit être stable et hiérarchique (``domaine.action``) :
c'est la clé d'agrégation du palmarès exposé à l'admin.

Ce que ``swallow`` n'attrape PAS
================================
``BaseException`` passe au travers — donc ``asyncio.CancelledError``,
``KeyboardInterrupt`` et ``SystemExit`` continuent de remonter. Avaler une
annulation transformerait un arrêt propre en tâche zombie ; c'est exactement le
genre de bug que ce module cherche à faire remonter, pas à créer.
"""
from __future__ import annotations

import logging
import threading
import time
from contextlib import contextmanager
from typing import Any, Dict, Iterator, List, Optional

logger = logging.getLogger("uvicorn.error")

# tag → {"n", "last_ts", "last_type", "last_msg"}
_counts: Dict[str, Dict[str, Any]] = {}
_lock = threading.Lock()

# Garde-fou : un tag est censé être un littéral posé dans le code, donc leur
# nombre est borné par le source. Si un appelant en fabrique dynamiquement (un
# chemin de fichier, un ID d'utilisateur…), le registre grossirait sans fin —
# on plafonne, et le dépassement est lui-même un signal.
_MAX_TAGS = 500


@contextmanager
def swallow(tag: str, *, level: int = logging.DEBUG) -> Iterator[None]:
    """Avale l'exception du bloc, en la comptant et en la journalisant.

    Équivalent strict de ``try: ... except Exception: pass``, à la trace près.
    """
    try:
        yield
    except Exception as exc:      # BaseException passe : cf. docstring du module
        record(tag, exc)
        logger.log(level, "[swallow] %s : %s", tag, exc, exc_info=True)


def record(tag: str, exc: BaseException) -> None:
    """Comptabilise une exception avalée. N'échoue jamais."""
    try:
        with _lock:
            slot = _counts.get(tag)
            if slot is None:
                if len(_counts) >= _MAX_TAGS:
                    slot = _counts.setdefault("__overflow__",
                                              {"n": 0, "last_ts": 0.0,
                                               "last_type": "", "last_msg": ""})
                else:
                    slot = _counts[tag] = {"n": 0, "last_ts": 0.0,
                                           "last_type": "", "last_msg": ""}
            slot["n"] += 1
            slot["last_ts"] = time.time()
            slot["last_type"] = type(exc).__name__
            slot["last_msg"] = str(exc)[:200]
    except Exception:
        # Une comptabilité qui casse le chemin qu'elle observe serait pire que
        # l'absence de comptabilité.
        pass


def snapshot(limit: Optional[int] = None) -> List[Dict[str, Any]]:
    """Palmarès des tags déclenchés, du plus fréquent au moins fréquent.

    Compteurs PAR PROCESS et en mémoire : ils repartent de zéro au
    redémarrage, et en multi-worker chaque worker a les siens. C'est
    volontaire — l'objectif est de savoir CE QUI se déclenche et à quel ordre
    de grandeur, pas de tenir une comptabilité durable.
    """
    with _lock:
        rows = [{"tag": tag, **slot} for tag, slot in _counts.items()]
    rows.sort(key=lambda r: (-r["n"], r["tag"]))
    return rows[:limit] if limit else rows


def reset() -> None:
    """Vide le registre (tests, et bouton de remise à zéro côté admin)."""
    with _lock:
        _counts.clear()
