# SPDX-License-Identifier: MIT
"""
backend.services._model_info — Cached model introspection for llama-server.

Two caches and the helpers that maintain them:

  - ``_cached_context_size`` (n_ctx)        — set by ``get_model_context_size``,
                                                refreshed via /props
  - ``_cached_total_slots``  (-np value)    — set by ``get_model_total_slots``,
                                                refreshed via /props

Both are populated lazily on first request and live for the lifetime of
the worker. They're invalidated by ``invalidate_*_cache`` helpers, called
from ``_model_lifecycle`` whenever a model is loaded/unloaded.

``invalidate_all_model_caches`` is the one-shot reset used by the admin
"Invalidate caches" button. It also flushes:
  - ``backend.services._llm_params._props_cache`` (sampling profiles)
  - ``backend.services._legacy._VISION_CAPABILITY_CACHE`` (vision capability)
The vision cache is mutated in place via the ``_legacy`` module reference
(it lives there as the single source of truth, also imported by
``_vision.py``).
"""
from __future__ import annotations

import logging
import os
import time
from typing import Any, Dict, Optional
from urllib.parse import quote

from llm_core._health import _parse_prometheus_metrics
from llm_core._llama_http import _llama_get, _llama_get_text
from llm_core.engines import current_engine

logger = logging.getLogger("uvicorn.error")


# ── Cache du contexte modèle ─────────────────────────────────────────────────
# BUG FIX (multi-modèle) — avant, c'était un SCALAIRE global : le 1er modèle
# interrogé peuplait le cache, et TOUT appel ultérieur (autre modèle) renvoyait
# CETTE valeur sans comparer le ``model_id``. En mode router (LLAMA_MAX_MODELS>1)
# ou avec deux users sur deux modèles concurrents, le n_ctx d'un modèle 8K était
# renvoyé pour un modèle 32K (et inversement) → budget/compression/_enforce
# calculés sur la mauvaise fenêtre → débordement n_ctx OU élagage trop agressif.
# L'invalidation sur changement de modèle (_model_lifecycle) ne couvrait que le
# mono-modèle séquentiel. On cache désormais PAR modèle (clé "" = défaut/sans filtre).
_cached_context_size: Dict[str, int] = {}   # model_id ("" = défaut) → n_ctx/slot
_cached_context_size_ts: Dict[str, float] = {}   # model_id → monotonic du dernier set

# F21 — TTL du cache n_ctx : le cache est PAR WORKER (in-process). Un opérateur
# qui redémarre llama-server avec un ``-c`` différent (à clé de modèle identique)
# puis « Invalider les caches » (endpoint admin) n'atteint QU'UN worker uvicorn ;
# les autres gardaient l'ancien n_ctx indéfiniment → budget/compression calculés
# sur la mauvaise fenêtre. Un TTL borne cette dérive : chaque worker re-sonde
# /props au plus tard après ``_CTX_CACHE_TTL_S`` (auto-cicatrisation cross-worker,
# sans signal partagé). Le n_ctx d'un modèle chargé ne bougeant pas en régime
# normal, le coût = un /props par worker/modèle toutes les N minutes.
_CTX_CACHE_TTL_S = 300.0


def _set_ctx_cache(key: str, val: int) -> None:
    _cached_context_size[key] = val
    _cached_context_size_ts[key] = time.monotonic()


async def _autoload_suffix() -> str:
    """``"&autoload=false"`` quand le moteur sait sonder SANS charger, ``""``
    sinon.

    ⚠ Le paramètre est ce qui empêche une simple sonde de faire monter 27 Go
    en VRAM (mode routeur, ``models_autoload``). Un build qui ne le connaît
    pas l'ignore — et charge. On ne peut donc pas se contenter de l'envoyer
    au hasard : sans preuve, on retombe sur la sonde historique, qui accepte
    ce risque parce qu'elle n'a jamais eu le choix.
    """
    try:
        from llm_core.providers.llama_caps import engine_caps
        return "&autoload=false" if (await engine_caps()).autoload_param else ""
    except Exception:                               # noqa: BLE001
        return ""


