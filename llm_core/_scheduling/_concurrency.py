# SPDX-License-Identifier: MIT
"""
backend.services._scheduling._concurrency — Two-level FIFO LLM concurrency manager.

What lives here
---------------
- ``LLMConcurrencyManager``: two-level FIFO scheduler.
  Level 1 caps the number of distinct models active at once; level 2
  caps parallel completions per model. Both levels respect priority
  (``high`` chat / ``low`` pipeline) for FAIRNESS, never preemption.

- ``_LLMAcquisition``: the async-context-manager handle returned by
  ``LLMConcurrencyManager.acquire_for(model)``. Releases both levels
  (model slot + per-model semaphore) on exit.

- ``LLM_SEMAPHORE``: process-wide singleton. Historical name retained
  for import-compat — every caller writes ``LLM_SEMAPHORE.acquire_for(model)``.

Configuration
-------------
``LLAMA_MAX_MODELS`` (default 1) and ``LLAMA_MAX_CONCURRENCY`` (the ``-np``
of llama-server) gate the two limits. Both come from ``backend.config``.

Reads ``get_model_total_slots`` from ``_model_info`` to refine the
per-model cap based on the slot count llama-server actually exposes.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from collections import deque
from typing import Any, Dict, Optional, Tuple

from llm_core import _model_info as _mi  # for live read of _mi._cached_total_slots
from llm_core._model_info import get_model_total_slots
from shared_infra.config import LLAMA_MAX_CONCURRENCY

logger = logging.getLogger("uvicorn.error")

# Defensive: LLAMA_MAX_MODELS may not be set in older configs.
from shared_infra import config as _bk_config

LLAMA_MAX_MODELS = int(getattr(_bk_config, "LLAMA_MAX_MODELS", 1) or 1)


# Plafond d'attente d'une acquisition « low » au portail de grâce.
# PARTAGÉ avec le niveau 1 (``_locks.ModelExclusivityLock``) depuis l'audit
# 2026-08-23 : deux constantes auraient re-divergé.
LOW_WAIT_CAP_S = 30.0


class LLMConcurrencyManager:
    """
    Gestionnaire de concurrence à DEUX niveaux pour les appels LLM,
    avec file d'attente FIFO stricte et équitable.

    ┌─ Niveau 1 — SLOTS MODÈLES (max_models) ──────────────────────────────┐
    │ Nombre de modèles distincts pouvant être actifs simultanément sur   │
    │ le serveur llama.cpp. Typiquement 1 (un seul modèle en VRAM).       │
    │                                                                      │
    │ Si tous les slots sont pris par d'autres modèles, la requête est    │
    │ enfilée dans une deque FIFO et attend qu'un slot se libère          │
    │ (toutes les conversations sur un autre modèle terminées).           │
    └──────────────────────────────────────────────────────────────────────┘

    ┌─ Niveau 2 — CONVERSATIONS PAR MODÈLE (max_conversations_per_model) ─┐
    │ Nombre de chat completions parallèles autorisées sur un modèle      │
    │ déjà chargé. Correspond au paramètre `-np` de llama.cpp.            │
    │                                                                      │
    │ Implémenté via asyncio.Semaphore qui est FIFO depuis Python 3.10.   │
    └──────────────────────────────────────────────────────────────────────┘

    Règles d'équité
    ───────────────
    • Une requête sur un modèle DÉJÀ ACTIF n'attend jamais en file
      slot-modèle : elle rejoint directement le pool de conversations,
      où elle prend sa place FIFO derrière les autres conversations.

    • Une requête sur un modèle NON actif est mise en queue FIFO si
      aucun slot modèle n'est libre. Quand un slot se libère, on
      drainent les waiters dans l'ORDRE D'ARRIVÉE.

    • Piggyback : pendant le drainage, si un waiter veut un modèle qui
      vient juste d'être activé par un waiter précédent, il rejoint
      gratuitement (sans consommer un nouveau slot). Cela ne brise pas
      la FIFO car personne n'est doublé : ce waiter aurait pu être servi
      de toute façon.

    • Drainage strict : on s'arrête au premier waiter non-servable.
      Aucun waiter postérieur n'est sauté pour cause de modèle différent.

    • Pipelines : chaque bloc relâche puis ré-acquiert. Un user qui
      enchaîne des blocs ne peut pas monopoliser le LLM ; il se replace
      en queue FIFO entre chaque bloc.

    • Annulation propre : si un waiter est cancellé (client disconnect),
      il est retiré de la queue et le drainage est relancé.

    Usage : ``async with LLM_SEMAPHORE.acquire_for(model, priority=…)``
    (l'ancien ``async with LLM_SEMAPHORE:`` sans modèle, plus appelé nulle
    part, a été retiré le 2026-09-24).
    """

    def __init__(self, max_models: int, max_conversations_per_model: int,
                 engine_key: str = "builtin"):
        self.max_models = max(1, int(max_models))
        self.max_convs = max(1, int(max_conversations_per_model))
        # AUDIT 2026-09-16 — serveur llama.cpp que CE gestionnaire ordonnance
        # (``builtin`` = intégré, ``conn:<id>`` = connecteur ; cf.
        # ``_scheduling._engines``). L'acquisition ne s'applique qu'aux appels
        # dont la cible est CE serveur.
        self.engine_key = engine_key or "builtin"
        # Dernier parallélisme découvert (``total_slots``) pour un serveur
        # autre que l'intégré — l'intégré lit ``_mi._cached_total_slots``.
        self._last_effective = 0
        self._guard: Optional[asyncio.Lock] = None
        # {model_key: {"sem": Semaphore, "holders": int, "had_high": bool}}
        self._active: Dict[str, Dict[str, Any]] = {}
        # Priority queue de waiters : (priority, model_key, future, registered_ts).
        # Priority "high" servie avant "low", FIFO à priorité égale.
        self._slot_waiters: "deque[Tuple[str, str, asyncio.Future, float]]" = deque()
        # Grâce post-release-high : map {model_key: grace_until_ts}.
        # Pendant ce temps, les low ne peuvent pas réclamer un slot
        # qui vient juste d'être libéré par un high. Ça couvre les chats
        # MCP qui font acquire/release/acquire entre tool calls.
        self._grace: Dict[str, float] = {}
        # Timer pour re-drainer la file quand la grâce expire (sans ce
        # timer, un low en file après la fin d'un chat ne serait pas
        # réveillé puisqu'il n'y a plus de release pour déclencher un
        # drain).
        self._grace_drain_handle: Optional[asyncio.TimerHandle] = None
        self._grace_drain_ts: float = 0.0

    GRACE_S: float = 8.0  # post-release-high window (synced with MODEL_EXCLUSIVITY)

    def _ensure(self) -> asyncio.Lock:
        """Verrou de l'ordonnanceur, créé au premier usage."""
        if self._guard is None:
            self._guard = asyncio.Lock()
        return self._guard

    @staticmethod
    def _key(model: Optional[str]) -> str:
        m = (model or "").strip()
        return m or "__default__"

    def acquire_for(
        self,
        model: Optional[str] = None,
        priority: str = "high",
    ) -> "_LLMAcquisition":
        """Retourne un context manager async qui gère les deux niveaux.

        :param priority: ``"high"`` (chat user) ou ``"low"`` (pipeline).
            Les acquires high sont servis avant les low dans la file
            d'attente. À la libération d'un slot par un high, une
            fenêtre de grâce de ``GRACE_S`` secondes empêche un low de
            s'en emparer — important pour les chats MCP qui font
            acquire/release/acquire entre tool calls.
        """
        return _LLMAcquisition(self, model, priority)

    def locked_for(self, model: Optional[str] = None) -> bool:
        """True si une nouvelle requête sur ce modèle devrait attendre."""
        key = self._key(model)
        entry = self._active.get(key)
        if entry is not None:
            sem = entry.get("sem")
            return bool(sem and sem.locked())
        # Modèle non encore actif : saturé si tous les slots modèles sont pris
        return len(self._active) >= self.max_models

    def get_stats(self) -> Dict[str, Any]:
        """Snapshot pour monitoring / admin UI."""
        return {
            "max_models": self.max_models,
            # Valeur de config (fallback). La valeur RÉELLEMENT utilisée
            # pour chaque modèle actif est dans active_models[].effective_max_convs
            # (lue depuis /props.total_slots du llama-server).
            "max_conversations_per_model_config_fallback": self.max_convs,
            "total_slots_from_props": _mi._cached_total_slots or None,
            "active_models": [
                {
                    "model": k,
                    "holders": v["holders"],
                    "sem_locked": bool(v["sem"] and v["sem"].locked()),
                    "effective_max_convs": v.get("effective_max_convs", self.max_convs),
                }
                for k, v in self._active.items()
            ],
            # NB : self._slot_waiters contient des 4-uplets
            # (priority, key, future, registered_ts) — cf. _acquire_model_slot.
            # On déballe les 4 champs (déballer en 2 levait ValueError dès
            # qu'un waiter était en file, ce qui crashait /api/llm/queue-status
            # et le broadcaster SSE EXACTEMENT sous contention).
            "slot_waiters": [
                {"model": wkey, "priority": wprio, "cancelled": wfut.cancelled()}
                for (wprio, wkey, wfut, _wts) in self._slot_waiters
            ],
        }

    # ── Drainage FIFO (appelé sous self._guard) ────────────────────────────

    def _drain_waiters_unsafe(self) -> None:
        """
        Sert les waiters dans l'ordre {high d'abord, FIFO à priorité égale}.
        Doit être appelé avec ``self._guard`` détenu. Ne réveille que les
        waiters effectivement servis (pas de thundering herd).

        Algorithme :
          - Nettoyage des cancelled/done sans changer l'ordre.
          - Tri stable : high avant low, FIFO (registered_at) à priorité
            égale.
          - On sert dans cet ordre tant qu'on peut. Dès qu'on tombe sur
            un waiter qui ne peut pas être servi, on stop pour ne pas
            violer FIFO à l'intérieur de la classe.

        Respect de la grâce :
          - Un waiter LOW ne peut pas être servi si une grâce est active
            sur un AUTRE modèle (le high va peut-être ré-acquire).
          - Un waiter LOW peut quand même rejoindre une entry existante
            (join gratuit, pas de switch nécessaire) ou prendre le
            modèle en grâce (puisque c'est CE modèle qui revient).
        """
        # 1. Nettoyage et GC des graces expirées.
        now = time.monotonic()
        self._grace = {k: v for k, v in self._grace.items() if v > now}

        cleaned: "deque[Tuple[str, str, asyncio.Future, float]]" = deque()
        for entry in self._slot_waiters:
            _prio, _wkey, wfut, _ts = entry
            if wfut.cancelled() or wfut.done():
                continue
            cleaned.append(entry)
        self._slot_waiters = cleaned

        if not self._slot_waiters:
            return

        # 2. Tri par (priorité, registered_at).
        ordered = sorted(
            self._slot_waiters,
            key=lambda e: (0 if e[0] == "high" else 1, e[3]),
        )

        served_indices: set = set()
        for entry in ordered:
            prio, wkey, wfut, ts = entry
            if wfut.cancelled() or wfut.done():
                served_indices.add(id(entry))
                continue

            existing = self._active.get(wkey)
            if existing is not None:
                # Modèle déjà actif → join gratuit (pas de switch).
                existing["holders"] += 1
                if prio == "high":
                    existing["had_high"] = True
                if not wfut.done():
                    wfut.set_result(existing["sem"])
                served_indices.add(id(entry))
                continue

            if len(self._active) < self.max_models:
                # Slot libre. Si je suis low ET qu'une grâce est active
                # sur un AUTRE modèle, je dois attendre — un high pourrait
                # ré-acquire ce modèle d'ici GRACE_S secondes et je ne
                # veux pas lui voler son slot.
                if prio == "low":
                    grace_blocking = any(
                        gk != wkey and gv > now
                        for gk, gv in self._grace.items()
                    )
                    if grace_blocking:
                        # Ne PAS break : un high arrivé après peut peut-être
                        # passer (s'il y en a un dans l'ordered list qui suit).
                        # Mais comme on est trié par priorité, tous les highs
                        # sont déjà passés ; donc s'arrêter ici est OK pour
                        # les low restants.
                        # On n'ajoute PAS à served_indices : le waiter reste
                        # en file pour la prochaine itération de drain.
                        continue

                if self.engine_key == "builtin":
                    _effective = (_share_slots_across_workers(_mi._cached_total_slots)
                                  if _mi._cached_total_slots > 0 else self.max_convs)
                else:
                    _effective = self._last_effective or self.max_convs
                sem = asyncio.Semaphore(_effective)
                self._active[wkey] = {
                    "sem": sem, "holders": 1,
                    "effective_max_convs": _effective,
                    "had_high": (prio == "high"),
                }
                if not wfut.done():
                    wfut.set_result(sem)
                served_indices.add(id(entry))
                continue

            # Saturation slots modèles. STOP.
            break

        # 3. Retire les servis de la deque dans l'ordre original.
        if served_indices:
            self._slot_waiters = deque(
                e for e in self._slot_waiters if id(e) not in served_indices
            )

    # ── Acquisition / libération slot modèle ──────────────────────────────

    async def _resolve_effective_max_convs(self) -> int:
        """
        Retourne le nombre de conversations parallèles effectivement utilisable,
        en priorité depuis /props.total_slots (= paramètre -np du llama-server).
        Fallback : self.max_convs (valeur de config LLAMA_MAX_CONCURRENCY).

        IMPORTANT : cet appel est async (/props HTTP) et doit être fait HORS
        du lock self._guard pour éviter une sérialisation inutile des users
        qui arrivent en simultané. L'appelant garantit ça en appelant cette
        méthode AVANT d'entrer dans le lock.

        Le résultat de /props est caché (_mi._cached_total_slots), donc après le
        premier appel c'est instantané jusqu'au prochain invalidation.
        """
        total = await get_model_total_slots()
        if total > 0:
            eff = _share_slots_across_workers(total)
            if self.engine_key != "builtin":
                self._last_effective = eff
            return eff
        return self.max_convs

    async def _acquire_model_slot(
        self,
        key: str,
        priority: str = "high",
    ) -> asyncio.Semaphore:
        """
        Réserve (ou réutilise) un slot modèle. Retourne le Semaphore
        de niveau conversation correspondant.

        :param priority: ``"high"`` (chat) ou ``"low"`` (pipeline).
            Les low en attente cèdent leur place aux high même si
            arrivés avant. Voir ``_drain_waiters_unsafe`` pour la
            logique d'arbitrage. Les low respectent aussi la fenêtre
            de grâce post-release-high (``self._grace``).
        """
        self._ensure()
        loop = asyncio.get_running_loop()

        # Résolution de la taille du pool AVANT le lock : appel async qui
        # pourrait prendre 1-3ms la première fois (ensuite cache), mais qui
        # ne doit pas bloquer les autres coroutines qui attendent ce lock.
        effective_max_convs = await self._resolve_effective_max_convs()

        # Pour les low : attendre la fin de toute grâce active sur un
        # AUTRE modèle ou sur le même modèle (puisque le high va peut-être
        # ré-acquire d'ici 8s). Un low qui veut le même modèle ATTEND la
        # grâce — il sera servi soit après expiration, soit par un drain
        # quand le high reviendra et ressortira proprement.
        if priority == "low":
            # BUG FIX — le plafond « 30s max » était du code mort : ``now``
            # était réassigné À CHAQUE tour de boucle, donc
            # ``time.monotonic() - now`` valait toujours ~la durée du dernier
            # sleep (≤1s) et la condition ``> 30.0`` n'était jamais vraie.
            # Sous trafic de chat soutenu, ``self._grace`` est rafraîchi en
            # continu (8s à chaque release d'un high) → un acquire ``low``
            # (pipeline / run) était affamé indéfiniment au portail de
            # scheduling. On capture désormais l'instant de début d'attente
            # UNE SEULE FOIS, hors boucle, pour que le plafond fonctionne.
            _wait_start = time.monotonic()
            while True:
                async with self._ensure():
                    now = time.monotonic()
                    # GC des graces expirées
                    self._grace = {
                        k: v for k, v in self._grace.items() if v > now
                    }
                    # SAME-MODEL / DÉJÀ-ACTIF = aucun switch requis → jamais
                    # bloqué par la grâce (cohérent avec _drain_waiters_unsafe
                    # `gk != wkey` et les deux ModelExclusivityLock `same_model_ok`).
                    # Avant, un `low` qui voulait le MÊME modèle qu'un `high` qui
                    # venait de libérer attendait toute la fenêtre de grâce (8 s)
                    # pour rien — aucun switch à empêcher. On n'attend QUE si une
                    # grâce pointe vers un AUTRE modèle et que le nôtre n'est ni
                    # actif ni en grâce.
                    same_model_ok = (key in self._active) or (key in self._grace)
                    _other = [v for gk, v in self._grace.items() if gk != key]
                    if same_model_ok or not _other:
                        break
                    grace_remaining = max(_other) - now
                # Wait the grace, capped at 1s for periodic re-check
                await asyncio.sleep(min(max(0.05, grace_remaining), 1.0))
                # Safety: never wait longer than 30s even if graces keep extending
                if time.monotonic() - _wait_start > LOW_WAIT_CAP_S:
                    break

        async with self._ensure():
            entry = self._active.get(key)
            if entry is not None:
                # Modèle déjà actif → join immédiat (pas de file).
                # On ignore la priorité ici : si le slot existe déjà,
                # rejoindre est gratuit, pas de raison de bloquer.
                entry["holders"] += 1
                # Si l'entry tracking l'a, marque qu'un high a holdé.
                if priority == "high":
                    entry["had_high"] = True
                return entry["sem"]
            if len(self._active) < self.max_models:
                # Slot libre. Si je suis low ET qu'un high attend déjà,
                # je m'enfile dans la priority queue au lieu de m'emparer
                # — ça évite que je consomme le seul slot dispo et
                # fasse attendre le high derrière moi.
                has_waiting_high = any(
                    w[0] == "high" and not w[2].cancelled() and not w[2].done()
                    for w in self._slot_waiters
                )
                if priority != "low" or not has_waiting_high:
                    sem = asyncio.Semaphore(effective_max_convs)
                    self._active[key] = {
                        "sem": sem, "holders": 1,
                        "effective_max_convs": effective_max_convs,
                        "had_high": (priority == "high"),
                    }
                    logger.info(
                        "[concurrency] Nouveau pool '%s' → %d conversations parallèles (source: %s)",
                        key, effective_max_convs,
                        "/props" if effective_max_convs != self.max_convs else "config",
                    )
                    return sem
            # Plein : enfiler en priority queue (high d'abord, FIFO ex æquo)
            fut: asyncio.Future = loop.create_future()
            self._slot_waiters.append((priority, key, fut, time.monotonic()))

        # Attente HORS du lock
        try:
            sem = await fut
            return sem
        except (asyncio.CancelledError, BaseException):
            # Annulation : nettoyage et relance du drainage
            async with self._ensure():
                self._slot_waiters = deque(
                    e for e in self._slot_waiters if e[2] is not fut
                )
                # Cas de course : on a été servi PENDANT l'annulation
                if fut.done() and not fut.cancelled():
                    try:
                        granted = fut.result()
                    except Exception:
                        granted = None
                    if granted is not None:
                        # On a hérité d'un slot/holder qu'il faut rendre
                        entry = self._active.get(key)
                        if entry is not None:
                            entry["holders"] -= 1
                            if entry["holders"] <= 0:
                                self._active.pop(key, None)
                                self._drain_waiters_unsafe()
            raise

    async def _release_model_slot(self, key: str) -> None:
        async with self._ensure():
            entry = self._active.get(key)
            if entry is None:
                return
            entry["holders"] -= 1
            if entry["holders"] > 0:
                return
            had_high = bool(entry.get("had_high", False))
            self._active.pop(key, None)
            # Si un high a tenu ce slot, ouvrir la fenêtre de grâce
            # post-release pour que les chats MCP qui font
            # acquire/release/acquire entre tool calls ne se fassent
            # pas voler le slot par un pipeline low qui passait par là.
            #
            # AUDIT 2026-06 — source UNIQUE de la grâce : quand le lock
            # distribué Redis est effectivement actif, il porte DÉJÀ sa
            # propre fenêtre de grâce (scripts Lua, cohérente cluster-wide).
            # Poser EN PLUS la grâce process-locale donnait deux fenêtres en
            # cascade, incohérentes entre workers. Toggle LLM_GRACE_SOURCE :
            #   auto  (défaut) = locale seulement si Redis inactif
            #   local / both   = comportement historique (rollback immédiat)
            # Fail-safe : toute erreur → grâce locale conservée.
            if had_high and self._local_grace_enabled():
                self._grace[key] = time.monotonic() + self.GRACE_S
                # Schedule un re-drain à expiration de la grâce. Sans
                # ça, un low en file qui attend l'expiration de la
                # grâce ne serait jamais réveillé (les drains ne se
                # produisent que sur release, et il n'y a plus de
                # release à venir si le user a fini son chat).
                self._schedule_grace_redrain(self.GRACE_S + 0.05)
            self._drain_waiters_unsafe()

    def _local_grace_enabled(self) -> bool:
        """Faut-il poser la grâce PROCESS-LOCALE ? (cf. commentaire au site
        d'appel — AUDIT 2026-06). Import paresseux de _locks pour éviter le
        cycle (_guard importe les deux modules)."""
        mode = os.environ.get("LLM_GRACE_SOURCE", "auto").strip().lower()
        if mode in ("local", "both"):
            return True
        if mode == "auto":
            try:
                from llm_core._scheduling._locks import MODEL_EXCLUSIVITY
                return not MODEL_EXCLUSIVITY.is_distributed()
            except Exception:
                return True            # fail-safe : comportement historique
        return True                    # valeur inconnue → historique

    def _schedule_grace_redrain(self, delay: float) -> None:
        """Schedule un re-drain dans ``delay`` secondes pour réveiller
        les low en attente quand la grâce expire. Idempotent : si un
        timer est déjà actif et expire après ce delay, on n'en re-schedule
        pas un autre. Sinon on remplace.
        """
        loop = asyncio.get_running_loop()
        target_ts = loop.time() + delay
        # Si un timer existant pointe vers une expiration ≥ la nôtre,
        # rien à faire : il drainera après nous, donc tant pis on aura
        # juste un wakeup légèrement tardif. C'est OK.
        existing = getattr(self, "_grace_drain_handle", None)
        existing_ts = getattr(self, "_grace_drain_ts", 0.0)
        if existing is not None and not existing.cancelled() and existing_ts >= target_ts:
            return
        if existing is not None:
            try: existing.cancel()
            except Exception: pass
        self._grace_drain_ts = target_ts

        def _trigger():
            # Schedule the actual drain on the loop. We can't await here
            # so we create a task. On garde une RÉFÉRENCE FORTE (asyncio ne
            # tient qu'une réf faible aux tasks → sans ça elle peut être GC en
            # plein vol) et on la retire à la fin. _do_grace_redrain est court
            # (acquire guard + drain), donc ne bloque pas l'arrêt du worker.
            t = loop.create_task(self._do_grace_redrain())
            tasks = getattr(self, "_grace_tasks", None)
            if tasks is None:
                tasks = self._grace_tasks = set()
            tasks.add(t)
            t.add_done_callback(tasks.discard)

        self._grace_drain_handle = loop.call_later(delay, _trigger)

    async def _do_grace_redrain(self) -> None:
        """Re-drain les waiters sous le lock. Appelé par le timer de grâce."""
        async with self._ensure():
            self._drain_waiters_unsafe()


