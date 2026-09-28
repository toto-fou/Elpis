# SPDX-License-Identifier: MIT
"""
backend/llm_params.py
═════════════════════════════════════════════════════════════════════════════
Module central de gestion des paramètres de sampling LLM.

Philosophie
───────────
llama-server expose sur `/props` un objet `default_generation_settings` qui
contient les paramètres de sampling recommandés par l'auteur du GGUF (temp,
top_p, top_k, min_p, pénalités, mirostat, dry_*, xtc_*, etc.). Ces valeurs
sont meilleures que n'importe quel hardcode, car elles sont calibrées pour
le modèle chargé.

Hiérarchie de résolution (du plus prioritaire au moins prioritaire) :
   1. `request_override` — paramètres envoyés par le frontend pour CE chat
      (UI "réglages avancés" par conversation)
   2. `props_defaults`   — `/props.default_generation_settings` de llama.cpp
   3. `HARDCODED_FALLBACK` — valeurs minimales si le serveur est injoignable
      (ne devrait jamais arriver en conditions normales)

Cache
─────
Même stratégie que `get_model_context_size()` dans services.py :
   - pas de TTL
   - invalidé explicitement au load/unload via `invalidate_params_cache()`

Utilisation
───────────
    from shared_infra.llm_params import resolve_sampling

    params = await resolve_sampling(
        model_id="qwen2.5-coder:7b",
        task="chat",
        request_override={"temperature": 0.9},  # optional, from frontend
    )
    payload = {"model": ..., "messages": ..., "stream": True, **params}

Les clés retournées sont directement compatibles avec le body OpenAI/llama.cpp
(`temperature`, `top_p`, `top_k`, `min_p`, `repeat_penalty`, etc.).
"""
from __future__ import annotations

import logging
import time
from typing import Any, Dict, List, Optional, Set

logger = logging.getLogger("uvicorn.error")

# ═════════════════════════════════════════════════════════════════════════════
# LISTE BLANCHE DES PARAMÈTRES ACCEPTÉS
# ═════════════════════════════════════════════════════════════════════════════
# Ne laisse passer que les clés connues — évite qu'un appelant injecte par
# erreur un champ comme "model" ou "messages" via request_override et écrase
# le payload. Toutes les valeurs viennent soit des props de llama.cpp, soit
# de l'override utilisateur après passage dans `_sanitize_override`.

# Sampling de base
_BASE_SAMPLING: Set[str] = {
    "temperature",
    "top_p",
    "top_k",
    "min_p",
    "typical_p",
}

# Pénalités anti-répétition
_PENALTY_PARAMS: Set[str] = {
    "repeat_penalty",
    "repeat_last_n",
    "frequency_penalty",
    "presence_penalty",
}

# Samplers modernes (DRY, XTC, mirostat)
_MODERN_SAMPLING: Set[str] = {
    "dry_multiplier",
    "dry_base",
    "dry_allowed_length",
    "dry_penalty_last_n",
    "xtc_probability",
    "xtc_threshold",
    "mirostat",
    "mirostat_tau",
    "mirostat_eta",
}

# Limites de génération (n_predict est souvent surchargé par tâche)
_GENERATION_LIMITS: Set[str] = {
    "n_predict",
    "max_tokens",  # alias OpenAI
    "seed",
}

# Union de toutes les clés autorisées dans un override utilisateur.
ALLOWED_SAMPLING_KEYS: Set[str] = (
    _BASE_SAMPLING
    | _PENALTY_PARAMS
    | _MODERN_SAMPLING
    | _GENERATION_LIMITS
)

# C2b — clés à NE PAS extraire de /props. ``n_predict``/``max_tokens`` exposés
# par ``/props`` sont des défauts SERVEUR (très souvent ``-1`` = illimité) : les
# recopier comme sampling désactivait le cap défensif de l'app (le garde
# ``if "n_predict" not in sampling`` devenait faux) → génération illimitée →
# dépassement de n_ctx. La longueur de génération ne doit venir QUE d'un override
# utilisateur explicite ou du cap de l'app, jamais des défauts serveur.
_PROPS_EXCLUDE_KEYS: Set[str] = {"n_predict", "max_tokens"}

# ═════════════════════════════════════════════════════════════════════════════
# FALLBACK MINIMAL — utilisé uniquement si /props est injoignable
# ═════════════════════════════════════════════════════════════════════════════
# Ces valeurs sont CONSERVATRICES : elles dégradent légèrement la qualité
# plutôt que de prendre un risque (températures hautes sur un modèle
# incompatible). En pratique, ce fallback ne devrait jamais s'activer :
# /props est disponible sur tous les builds récents de llama.cpp.
HARDCODED_FALLBACK: Dict[str, float] = {
    "temperature": 0.7,   # valeur neutre proche de la moyenne des GGUF
    "top_p":       0.9,
    "top_k":       40,
    "min_p":       0.05,
}