async def get_model_context_size(model_id: Optional[str] = None) -> int:
    """
    Retourne le n_ctx EFFECTIF PAR SLOT de llama-server — c.-à-d. le nombre
    de tokens disponibles pour UNE requête. Mis en cache après le premier
    appel réussi.

    ⚠ Par slot, PAS total. Avec ``-np N`` côté llama-server, le ``-c C``
    passé au lancement est RÉPARTI entre les slots : chaque slot — donc
    chaque requête — ne dispose que de ``C / N`` tokens. C'est cette borne
    par slot qui limite une conversation ; utiliser le ``C`` global pour
    le budget de contexte ferait déborder les longues conversations sur un
    serveur multi-slots.

    Ordre de priorité :
      0. ENV ``LLAMA_N_CTX_PER_SLOT`` — override opérateur. Échappatoire si
         le serveur rapporte une valeur inattendue (versions llama.cpp
         variables).
      1. GET /props → ``default_generation_settings.n_ctx`` — llama.cpp y
         expose le n_ctx DU SLOT (déjà divisé), pas le total. Source fiable.
      2. GET /metrics → ``llamacpp_n_ctx_total`` — métrique TOTALE → on la
         divise par ``total_slots`` pour obtenir le par-slot.

    Retourne 0 si indisponible (l'appelant gère : pas de troncature auto).

    AUDIT 2026-09-16 — interroge le serveur de la CIBLE COURANTE
    (``engines.current_engine``) : l'intégré hors tour de chat, le connecteur
    llama.cpp pendant un tour qui le vise. Serveur non llama.cpp ⇒ 0 sans
    aucun appel (les fenêtres distantes passent par ``_ctx_window``).
    """
    _eng = current_engine()
    if not _eng.is_llamacpp:
        return 0
    _key = _eng.cache_key(model_id)
    _hit = _cached_context_size.get(_key, 0)
    if _hit > 0:
        # F21 — respecte le TTL : au-delà, on re-sonde (le worker peut avoir un
        # n_ctx périmé après un redémarrage llama-server à clé identique).
        _ts = _cached_context_size_ts.get(_key, 0.0)
        if (time.monotonic() - _ts) < _CTX_CACHE_TTL_S:
            return _hit
        # Périmé : purge l'entrée et re-sonde ci-dessous.
        _cached_context_size.pop(_key, None)
        _cached_context_size_ts.pop(_key, None)

    # ── Priorité 0 : override opérateur ──────────────────────────────────
    # Propre au serveur INTÉGRÉ : il ne doit pas écraser la fenêtre réelle
    # d'un autre serveur.
    _override = (os.environ.get("LLAMA_N_CTX_PER_SLOT") or "").strip() \
        if _eng.is_builtin else ""
    if _override:
        try:
            v = int(_override)
            if v > 0:
                _set_ctx_cache(_key, v)
                logger.info(
                    "[context_size] n_ctx/slot=%d (override LLAMA_N_CTX_PER_SLOT)", v
                )
                return v
        except ValueError:
            logger.warning(
                "[context_size] LLAMA_N_CTX_PER_SLOT invalide (%r) — ignoré",
                _override,
            )

    def _extract_n_ctx(props_obj: Dict) -> int:
        """Cherche n_ctx aux endroits possibles de la structure /props.

        ``default_generation_settings.n_ctx`` est le n_ctx du SLOT côté
        llama.cpp (déjà ``-c / -np``), donc directement la valeur par slot
        recherchée.
        """
        if not isinstance(props_obj, dict):
            return 0
        gs = props_obj.get("default_generation_settings") or {}
        if not isinstance(gs, dict):
            return 0
        # Ordre : default_generation_settings.n_ctx (plat) → .params.n_ctx (imbriqué)
        # → top-level (fallback très ancien)
        n = gs.get("n_ctx")
        if not n:
            params = gs.get("params")
            if isinstance(params, dict):
                n = params.get("n_ctx")
        if not n:
            n = props_obj.get("n_ctx")
        try:
            return int(n) if n else 0
        except (TypeError, ValueError):
            return 0

    # Priorité 1 : /props?model=xxx (nécessaire en mode router) — déjà par slot
    #
    # ``autoload=false`` (llama-server b10545+) : SONDER NE CHARGE PLUS. Sans
    # ce paramètre, lire les propriétés d'un modèle déchargé déclenchait son
    # chargement — un effet de bord si contre-intuitif qu'il a fallu interdire
    # la sonde à plusieurs endroits du code (invariant model-select-no-autoload).
    # Sur un modèle déchargé le serveur répond maintenant 400 « model is not
    # loaded » (vérifié en live) et on retombe simplement sur les priorités
    # suivantes. Rien à perdre côté chemin d'exécution : avec un timeout de 3 s,
    # la sonde d'un modèle en cours de chargement expirait de toute façon —
    # elle laissait juste un chargement parasite derrière elle.
    if model_id:
        props = await _llama_get(
            f"/props?model={quote(model_id, safe='')}"
            f"{await _autoload_suffix()}", timeout=3.0)
        if props:
            n_ctx = _extract_n_ctx(props)
            if n_ctx > 0:
                _set_ctx_cache(_key, n_ctx)
                logger.info(
                    "[context_size] n_ctx/slot=%d (via /props?model=%s — déjà par slot)",
                    n_ctx, model_id,
                )
                return n_ctx

    # Priorité 2 : /props sans filtre (single-model build) — déjà par slot
    props = await _llama_get("/props", timeout=3.0)
    if props:
        n_ctx = _extract_n_ctx(props)
        if n_ctx > 0:
            _set_ctx_cache(_key, n_ctx)
            logger.info(
                "[context_size] n_ctx/slot=%d (via /props — déjà par slot)", n_ctx
            )
            return n_ctx

    # Priorité 3 : /metrics → llamacpp_n_ctx_total est le contexte TOTAL du
    # serveur. Le par-slot = total / n_parallel.
    metrics_text = await _llama_get_text("/metrics", timeout=3.0)
    if metrics_text:
        pm = _parse_prometheus_metrics(metrics_text)
        n_ctx_total = int(pm.get("llamacpp_n_ctx_total", 0))
        if n_ctx_total > 0:
            slots = await get_model_total_slots(model_id)
            if slots >= 1:
                # Parallélisme CONNU → par-slot exact, mis en cache.
                per_slot = n_ctx_total // slots
                _set_ctx_cache(_key, per_slot)
                if slots > 1:
                    logger.info(
                        "[context_size] n_ctx/slot=%d (via /metrics : total=%d ÷ %d slots)",
                        per_slot, n_ctx_total, slots,
                    )
                return per_slot
            # F23 — slots INCONNU (0) : NE PAS supposer mono-slot (cacher le
            # TOTAL comme per-slot sur un serveur -np>1 → budget N× trop grand →
            # dépassement de contexte garanti → finish=length). On divise par la
            # concurrence CONFIGURÉE (repli conservateur : sous-estimer élague un
            # peu plus mais ne dépasse JAMAIS) et on NE MET PAS en cache — une
            # reprise de /props (déjà par-slot, prioritaire) corrigera au prochain
            # appel au lieu de figer une valeur fausse.
            try:
                from llm_core.engines import engine_limits
                _div = max(1, int(engine_limits(_eng)[1] or 1))
            except Exception:
                _div = 1
            per_slot = n_ctx_total // _div
            logger.warning(
                "[context_size] n_ctx=%d via /metrics, total_slots INCONNU — repli "
                "conservateur total=%d ÷ concurrence=%d (NON caché). Fixe "
                "LLAMA_N_CTX_PER_SLOT pour un budget exact.",
                per_slot, n_ctx_total, _div,
            )
            return per_slot

    logger.debug("[context_size] n_ctx indisponible — troncature auto désactivée.")
    return 0

