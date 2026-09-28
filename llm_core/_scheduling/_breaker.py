# SPDX-License-Identifier: MIT
"""
llm_core._scheduling._breaker — Disjoncteur (circuit-breaker) LLM, fail-safe.

Problème (fragilité d'archi) : si llama-server est figé / down, CHAQUE requête de
génération attend le read-timeout httpx (potentiellement long) avant d'échouer, en
occupant un slot de sémaphore tout ce temps → dégradation/cascade pour tous.

Ce breaker fait FAIL-FAST une fois la panne détectée :
  - on compte les échecs de TRANSPORT consécutifs (httpx ConnectError/Timeout) par
    modèle ; au-delà de ``LLM_BREAKER_FAILS`` (défaut 5), le circuit s'OUVRE ;
  - pendant ``LLM_BREAKER_COOLDOWN_S`` (défaut 15 s), ``allow()`` lève
    ``LLMCircuitOpen`` immédiatement (pas d'acquire, pas d'attente du timeout) ;
  - après le cooldown, on laisse repasser les requêtes (half-open) : un succès
    RESET le circuit, un nouvel échec le ré-ouvre.

Garanties FAIL-SAFE (ne JAMAIS casser le chat à cause du breaker lui-même) :
  - seuls les échecs de transport comptent (pas les erreurs métier / annulations) ;
  - tout bug interne du breaker est avalé → la requête PASSE (jamais bloquée à tort) ;
  - désactivable via ``LLM_BREAKER=0``.

Portée : PAR worker (état module-local). Suffisant — chaque worker détecte la panne
et fail-fast de son côté. (Une coordination cross-worker via Redis serait un +,
non requise pour la valeur principale.)
"""
from __future__ import annotations

import logging
import os
import time
from typing import Dict

logger = logging.getLogger("uvicorn.error")


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        return default


def _float_env(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        return default


_ENABLED = os.environ.get("LLM_BREAKER", "1").strip().lower() not in ("0", "false", "no", "")
_FAILS_TO_OPEN = max(1, _int_env("LLM_BREAKER_FAILS", 5))
_COOLDOWN_S = max(1.0, _float_env("LLM_BREAKER_COOLDOWN_S", 15.0))

# model_key -> {"fails": int, "open_until": float(monotonic), "gen": int}
#
# ``gen`` (audit 2026-08-23) est incrémenté à CHAQUE échec enregistré. Le garde
# le lit avant d'exécuter le corps et le repasse à ``record_success`` : si le
# compteur a bougé entre-temps, c'est qu'une panne a été constatée PENDANT ce
# tour — le succès apparent du garde (les chemins de génération ne LÈVENT pas)
# ne doit alors surtout pas effacer ce que le tour vient d'apprendre.
_state: Dict[str, Dict[str, float]] = {}


class LLMCircuitOpen(RuntimeError):
    """Circuit LLM ouvert : llama-server jugé indisponible → fail-fast (pas d'attente)."""


def _key(model) -> str:
    return str(model) if model else "__default__"


def allow(model) -> None:
    """Lève ``LLMCircuitOpen`` si le circuit du modèle est OUVERT (cooldown en cours).

    Fail-safe : toute exception interne (≠ LLMCircuitOpen) est avalée → on autorise."""
    if not _ENABLED:
        return
    try:
        st = _state.get(_key(model))
        if not st:
            return
        if st.get("open_until", 0.0) > time.monotonic():
            raise LLMCircuitOpen(
                "Service LLM temporairement indisponible (circuit ouvert) — réessaie dans quelques secondes."
            )
        # cooldown écoulé → half-open : on laisse repasser (probe).
    except LLMCircuitOpen:
        raise
    except Exception:
        # Bug interne du breaker : ne JAMAIS bloquer une requête légitime.
        return


def generation(model) -> int:
    """Numéro de génération courant du modèle (cf. ``_state``)."""
    try:
        st = _state.get(_key(model))
        return int(st.get("gen") or 0) if st else 0
    except Exception:
        return 0


def record_success(model, since_generation: "int | None" = None) -> None:
    """Un appel LLM a abouti → RESET du compteur d'échecs (referme le circuit).

    ``since_generation`` : numéro lu AVANT le tour. S'il a changé, un échec de
    transport a été enregistré entre-temps et on ne referme rien."""
    if not _ENABLED:
        return
    if since_generation is not None and generation(model) != since_generation:
        return
    try:
        st = _state.get(_key(model))
        if st and (st.get("fails") or st.get("open_until")):
            _state.pop(_key(model), None)
            logger.info("[llm_breaker] circuit refermé pour %s", model or "<default>")
    except Exception:
        pass


def note_transport_failure(model, err: "BaseException | None") -> None:
    """Alimente le disjoncteur depuis la CAUSE, pas depuis le type remonté.

    AUDIT 2026-08-23 — ``record_failure`` n'avait qu'un appelant : le
    ``except (httpx.ConnectError, ConnectTimeout, ReadTimeout, PoolTimeout)``
    de ``llm_scheduling_guard``. Or AUCUN des deux chemins de génération ne
    laisse remonter d'httpx brut : le chemin classic RETOURNE un tuple
    d'erreur (le tour « se passe bien » du point de vue du garde) et le chemin
    outils lève un ``LLMFailure`` (RuntimeError). Le compteur restait donc
    vide pour toujours, ``allow()`` était un no-op permanent, et le fail-fast
    promis par la docstring de ce module ne se produisait jamais : moteur
    figé, chaque requête consommait un slot pendant tout le read-timeout —
    exactement la cascade que ce module dit prévenir.

    On filtre sur la FAMILLE d'erreur (``unreachable`` / ``timeout``) : une
    erreur métier (400 contexte dépassé, refus de requête) ne doit pas ouvrir
    le circuit, elle ne dit rien de la santé du transport.
    """
    if not _ENABLED or err is None:
        return
    try:
        from llm_core._llm_retry import (
            llm_error_kind, KIND_UNREACHABLE, KIND_TIMEOUT,
        )
        cause = getattr(err, "cause", None) or err
        if llm_error_kind(cause) in (KIND_UNREACHABLE, KIND_TIMEOUT):
            record_failure(model)
    except Exception:
        pass


def record_failure(model) -> None:
    """Un échec de TRANSPORT (LLM down/figé) → incrémente ; ouvre au seuil."""
    if not _ENABLED:
        return
    try:
        st = _state.setdefault(_key(model),
                               {"fails": 0.0, "open_until": 0.0, "gen": 0})
        st["fails"] = (st.get("fails") or 0) + 1
        st["gen"] = (st.get("gen") or 0) + 1
        if st["fails"] >= _FAILS_TO_OPEN:
            st["open_until"] = time.monotonic() + _COOLDOWN_S
            logger.warning(
                "[llm_breaker] circuit OUVERT pour %s (%d échecs transport consécutifs) "
                "— fail-fast pendant %.0fs", model or "<default>", int(st["fails"]), _COOLDOWN_S,
            )
    except Exception:
        pass


def reset(model=None) -> None:
    """Réinitialise l'état (tests / admin)."""
    try:
        if model is None:
            _state.clear()
        else:
            _state.pop(_key(model), None)
    except Exception:
        pass