# ═════════════════════════════════════════════════════════════════════════════
# PROFILS DE TÂCHE (surcharges minimales)
# ═════════════════════════════════════════════════════════════════════════════
# Principe : on part des props du modèle et on applique un ajustement
# ciblé pour certaines tâches où le défaut du modèle n'est pas optimal.
# Ces overrides sont APPLIQUÉS AU-DESSUS des props (donc écrasent), mais
# restent SOUS l'override utilisateur (l'utilisateur a toujours le dernier mot).
#
# "chat"     → pas de surcharge, on prend ce que recommande le modèle.
# "tools"    → pas de surcharge non plus : le fine-tuning tool-calling du
#              modèle (Qwen, Llama 3.x) a déjà été calibré pour ces valeurs.
# "thinking" → même logique : le mode thinking est piloté par le modèle lui-
#              même (Qwen3, DeepSeek-R1 …). L'utilisateur a demandé de
#              "laisser le modèle décider", on ne touche donc RIEN ici.
# "infill"   → seul n_predict est borné pour éviter les boucles infinies
#              sur le code completion. Les samplers viennent du modèle.
# "debug"    → max_tokens petit pour les ping de santé / tests rapides.
TASK_PROFILES: Dict[str, Dict[str, Any]] = {
    "chat":     {},
    "tools":    {},
    "thinking": {},
    "infill":   {"n_predict": 256},
    "debug":    {"max_tokens": 50},
}

# ═════════════════════════════════════════════════════════════════════════════
# CACHE
# ═════════════════════════════════════════════════════════════════════════════
# Structure : model_id → dict des paramètres extraits de /props.
# "" (chaîne vide) = clé pour "modèle par défaut" (quand aucun model_id
# n'est spécifié dans la requête chat).

_props_cache: Dict[str, Dict[str, Any]] = {}

# ── TTL des caches dérivés de /props (audit long-run 2026-08-21) ────────────
# Ces caches sont PAR WORKER (in-process) et n'étaient purgés que par
# ``invalidate_params_cache()`` — dont le SEUL appelant réel est l'endpoint
# admin ``POST /admin/cache/invalidate`` (shared_infra/routes/admin/lifecycle),
# servi par UN worker : les N-1 autres gardaient indéfiniment les valeurs de
# l'ancien modèle / de l'ancien binaire llama-server. Le recyclage gunicorn
# (``max_requests``) les rafraîchissait par accident ; il est désactivé depuis
# le 2026-08-21 (règle « recyclage invisible »), donc plus rien ne les périme.
#
# C'est le mécanisme exact du bug des ``*_last_n`` : un worker avait re-sondé
# /props (64), l'autre servait encore le -1 des anciens builds → 400
# intermittents selon le worker qui prenait le tour.
#
# Même valeur que ``_model_info._CTX_CACHE_TTL_S`` : au-delà, le worker
# re-sonde /props (un GET local, servi par le cache HTTP keep-alive) et
# s'auto-cicatrise sans intervention.
_PROPS_CACHE_TTL_S = 300.0
_props_cache_ts: Dict[str, float] = {}


def _cache_fresh(cache_ts: Dict[str, float], key: str) -> bool:
    """True si l'entrée ``key`` a été posée il y a moins de ``_PROPS_CACHE_TTL_S``.

    Une entrée sans horodatage (posée par du code de test qui écrit
    directement dans le dict) est considérée FRAÎCHE : on ne casse pas les
    injections directes, on ne périme que ce qu'on a soi-même daté."""
    ts = cache_ts.get(key)
    if ts is None:
        return True
    return (time.monotonic() - ts) < _PROPS_CACHE_TTL_S


def _engine_key(model_id: Optional[str]) -> str:
    """Clé de cache par (serveur, modèle) — AUDIT 2026-09-16. Inchangée pour
    le serveur intégré ; deux serveurs exposant le même nom de modèle ont
    désormais deux entrées (capacités, template, reprise native)."""
    try:
        from llm_core.engines import current_engine
        return current_engine().cache_key(model_id)
    except Exception:                                           # noqa: BLE001
        return model_id or ""

# Cache : model_id → bool « le modèle supporte le reasoning/thinking ».
# Rempli paresseusement par get_thinking_support(). Purgé en même temps que
# _props_cache (au load/unload de modèle) via invalidate_params_cache().
_thinking_cache: Dict[str, bool] = {}
_thinking_cache_ts: Dict[str, float] = {}

# Cache : model_id → liste des valeurs ``reasoning_effort`` acceptées par le
# chat_template ([] = non supporté). Rempli par get_reasoning_effort_values(),
# purgé avec _props_cache via invalidate_params_cache().
_reasoning_effort_cache: Dict[str, List[str]] = {}
_reasoning_effort_cache_ts: Dict[str, float] = {}

# Cache : model_id → bool « le chat_template honore le kwarg
# ``preserve_reasoning`` » (capacité EXPOSÉE par llama.cpp dans
# /props.chat_template_caps.supports_preserve_reasoning — le serveur a
# réellement rendu le template pour la calculer, c'est donc un signal
# AUTORITAIRE, pas une heuristique). Purgé avec _props_cache via
# invalidate_params_cache().
_preserve_reasoning_cache: Dict[str, bool] = {}
_preserve_reasoning_cache_ts: Dict[str, float] = {}

# Cache : model_id → bool « le serveur accepte ``continue_final_message`` »
# (reprise native d'un dernier message assistant NON fermé — builds llama.cpp
# récents ; cf. llm_core._think_resume). Absent = inconnu → tentative
# OPTIMISTE au premier usage ; False mémorisé après un 4xx (le repli prefill
# prend alors le relais sans re-tenter à chaque tour). Purgé avec _props_cache
# via invalidate_params_cache() (un swap de binaire llama-server passe par un
# reload → re-détection).
_continue_final_cache: Dict[str, bool] = {}
_continue_final_cache_ts: Dict[str, float] = {}