def invalidate_context_size_cache(model_id: Optional[str] = None) -> None:
    """Réinitialise le cache n_ctx (à appeler après un changement de modèle).

    Sans argument : vide TOUT le cache (tous modèles) — contrat historique des
    callers existants (_model_lifecycle). Avec ``model_id`` : n'invalide que cette
    entrée (clé "" = défaut)."""
    if model_id is None:
        _cached_context_size.clear()
        _cached_context_size_ts.clear()
    else:
        _cached_context_size.pop(model_id or "", None)
        _cached_context_size_ts.pop(model_id or "", None)

# ── Cache du nombre de slots du modèle ─────────────────────────────────────
# Exposé par llama-server dans /props (champ `total_slots`). Reflète le -np
# passé au lancement. 0 = pas encore récupéré.
_cached_total_slots: int = 0
# Cache PAR MODÈLE + horodatage (audit 2026-08-23) : ``model_id`` → (slots, ts).
# Le scalaire ci-dessus reste la vue « dernier connu », lue directement par
# ``_scheduling/_concurrency`` et ``_health`` — on le tient à jour en parallèle.
_total_slots_cache: "Dict[str, tuple]" = {}

async def get_model_total_slots(model_id: Optional[str] = None) -> int:
    """
    Retourne le nombre de slots parallèles configurés côté llama-server
    (paramètre `-np` du serveur). Mis en cache après le premier appel.

    Sources, dans l'ordre :
      1. /props?model=xxx → total_slots (mode router avec modèle chargé)
      2. /props → total_slots (single-model)
      3. /props → max_instances (mode router sans modèle chargé — approximation
         qui reflète la limite d'instances parallèles côté routeur)

    Retourne 0 si injoignable — l'appelant retombe alors sur la valeur de
    config LLAMA_MAX_CONCURRENCY.

    AUDIT 2026-09-16 — serveur de la CIBLE COURANTE ; le scalaire
    ``_cached_total_slots`` (vue « dernier connu » lue par l'ordonnanceur de
    l'intégré) n'est tenu à jour QUE pour l'intégré.
    """
    global _cached_total_slots
    _eng = current_engine()
    if not _eng.is_llamacpp:
        return 0
    # AUDIT 2026-08-23 — TTL + clé PAR MODÈLE, exactement ce que le cache n_ctx
    # dix lignes plus haut a reçu (F21) et que celui-ci n'avait pas : un
    # scalaire figé au premier appel réussi, pour la vie du worker. Le bouton
    # admin « Invalider les caches » n'atteint qu'UN worker sur N ; passer
    # ``-np 4`` à ``-np 1`` laissait donc les autres autoriser 4 conversations
    # simultanées vers un serveur qui n'en traite qu'une (ReadTimeout, tours
    # figés), et ``resolve_slot_id_async`` pinnait des ``id_slot`` dans [0,4).
    # Le repli ``max_instances`` (limite d'INSTANCES du routeur, pas le -np du
    # serveur enfant) était caché avec la même permanence.
    _mkey = _eng.cache_key(model_id)
    _now = time.monotonic()
    _hit = _total_slots_cache.get(_mkey)
    if _hit and (_now - _hit[1]) < _CTX_CACHE_TTL_S and _hit[0] > 0:
        if _eng.is_builtin:
            _cached_total_slots = _hit[0]
        return _hit[0]
    if (_eng.is_builtin and _cached_total_slots > 0 and _mkey == ""
            and not _total_slots_cache):
        # Valeur posée à la main (tests, injection) : on la respecte.
        return _cached_total_slots

    def _extract_slots(props_obj: Dict) -> int:
        """Cherche total_slots / max_instances dans /props."""
        if not isinstance(props_obj, dict):
            return 0
        for key in ("total_slots", "max_instances"):
            v = props_obj.get(key)
            try:
                if v and int(v) > 0:
                    return int(v)
            except (TypeError, ValueError):
                continue
        return 0

    # Priorité 1 : /props?model=xxx (nécessaire en mode router)
    if model_id:
        props = await _llama_get(
            f"/props?model={quote(model_id, safe='')}"
            f"{await _autoload_suffix()}", timeout=3.0)
        if props:
            total = _extract_slots(props)
            if total > 0:
                if _eng.is_builtin:
                    _cached_total_slots = total
                _total_slots_cache[_mkey] = (total, time.monotonic())
                logger.info("[total_slots] total_slots=%d (via /props?model=%s)", total, model_id)
                return total

    # Priorité 2 : /props sans filtre (single-model ou router sans modèle)
    props = await _llama_get("/props", timeout=3.0)
    if props:
        total = _extract_slots(props)
        if total > 0:
            if _eng.is_builtin:
                _cached_total_slots = total
            _src = "max_instances" if props.get("role") == "router" and not props.get("total_slots") else "total_slots"
            # Le repli ``max_instances`` n'est PAS le ``-np`` du serveur : on
            # le mémorise avec un TTL comme le reste, jamais à vie.
            _total_slots_cache[_mkey] = (total, time.monotonic())
            logger.info("[total_slots] %s=%d (via /props, role=%s)", _src, total, props.get("role", "?"))
            return total

    logger.debug("[total_slots] indisponible — fallback config.")
    return 0

