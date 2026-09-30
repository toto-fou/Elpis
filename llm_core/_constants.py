# SPDX-License-Identifier: MIT
"""
backend.services._constants — Module-level constants shared across services.

Why this file
-------------
A handful of constants used to live in ``backend.services._legacy`` because
they were computed defensively from ``backend.config`` (which itself loads
from environment variables / ``config.json``). Several sibling modules
(``_chat_classic``, ``_chat_with_tools``, ``_vision``, ``_rag``, etc.) and
external callers (``agentic/orchestrator``) imported them from there.

After the v4.x split they have been moved here so that:

  • ``_legacy.py`` no longer needs to define live state — it can become a
    pure re-export shim like ``backend.routes._legacy``.
  • Sibling modules can import the constants WITHOUT crossing through
    ``_legacy`` (less import-cycle surface).

Backward compatibility
----------------------
``backend.services._legacy`` re-exports every name from this module so
existing import sites
``from backend.services._legacy import LLAMA_FORCE_IDLE_SLOT`` keep working
unchanged.
"""
from __future__ import annotations

import os
from typing import Dict, Optional

# ── LLM tuning constants ─────────────────────────────────────────────
# Read defensively from backend.config so partial deployments where
# config.py predates one of these names don't blow up at import.
from shared_infra import config as _bk_config

LLAMA_MAX_MODELS = int(getattr(_bk_config, "LLAMA_MAX_MODELS", 1) or 1)
# Source de vérité = shared_infra.config.LLAMA_MAX_TOOL_ITERATIONS (défaut
# 200, env/config.json/override par-chat via sampling_override). Le fallback
# ici est MORT en pratique (getattr trouve toujours l'attribut) — il doit
# rester ALIGNÉ sur config.py pour ne pas mentir au lecteur : il a longtemps
# affiché 80, faussant de 60 % toute estimation de budget faite d'ici.
LLAMA_MAX_TOOL_ITERATIONS = int(
    getattr(_bk_config, "LLAMA_MAX_TOOL_ITERATIONS", 200) or 200
)
LLAMA_THINKING_BUDGET_TOKENS = int(
    getattr(_bk_config, "LLAMA_THINKING_BUDGET_TOKENS", 8192) or 8192
)
# Borne dure par appel d'outil (cf. shared_infra.config pour la rationale
# et les percentiles mesurés) ; override par-outil via context_config.json
# ``tools.<name>.timeout_s``.
LLAMA_TOOL_TIMEOUT_S = int(getattr(_bk_config, "LLAMA_TOOL_TIMEOUT_S", 300) or 300)

# Multi-slot distribution: when llama-server is launched with -np > 1, it
# dispatches requests by prompt-similarity (-sps 0.5 by default). With shared
# system prompts everybody lands on the same slot → serialization instead of
# parallelism. Sending id_slot=-1 forces llama-server to pick the first idle
# slot (round-robin) rather than hashing by prefix.
# Disable via env var if you'd rather keep cache-hit selection.
LLAMA_FORCE_IDLE_SLOT = os.environ.get(
    "LLAMA_FORCE_IDLE_SLOT", "1"
).strip().lower() not in ("0", "false", "no", "")

# ── Slot pinning by chat_id ──────────────────────────────────────────
# When LLAMA_FORCE_IDLE_SLOT=1, every conversation lands on a different
# slot at every turn → KV cache prefix is lost. We instead pin by a
# stable hash of the chat_id (or run_id for agentic), so the same chat
# returns to the same slot turn after turn → prefix cache HOT.
# Set LLAMA_PIN_SLOT_BY_CHAT=0 to fall back to the old round-robin.
LLAMA_PIN_SLOT_BY_CHAT = os.environ.get(
    "LLAMA_PIN_SLOT_BY_CHAT", "1"
).strip().lower() not in ("0", "false", "no", "")