def continue_final_support(model_id: Optional[str]) -> Optional[bool]:
    """Support connu de ``continue_final_message`` pour ce modèle/serveur.

    True/False = résultat mémorisé d'une tentative ; None = jamais tenté
    (l'appelant tente le mode natif d'abord).

    Le mémo EXPIRE (``_PROPS_CACHE_TTL_S``) : un ``False`` posé après un 4xx
    d'un ancien binaire llama-server condamnait sinon la reprise native pour
    toute la vie du worker — c.-à-d. pour toujours depuis que le recyclage
    ``max_requests`` est désactivé."""
    key = _engine_key(model_id)
    if key in _continue_final_cache and not _cache_fresh(_continue_final_cache_ts, key):
        _continue_final_cache.pop(key, None)
        _continue_final_cache_ts.pop(key, None)
        return None
    return _continue_final_cache.get(key)


def note_continue_final_support(model_id: Optional[str], ok: bool) -> None:
    """Mémorise le résultat d'une tentative ``continue_final_message``."""
    _continue_final_cache[_engine_key(model_id)] = bool(ok)
    _continue_final_cache_ts[_engine_key(model_id)] = time.monotonic()


def invalidate_params_cache(model_id: Optional[str] = None) -> None:
    """Invalide le cache des props.

    - `model_id=None`  → vide tout le cache (appelé au load/unload global)
    - `model_id="..."` → vide uniquement l'entrée correspondante
    """
    global _props_cache
    if model_id is None:
        _props_cache = {}
        _props_cache_ts.clear()
        _thinking_cache.clear()
        _thinking_cache_ts.clear()
        _reasoning_effort_cache.clear()
        _reasoning_effort_cache_ts.clear()
        _preserve_reasoning_cache.clear()
        _preserve_reasoning_cache_ts.clear()
        _continue_final_cache.clear()
        _continue_final_cache_ts.clear()
        logger.info("[llm_params] Cache global invalidé.")
    else:
        for _c, _ts in ((_props_cache, _props_cache_ts),
                        (_thinking_cache, _thinking_cache_ts),
                        (_reasoning_effort_cache, _reasoning_effort_cache_ts),
                        (_preserve_reasoning_cache, _preserve_reasoning_cache_ts),
                        (_continue_final_cache, _continue_final_cache_ts)):
            # "" = modèle par défaut : invalidé avec n'importe quel model_id.
            _c.pop(model_id, None); _c.pop("", None)
            _ts.pop(model_id, None); _ts.pop("", None)
            # Entrées d'autres serveurs pour ce nom (« <serveur>|<modèle> »).
            for _k in [k for k in _c if k.endswith("|" + model_id)]:
                _c.pop(_k, None); _ts.pop(_k, None)
        logger.info("[llm_params] Cache invalidé pour model_id=%s", model_id)


# ═════════════════════════════════════════════════════════════════════════════
# EXTRACTION DEPUIS /props
# ═════════════════════════════════════════════════════════════════════════════

def _extract_sampling_from_props(props: Dict[str, Any]) -> Dict[str, Any]:
    """
    Extrait les paramètres de sampling d'une réponse `/props` de llama-server.

    Deux structures sont supportées :

    Structure A (llama-server récent, mode router multi-instance) :
        {
          "role": "router",
          "default_generation_settings": {
            "n_ctx": 32768,
            "params": {
              "temperature": 0.8, "top_p": 0.95, "top_k": 40, ...
            }
          }
        }

    Structure B (builds plus anciens, single-model) :
        {
          "default_generation_settings": {
            "n_ctx": 32768,
            "temperature": 0.8, "top_p": 0.95, ...   ← à plat
          }
        }

    On tente d'abord `default_generation_settings.params` (A), puis fallback
    sur `default_generation_settings` directement (B), puis top-level (vieux).

    Retourne un dict filtré via ALLOWED_SAMPLING_KEYS. Dict vide si la
    structure ne correspond à rien de connu (ex. mode router sans modèle
    chargé, où `params` vaut `null`).
    """
    if not isinstance(props, dict):
        return {}

    # Niveau 1 : default_generation_settings
    gen_settings = props.get("default_generation_settings") or {}
    if not isinstance(gen_settings, dict):
        gen_settings = {}

    # Niveau 2 : default_generation_settings.params (llama-server récent)
    # Si `params` existe ET contient un dict non vide, c'est la source primaire.
    # Si `params` est None (mode router sans modèle) ou absent, on tombe sur
    # la structure plate.
    params_nested = gen_settings.get("params")
    if isinstance(params_nested, dict) and params_nested:
        primary_source = params_nested
    else:
        primary_source = gen_settings

    # Merge : top-level de props (fallback le plus faible) < primary_source
    merged: Dict[str, Any] = {}
    for k, v in props.items():
        if k in ALLOWED_SAMPLING_KEYS and k not in _PROPS_EXCLUDE_KEYS and v is not None:
            merged[k] = v
    for k, v in primary_source.items():
        if k in ALLOWED_SAMPLING_KEYS and k not in _PROPS_EXCLUDE_KEYS and v is not None:
            merged[k] = v

    return merged