def invalidate_total_slots_cache() -> None:
    """Réinitialise le cache total_slots (à appeler après un changement de modèle)."""
    global _cached_total_slots
    _cached_total_slots = 0
    _total_slots_cache.clear()


# ── Snapshot d'occupation des slots ──────────────────────────────────────────
# Utilisé par resolve_slot_id (_constants.py) pour corriger le défaut du hash
# pur : si le slot préféré d'un chat est déjà occupé par une autre requête, on
# dévie. On expose l'ensemble des slots EN TRAITEMENT, mis en cache avec un TTL
# court — sous charge la plupart des appels lisent le snapshot sans I/O, au
# plus un GET /slots par fenêtre de TTL.
_slots_busy_cache: Optional[frozenset] = None
_slots_busy_ts: float = 0.0
_SLOTS_SNAPSHOT_TTL = 2.0   # secondes
# Indisponibilité mémorisée plus longtemps : /slots absent ne réapparaît pas
# d'une seconde à l'autre, et c'est un chemin chaud (cf. get_busy_slots_snapshot).
_SLOTS_FAIL_TTL = 30.0
# Autres serveurs llama.cpp (connecteurs) : même instantané, par clé de moteur.
# {engine_key: (frozenset|None, ts)}. L'intégré garde les deux scalaires
# ci-dessus (lus et remis à zéro directement par des tests).
_slots_busy_other: Dict[str, tuple] = {}