def resolve_slot_id(
    chat_id: object,
    total_slots: int,
    busy_slots: object = None,
    *,
    avoid_own: bool = False,
) -> int:
    """Calcule l'``id_slot`` à passer à llama-server.

    Args:
        chat_id     : identifiant stable de la conversation (str ou int —
                      run_id agentic peut être un int).
        total_slots : nombre de slots ``-np`` côté llama-server.
        busy_slots  : ensemble (set/frozenset) des id de slots ACTUELLEMENT
                      en traitement côté serveur — cf.
                      ``_model_info.get_busy_slots_snapshot``. ``None`` →
                      comportement historique (hash pur, sans correction).

    Returns:
        - Un entier ``[0, total_slots)`` si on peut pinner cette conv.
        - ``-1`` si on ne peut pas pinner (chat_id absent, total_slots
          inconnu, ou pinning désactivé) → llama-server choisit le slot.

    Pourquoi ``busy_slots`` — correction d'un défaut du hash pur
    ------------------------------------------------------------
    ``sha256(chat_id) % total_slots`` répartit les conversations sur les
    slots de façon DÉTERMINISTE (même chat → même slot à chaque tour, KV
    cache chaud, et c'est stable d'un worker gunicorn à l'autre). Mais des
    hashs indépendants COLLISIONNENT (paradoxe des anniversaires) bien
    avant de saturer les slots : deux chats actifs peuvent tomber sur le
    même slot → ils s'évincent mutuellement le KV ET, en passant le même
    ``id_slot``, la 2e requête QUEUE derrière la 1re (sérialisation)
    pendant que d'autres slots sont idle.

    Avec ``busy_slots`` fourni, on garde le hash comme slot PRÉFÉRÉ (donc
    l'affinité déterministe quand la charge est faible), mais si ce slot
    est occupé par une autre requête on DÉVIE vers un slot libre — choix
    déterministe parmi les libres pour garder une affinité de repli
    stable. Aucune régression : ``busy_slots=None`` → hash pur comme avant.
    """
    if not LLAMA_PIN_SLOT_BY_CHAT:
        return -1 if LLAMA_FORCE_IDLE_SLOT else 0
    if total_slots is None or total_slots <= 1:
        # Un seul slot : pas la peine de hasher
        return -1 if LLAMA_FORCE_IDLE_SLOT else 0
    if chat_id in (None, "", 0):
        # Pas d'ID stable → fallback round-robin
        return -1 if LLAMA_FORCE_IDLE_SLOT else 0
    import hashlib as _hashlib
    _digest = _hashlib.sha256(str(chat_id).encode("utf-8")).hexdigest()
    preferred = int(_digest[:8], 16) % total_slots

    if avoid_own:
        # OPTIM 2026-09-26 — requête ANNEXE d'un chat (titre) : elle ne partage
        # rien avec la conversation et, posée sur le slot du chat, en évinçait
        # le KV — le tour suivant re-préremplissait tout (mesuré : 10 débuts
        # de tour sur 42 à 0 %, ~7 500 tokens chacun, ~35 s à 210 tok/s).
        # Slot LIBRE autre que celui du chat ; aucun → le slot du chat (mieux
        # vaut perdre son propre préfixe que celui d'un run en cours).
        _others = [s for s in range(total_slots)
                   if s != preferred and s not in (busy_slots or ())]
        if _others:
            return _others[int(_digest[8:16], 16) % len(_others)]
        return preferred

    # Pas de données d'occupation → hash pur (comportement historique).
    if not busy_slots:
        return preferred
    # Slot préféré libre → affinité respectée, KV chaud.
    if preferred not in busy_slots:
        return preferred
    # Slot préféré occupé par une AUTRE requête : dévier vers un slot libre
    # plutôt que de queuer derrière elle. Choix déterministe (2e tranche du
    # digest) parmi les libres → le même chat dévie toujours vers le même
    # slot de repli.
    free = [s for s in range(total_slots) if s not in busy_slots]
    if not free:
        # Tous les slots occupés — rien de mieux : on garde le préféré
        # (il queuera, mais au moins l'affinité de base est préservée).
        return preferred
    return free[int(_digest[8:16], 16) % len(free)]


