# SPDX-License-Identifier: MIT
"""llm_core._ctx_window — fenêtre de contexte de la CIBLE courante.

Le trou comblé ici (audit 2026-08-01, P0-3)
--------------------------------------------
``_model_info.get_model_context_size()`` interroge le ``/props`` du
llama-server **LOCAL**, quelle que soit la cible réellement utilisée. Sur un
connecteur distant (Anthropic, OpenAI, vLLM cloud…) cela donnait deux
situations, toutes deux fausses :

  • pas de llama-server local → ``ctx_size = 0``. Et 0 ne dégrade pas
    gracieusement : ``enforce_context_budget`` sort immédiatement,
    ``select_prune_keys`` renvoie ``[]``, la porte de compaction ne s'arme
    jamais (``usable = 0``) et le cap d'émission d'un résultat d'outil tombe
    à son PLANCHER (2 400 tokens). Autrement dit : plus aucune gestion de
    contexte, et des sorties d'outils tronquées sans raison, jusqu'au 400 du
    fournisseur ;

  • llama-server local présent → tous les budgets sont calibrés sur le n_ctx
    d'un AUTRE modèle que celui qui répond.

La boucle savait déjà que le n_ctx local ne vaut rien pour une cible distante
— mais elle ne s'en servait que pour MASQUER la jauge d'affichage
(``_gauge_ctx_total``). La mécanique, elle, continuait de l'utiliser.

Ordre de résolution
-------------------
1. cible locale llama.cpp → ``get_model_context_size`` (comportement
   historique, strictement inchangé) ;
2. ``context_window`` déclaré sur le connecteur (``llm_connectors.meta``) —
   l'opérateur a le dernier mot ;
3. table des familles connues (préfixe de nom de modèle) ;
4. env ``LLM_REMOTE_N_CTX`` — échappatoire globale ;
5. 0 = inconnu. Le pipeline reste dégradé, mais c'est désormais TRACÉ
   (log une fois par modèle) au lieu d'être silencieux.
"""
from __future__ import annotations

import logging
import os
import time
from typing import Dict, Optional

logger = logging.getLogger("uvicorn.error")


# ── Familles connues ────────────────────────────────────────────────────────
# Clé = préfixe (minuscules) matché sur le nom de modèle, valeur = fenêtre en
# tokens. Volontairement CONSERVATEUR : mieux vaut sous-estimer (on compacte
# un peu tôt) que sur-estimer (le fournisseur refuse la requête). L'ordre
# compte — le premier préfixe matché gagne, donc les plus spécifiques d'abord.
_KNOWN_WINDOWS = (
    # Anthropic
    ("claude-opus-5", 200_000),
    ("claude-sonnet-5", 200_000),
    ("claude-fable-5", 200_000),
    ("claude-haiku-4-5", 200_000),
    ("claude-opus-4", 200_000),
    ("claude-sonnet-4", 200_000),
    ("claude-haiku-4", 200_000),
    ("claude-3-7", 200_000),
    ("claude-3-5", 200_000),
    ("claude-3", 200_000),
    ("claude-", 200_000),
    # OpenAI
    ("gpt-5", 200_000),
    ("gpt-4.1", 1_000_000),
    ("gpt-4o", 128_000),
    ("gpt-4-turbo", 128_000),
    ("gpt-4", 8_192),
    ("gpt-3.5", 16_385),
    ("o3", 200_000),
    # o1-mini / o1-preview : 128k (le préfixe « o1 » les comptait à 200k →
    # porte de compaction jamais armée avant le 400 du fournisseur).
    ("o1-mini", 128_000),
    ("o1-preview", 128_000),
    ("o1", 200_000),
    # Google
    ("gemini-2", 1_000_000),
    ("gemini-1.5", 1_000_000),
    ("gemini-", 32_768),
    # Ouverts fréquents chez les fournisseurs compatibles OpenAI
    ("qwen3", 131_072),
    ("qwen2.5", 131_072),
    ("qwen2", 32_768),
    ("deepseek-v3", 131_072),
    ("deepseek-r1", 131_072),
    ("deepseek", 65_536),
    ("kimi", 131_072),
    ("moonshot", 131_072),
    ("llama-4", 131_072),
    ("llama-3.3", 131_072),
    ("llama-3.1", 131_072),
    ("llama-3", 8_192),
    ("mistral-large", 131_072),
    ("mixtral", 32_768),
    ("mistral", 32_768),
    ("command-r", 131_072),
    ("grok", 131_072),
)