class _LLMAcquisition:
    """
    Context manager qui acquiert (1) un slot modèle puis (2) un slot
    conversation. Libère les deux dans l'ordre inverse.

    Priorité (v4.33+) :
        Les acquires "low" cèdent leur tour aux "high" en attente, à la
        fois pour le slot modèle (priority queue dans
        ``_drain_waiters_unsafe``) et pour le slot conversation (yield
        check avant chaque acquire).
    """

    __slots__ = ("_mgr", "_model_key", "_priority", "_sem",
                 "_sem_acquired", "_slot_acquired")

    def __init__(self, mgr: LLMConcurrencyManager,
                 model: Optional[str], priority: str = "high"):
        self._mgr = mgr
        self._model_key = mgr._key(model)
        self._priority = priority if priority in ("high", "low") else "high"
        self._sem: Optional[asyncio.Semaphore] = None
        self._sem_acquired = False
        self._slot_acquired = False

    async def _yield_to_high_if_low(self) -> None:
        """Si je suis low, vérifier qu'aucun high n'est en attente du
        même modèle dans la file d'attente du manager. Si oui, attendre
        qu'il passe avant de tenter mon acquire de slot conversation.

        Cap à 30s pour ne JAMAIS bloquer indéfiniment un low — au pire
        il passe après 30s même si un high pop en boucle. Ce sont des
        runs batch, pas du synchrone temps-réel.
        """
        if self._priority != "low":
            return
        deadline = time.monotonic() + 30.0
        while time.monotonic() < deadline:
            async with self._mgr._ensure():
                has_waiting_high = any(
                    w[0] == "high"
                    and w[1] == self._model_key
                    and not w[2].cancelled()
                    and not w[2].done()
                    for w in self._mgr._slot_waiters
                )
            if not has_waiting_high:
                return
            # Attente courte et re-check (les highs sont en général brefs)
            await asyncio.sleep(0.1)

    async def __aenter__(self):
        # AUDIT 2026-08-23 — ORDONNANCEUR = RESSOURCE LOCALE, au point où le
        # verrou est RÉELLEMENT pris.
        #
        # Le correctif D1 (2026-08-22) avait posé la règle en tête de
        # ``llm_scheduling_guard`` : cible non ``is_local_llamacpp`` ⇒ aucun
        # niveau. Mais en mode « optimized » le garde DÉLÈGUE le niveau 2 à
        # ``run_chat_multi_mcp_v2``, qui pose ``_inline_semaphore=True`` en dur
        # sans jamais consulter la cible et prend ce sémaphore autour de chaque
        # appel LLM. La clé étant le NOM du modèle, ``claude-opus-5`` occupait
        # donc LE slot modèle local (``LLAMA_MAX_MODELS=1`` par défaut) pendant
        # toute la durée d'un appel qui ne touche jamais le llama-server : les
        # chats locaux passaient en file derrière un run cloud — exactement la
        # panne que D1 décrit, déplacée du niveau 1 au niveau 2.
        #
        # Le garde ici est le point de passage OBLIGÉ de tous les appelants,
        # présents et futurs.
        #
        # AUDIT 2026-09-16 — la règle devient « CE gestionnaire n'ordonnance
        # que SON serveur » : un connecteur llama.cpp a désormais son propre
        # gestionnaire (``_scheduling._engines.scheduling_for``). Un appel dont
        # la cible est un autre serveur (cloud, autre llama.cpp) ne prend rien
        # ici — même si un site d'appel oublié acquiert encore le singleton de
        # l'intégré.
        try:
            from llm_core.engines import current_engine
            _eng = current_engine()
            if not _eng.is_llamacpp or _eng.key != self._mgr.engine_key:
                self._slot_acquired = False
                self._sem_acquired = False
                return self
        except Exception:                                       # noqa: BLE001
            pass                    # cible inconnue ⇒ comportement historique
        # Phase 1 : slot modèle (priority-aware FIFO)
        self._sem = await self._mgr._acquire_model_slot(
            self._model_key, priority=self._priority,
        )
        self._slot_acquired = True
        # Phase 2 : avant de prendre le slot conversation, si je suis
        # low je laisse passer les high déjà en file d'attente.
        try:
            await self._yield_to_high_if_low()
            await self._sem.acquire()
            self._sem_acquired = True
        except BaseException:
            # Annulation pendant l'attente du sem conversation → libérer le slot modèle
            await self._mgr._release_model_slot(self._model_key)
            self._slot_acquired = False
            raise
        return self

    async def __aexit__(self, exc_type, exc, tb):
        # 1. Relâcher le slot conversation
        if self._sem_acquired and self._sem is not None:
            try:
                self._sem.release()
            except Exception:
                pass
            self._sem_acquired = False
        # 2. Décrémenter holders ; si dernier → libérer le slot modèle + drainer FIFO
        if self._slot_acquired:
            try:
                await self._mgr._release_model_slot(self._model_key)
            finally:
                self._slot_acquired = False
        return False