async def resolve_slot_id_async(chat_id: object, *, avoid_own: bool = False) -> int:
    """Variante async qui encapsule la lecture du ``total_slots`` caché
    et le snapshot ``busy_slots`` côté llama-server.

    Court-circuit volontaire — si ``total_slots ≤ 1`` (typique d'un
    llama-server lancé en ``--parallel 1``), inutile d'appeler
    ``get_busy_slots_snapshot()`` : il n'y a qu'un seul slot, aucun
    arbitrage à faire. Économie : un round-trip HTTP ``/slots`` par appel
    chat (≈10-50ms) qui n'apporte aucune information utile dans ce cas.

    Retourne la valeur à mettre dans ``payload["id_slot"]`` selon le
    contrat de ``resolve_slot_id`` (entier positif = slot pinné, -1 =
    laisser llama-server choisir, ou retour de ``resolve_slot_id`` quand
    pinning désactivé).

    Toute exception (cache pas encore rempli, llama injoignable) tombe
    sur ``-1`` ou ``0`` selon ``LLAMA_FORCE_IDLE_SLOT`` — comportement
    historique de la branche ``except`` qu'on remplace.
    """
    try:
        from llm_core._model_info import (
            _cached_total_slots as _ts,
            get_busy_slots_snapshot,
        )
        from llm_core.engines import current_engine
        _eng = current_engine()
        if not _eng.is_builtin:
            # AUDIT 2026-09-16 — le scalaire ``_cached_total_slots`` décrit
            # l'INTÉGRÉ : pour un connecteur llama.cpp, SON ``total_slots``
            # (cache par serveur, TTL — cf. ``get_model_total_slots``).
            from llm_core._model_info import get_model_total_slots
            _ts = await get_model_total_slots()
    except Exception:
        return -1 if LLAMA_FORCE_IDLE_SLOT else 0
    # Pas la peine d'aller chercher l'occupation s'il n'y a qu'un slot.
    if _ts is None or _ts <= 1:
        return resolve_slot_id(chat_id, _ts or 0, None)
    try:
        _busy = await get_busy_slots_snapshot()
    except Exception:
        _busy = None
    if avoid_own:
        return resolve_slot_id(chat_id, _ts, _busy, avoid_own=True)
    return resolve_slot_id(chat_id, _ts, _busy)


# ── KV cache reuse tunables ──────────────────────────────────────────
# llama-server reconnaît deux leviers de réutilisation KV. ATTENTION aux
# noms EXACTS — un champ inconnu est SILENCIEUSEMENT IGNORÉ côté serveur :
#   - ``cache_prompt`` (bool, champ body) : conserve le KV du prompt après la
#       requête → le tour suivant ne re-prefile QUE les nouveaux tokens (gain :
#       skip prefill ~1-3s). Indispensable.
#   - ``n_cache_reuse`` (int, champ body ; flag serveur ``--cache-reuse N``) :
#       autorise la réutilisation PARTIELLE du KV via KV-shifting quand le
#       préfixe a un "trou" en milieu (insertion d'un summary de compression,
#       élagage de contexte). Sémantique RÉELLE = *min chunk size* : taille
#       minimale d'un bloc contigu qu'on tente de réutiliser — PAS un "saut max".
#       Reco officielle (ggerganov) : 256. Le lieu CANONIQUE est le flag serveur
#       ``--cache-reuse`` ; on envoie aussi le champ body pour le contrôle par
#       requête.
#       ⚠️ Bug historique corrigé : l'ancien code envoyait ``cache_reuse`` (nom
#       NON reconnu) avec une valeur 2048 (pensée à tort comme un "trou max") →
#       la réutilisation partielle n'a JAMAIS été active. Champ correct =
#       ``n_cache_reuse``, valeur = min-chunk = 256.
# Désactiver via env var pour debug ou comparaison.
LLAMA_CACHE_PROMPT = os.environ.get(
    "LLAMA_CACHE_PROMPT", "1"
).strip().lower() not in ("0", "false", "no", "")

try:
    LLAMA_CACHE_REUSE_TOKENS = int(os.environ.get("LLAMA_CACHE_REUSE_TOKENS", "256"))
except (TypeError, ValueError):
    LLAMA_CACHE_REUSE_TOKENS = 256


def apply_kv_cache_params(payload: dict) -> None:
    """Injecte dans ``payload`` les paramètres de réutilisation KV reconnus
    par llama-server. Source UNIQUE partagée par le chat classique et le chat
    à outils (avant : 4 blocs inline dupliqués, qui envoyaient tous le champ
    erroné ``cache_reuse`` → ignoré). Mute ``payload`` en place.

      - ``cache_prompt``  : conserve le KV après la requête (prefill incrémental
        au tour suivant de la même conversation).
      - ``n_cache_reuse`` : *min chunk size* pour la réutilisation via KV-shifting
        — récupère le KV autour d'un "trou" (summary de compression, élagage)
        au lieu de tout re-prefiller. Le défaut GLOBAL se règle aussi via le flag
        serveur ``--cache-reuse`` au lancement de llama-server."""
    if LLAMA_CACHE_PROMPT:
        payload["cache_prompt"] = True
    if LLAMA_CACHE_REUSE_TOKENS > 0:
        payload["n_cache_reuse"] = LLAMA_CACHE_REUSE_TOKENS