# Fenêtre par défaut d'un FOURNISSEUR dont les identifiants ne ressemblent à
# aucune famille connue. Sans elle, la fenêtre reste « inconnue » et compaction,
# élagage et budget dur sont INACTIFS sur ce modèle — la panne se manifeste bien
# plus tard, par un 400 du fournisseur en plein tour.
#
# Chiffre volontairement CONSERVATEUR : sous-estimer ne coûte que du contexte
# inutilisé, surestimer coûte le tour. 131 072 est la plus petite fenêtre du
# catalogue gratuit d'OpenCode Zen (les autres vont de 200 k à 1 M) ; un modèle
# précis se déclare sur le connecteur (``context_window``), qui prime.
_PROVIDER_DEFAULT_WINDOWS = {
    "opencode": 131_072,
}

# Modèles déjà tracés « fenêtre inconnue » — un log par modèle, pas par appel.
_warned_unknown: set = set()
# Mémoïsation par (connector_id, model) : la résolution ne dépend que d'eux et
# elle est appelée à chaque tour.
_cache: Dict[tuple, int] = {}
# Horodatage des entrées NÉGATIVES (fenêtre inconnue) : elles expirent —
# cf. resolve_context_window (passe 3 2026-08-31). Les positives sont à vie.
_neg_ts: Dict[tuple, float] = {}
_NEG_TTL_S = 60.0


def _from_known_family(model_id: str) -> int:
    m = (model_id or "").strip().lower()
    if not m:
        return 0
    # Les fournisseurs préfixent souvent (``anthropic/claude-…``,
    # ``accounts/fireworks/models/qwen3-…``) : on teste le nom complet ET le
    # dernier segment.
    candidates = [m]
    if "/" in m:
        candidates.append(m.rsplit("/", 1)[-1])
    for cand in candidates:
        for prefix, win in _KNOWN_WINDOWS:
            if cand.startswith(prefix):
                return win
    # Repli : certains noms portent la fenêtre (``…-128k``, ``…-1m``).
    import re
    mm = re.search(r"[-_](\d+)([km])\b", m)
    if mm:
        try:
            n = int(mm.group(1))
            # Base DÉCIMALE (conservatrice) : « -1m » = 1 000 000 annoncés,
            # pas 1 048 576 (≈ 48k de trop, plus que la marge de compaction).
            return n * (1000 if mm.group(2) == "k" else 1_000_000)
        except (TypeError, ValueError):
            pass
    return 0


def _from_connector(connector_id: Optional[int]) -> int:
    """``context_window`` déclaré sur le connecteur (source d'autorité)."""
    if not connector_id:
        return 0
    try:
        from shared_infra.llm import connectors as _lc
    except Exception:
        return 0
    for getter in ("get_meta", "get_by_id", "get"):
        fn = getattr(_lc, getter, None)
        if not callable(fn):
            continue
        try:
            row = fn(int(connector_id))
        except Exception:
            continue
        if not isinstance(row, dict):
            continue
        for key in ("context_window", "n_ctx", "ctx_size"):
            try:
                v = int(row.get(key) or 0)
            except (TypeError, ValueError):
                v = 0
            if v > 0:
                return v
        meta = row.get("meta")
        if isinstance(meta, dict):
            for key in ("context_window", "n_ctx", "ctx_size"):
                try:
                    v = int(meta.get(key) or 0)
                except (TypeError, ValueError):
                    v = 0
                if v > 0:
                    return v
    return 0


# Fenêtre DÉCLARÉE par connecteur, mémoïsée : ``_from_connector`` lit SQLite
# (1 à 3 requêtes). AUDIT 2026-09-24 (2e passe) — l'étape 1 bis la rejouait à
# CHAQUE tour d'un connecteur llama.cpp, en synchrone dans la boucle
# d'événements : une base verrouillée (écriture WAL concurrente) gelait tout
# le worker, flux SSE des autres utilisateurs compris, pendant le
# ``busy_timeout``. Désormais : lecture dans un thread, résultat gardé
# ``_DECLARED_TTL_S`` (``invalidate_cache``, branchée sur les routes
# connecteur, le purge aussitôt).
_declared: Dict[str, tuple] = {}
_DECLARED_TTL_S = 60.0