# ─────────────────────────────────────────────────────────────────────────────
#  Singleton
# ─────────────────────────────────────────────────────────────────────────────
# ``LLM_SEMAPHORE`` is the historical name kept for import-compatibility.
# It is the FIFO two-level manager every caller acquires from.
def _share_slots_across_workers(total_slots: int) -> int:
    """Part des slots llama.cpp qui revient à CE worker.

    AUDIT 2026-08-22 (D3) — ce gestionnaire est un singleton de PROCESS, mais
    il se dimensionnait sur ``total_slots``, c'est-à-dire le ``-np`` du
    llama-server, qui est une ressource de MACHINE. Avec trois workers gunicorn
    (le calcul par défaut sur une VM 4 cœurs), chacun s'autorisait les quatre
    slots d'un serveur qui n'en a que quatre : jusqu'à douze générations
    lancées sur quatre emplacements. Le surplus s'empile dans la file interne
    de llama.cpp, les caches KV s'évincent mutuellement et se re-préchargent, et
    l'hypothèse « n_ctx par slot = C / -np » — sur laquelle repose tout le
    calcul de contexte — ne tient plus. Un utilisateur voyait donc son flux
    caler à cause de trois autres, sur d'autres workers, qu'aucun compteur ne
    lui opposait.

    Le partage est volontairement ARITHMÉTIQUE et non distribué : un compteur
    de slots partagé via Redis serait plus fin, mais il ferait dépendre chaque
    appel LLM de la disponibilité de Redis. Ici, au pire, on sous-utilise.
    """
    try:
        n_workers = int(os.environ.get("APP_WORKERS_EFFECTIVE", "") or 0)
    except (TypeError, ValueError):
        n_workers = 0
    if n_workers <= 1:
        return max(1, int(total_slots))
    return max(1, int(total_slots) // n_workers)


LLM_SEMAPHORE = LLMConcurrencyManager(LLAMA_MAX_MODELS, LLAMA_MAX_CONCURRENCY)
