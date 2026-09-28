# SPDX-License-Identifier: MIT
"""
llm_core._scheduling._engines — un ordonnanceur PAR SERVEUR llama.cpp.

AUDIT 2026-09-16 — l'ordonnanceur (exclusivité de modèle, parallélisme par
slots, disjoncteur) décrit UN llama-server : un nombre de modèles en mémoire,
``-np`` slots, une santé de transport. Il n'existait que pour le serveur
intégré ; toute autre cible le sautait. Un connecteur llama.cpp partait donc
sans aucune file : dix conversations sur un serveur à deux slots s'empilaient
dans sa file interne, les caches KV s'évinçaient mutuellement, et le widget ne
disait rien.

:func:`scheduling_for` rend le couple ``(exclusivité, gestionnaire)`` d'un
serveur :

* intégré ⇒ les singletons historiques ``MODEL_EXCLUSIVITY`` / ``LLM_SEMAPHORE``
  (aucun changement) ;
* connecteur llama.cpp ⇒ une paire DÉDIÉE, créée à la première demande :
  verrou distribué dans son propre espace de clés Redis, gestionnaire
  dimensionné par les réglages du connecteur (migration 0019 :
  ``max_models`` défaut 1, ``max_concurrency`` défaut 1 puis ``total_slots``
  découvert sur SON ``/props``).

Un changement de réglage côté admin remplace le gestionnaire (les acquisitions
en vol se libèrent sur l'ancien) ; le verrou d'exclusivité est conservé.
"""
from __future__ import annotations

import threading
import time
from typing import Any, Dict, Tuple

_REGISTRY: Dict[str, Tuple[Tuple[int, int], Any, Any]] = {}
_LOCK = threading.Lock()
# Réglages relus au plus toutes les N secondes par serveur : cette fonction
# est appelée à chaque appel LLM de la boucle d'outils.
_LIMITS_TTL_S = 5.0
_limits_seen: Dict[str, Tuple[float, Tuple[int, int]]] = {}


def _limits(engine) -> Tuple[int, int]:
    now = time.monotonic()
    hit = _limits_seen.get(engine.key)
    if hit is not None and (now - hit[0]) < _LIMITS_TTL_S:
        return hit[1]
    from llm_core.engines import engine_limits
    mm, mc = engine_limits(engine)
    val = (max(1, int(mm or 1)), max(1, int(mc or 1)))
    _limits_seen[engine.key] = (now, val)
    return val


def scheduling_for(engine) -> Tuple[Any, Any]:
    """``(verrou d'exclusivité, gestionnaire de concurrence)`` du serveur."""
    if engine is None or engine.is_builtin:
        from llm_core._scheduling._concurrency import LLM_SEMAPHORE
        from llm_core._scheduling._locks import MODEL_EXCLUSIVITY
        return MODEL_EXCLUSIVITY, LLM_SEMAPHORE
    from llm_core._scheduling._concurrency import LLMConcurrencyManager
    from llm_core._scheduling._locks import DistributedModelExclusivityLock
    limits = _limits(engine)
    with _LOCK:
        hit = _REGISTRY.get(engine.key)
        if hit is not None and hit[0] == limits:
            return hit[1], hit[2]
        excl = hit[1] if hit is not None else DistributedModelExclusivityLock(
            namespace=engine.key)
        sem = LLMConcurrencyManager(limits[0], limits[1], engine_key=engine.key)
        _REGISTRY[engine.key] = (limits, excl, sem)
        return excl, sem


def _effective_model(model, target=None):
    """Modèle EFFECTIVEMENT servi quand l'appelant n'en nomme pas : même
    résolution que les chemins de génération (``model_override or
    _target.model or LLAMA_MODEL``)."""
    if model:
        return model
    try:
        if target is None:
            from llm_core._target import current_target
            target = current_target()
        if getattr(target, "model", None):
            return target.model
    except Exception:                                           # noqa: BLE001
        pass
    try:
        from shared_infra.config import LLAMA_MODEL
        return LLAMA_MODEL or model
    except Exception:                                           # noqa: BLE001
        return model


def breaker_key(engine, model, target=None) -> str:
    """Clé du disjoncteur : le nom du modèle pour l'intégré (inchangé),
    préfixé par le serveur sinon — la panne d'un serveur ne doit pas ouvrir
    le circuit du modèle homonyme d'un autre.

    AUDIT 2026-09-24 — un ``model`` absent est résolu vers le modèle
    effectif. Le garde (``allow``) le passait tel quel (``None`` →
    ``__default__``) alors que les échecs s'inscrivent sous le modèle résolu
    (``… or LLAMA_MODEL``) : le circuit d'une requête sans modèle ne
    s'ouvrait jamais, et ``record_success`` ne purgeait pas les échecs."""
    model = _effective_model(model, target)
    if engine is None or engine.is_builtin:
        return model
    return engine.cache_key(model)


def forget(engine_key: str) -> None:
    """Oublie un serveur (connecteur supprimé).

    Passe robustesse 2026-09-24 — jamais appelée jusqu'ici : chaque
    connecteur supprimé gardait, pour toute la vie du worker, son verrou
    d'exclusivité et la tâche d'abonnement Redis (pub/sub) qui va avec.
    Appelable depuis un thread (routes ``def``) : l'annulation de la tâche
    est confiée à SA boucle."""
    with _LOCK:
        entry = _REGISTRY.pop(engine_key, None)
    _limits_seen.pop(engine_key, None)
    excl = entry[1] if entry else None
    task = getattr(excl, "_sub_task", None)
    if task is not None and not task.done():
        try:
            task.get_loop().call_soon_threadsafe(task.cancel)
        except RuntimeError:          # boucle déjà fermée
            pass


def forget_connector(connector_id) -> None:
    """``forget`` d'un connecteur par son id (routes de suppression)."""
    try:
        from llm_core.engines import connector_key
        forget(connector_key(connector_id))
    except (TypeError, ValueError):
        pass
