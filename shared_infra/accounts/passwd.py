# SPDX-License-Identifier: MIT
"""
shared_infra.accounts.passwd — sortir le hachage de mot de passe de la boucle.

Le problème, mesuré
-------------------
``_hash_password`` fait un PBKDF2-HMAC-SHA256 à **150 000 itérations** : c'est
un choix de sécurité délibéré et il ne bouge pas ici. Il coûte **87 ms de CPU
pur** sur cette machine. Or ses appelants sont des handlers ``async def``
— FastAPI les exécute **directement sur la boucle d'événements**, pas dans le
pool de threads. Pendant ces 87 ms, le worker ne fait donc STRICTEMENT rien
d'autre : ni streaming de chat, ni SSE, ni la moindre requête des autres
utilisateurs.

Conséquences concrètes :

- plafond de **11,5 connexions/s par worker**, pendant lesquelles tout le reste
  est gelé — une arrivée groupée le matin suffit à faire hoqueter l'appli ;
- le module ``routes/auth.py`` documente que la limitation de débit sur le
  login a été **retirée** (déléguée à l'ACL réseau). Un bourrage
  d'identifiants depuis l'extérieur n'a donc rien à casser : il lui suffit
  d'envoyer des logins pour figer la boucle.

Ce que fait ce module
---------------------
Il déporte l'opération sur un pool de threads **dédié et petit**. PBKDF2 relâche
le GIL, le parallélisme est donc réel.

Pourquoi un pool dédié plutôt que ``asyncio.to_thread`` : ``to_thread`` puise
dans le pool par défaut d'anyio (40 jetons) — celui-là même qu'utilisent les
**196 routes synchrones** de l'application. Une rafale de connexions y
consommerait tous les jetons et bloquerait alors tout le reste, c'est-à-dire
exactement le symptôme qu'on cherche à supprimer. Avec un pool séparé, une
rafale ne peut dégrader que… les connexions.

Dimensionnement : ``APP_PWHASH_THREADS``, **un seul thread par défaut**.

Ce n'est pas de la timidité, c'est une mesure. Sous 16 clients qui enchaînent
les connexions (tests/load, 3 workers, VM 4 cœurs) :

    | threads/worker | connexions/s | p50 connexion | p50 témoin | p99 témoin | CPU |
    |---|---|---|---|---|---|
    | 1 | 26,6 | 564 ms | **14,3 ms** | **166,7 ms** | 63,5 % |
    | 2 | 31,8 | 445 ms | 30,2 ms | 277,2 ms | 81,2 % |
    | 4 | 38,3 | 376 ms | 49,3 ms | 322,3 ms | 84,6 % |

Élargir le pool achète du débit de connexion en le facturant à **tous les
autres utilisateurs** : de 1 à 4 threads, la latence médiane du témoin est
multipliée par 3,4. Or le parallélisme utile est déjà fourni par les workers —
3 workers × 1 thread = 3 hachages simultanés, soit trois des quatre cœurs, en
laissant de quoi servir le reste. Une rafale se met alors en file d'attente au
lieu de prendre la machine.

En usage normal (une connexion à la fois), la valeur n'a aucun effet : le
hachage coûte ses 87 ms, et c'est tout.
"""
from __future__ import annotations

import asyncio
import functools
import os
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Optional, TypeVar

T = TypeVar("T")

_DEFAULT_THREADS = 1

_lock = threading.Lock()
_executor: Optional[ThreadPoolExecutor] = None
_executor_pid: Optional[int] = None


def _max_workers() -> int:
    try:
        n = int(os.environ.get("APP_PWHASH_THREADS", "") or _DEFAULT_THREADS)
    except (TypeError, ValueError):
        n = _DEFAULT_THREADS
    return max(1, min(n, 16))


def _get_executor() -> ThreadPoolExecutor:
    """Pool créé à la demande, et **par PID**.

    Créé paresseusement pour deux raisons : les outils en ligne de commande qui
    importent ``shared_infra`` n'ont aucune raison de payer des threads, et
    gunicorn fabrique ses workers par ``fork`` — les threads d'un pool créé
    avant le fork ne survivraient pas à l'enfant, qui hériterait d'un pool aux
    files intactes mais sans personne pour les vider. La garde sur le PID rend
    ce cas inoffensif même si l'ordre d'import changeait un jour.
    """
    global _executor, _executor_pid
    pid = os.getpid()
    if _executor is not None and _executor_pid == pid:
        return _executor
    with _lock:
        if _executor is None or _executor_pid != pid:
            _executor = ThreadPoolExecutor(
                max_workers=_max_workers(), thread_name_prefix="pwhash")
            _executor_pid = pid
    return _executor


async def run_password_op(fn: Callable[..., T], *args: Any, **kwargs: Any) -> T:
    """Exécute une opération coûteuse en CPU hors de la boucle d'événements.

    Le contrat de ``fn`` est **inchangé** : mêmes arguments, même valeur de
    retour, mêmes exceptions (elles traversent le future et sont relevées à
    l'``await``). Seul le fil d'exécution change.
    """
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        _get_executor(), functools.partial(fn, *args, **kwargs))


def shutdown(wait: bool = False) -> None:
    """Ferme le pool (tests, arrêt applicatif). Idempotent."""
    global _executor, _executor_pid
    with _lock:
        ex, _executor, _executor_pid = _executor, None, None
    if ex is not None:
        ex.shutdown(wait=wait)
