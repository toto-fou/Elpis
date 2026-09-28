# SPDX-License-Identifier: MIT
"""
backend.services._queue — LLM queue-status tracker for the chat UI widget.

Purpose
-------
The frontend shows a discreet "file d'attente" widget under the chat input
when EITHER:
  - a model switch is needed (requested model ≠ currently-loaded model), OR
  - all slots of the currently-loaded model are occupied.

The chat handler emits an SSE ``queue_status`` event at the top of the
streaming generator if either condition holds. The widget displays
estimated wait time. As soon as the LLM produces its first token the
``content_token`` event auto-hides the widget client-side, so the data
here only needs to be approximately correct for the first few seconds.

Estimation strategy
-------------------
A sliding-window mean of the last ``_RECENT_LLM_DURATIONS_MAX`` durations
observed for that model, biased upward by 20 % to under-promise. Tracker
state is purely in-process — multi-worker deployments under-estimate
slightly because each worker only sees its own runs, but the visible-only-
on-first-second nature of the widget makes that acceptable.

Public surface
--------------
- ``record_llm_duration(model, duration_ms)`` — call from chat handlers
  on every successful generation.
- ``record_model_load_duration(model, duration_ms)`` — call from the
  loader on every successful model load (informs estimates when a switch
  is needed).
- ``estimate_single_run_ms(model)`` — read accessor.
- ``get_queue_status_for(model)`` — sync; uses the local snapshot only.
- ``get_queue_status_for_async(model)`` — async; uses the cluster-wide
  Redis snapshot when available. Prefer this in async code paths.
- ``_build_queue_status(...)`` — internal helper; exported because some
  test code uses it directly.

The module-level dicts ``_RECENT_LLM_DURATIONS`` and ``_MODEL_LOAD_TIME_MS``
are exported too for the same reason.
"""
from __future__ import annotations

import logging
from collections import deque as _deque
from typing import Any, Dict, Optional

from shared_infra.config import LLAMA_MODEL
from llm_core._capabilities import _LLAMA_CAPABILITIES

logger = logging.getLogger("uvicorn.error")


# Late imports — these come from sibling submodules of ``backend.services``.
# They live behind functions so the import order in ``__init__.py`` cannot
# create a cycle.
def _llm_semaphore():
    """Gestionnaire du serveur de la CIBLE COURANTE (AUDIT 2026-09-16) :
    l'intégré hors tour de chat, le connecteur llama.cpp visé sinon."""
    from llm_core._scheduling._engines import scheduling_for
    from llm_core.engines import current_engine
    return scheduling_for(current_engine())[1]


def _model_exclusivity():
    from llm_core._scheduling._engines import scheduling_for
    from llm_core.engines import current_engine
    return scheduling_for(current_engine())[0]



_RECENT_LLM_DURATIONS: Dict[str, "_deque[float]"] = {}
_RECENT_LLM_DURATIONS_MAX = 20
_MODEL_LOAD_TIME_MS: Dict[str, int] = {}  # mesure réelle des switch de modèle
_DEFAULT_ESTIMATE_MS = 15_000             # fallback si pas encore de data


def _duration_key(model: Optional[str]) -> str:
    """Clé des estimations : le nom du modèle pour l'intégré, préfixé par le
    serveur sinon (AUDIT 2026-09-16 — deux serveurs, même nom, débits
    différents)."""
    name = model or LLAMA_MODEL or "default"
    try:
        from llm_core.engines import current_engine
        return current_engine().cache_key(name)
    except Exception:                                           # noqa: BLE001
        return name


def record_llm_duration(model: Optional[str], duration_ms: float) -> None:
    """Alimente le tracker de durées. Appelé en fin de chaque génération
    LLM réussie pour affiner l'estimation future."""
    key = _duration_key(model)
    dq = _RECENT_LLM_DURATIONS.get(key)
    if dq is None:
        dq = _deque(maxlen=_RECENT_LLM_DURATIONS_MAX)
        _RECENT_LLM_DURATIONS[key] = dq
    if duration_ms > 0:
        dq.append(float(duration_ms))


def estimate_single_run_ms(model: Optional[str]) -> int:
    """Estimation en ms d'une génération sur ce modèle (moyenne glissante
    + marge 20%). Retourne ``_DEFAULT_ESTIMATE_MS`` si pas encore de data."""
    key = _duration_key(model)
    dq = _RECENT_LLM_DURATIONS.get(key)
    if not dq:
        return _DEFAULT_ESTIMATE_MS
    avg = sum(dq) / len(dq)
    return int(avg * 1.2)


def record_model_load_duration(model: str, duration_ms: float) -> None:
    """Alimente l'estimation du coût de chargement pour un modèle donné."""
    if model and duration_ms > 0:
        _MODEL_LOAD_TIME_MS[model] = int(duration_ms)