# ── Generation safety caps ───────────────────────────────────────────
# Borne défensive sur ``max_tokens``. En pratique l'EOS arrive bien avant,
# mais sur un modèle qui hallucine du JSON infini ou rentre en boucle de
# répétition, ça évite que la génération tourne jusqu'à n_ctx-prompt_size.
# 0 = pas de cap (laisse le comportement historique).
#
# 16384 par défaut (vs 8192 historique) : sur des tâches d'ingénierie
# (génération de code, refactoring, analyse de logs) le modèle a souvent
# besoin de produire >8K tokens d'une traite. 16K est encore loin de saturer
# un contexte 240K mais cap les boucles infinies.
# Source de vérité = shared_infra.config (env > config.json > défaut) ; les
# fallbacks ci-dessous doivent rester ALIGNÉS sur config.py (cf. note
# LLAMA_MAX_TOOL_ITERATIONS plus haut).
try:
    LLAMA_MAX_TOKENS_CHAT = int(getattr(_bk_config, "LLAMA_MAX_TOKENS_CHAT", 16384))
except (TypeError, ValueError):
    LLAMA_MAX_TOKENS_CHAT = 16384
try:
    LLAMA_MAX_TOKENS_THINKING = int(getattr(_bk_config, "LLAMA_MAX_TOKENS_THINKING", 24576))
except (TypeError, ValueError):
    LLAMA_MAX_TOKENS_THINKING = 24576

# Mode thinking LOCAL : sortie non plafonnée (aucun max_tokens envoyé) — voir
# la rationale complète dans shared_infra/config.py. Consommé par
# build_llama_payload via ``clamp_generation_budget(..., uncap_output=)``.
LLAMA_THINKING_OUTPUT_UNCAPPED = bool(
    getattr(_bk_config, "LLAMA_THINKING_OUTPUT_UNCAPPED", True)
)
# Filet d'auto-reprise d'un raisonnement coupé (cf. llm_core._think_resume).
try:
    LLAMA_THINK_RESUME_MAX = max(0, int(getattr(_bk_config, "LLAMA_THINK_RESUME_MAX", 6)))
except (TypeError, ValueError):
    LLAMA_THINK_RESUME_MAX = 6
try:
    LLAMA_THINK_RESUME_TOTAL_TOKENS = max(0, int(
        getattr(_bk_config, "LLAMA_THINK_RESUME_TOTAL_TOKENS", 131072)))
except (TypeError, ValueError):
    LLAMA_THINK_RESUME_TOTAL_TOKENS = 131072
# Filet d'auto-reprise d'une RÉPONSE (prose) coupée — audit long-run
# 2026-08-21. Distinct du plafond de reprise du raisonnement : la prose n'est
# pas éphémère, chaque segment reste dans la réponse et dans l'historique, et
# la reprise exige le canal natif ``continue_final_message``. 0 = désactivé.
try:
    LLAMA_CONTENT_RESUME_MAX = max(0, int(
        getattr(_bk_config, "LLAMA_CONTENT_RESUME_MAX", 4)))
except (TypeError, ValueError):
    LLAMA_CONTENT_RESUME_MAX = 4


# ── Cap de génération adaptatif au n_ctx ─────────────────────────────
# Fraction MAX de la fenêtre de contexte réservable à la SORTIE. Le cap
# théorique (LLAMA_MAX_TOKENS_*) est pensé pour les GRANDES fenêtres ; sur un
# petit n_ctx, réserver 16-24K pour la sortie ampute le prompt — ex. 32K en
# thinking : cap 24576 = 75% réservé → seulement ~8K de prompt (log « fit dans
# ~8192 tokens »). On plafonne la sortie à cette fraction du n_ctx → la MAJORITÉ
# du contexte reste pour le prompt (historique/observations/outils), sans risque
# de finish=length (prompt + sortie restent ≤ n_ctx car le budget de prompt est
# borné par la même valeur dans _enforce_context_budget).
try:
    LLAMA_GEN_CAP_CTX_RATIO = float(os.environ.get("LLAMA_GEN_CAP_CTX_RATIO", "0.4"))
except (TypeError, ValueError):
    LLAMA_GEN_CAP_CTX_RATIO = 0.4
LLAMA_GEN_CAP_FLOOR = 2048   # toujours de quoi produire une réponse utile