async def _declared_window(connector_id: Optional[str]) -> int:
    if not connector_id:
        return 0
    hit = _declared.get(connector_id)
    now = time.monotonic()
    if hit is not None and (now - hit[1]) < _DECLARED_TTL_S:
        return hit[0]
    import asyncio
    try:
        win = await asyncio.to_thread(_from_connector, connector_id)
    except Exception:
        win = 0
    _declared[connector_id] = (win, now)
    return win


def _env_default() -> int:
    try:
        return max(0, int(os.environ.get("LLM_REMOTE_N_CTX") or 0))
    except (TypeError, ValueError):
        return 0


async def resolve_context_window(model_id: Optional[str] = None,
                                 target=None) -> int:
    """Fenêtre de contexte utilisable pour la cible courante, en tokens.

    ``0`` = inconnue (l'appelant dégrade — mais le fait sciemment).

    Ne lève jamais : toute la chaîne de contexte en dépend, une exception ici
    casserait des chats qui fonctionnaient.
    """
    try:
        if target is None:
            from llm_core._target import current_target
            target = current_target()
    except Exception:
        target = None

    # 1. Cible locale llama.cpp : comportement historique (sonde /props).
    if target is None or getattr(target, "is_local_llamacpp", True):
        try:
            from llm_core._model_info import get_model_context_size
            return await get_model_context_size(model_id or "")
        except Exception:
            return 0

    model = (model_id or getattr(target, "model", "") or "").strip()

    # 1 bis. Connecteur llama.cpp (AUDIT 2026-09-16) : une fenêtre DÉCLARÉE
    # sur le connecteur prime ; sinon on lit la VRAIE fenêtre sur SON serveur
    # (``/props``, par slot), comme pour l'intégré — plutôt que de la deviner
    # au nom du modèle. Les caches de ``_model_info`` sont indexés par
    # serveur : aucune collision avec un modèle homonyme de l'intégré.
    if getattr(target, "is_llamacpp", False):
        declared = await _declared_window(getattr(target, "connector_id", None))
        if declared > 0:
            return declared
        try:
            from llm_core._model_info import get_model_context_size
            from llm_core.engines import engine_for_target, use_engine
            with use_engine(engine_for_target(target)):
                live = await get_model_context_size(model)
            if live > 0:
                return live
        except Exception:
            pass
    ck = (getattr(target, "connector_id", None), model)
    hit = _cache.get(ck)
    if hit is not None:
        # AUDIT 2026-08-31 (passe 3) — le résultat NÉGATIF (0) expire : sans
        # ça, déclarer ``context_window`` sur le connecteur — exactement ce
        # que le log demande de faire — restait sans effet jusqu'au
        # redémarrage, et la compaction/élagage restaient morts jusqu'au 400
        # « context length exceeded » du fournisseur. Un positif reste mémoïsé
        # à vie (invalidate_cache, désormais branchée sur les routes
        # connecteur, le purge au besoin).
        if hit > 0:
            return hit
        if (time.monotonic() - _neg_ts.get(ck, 0.0)) < _NEG_TTL_S:
            return 0
        _cache.pop(ck, None)

    win = await _declared_window(getattr(target, "connector_id", None))
    src = "connecteur"
    if win <= 0:
        win = _from_known_family(model)
        src = "famille connue"
    if win <= 0:
        win = _PROVIDER_DEFAULT_WINDOWS.get(getattr(target, "provider_type", "") or "", 0)
        src = "défaut du fournisseur"
    if win <= 0:
        win = _env_default()
        src = "LLM_REMOTE_N_CTX"

    if win > 0:
        _cache[ck] = win
        logger.info("[ctx_window] n_ctx=%d pour '%s' (source : %s)",
                    win, model or "?", src)
        return win

    if model not in _warned_unknown:
        _warned_unknown.add(model)
        logger.warning(
            "[ctx_window] fenêtre de contexte INCONNUE pour '%s' (cible "
            "distante) — compaction, élagage et budget dur restent inactifs "
            "sur ce modèle. Déclarez ``context_window`` sur le connecteur ou "
            "posez LLM_REMOTE_N_CTX.", model or "?",
        )
    _cache[ck] = 0
    _neg_ts[ck] = time.monotonic()
    return 0


def invalidate_cache() -> None:
    """Purge la mémoïsation (changement de connecteur côté admin)."""
    _cache.clear()
    _neg_ts.clear()
    _declared.clear()
    _warned_unknown.clear()