async def get_queue_status_for_async(model: Optional[str]) -> Dict[str, Any]:
    """Async variant of :func:`get_queue_status_for` — preferred in async
    contexts because it uses the distributed Redis snapshot, which sees
    locks held by ALL workers (not just this one).

    Sync code can keep calling :func:`get_queue_status_for` for backward
    compat, but in multi-worker deployments that view is incomplete.
    """
    # AUDIT 2026-08-31 (passe 3) — cible DISTANTE : la file et l'exclusivité
    # ne concernent que le moteur LOCAL. On sondait quand même le /v1/models
    # du llama-server local (jusqu'à 5 s de TTFT si le port est filtré) et on
    # comparait le modèle CLOUD au modèle local chargé → needs_switch_llama
    # ⇒ widget « chargement » + load-watcher pour un modèle que le moteur
    # local ne chargera jamais. Court-circuit : un connecteur distant est
    # toujours « ready » du point de vue de la file locale.
    #
    # AUDIT 2026-09-16 — la file vaut pour tout serveur llama.cpp, chacun la
    # sienne (``_llm_semaphore`` / ``_model_exclusivity`` et l'inventaire
    # ``model_statuses`` suivent la cible). Seules les cibles qui ne sont pas
    # llama.cpp restent « toujours prêtes ».
    try:
        from llm_core.engines import current_engine
        if not current_engine().is_llamacpp:
            return {"kind": "ready", "model": model or ""}
    except Exception:
        pass
    target = model or LLAMA_MODEL or "default"

    # Niveau 1 : snapshot distribué via Redis (vue cluster)
    try:
        if hasattr(_model_exclusivity(), "snapshot_async"):
            excl = await _model_exclusivity().snapshot_async()
        else:
            excl = _model_exclusivity().snapshot()
        excl_model = excl.get("current_model")
        excl_count = excl.get("active_count", 0)
    except Exception:
        excl_model = None
        excl_count = 0
    # Vue AUTORITAIRE du moteur quand il sait répondre (routeur b10545+) :
    # « quel modèle est chargé » cesse d'être une déduction. Best-effort,
    # cache de 3 s : aucun coût en régime nominal. La variante SYNC garde son
    # comportement (pas de réseau depuis un contexte sync).
    _loaded_engine = None
    try:
        from llm_core.engines import current_engine
        _builtin = current_engine().is_builtin
    except Exception:                                           # noqa: BLE001
        _builtin = True
    try:
        from llm_core.providers.llama_models import model_statuses
        _st = await model_statuses()
        if _st:
            # AUDIT 2026-08-23 — ``""`` n'est pas ``None`` : il écrasait notre
            # cache tout en rendant ``needs_switch_llama`` faux, donc « ready »
            # alors qu'un chargement complet est justement imminent
            # (configuration ``autoload=false`` du routeur). On distingue
            # explicitement « le moteur répond, rien n'est chargé ».
            # Plusieurs modèles chargés (routeur, LLAMA_MAX_MODELS > 1) : la
            # CIBLE, si elle en fait partie — le premier venu annonçait un
            # faux « chargement » (audit 2026-09-24, 2e passe).
            _charges = [m for m, v in _st.items() if v == "loaded"]
            _loaded_engine = (target if target in _charges
                              else (_charges[0] if _charges else None))
            if _loaded_engine is None:
                _loaded_engine = _RIEN_DE_CHARGE
    except Exception:
        _loaded_engine = None
    return _build_queue_status(target, excl_model, excl_count, _loaded_engine,
                               use_builtin_caps=_builtin)


def get_queue_status_for(model: Optional[str]) -> Dict[str, Any]:
    """Construit le dict ``queue_status`` à envoyer au frontend.

    Trois cas possibles dans le champ ``kind`` :
      - ``"ready"``    : slot libre, modèle chargé → rien à afficher
      - ``"waiting"``  : tous les slots sont occupés par d'autres requêtes
                         sur le même modèle
      - ``"loading"``  : le modèle demandé n'est pas celui actuellement
                         chargé en VRAM OU quelqu'un d'autre utilise un
                         modèle différent (switch en attente côté Python)

    Les deux derniers déclenchent le widget côté frontend. Le timestamp
    ``est_ms`` est une estimation éclairée, pas une promesse.

    .. note::
        En multi-worker, cette version sync ne voit que les locks de CE
        worker (pas du cluster). Préférer :func:`get_queue_status_for_async`
        dans tout contexte async pour avoir la vue Redis complète.
    """
    target = model or LLAMA_MODEL or "default"

    # ── Niveau 1 : _model_exclusivity() (vue locale, snapshot sync) ──────────
    try:
        excl = _model_exclusivity().snapshot()
        excl_model = excl.get("current_model")
        excl_count = excl.get("active_count", 0)
    except Exception:
        excl_model = None
        excl_count = 0
    return _build_queue_status(target, excl_model, excl_count)