def effective_generation_cap(thinking_mode: bool, ctx_size: Optional[int] = None) -> int:
    """Cap de génération EFFECTIF : le cap théorique
    (``LLAMA_MAX_TOKENS_THINKING``/``CHAT``) borné par ``LLAMA_GEN_CAP_CTX_RATIO``
    du ``ctx_size`` quand celui-ci est connu (plancher ``LLAMA_GEN_CAP_FLOOR``).
    Quand ``ctx_size`` est None/0, retombe sur le cap théorique (rétro-compat)."""
    cap = LLAMA_MAX_TOKENS_THINKING if thinking_mode else LLAMA_MAX_TOKENS_CHAT
    if ctx_size and ctx_size > 0:
        cap = min(cap, max(LLAMA_GEN_CAP_FLOOR, int(ctx_size * LLAMA_GEN_CAP_CTX_RATIO)))
    return cap


def clamp_generation_budget(payload: dict, sampling_params: dict, thinking_mode: bool,
                            ctx_size: Optional[int] = None, *,
                            uncap_output: bool = False) -> None:
    """Borne le budget de génération (``max_tokens`` / ``n_predict``) au cap
    EFFECTIF (``effective_generation_cap`` : cap théorique borné par le n_ctx
    quand ``ctx_size`` est fourni).

    Source UNIQUE partagée par le chat classique et le chat à outils (avant, le code
    était dupliqué et avait divergé : le path classique ne clampait pas les overrides
    explicites → BUG). Trois cas :
      - ``uncap_output`` (mode thinking local, défaut opérateur) et aucune limite
        explicite → AUCUN ``max_tokens`` envoyé : llama-server défaute à
        ``n_predict=-1`` (illimité), un long raisonnement n'est plus coupé par un
        plafond arbitraire (finish=length en plein <think> toutes les 5-10 min).
        La génération reste bornée par la fenêtre de contexte, et la RÉSERVE de
        prompt (_enforce_context_budget, qui utilise le même
        ``effective_generation_cap``) garantit une marge de sortie ≥ cap.
      - aucune limite explicite (positive) → on INJECTE le cap ;
      - limite explicite → on la CLAMP au cap (un override élevé — jusqu'à 1 000 000
        accepté par _sanitize_override — ne doit pas faire dépasser n_ctx, sinon
        finish=length en plein tool_call → JSON tronqué → historique corrompu).
        Un override explicite reste un plafond VOULU : ``uncap_output`` ne le
        neutralise pas.
    Mute ``payload`` en place."""
    def _positive(key: str) -> bool:
        v = sampling_params.get(key)
        try:
            return v is not None and int(v) > 0
        except (TypeError, ValueError):
            return False
    cap = effective_generation_cap(thinking_mode, ctx_size)
    if cap <= 0:
        return
    if not _positive("max_tokens") and not _positive("n_predict"):
        if uncap_output:
            payload.pop("max_tokens", None)
            # n_predict non-positif résiduel (héritage sampling) : retiré aussi,
            # le défaut serveur -1 est déjà « illimité » — pas d'ambiguïté.
            if sampling_params.get("n_predict") is not None and not _positive("n_predict"):
                payload.pop("n_predict", None)
            return
        payload["max_tokens"] = cap
        # Évite max_tokens=cap ET n_predict=-1 (ambigu pour le serveur).
        if sampling_params.get("n_predict") is not None and not _positive("n_predict"):
            payload.pop("n_predict", None)
    else:
        if _positive("max_tokens"):
            payload["max_tokens"] = min(int(sampling_params["max_tokens"]), cap)
        if _positive("n_predict"):
            payload["n_predict"] = min(int(sampling_params["n_predict"]), cap)


# ── Tool execution parallelism ───────────────────────────────────────
# Quand le LLM retourne plusieurs tool_calls dans le même tour (parallel
# tool use, supporté par Qwen3, Llama 3.x, Gemma2…), on les exécute en
# parallèle plutôt qu'en série. Borne pour éviter qu'un tour à 20 tools
# sature les workers.
try:
    LLAMA_TOOL_PARALLELISM = int(os.environ.get("LLAMA_TOOL_PARALLELISM", "8"))
except (TypeError, ValueError):
    LLAMA_TOOL_PARALLELISM = 8