# ═════════════════════════════════════════════════════════════════════════════
# NORMALISATION « -1 = tout le contexte » (famille *_last_n)
# ═════════════════════════════════════════════════════════════════════════════
# llama-server récent (≥ b10545 constaté) VALIDE strictement les champs du
# body et rejette en 400 tout *_last_n négatif :
#     « Field 'dry_penalty_last_n': Value must be between 0 <= value <=
#       2147483647, but got -1 »
# alors que « -1 = tout le contexte » est la convention HISTORIQUE de
# llama.cpp — les /props des builds antérieurs annonçaient même -1 comme
# défaut de dry_penalty_last_n. Un -1 resté dans le cache props (rempli sous
# l'ancien binaire), recopié d'un GGUF, ou saisi en override utilisateur
# faisait donc échouer TOUTES les requêtes après un swap de llama-server
# (« Le modèle a refusé la requête telle qu'elle a été construite »).
# On traduit la convention au lieu de la transmettre : INT32_MAX passe la
# validation et le serveur borne de toute façon la fenêtre au contexte —
# même effet que l'ancien -1, accepté par les deux générations de builds.

_LAST_N_SENTINEL_KEYS = ("repeat_last_n", "dry_penalty_last_n")
_INT32_MAX = 2**31 - 1


def _normalize_last_n_sentinels(params: Dict[str, Any]) -> Dict[str, Any]:
    """Mute ``params`` en place : tout *_last_n négatif devient INT32_MAX
    (« tout le contexte » exprimé dans la seule forme que la validation
    stricte des llama-server récents accepte). Retourne ``params``."""
    for key in _LAST_N_SENTINEL_KEYS:
        v = params.get(key)
        if isinstance(v, (int, float)) and not isinstance(v, bool) and v < 0:
            params[key] = _INT32_MAX
    return params


# ═════════════════════════════════════════════════════════════════════════════
# SANITIZATION DE L'OVERRIDE UTILISATEUR
# ═════════════════════════════════════════════════════════════════════════════