async def get_busy_slots_snapshot() -> Optional[frozenset]:
    """Renvoie l'ensemble des id de slots actuellement EN TRAITEMENT côté
    llama-server, ou ``None`` si ``/slots`` est indisponible.

    Best-effort : toute erreur → ``None`` → ``resolve_slot_id`` retombe sur
    le hash pur (aucune régression). Le résultat est caché ``_SLOTS_SNAPSHOT_TTL``
    secondes ; en cas d'échec de rafraîchissement on renvoie le dernier
    snapshot connu (qui peut aussi être ``None``).
    """
    global _slots_busy_cache, _slots_busy_ts
    now = time.monotonic()
    _eng = current_engine()
    if not _eng.is_llamacpp:
        return None
    if not _eng.is_builtin:
        return await _busy_slots_other(_eng, now)
    if _slots_busy_cache is not None and (now - _slots_busy_ts) < _SLOTS_SNAPSHOT_TTL:
        return _slots_busy_cache

    # Mode routeur : ``_llama_get`` nomme le modèle CHARGÉ, sans charger
    # (cf. ``_llama_http._per_model_path``) — jamais le modèle par défaut de
    # la config, qu'un routeur à une instance chargerait à la place du bon.
    slots = await _llama_get("/slots", timeout=2.0)

    if not isinstance(slots, list):
        # AUDIT 2026-08-23 — l'échec est MÉMORISÉ. L'horodatage n'était touché
        # que sur le chemin de succès : la garde de TTL (``_slots_busy_cache
        # is not None``) restait fausse tant que le cache valait None, donc
        # l'appel SUIVANT re-sondait immédiatement — et deux fois (/slots nu
        # puis /slots?model=). Or cette fonction est sur le chemin CHAUD
        # (``resolve_slot_id_async`` ← ``build_llama_payload``, à chaque
        # requête LLM et à chaque itération d'outil) : un llama-server lancé
        # sans ``--slots`` produisait 400 requêtes perdues sur une mission de
        # 200 itérations, et sur un serveur qui accepte le TCP sans répondre,
        # 2 s + 2 s de timeout AVANT chaque complétion — ~13 minutes ajoutées.
        # TTL d'échec plus long que celui de succès : rien ne presse quand la
        # route n'existe pas.
        _slots_busy_ts = now + max(0.0, _SLOTS_FAIL_TTL - _SLOTS_SNAPSHOT_TTL)
        if _slots_busy_cache is None:
            _slots_busy_cache = frozenset()
        return _slots_busy_cache

    busy: set = set()
    for s in slots:
        if not isinstance(s, dict):
            continue
        sid = s.get("id")
        if sid is None:
            continue
        # llama.cpp expose selon la version ``is_processing`` (bool) ou
        # ``state`` (1 / "processing" = en cours).
        is_busy = s.get("is_processing")
        if is_busy is None:
            st = s.get("state")
            is_busy = st in (1, "processing", "PROCESSING")
        if is_busy:
            try:
                busy.add(int(sid))
            except (TypeError, ValueError):
                continue

    _slots_busy_cache = frozenset(busy)
    _slots_busy_ts = now
    return _slots_busy_cache