# Outils dont l'exécution NE DOIT PAS être parallélisée (effets de bord
# concurrents) — on les force en série même quand le LLM les groupe avec
# d'autres. Préfixes (tout outil dont le nom commence par l'un d'eux).
# write_file, edit_file, sandbox_*, git_* mutent l'état partagé du sandbox ;
# memory fait un read-modify-write sur MEMORY.md/USER.md (deux mutations
# groupées calculeraient leur cible sur un état concurrent ; session_search,
# lecture seule, ne commence pas par "memory" et reste parallèle).
# manage_files (copy/move/delete/chmod), skill_save, skill_add_file : ajoutés
# 2026-07-13 — absents de la liste, ils partaient dans le pool PARALLÈLE
# (course delete‖write possible sur un même chemin) et échappaient au ledger
# d'artefacts de la compression (même liste, cf. compression/serializer).
# task : sous-agent éphémère (llm_core/tools/task_tool.py). Deux ``task``
# groupés dans un même batch DOIVENT être sérialisés : en mode "classic" le
# parent TIENT LLM_SEMAPHORE pendant les tool calls → deux enfants concurrents
# casseraient l'invariant mono-slot (et un seul GPU de toute façon).
LLAMA_TOOL_SERIAL_PREFIXES = tuple(
    p.strip() for p in os.environ.get(
        "LLAMA_TOOL_SERIAL_PREFIXES",
        # (passe 7, H7) ``desktop_``/``pw_`` : un ÉCRAN / un onglet par
        # session — deux actions d'UI en parallel-tool-use s'exécutaient
        # concurremment (ordre non déterministe, signatures anti-cycle
        # bruitées). ``execute_shell`` reste parallèle (démultiplexé par
        # call_id, voulu).
        "write_file,edit_file,sandbox_,git_,fs_write,fs_edit,fs_delete,fs_move,fs_rename,skill_run_script,memory,manage_files,skill_save,skill_add_file,task,desktop_,pw_"
    ).split(",") if p.strip()
)

# ── Sous-agents (outil ``task``) ─────────────────────────────────────
# Borne wall-clock d'un enfant (le chemin builtin n'est PAS borné par le loop
# — seul le chemin MCP l'est via LLAMA_TOOL_TIMEOUT_S). Généreux : modèles
# locaux lents + éviction/re-prefill KV au retour. Le handler enveloppe le
# run enfant dans asyncio.wait_for(..., TASK_CHILD_TIMEOUT_S). Les clés
# TASK_* existent désormais dans shared_infra/config.py (llm.task.* /
# APP_TASK_*) — les fallbacks ici doivent rester alignés sur ses défauts.
try:
    TASK_CHILD_TIMEOUT_S = int(getattr(_bk_config, "TASK_CHILD_TIMEOUT_S", 3600) or 3600)
except (TypeError, ValueError):
    TASK_CHILD_TIMEOUT_S = 3600

# Profondeur de sous-agents autorisée (modèle OpenCode v1.18.3 ``subagent_depth``,
# défaut 1) : 1 = le chat peut spawner des enfants, mais un enfant ne peut PAS
# spawner de petit-enfant. N ≥ 2 = récursion opt-in bornée — le builtin ``task``
# n'est injecté à un enfant que si sa profondeur < N.
try:
    TASK_SUBAGENT_DEPTH = max(1, int(getattr(_bk_config, "TASK_SUBAGENT_DEPTH", 1) or 1))
except (TypeError, ValueError):
    TASK_SUBAGENT_DEPTH = 1

# Reprise ``task_id`` (continuité d'un enfant) : TTL et cap d'entrées, appliqués
# au cache mémoire de ``task_tool`` ET au store PARTAGÉ ``tools/_task_resume``.
# ⚠ Ce store partagé n'est pas un luxe : le tour qui rejoue un ``task_id`` est
# une NOUVELLE requête HTTP, donc un worker gunicorn arbitraire. Le store
# in-process seul répondait ``unknown_task_id`` (N-1)/N du temps — juste après
# avoir proposé cette reprise au modèle.
try:
    TASK_RESUME_TTL_S = int(getattr(_bk_config, "TASK_RESUME_TTL_S", 21600) or 21600)
except (TypeError, ValueError):
    TASK_RESUME_TTL_S = 21600
try:
    TASK_RESUME_MAX = int(getattr(_bk_config, "TASK_RESUME_MAX", 200) or 200)
except (TypeError, ValueError):
    TASK_RESUME_MAX = 200

# Budgets d'itérations PAR AGENT (le loop clampe à 1..500). Consommés par le
# registre _AGENTS de task_tool à l'import. Calés sur la FORME du travail, pas
# uniformes (docs/agents-specialises-design-2026-08-04.md) : implement écrit,
# teste et corrige (100) ; explore et verify enchaînent des lectures (60) ; pr
# déroule une séquence courte et bornée (40).
#
# RELEVÉS le 2026-08-30 (×2 à ×2,4 : 25/45/25/30/20/40 → 60/100/60/60/40/80).
# Motif : le harnais PARENT tourne à 200 itérations et les enfants s'arrêtaient
# à un geste près, rendant « je n'ai pas pu terminer » au lieu d'un résultat.
# ⚠ Le budget d'itérations n'est utile que si le mur wall-clock suit : c'est
# pourquoi TASK_CHILD_TIMEOUT_S passe de 1800 à 3600 s dans le même geste —
# sinon 100 itérations d'implement se font couper par le timeout, pas par le
# budget, et le symptôme se déplace au lieu de disparaître.
# ⚠ Un agent CUSTOM peut désormais porter son propre budget (champ
# ``max_iters``) ; ces valeurs ne sont plus que les DÉFAUTS.
try:
    TASK_MAX_ITERS_EXPLORE = max(1, int(getattr(_bk_config, "TASK_MAX_ITERS_EXPLORE", 60) or 60))