# Sentinelle : « le moteur a répondu, AUCUN modèle n'est chargé ». Distincte
# de ``None`` (« on ne sait pas ») et de ``""`` (qui était pris pour « on ne
# sait pas » tout en écrasant le cache).
_RIEN_DE_CHARGE = object()


def _build_queue_status(target, excl_model, excl_count,
                       loaded_override=None, *,
                       use_builtin_caps: bool = True) -> Dict[str, Any]:
    """Shared body for sync/async queue status builders.

    ``loaded_override`` : modèle réellement chargé d'après le MOTEUR
    (``GET /models`` d'un llama-server routeur). Jusqu'ici on ne disposait que
    de notre propre cache (``_LLAMA_CAPABILITIES``), alimenté par nos propres
    appels : au démarrage d'un worker, ou après un swap déclenché par un autre
    worker, il ment. Le widget annonçait alors « chargement » à tort — ou se
    taisait pendant un vrai chargement.
    """
    # Quelqu'un d'autre détient le lock sur un modèle différent
    needs_switch_excl = bool(excl_model and excl_model != target)

    # ── Niveau 2 : probe llama-server (secondaire) ────────────────────────
    # Fallback si _model_exclusivity() n'a pas encore de référence (début de
    # vie du process) : on check aussi ce que llama rapporte être chargé.
    caps = _LLAMA_CAPABILITIES
    if loaded_override is _RIEN_DE_CHARGE:
        # Le moteur a répondu et n'a RIEN en VRAM : servir ``target`` exige un
        # chargement complet. C'est un « loading », pas un « ready ».
        loaded = None
        needs_switch_llama = True
    else:
        # ``_LLAMA_CAPABILITIES`` décrit le serveur INTÉGRÉ : jamais de repli
        # dessus pour un autre serveur (il annoncerait le modèle de l'intégré).
        loaded = (loaded_override if loaded_override is not None
                  else (caps.get("loaded_model") if use_builtin_caps else None))
        needs_switch_llama = bool(loaded and loaded != target)
    needs_switch = needs_switch_excl or needs_switch_llama

    # ── Occupation des slots côté Python (saturation même-modèle) ─────────
    # AUDIT 2026-08-23 — ce bloc lisait ``stats["per_model"]``, une clé que
    # ``LLMConcurrencyManager.get_stats()`` n'a JAMAIS produite (elle en rend
    # cinq : max_models, max_conversations_per_model_config_fallback,
    # total_slots_from_props, active_models, slot_waiters — vérifié aussi sur
    # le commit de base : ce lecteur n'a jamais eu de producteur). Le ``or {}``
    # avalait l'absence sans bruit, donc ``active = waiting = 0`` en
    # permanence : ``position = waiting + 1`` valait TOUJOURS 1 et ``est_ms``
    # une seule génération. Le 5e utilisateur d'une file lisait « 1 requête en
    # cours · vous êtes 1er · ~15 s » alors qu'il attendait derrière quatre
    # générations. On dérive désormais des clés qui EXISTENT.
    try:
        stats = _llm_semaphore().get_stats() or {}
        _actifs = stats.get("active_models") or []
        active = sum(int(e.get("holders") or 0) for e in _actifs
                     if isinstance(e, dict) and e.get("model") == target)
        _waiters = stats.get("slot_waiters") or []
        waiting = sum(1 for w in _waiters
                      if isinstance(w, dict) and w.get("model") == target
                      and not w.get("cancelled"))
    except Exception:
        active = 0
        waiting = 0
    is_full = _llm_semaphore().locked_for(target) if hasattr(_llm_semaphore(), "locked_for") else False

    # Construction du status
    if not needs_switch and not is_full:
        return {"kind": "ready"}

    single_run_ms = estimate_single_run_ms(target)

    # Position : si switch nécessaire, on est derrière TOUS les actifs de
    # l'autre modèle. Sinon, derrière les waiting du même modèle.
    if needs_switch_excl:
        # Attente que les excl_count requêtes en cours sur l'autre modèle
        # finissent toutes. Leur durée reflète l'ancien modèle, approximée
        # par l'estimation du nôtre (meilleure heuristique dispo).
        position = excl_count + 1
        est_ms = single_run_ms * excl_count
        kind = "loading"
    elif needs_switch_llama:
        # Cas dégradé : llama dit "autre modèle chargé" mais personne ne
        # détient le lock (bug ou probe obsolète). On met position=1.
        position = 1
        est_ms = 0
        kind = "loading"
    else:
        # Saturation pure (même modèle, tous slots occupés)
        position = waiting + 1
        est_ms = single_run_ms * position
        kind = "waiting"

    if kind == "loading":
        load_ms = _MODEL_LOAD_TIME_MS.get(target, _DEFAULT_ESTIMATE_MS)
        est_ms += load_ms

    return {
        "kind":      kind,
        "model":     target,
        "loaded":    loaded or excl_model,  # priorité à l'info locale
        "position":  position,
        "active":    max(active, excl_count, 1),
        "est_ms":    int(est_ms),
    }