def _parse_busy(slots) -> frozenset:
    busy: set = set()
    for s in slots:
        if not isinstance(s, dict) or s.get("id") is None:
            continue
        is_busy = s.get("is_processing")
        if is_busy is None:
            is_busy = s.get("state") in (1, "processing", "PROCESSING")
        if is_busy:
            try:
                busy.add(int(s["id"]))
            except (TypeError, ValueError):
                continue
    return frozenset(busy)


async def _busy_slots_other(eng, now: float) -> Optional[frozenset]:
    """``get_busy_slots_snapshot`` pour un serveur autre que l'intégré : même
    TTL de succès et d'échec, cache par clé de moteur."""
    hit = _slots_busy_other.get(eng.key)
    if hit is not None and now < hit[1]:
        return hit[0]
    slots = await _llama_get("/slots", timeout=2.0)
    if not isinstance(slots, list):
        snap = hit[0] if hit is not None and hit[0] is not None else frozenset()
        _slots_busy_other[eng.key] = (snap, now + _SLOTS_FAIL_TTL)
        return snap
    snap = _parse_busy(slots)
    _slots_busy_other[eng.key] = (snap, now + _SLOTS_SNAPSHOT_TTL)
    return snap


def invalidate_all_model_caches() -> Dict[str, Any]:
    """
    Invalide tous les caches liés aux modèles en une seule passe.

    Utile quand llama-server est redémarré sans passer par /models/load
    (ce qui est le cas normal côté opérateur : les caches Python gardent
    alors les anciens props d'un modèle qui n'est plus chargé).

    Invalide :
      - _cached_context_size (n_ctx)
      - backend.services._llm_params._props_cache (sampling params par modèle)
      - _VISION_CAPABILITY_CACHE (détection vision par modèle)

    Retourne un dict récapitulatif du nombre d'entrées effacées par cache,
    pratique pour le retour d'un endpoint admin.
    """
    # ``_VISION_CAPABILITY_CACHE`` is owned by ``llm_core._constants`` (the
    # dict object is shared by reference — ``_vision.py`` mutates the same
    # one). We access the module attribute and ``.clear()`` it in place
    # rather than rebinding a local that would only shadow the import.
    from llm_core import _constants as _legacy_state

    global _cached_total_slots, _slots_busy_cache, _slots_busy_ts
    summary: Dict[str, Any] = {}

    # 1. n_ctx (cache PAR modèle depuis le fix multi-modèle → dict, pas scalaire)
    summary["context_size_was_cached"] = bool(_cached_context_size)
    summary["context_size_entries_cleared"] = len(_cached_context_size)
    _cached_context_size.clear()
    _cached_context_size_ts.clear()

    # 2. total_slots (nombre de slots parallèles côté llama-server)
    summary["total_slots_was_cached"] = _cached_total_slots > 0
    summary["total_slots_entries_cleared"] = len(_total_slots_cache)
    _cached_total_slots = 0
    _total_slots_cache.clear()
    _slots_busy_other.clear()
    # Vue « slots occupés » de l'intégré aussi : un échec y est mémorisé
    # 30 s, et « Invalider » laissait l'intégré sans pinning de slot.
    _slots_busy_cache = None
    _slots_busy_ts = 0.0

    # 3. sampling params (delegate au module llm_params)
    try:
        from llm_core._llm_params import _props_cache, invalidate_params_cache
        summary["llm_params_entries_cleared"] = len(_props_cache)
        invalidate_params_cache()
    except ImportError:
        summary["llm_params_entries_cleared"] = 0

    # 4. vision capability
    summary["vision_entries_cleared"] = len(_legacy_state._VISION_CAPABILITY_CACHE)
    _legacy_state._VISION_CAPABILITY_CACHE.clear()

    # 5. fenêtres de contexte des cibles DISTANTES (passe 3 2026-08-31) —
    # ce cache manquait à la passe globale : un ``context_window`` corrigé
    # sur un connecteur restait invisible jusqu'au redémarrage.
    try:
        from llm_core import _ctx_window as _cw
        summary["ctx_window_entries_cleared"] = len(_cw._cache)
        _cw.invalidate_cache()
    except Exception:
        summary["ctx_window_entries_cleared"] = 0

    logger.info(
        "[cache] Invalidation globale : n_ctx=%s, total_slots=%s, llm_params=%d, vision=%d",
        summary["context_size_was_cached"],
        summary["total_slots_was_cached"],
        summary["llm_params_entries_cleared"],
        summary["vision_entries_cleared"],
    )
    return summary