except (TypeError, ValueError):
    TASK_MAX_ITERS_EXPLORE = 60
try:
    TASK_MAX_ITERS_IMPLEMENT = max(1, int(getattr(_bk_config, "TASK_MAX_ITERS_IMPLEMENT", 100) or 100))
except (TypeError, ValueError):
    TASK_MAX_ITERS_IMPLEMENT = 100
try:
    TASK_MAX_ITERS_VERIFY = max(1, int(getattr(_bk_config, "TASK_MAX_ITERS_VERIFY", 60) or 60))
except (TypeError, ValueError):
    TASK_MAX_ITERS_VERIFY = 60
try:
    TASK_MAX_ITERS_WEB = max(1, int(getattr(_bk_config, "TASK_MAX_ITERS_WEB", 60) or 60))
except (TypeError, ValueError):
    TASK_MAX_ITERS_WEB = 60
try:
    TASK_MAX_ITERS_PR = max(1, int(getattr(_bk_config, "TASK_MAX_ITERS_PR", 40) or 40))
except (TypeError, ValueError):
    TASK_MAX_ITERS_PR = 40
# Agents CUSTOM. Repli sur l'ancienne clé ``GENERAL`` (agent intégré supprimé)
# pour ne pas perdre le réglage des instances qui l'avaient ajusté.
try:
    _iters_general = max(1, int(getattr(_bk_config, "TASK_MAX_ITERS_GENERAL", 80) or 80))
except (TypeError, ValueError):
    _iters_general = 80
try:
    TASK_MAX_ITERS_CUSTOM = max(1, int(
        getattr(_bk_config, "TASK_MAX_ITERS_CUSTOM", _iters_general) or _iters_general))
except (TypeError, ValueError):
    TASK_MAX_ITERS_CUSTOM = _iters_general


# Résultat FINAL d'un sous-agent, persisté en entier pour la modale « œil »
# (le modèle parent, lui, l'a toujours reçu sans coupe via ``_render_result``).
# Ce plafond n'est PAS un affichage tronqué : c'est un garde-fou contre un
# enfant qui renverrait des mégaoctets et gonflerait ``meta_json`` — un rapport
# d'agent réel pèse quelques kilooctets.
TASK_RESULT_PERSIST_CAP = 256 * 1024


# ── Tool category mapping ────────────────────────────────────────────
# Maps high-level tool categories (used in user-facing UI toggles) to
# the concrete tool names that ship with the matching MCP server.
#
# This used to be a hand-maintained dict literal here. It is now built
# automatically from each ``tools/*_tools.py`` module's top-level
# ``CATEGORY`` declaration (parsed via AST so the FastAPI process
# never has to import ``fastmcp`` or any other tool dependency).
#
# Adding a new tool module → drop a ``tools/foo_tools.py`` with a
# ``CATEGORY`` constant, register it in ``local_mcp_server.py``, restart
# the app. The category appears in the user MCP panel AND in the admin
# Outils MCP tab — no edit to this file needed.
#
# See ``backend.services._mcp_categories`` for the full contract.
class _LiveToolCategories(dict):
    """``{category: [tool_name, ...]}`` — a dict-compatible *view* that
    always reflects the live category registry.

    It used to be a hand-maintained literal, then a snapshot frozen at
    import time from a side-car manifest. That snapshot is exactly what
    broke: the FastAPI workers import this module before the MCP
    subprocess has published its tools, so the snapshot froze EMPTY and
    never recovered → ``LOCAL_PREFIXES`` empty → ``_username``/``_chat_id``
    never injected → todo writes silently went to guest/todos_default.

    Now every read hits ``_mcp_categories``, which the MCP pool keeps in
    sync with the live ``list_tools()`` response (tags/meta). Kept under
    the historical name ``TOOL_CATEGORIES`` so the many importers
    (_legacy, services.__init__, agentic.*, routes.pipelines, ...) keep
    working unchanged — but it can no longer go stale. Empty until the
    pool connects once; callers must treat empty as "don't filter".
    """
    def _live(self) -> Dict[str, list]:
        try:
            from llm_core._mcp_categories import get_tool_categories_dict
            return get_tool_categories_dict()
        except Exception:
            return {}
    def __getitem__(self, k):       return self._live()[k]
    def __iter__(self):             return iter(self._live())
    def __len__(self):              return len(self._live())
    def __contains__(self, k):      return k in self._live()
    def __eq__(self, other):        return self._live() == other
    def __ne__(self, other):        return self._live() != other
    def __bool__(self):             return bool(self._live())
    def __repr__(self):             return f"_LiveToolCategories({self._live()!r})"
    def keys(self):                 return self._live().keys()
    def values(self):               return self._live().values()
    def items(self):                return self._live().items()
    def get(self, k, default=None): return self._live().get(k, default)