def _sanitize_override(override: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Filtre l'override utilisateur : ne garde que les clés autorisées ET
    valide les bornes pour éviter les valeurs qui casseraient le modèle.

    Retourne un dict propre, prêt à être mergé.
    """
    if not override or not isinstance(override, dict):
        return {}

    clean: Dict[str, Any] = {}
    for key, value in override.items():
        if key not in ALLOWED_SAMPLING_KEYS:
            logger.debug("[llm_params] Clé ignorée dans override : %s", key)
            continue
        if value is None:
            continue

        # Validation numérique + bornes de sécurité
        try:
            if key == "temperature":
                v = float(value)
                if 0.0 <= v <= 2.0:
                    clean[key] = v
            elif key in ("top_p", "min_p", "typical_p", "xtc_probability",
                         "xtc_threshold"):
                v = float(value)
                if 0.0 <= v <= 1.0:
                    clean[key] = v
            elif key == "top_k":
                v = int(value)
                if 0 <= v <= 1000:
                    clean[key] = v
            elif key in ("repeat_penalty",):
                v = float(value)
                if 0.5 <= v <= 2.0:
                    clean[key] = v
            elif key in ("frequency_penalty", "presence_penalty"):
                v = float(value)
                if -2.0 <= v <= 2.0:
                    clean[key] = v
            elif key in ("repeat_last_n", "dry_penalty_last_n",
                         "dry_allowed_length", "n_predict", "max_tokens"):
                v = int(value)
                if -1 <= v <= 1_000_000:  # -1 = unlimited (n_predict)
                    clean[key] = v
            elif key in ("dry_multiplier", "dry_base",
                         "mirostat_tau", "mirostat_eta"):
                v = float(value)
                if 0.0 <= v <= 10.0:
                    clean[key] = v
            elif key == "mirostat":
                v = int(value)
                if v in (0, 1, 2):
                    clean[key] = v
            elif key == "seed":
                clean[key] = int(value)
        except (TypeError, ValueError):
            logger.debug("[llm_params] Valeur invalide pour %s : %r", key, value)
            continue

    return clean


# ═════════════════════════════════════════════════════════════════════════════
# RÉSOLUTION PRINCIPALE
# ═════════════════════════════════════════════════════════════════════════════

async def resolve_sampling(
    model_id: Optional[str] = None,
    task: str = "chat",
    request_override: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Résout les paramètres de sampling effectifs pour une requête.

    Args:
        model_id: ID du modèle cible. Si None, prend les props par défaut
                  (utile pour les requêtes sans model spécifique).
        task: "chat" | "tools" | "thinking" | "infill" | "debug" — détermine
              les overrides du profil de tâche.
        request_override: Dict des paramètres envoyés par le frontend pour
              cette requête précise (UI avancée du chat).

    Returns:
        Dict prêt à être mergé dans le payload llama-server :
            {"temperature": 0.7, "top_p": 0.95, ...}
    """
    # 1) PROPS du modèle (avec cache)
    props_params = await _get_cached_props(model_id)

    # 2) FALLBACK si /props injoignable
    if not props_params:
        logger.warning(
            "[llm_params] /props indisponible pour %s — fallback hardcode. "
            "Vérifier que /props?model=<id> renvoie bien default_generation_settings.params",
            model_id or "<default>",
        )
        props_params = dict(HARDCODED_FALLBACK)
    else:
        # Log discret pour confirmer que les vrais params sont appliqués.
        # En DEBUG pour ne pas spammer la prod, mais visible si on passe le
        # logger.error/info. Tu peux augmenter le niveau temporairement.
        logger.debug(
            "[llm_params] Sampling %s : source=props, %d params appliqués",
            model_id or "<default>", len(props_params),
        )

    # 3) Profil de tâche (peut ajouter n_predict, max_tokens, etc.)
    task_profile = TASK_PROFILES.get(task, {})

    # 4) Override utilisateur (par-dessus tout)
    safe_override = _sanitize_override(request_override)

    # Merge final : props < task < user_override
    effective: Dict[str, Any] = {}
    effective.update(props_params)
    effective.update(task_profile)
    effective.update(safe_override)

    # Traduction wire : la convention « -1 = tout le contexte » n'est plus
    # acceptée par la validation stricte des llama-server récents (cf.
    # _normalize_last_n_sentinels). Appliquée en DERNIER : couvre les trois
    # sources (props — y compris un cache rempli sous un ancien binaire —,
    # profil de tâche, override utilisateur).
    return _normalize_last_n_sentinels(effective)


async def _get_cached_props(model_id: Optional[str]) -> Dict[str, Any]:
    """
    Récupère et cache les paramètres extraits de /props pour un modèle.
    Import paresseux de `backend.services` pour éviter un cycle d'import.
    """
    # AUDIT 2026-09-16 — serveur de la CIBLE COURANTE (cf. llm_core.engines) ;
    # clé inchangée pour l'intégré, préfixée par le serveur sinon.
    from llm_core.engines import current_engine
    _eng = current_engine()
    if not _eng.is_llamacpp:
        return {}
    cache_key = _eng.cache_key(model_id)
    if cache_key in _props_cache and _cache_fresh(_props_cache_ts, cache_key):
        return _props_cache[cache_key]

    # Import tardif : services.py importe ce module plus tard dans son exécution,
    # et on veut éviter un cycle à l'import initial.
    try:
        from llm_core import _llama_get  # type: ignore
    except ImportError:
        logger.warning("[llm_params] Impossible d'importer _llama_get")
        return {}

    # llama-server en mode router a besoin du paramètre ?model=xxx pour
    # retourner les props d'UN modèle précis. Sans ce param, il retourne
    # les props du routeur (role="router", params=null) qui ne contiennent
    # pas de samplers exploitables.
    path = "/props"
    if model_id:
        from urllib.parse import quote
        encoded = quote(model_id, safe="")
        props = await _llama_get(f"{path}?model={encoded}", timeout=3.0)
        # Fallback : certains builds single-model ignorent le query param.
        if not props:
            props = await _llama_get(path, timeout=3.0)
    else:
        props = await _llama_get(path, timeout=3.0)

    if not props:
        logger.debug("[llm_params] /props injoignable pour %s", model_id)
        return {}

    extracted = _extract_sampling_from_props(props)
    if extracted:
        _props_cache[cache_key] = extracted
        _props_cache_ts[cache_key] = time.monotonic()
        logger.info(
            "[llm_params] Props cachés pour %s : %d paramètres — %s",
            model_id or "<default>",
            len(extracted),
            ", ".join(sorted(extracted.keys())),
        )
    return extracted


# ═════════════════════════════════════════════════════════════════════════════
# DÉTECTION DE LA CAPACITÉ REASONING / THINKING
# ═════════════════════════════════════════════════════════════════════════════

# Marqueurs présents dans le chat_template des modèles reasoning (Qwen3,
# DeepSeek-R1, QwQ…). C'est le signal le plus fiable : si le template gère
# le reasoning, le modèle sait raisonner.
_THINKING_TEMPLATE_MARKERS = (
    "enable_thinking", "enable_thought", "add_thinking",
    "<think>", "reasoning_content",
)
# Fallback : familles de modèles reasoning reconnaissables au nom, utilisé
# quand /props n'expose pas le chat_template.
_THINKING_NAME_HINTS = (
    "qwen3", "deepseek-r1", "deepseek_r1", "deepseekr1", "r1-distill",
    "qwq", "magistral", "thinking", "reasoning", "-think",
)


def _props_chat_template(props: Dict[str, Any]) -> str:
    """Extrait le chat_template d'une réponse /props (les deux shapes
    llama-server : top-level, ou sous default_generation_settings)."""
    if not isinstance(props, dict):
        return ""
    tmpl = str(props.get("chat_template") or "")
    if not tmpl:
        gs = props.get("default_generation_settings")
        if isinstance(gs, dict):
            tmpl = str(gs.get("chat_template") or "")
    return tmpl


async def _fetch_raw_props(model_id: Optional[str]) -> Dict[str, Any]:
    """GET /props BRUT (avec chat_template), sans passer par _props_cache qui
    ne retient que le sampling. Best-effort : {} si le serveur est injoignable.
    Serveur de la cible courante ; rien si ce n'est pas llama.cpp."""
    try:
        from llm_core.engines import current_engine
        if not current_engine().is_llamacpp:
            return {}
        from llm_core import _llama_get  # type: ignore
        if model_id:
            from urllib.parse import quote
            raw = await _llama_get(
                f"/props?model={quote(model_id, safe='')}", timeout=3.0
            ) or {}
            if not raw:
                raw = await _llama_get("/props", timeout=3.0) or {}
        else:
            raw = await _llama_get("/props", timeout=3.0) or {}
        return raw if isinstance(raw, dict) else {}
    except Exception as e:
        logger.debug("[llm_params] _fetch_raw_props: /props KO (%s)", e)
        return {}


def _detect_thinking_from_props(props: Dict[str, Any],
                                model_id: Optional[str]) -> bool:
    """Heuristique best-effort : le modèle supporte-t-il le reasoning ?

    1. Signal primaire — le chat_template exposé par /props référence le
       reasoning (enable_thinking, <think>, reasoning_content).
    2. Fallback — le nom du modèle matche une famille reasoning connue.
    """
    tl = _props_chat_template(props).lower()
    if any(marker in tl for marker in _THINKING_TEMPLATE_MARKERS):
        return True

    name = (model_id or "").lower()
    return any(hint in name for hint in _THINKING_NAME_HINTS)


async def get_thinking_support(model_id: Optional[str]) -> bool:
    """True si le modèle supporte le reasoning/thinking (best-effort, caché).

    Récupère /props (qui contient le chat_template) et applique
    `_detect_thinking_from_props`. Mis en cache par model_id ; le cache est
    purgé par `invalidate_params_cache` au load/unload de modèle.
    """
    cache_key = _engine_key(model_id)
    if cache_key in _thinking_cache and _cache_fresh(_thinking_cache_ts, cache_key):
        return _thinking_cache[cache_key]

    raw_props = await _fetch_raw_props(model_id)

    result = _detect_thinking_from_props(raw_props, model_id)
    _thinking_cache[cache_key] = result
    _thinking_cache_ts[cache_key] = time.monotonic()
    logger.info("[llm_params] thinking support pour %s : %s",
                model_id or "<default>", result)
    return result


# ═════════════════════════════════════════════════════════════════════════════
# DÉTECTION DU « REASONING EFFORT » (Qwen3.8 et assimilés)
# ═════════════════════════════════════════════════════════════════════════════
# Certains chat_templates (Qwen3.8-27B…) acceptent un niveau d'effort de
# réflexion par requête, passé dans chat_template_kwargs["reasoning_effort"].
# llama.cpp IGNORE le champ OpenAI top-level du même nom : seul le kwarg de
# template agit. La détection lit le chat_template exposé par /props — AUCUNE
# heuristique de nom : un kwarg injecté dans un template qui ne le déclare pas
# est ignoré au mieux, fatal au pire (le template officiel Qwen3.8 lève une
# exception Jinja sur valeur inconnue) ; on n'injecte donc que du sûr.

# Valeurs candidates connues ; la liste PAR MODÈLE est restreinte à celles que
# son template cite littéralement (entre guillemets), pour ne jamais envoyer
# une valeur que le template rejetterait.
_REASONING_EFFORT_KNOWN_VALUES = (
    "none", "minimal", "low", "medium", "high", "xhigh",
)


def _detect_reasoning_effort_from_props(props: Dict[str, Any]) -> List[str]:
    """Valeurs ``reasoning_effort`` supportées par le chat_template ([] si le
    template ne mentionne pas la variable — signal unique, pas de fallback nom).
    """
    tl = _props_chat_template(props).lower()
    if "reasoning_effort" not in tl:
        return []
    vals = [v for v in _REASONING_EFFORT_KNOWN_VALUES
            if f'"{v}"' in tl or f"'{v}'" in tl]
    # Template qui référence la variable sans littéraux détectables (comparaison
    # indirecte…) : repli conservateur sur le trio le plus répandu.
    return vals or ["low", "medium", "high"]


async def get_reasoning_effort_values(model_id: Optional[str]) -> List[str]:
    """Valeurs ``reasoning_effort`` acceptées par le modèle ([] = non supporté).

    Même mécanique que get_thinking_support : /props (chat_template) + cache
    par model_id, purgé par invalidate_params_cache au load/unload.
    """
    cache_key = _engine_key(model_id)
    if cache_key in _reasoning_effort_cache and _cache_fresh(
            _reasoning_effort_cache_ts, cache_key):
        return _reasoning_effort_cache[cache_key]

    raw_props = await _fetch_raw_props(model_id)
    result = _detect_reasoning_effort_from_props(raw_props)
    _reasoning_effort_cache[cache_key] = result
    _reasoning_effort_cache_ts[cache_key] = time.monotonic()
    logger.info("[llm_params] reasoning_effort pour %s : %s",
                model_id or "<default>", result or "non supporté")
    return result


def sanitize_reasoning_effort(
    sampling_override: Optional[Dict[str, Any]],
) -> Optional[str]:
    """Extrait/valide ``reasoning_effort`` d'un sampling_override brut.

    Volontairement HORS d'ALLOWED_SAMPLING_KEYS (ce n'est pas un paramètre de
    sampling llama.cpp mais un kwarg de template) — même traitement que
    thinking_budget_tokens : lu du dict brut, jamais recopié dans le payload
    de sampling. None si absent ou hors valeurs connues.
    """
    if not isinstance(sampling_override, dict):
        return None
    v = sampling_override.get("reasoning_effort")
    if isinstance(v, str):
        v = v.strip().lower()
        if v in _REASONING_EFFORT_KNOWN_VALUES:
            return v
    return None


# ═════════════════════════════════════════════════════════════════════════════
# DÉTECTION DU « PRESERVE REASONING »
# ═════════════════════════════════════════════════════════════════════════════
# Certains chat_templates (Qwen3.8, GLM-4.x…) savent GARDER le bloc <think> des
# tours PASSÉS dans le prompt re-rendu, au lieu de ne conserver que celui du
# tour courant. llama.cpp pilote ça par le kwarg de template
# ``chat_template_kwargs.preserve_reasoning`` (booléen JSON), qui pose en
# contexte Jinja les 4 variables miroir : ``preserve_thinking`` /
# ``clear_thinking`` / ``truncate_history_thinking`` / ``drop_thinking``
# (common/jinja/caps.cpp:22-27). Le drapeau CLI équivalent est
# ``--reasoning-preserve`` — dont le défaut documenté est « template default »
# (common/arg.cpp:3441-3452) : SANS kwarg, c'est le template qui tranche.
#
# ⚠ Ce n'est PAS un paramètre de sampling : il change les BYTES du prompt.
#    Le basculer en cours de conversation invalide le préfixe KV à partir du
#    1er message assistant (mesuré : ~6× de préfill sur le tour de bascule).
#
# Détection : la capacité est exposée telle quelle par llama.cpp dans
# /props → ``chat_template_caps.supports_preserve_reasoning``. Le serveur
# l'obtient en RENDANT réellement le template avec un marqueur de raisonnement
# et en vérifiant qu'il ressort (caps.cpp:470-495) : signal autoritaire. Repli
# pour les builds antérieurs à ``chat_template_caps`` : marqueurs dans le
# chat_template.
_PRESERVE_REASONING_TEMPLATE_MARKERS = (
    "preserve_thinking", "clear_thinking",
    "truncate_history_thinking", "drop_thinking",
)


def _detect_preserve_reasoning_from_props(props: Dict[str, Any]) -> bool:
    """True si le chat_template honore ``preserve_reasoning``.

    Signal PRIMAIRE : ``/props.chat_template_caps.supports_preserve_reasoning``
    (calculé par llama.cpp en rendant le template — autoritaire). Repli
    (builds sans ``chat_template_caps``) : une des 4 variables miroir citée
    par le template.
    """
    if not isinstance(props, dict):
        return False
    caps = props.get("chat_template_caps")
    if isinstance(caps, dict) and "supports_preserve_reasoning" in caps:
        return bool(caps.get("supports_preserve_reasoning"))
    tl = _props_chat_template(props).lower()
    return any(m in tl for m in _PRESERVE_REASONING_TEMPLATE_MARKERS)


async def get_preserve_reasoning_support(model_id: Optional[str]) -> bool:
    """True si le modèle accepte le kwarg ``preserve_reasoning`` (caché).

    Même mécanique que get_reasoning_effort_values : /props + cache par
    model_id, purgé par invalidate_params_cache au load/unload.
    """
    cache_key = _engine_key(model_id)
    if cache_key in _preserve_reasoning_cache and _cache_fresh(
            _preserve_reasoning_cache_ts, cache_key):
        return _preserve_reasoning_cache[cache_key]

    raw_props = await _fetch_raw_props(model_id)
    result = _detect_preserve_reasoning_from_props(raw_props)
    _preserve_reasoning_cache[cache_key] = result
    _preserve_reasoning_cache_ts[cache_key] = time.monotonic()
    logger.info("[llm_params] preserve_reasoning pour %s : %s",
                model_id or "<default>", result)
    return result


def sanitize_preserve_reasoning(
    sampling_override: Optional[Dict[str, Any]],
) -> Optional[bool]:
    """Extrait/valide ``preserve_reasoning`` d'un sampling_override brut.

    TRI-ÉTAT : None = clé absente/invalide → aucun kwarg envoyé, le template
    garde son défaut (= comportement historique, aucune régression) ; True /
    False = choix EXPLICITE de l'utilisateur. Hors d'ALLOWED_SAMPLING_KEYS
    comme reasoning_effort : c'est un kwarg de template, jamais un sampler,
    il ne doit pas fuiter dans le payload de sampling.
    """
    if not isinstance(sampling_override, dict):
        return None
    v = sampling_override.get("preserve_reasoning")
    if isinstance(v, bool):
        return v
    return None


# ═════════════════════════════════════════════════════════════════════════════
# DEBUG / INTROSPECTION
# ═════════════════════════════════════════════════════════════════════════════

def describe_effective_params_degraded(
    model_id: Optional[str] = None,
    task: str = "chat",
) -> Dict[str, Any]:
    """Variante SANS RÉSEAU de ``describe_effective_params`` : aucun accès
    ``/props`` (lire /props d'un modèle non chargé le CHARGERAIT sur un
    llama-server router — invariant model-select-no-autoload) ni détection
    thinking.

    Sert le panneau sampling quand les valeurs du modèle sont indisponibles :
    modèle local NON chargé, ou modèle d'un CONNECTEUR (cloud). Les overrides
    par chat (max_tool_iterations, temperature…) s'appliquent sans /props —
    seule la colonne « modèle » de l'UI reste vide. ``supports_thinking`` est
    inconnu (None) : le front décide (toggle affiché pour les connecteurs)."""
    task_profile = TASK_PROFILES.get(task, {})
    from ._constants import (
        LLAMA_MAX_TOOL_ITERATIONS,
        LLAMA_THINKING_BUDGET_TOKENS,
    )
    return {
        "model_id": model_id,
        "task": task,
        "degraded": True,
        "supports_thinking": None,
        # Inconnu sans /props (même invariant no-autoload) : None, et pas de
        # valeurs → le front n'affiche PAS le sélecteur d'effort en dégradé.
        "supports_reasoning_effort": None,
        "reasoning_effort_values": [],
        # Idem : sans /props on ne sait pas si le template honore le kwarg
        # → None, le front masque le toggle « Raisonnement conservé ».
        "supports_preserve_reasoning": None,
        "supports_continue_final_message": None,
        "sources": {
            "props":         {},
            "task_profile":  task_profile,
            "user_override": {},
        },
        "effective":     dict(task_profile),
        "param_sources": {k: "task_profile" for k in task_profile},
        "agent_defaults": {
            "max_tool_iterations":    LLAMA_MAX_TOOL_ITERATIONS,
            "thinking_budget_tokens": LLAMA_THINKING_BUDGET_TOKENS,
        },
    }


async def describe_effective_params(
    model_id: Optional[str] = None,
    task: str = "chat",
    request_override: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Version verbose de `resolve_sampling` : retourne la décomposition source
    par source, utile pour un endpoint admin ou pour le debug.

    Retourne :
        {
          "model_id": "...",
          "task": "chat",
          "sources": {
            "props":           {...},   # ce qu'expose /props
            "task_profile":    {...},   # overrides du profil
            "user_override":   {...},   # override utilisateur (filtré)
          },
          "effective": {...},           # résultat final
          "param_sources": {            # pour chaque clé, d'où vient la valeur
            "temperature": "user_override",
            "top_p":       "props",
            "n_predict":   "task_profile",
          }
        }
    """
    # AUDIT 2026-08-23 — drapeau EXPLICITE de dégradation. Le repli
    # construisait une COPIE (``dict(...)``), donc le test d'identité plus bas
    # (``is not HARDCODED_FALLBACK``) était vrai dans TOUS les cas : la valeur
    # « fallback » ne pouvait jamais être produite, et le panneau Sampling
    # affichait « modèle : 0.7 / 0.9 / 40 / 0.05 » comme s'il s'agissait des
    # valeurs calibrées du GGUF. Cas atteignable sans panne franche : en mode
    # routeur sans modèle chargé, ``params`` vaut null, le serveur répond 200,
    # et la route non dégradée est empruntée. L'utilisateur calait ses
    # réglages sur des chiffres inventés.
    _props_reels = await _get_cached_props(model_id)
    _props_degrade = not _props_reels
    props_params = _props_reels or dict(HARDCODED_FALLBACK)
    task_profile = TASK_PROFILES.get(task, {})
    safe_override = _sanitize_override(request_override)
    supports_thinking = await get_thinking_support(model_id)
    reasoning_effort_values = await get_reasoning_effort_values(model_id)
    preserve_reasoning_ok = await get_preserve_reasoning_support(model_id)

    # Défauts agent/reasoning réels (config), surfacés pour que l'UI n'affiche
    # plus de littéraux figés. Ni max_tool_iterations ni thinking_budget_tokens
    # ne font partie d'ALLOWED_SAMPLING_KEYS → ils n'apparaissent pas dans
    # `effective`; on n'expose ici que le DÉFAUT, pas une valeur résolue. Import
    # local : garde `_llm_params` sans dépendance de module au chargement.
    from ._constants import (
        LLAMA_MAX_TOOL_ITERATIONS,
        LLAMA_THINKING_BUDGET_TOKENS,
    )

    effective: Dict[str, Any] = {}
    sources: Dict[str, str] = {}

    for k, v in props_params.items():
        effective[k] = v
        sources[k] = "fallback" if _props_degrade else "props"
    for k, v in task_profile.items():
        effective[k] = v
        sources[k] = "task_profile"
    for k, v in safe_override.items():
        effective[k] = v
        sources[k] = "user_override"

    # Même traduction wire que resolve_sampling (« -1 = tout le contexte » →
    # INT32_MAX) : le panneau affiche la valeur RÉELLEMENT envoyée. Les
    # ``sources`` restent brutes — elles documentent la provenance.
    _normalize_last_n_sentinels(effective)

    return {
        "model_id": model_id,
        "task": task,
        "supports_thinking": supports_thinking,
        "supports_reasoning_effort": bool(reasoning_effort_values),
        "reasoning_effort_values": reasoning_effort_values,
        # Capacité /props.chat_template_caps : pilote l'affichage du toggle
        # « Raisonnement conservé » dans le panneau sampling.
        "supports_preserve_reasoning": preserve_reasoning_ok,
        # Observabilité seule (aucune dépendance UI) : True/False = résultat
        # mémorisé d'une tentative de reprise native, None = jamais tenté.
        "supports_continue_final_message": continue_final_support(model_id),
        # Vrai quand /props n'a rien donné : les valeurs de ``sources.props``
        # sont alors nos défauts, pas ceux du modèle. Le panneau doit dire
        # « défaut » et non « modèle » — sinon le correctif reste invisible.
        "props_unavailable": _props_degrade,
        "sources": {
            "props":         props_params,
            "task_profile":  task_profile,
            "user_override": safe_override,
        },
        "effective":     effective,
        "param_sources": sources,
        "agent_defaults": {
            "max_tool_iterations":    LLAMA_MAX_TOOL_ITERATIONS,     # config, déf 200
            "thinking_budget_tokens": LLAMA_THINKING_BUDGET_TOKENS,  # config, déf 8192
        },
    }