TOOL_CATEGORIES: Dict[str, list] = _LiveToolCategories()


# ── Vision support ───────────────────────────────────────────────────
# When a vision-capable model is active and pw_page(action="inspect") is called,
# the last web screenshot is auto-injected into the LLM context (OpenAI
# multimodal content format).
#
# Constants below are READ by ``backend.services._vision`` (which owns the
# actual injection logic). They live here so legacy imports keep working
# (``from backend.services._legacy import _VISION_MAX_WIDTH``).

# Per-model vision capability cache (avoids re-querying llama-server's
# /v1/models on every call). Populated by _vision._model_supports_vision().
_VISION_CAPABILITY_CACHE: Dict[str, bool] = {}

# Fallback patterns matched against the model name when /v1/models doesn't
# explicitly expose a vision capability bit.
_VISION_MODEL_PATTERNS = (
    "-vl-", "vl-instruct", "vision", "llava",
    "qwen2.5-omni", "qwen3-omni", "qwen2-vl", "qwen2.5-vl", "qwen3-vl",
    "gemma-3-", "gemma-4-", "llama-3.2-vision", "llama-4-",
    "pixtral", "moondream", "intern-vl", "internvl",
    "minicpm-v", "minicpm-o", "molmo", "phi-3.5-vision", "phi-4-vision",
    "cohere-aya-vision", "smolvlm",
)

# Last screenshot per (username, chat_id) → downscaled JPEG bytes. Capped at
# one shot per session to keep RAM bounded.
_LAST_SCREENSHOT: Dict[str, bytes] = {}
_VISION_MAX_WIDTH = 1024     # downscale target
_VISION_JPEG_QUALITY = 85    # JPEG quality (lower → fewer tokens)


# ── RAG tool definitions ─────────────────────────────────────────────
# Self-contained — no dependency on rag_app.rag_query exports. Used by
# ``backend.services._rag.build_rag_builtin_tools``.
_RAG_TOOL_DEFS = [
    {
        "type": "function",
        "function": {
            "name": "rag_search",
            "description": (
                "Search the document knowledge base. Use it when you need "
                "information from the indexed documents, when the user asks a "
                "factual question, or when you lack context. You may call it "
                "several times with different queries to refine."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Keywords or question to search for in the documents.",
                    },
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "rag_get_document",
            "description": (
                "Fetch the full content of a specific file from the document "
                "base. Use it when the user mentions a file by name or when "
                "you need a document's complete content."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "filename": {
                        "type": "string",
                        "description": "File name (e.g. 'rapport.pdf', 'config.py').",
                    },
                },
                "required": ["filename"],
            },
        },
    },
]


# ── RAG query handle — DEPRECATED ─────────────────────────────────────
# Historically this module imported ``rag_app.rag_query.rag`` directly,
# producing a callable ``rag_query`` that the chat pipeline used inline.
# That created a hard import-time dependency from the chatbot to the
# ``rag_app/`` source tree.
#
# Since the SSE-decoupling refactor (v3) the chatbot reaches the RAG
# service over HTTP/SSE through ``backend.services._rag_client``. The
# in-process callable is no longer needed, but we keep ``rag_query`` as
# a defined-but-None symbol because:
#
#   1. ``backend.services.__init__`` historically re-exported it;
#   2. external callers (e.g. ``agentic.*``) may still ``import`` it for
#      defensive ``if rag_query is None`` branch checks.
#
# Setting it to ``None`` triggers exactly the same fallback paths those
# callers use today when the import fails — so no behavior change.
rag_query = None  # noqa: F841 — intentionally exported as None
