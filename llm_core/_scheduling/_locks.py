# SPDX-License-Identifier: MIT
"""
backend.services._scheduling._locks — Cross-model exclusivity locks.

Two implementations of the same contract — only one is alive at a time:

  - ``ModelExclusivityLock`` (process-local): single-worker fallback.
    Fast in-process Event + counter. Fine for ``gunicorn workers=1``.

  - ``DistributedModelExclusivityLock`` (Redis-backed): multi-worker safe.
    State is a JSON value in Redis; arbitration is performed by atomic
    Lua scripts so several workers contending for a lock never race.
    Wakeups across workers go through Redis Pub/Sub.

The four ``_LUA_*`` strings are the Lua scripts loaded into Redis at
first acquisition. They live at module level so they are uploaded once
per worker, not per call.

Why both?
---------
A single-process app would never need the distributed version. But the
dev VM and the prod box both run gunicorn with N>1 workers, and a chat
in worker A must not let worker B trigger a model switch in the middle
of generation. Without the distributed lock, the user sees their stream
cut mid-token whenever someone else picks a different model.

If Redis is unreachable, the distributed lock degrades to the local one
automatically (logged as a warning, app keeps working).

Singleton
---------
``MODEL_EXCLUSIVITY = DistributedModelExclusivityLock()`` is the global
both ``llm_scheduling_guard`` and ``get_queue_status_for`` acquire from.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from contextlib import asynccontextmanager
from typing import Any, Dict, Optional

from shared_infra.config import LLAMA_MODEL

logger = logging.getLogger("uvicorn.error")


class ModelExclusivityLock:
    """Sérialise les requêtes entre modèles différents, parallélise
    celles sur le même modèle. Voir module docstring plus haut.

    Priorités (v4.31+) :
        - "high" : appels du chat utilisateur (interactif, sensible à la
                   latence — on ne doit JAMAIS faire attendre un user qui
                   tape pour lui répondre derrière un pipeline batch).
        - "low"  : appels de fond (compression, routines, rejeux de
                   scénarios). Peuvent être différés pour laisser passer
                   un chat.

    Règles d'arbitrage :
        1. Un acquire "high" passe avant tout acquire "low" en attente
           pour un autre modèle, même si le low était arrivé en premier.
        2. Un nouvel acquire "low" ne peut pas commencer un SWITCH de
           modèle s'il y a au moins un "high" en attente (ou actif sur
           un modèle différent). Il attend la fin du high.
        3. **Fenêtre de grâce post-release** : quand un "high" libère
           le lock, le modèle courant reste réservé pour ``GRACE_S``
           secondes. Pendant cette fenêtre, un "low" qui voudrait
           switcher de modèle doit attendre. C'est essentiel pour les
           chats MCP qui font ``acquire → tool_call (lock released) →
           acquire`` en boucle — sans grâce, un pipeline peut s'insérer
           entre deux étapes du chat et forcer un switch de modèle
           pendant le tool call, cassant la conversation.
        4. Les acquires actifs ne sont jamais interrompus en cours
           d'exécution (sinon on casse la génération en flight). On
           garantit juste l'ORDRE de passage des prochains acquires.
        5. Les acquires sur le MÊME modèle que l'actif (ou que celui en
           grâce) se parallélisent normalement quelle que soit leur
           priorité (pas de switch nécessaire).
    """

    # Durée pendant laquelle le modèle reste "réservé" après qu'un high
    # ait libéré le lock. Doit être assez large pour couvrir la pause
    # MCP entre deux steps (généralement < 5 s pour des tool calls non-
    # bloquants), mais pas trop pour ne pas geler un pipeline si le user
    # a vraiment fini son chat.
    GRACE_S: float = 8.0

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._current_model: Optional[str] = None
        self._active_count: int = 0
        # Event mis à True quand aucune requête n'est active (libre de
        # switch). Clear dès qu'une requête entre en section critique.
        self._idle_event = asyncio.Event()
        self._idle_event.set()
        # Compteur de hauts en attente d'un autre modèle. Si ≥ 1, les
        # nouveaux "low" qui veulent un switch attendent.
        self._high_waiting: int = 0
        # Event signalé quand le compteur _high_waiting passe à 0.
        # Utilisé par les "low" pour savoir quand ils peuvent retenter.
        self._no_high_waiting = asyncio.Event()
        self._no_high_waiting.set()
        # Fenêtre de grâce post-release-high : modèle réservé pendant
        # GRACE_S secondes après qu'un high ait libéré le lock. Les low
        # qui veulent un autre modèle attendent la fin de la grâce —
        # essentiel pour ne pas casser un chat MCP entre deux tool calls.
        self._grace_model: Optional[str] = None
        self._grace_until: float = 0.0  # event-loop monotonic timestamp

    def _grace_active_for_other(self, target: str) -> float:
        """Renvoie le nombre de secondes de grâce restantes si le target
        diffère du modèle en grâce, 0 sinon. Appelée sous lock."""
        if not self._grace_model or self._grace_model == target:
            return 0.0
        try:
            remaining = self._grace_until - asyncio.get_event_loop().time()
        except RuntimeError:
            return 0.0
        return remaining if remaining > 0 else 0.0

    @property
    def current_model(self) -> Optional[str]:
        return self._current_model

    @property
    def active_count(self) -> int:
        return self._active_count

    def snapshot(self) -> Dict[str, Any]:
        """Pour debug / metrics / queue_status. Copie atomique."""
        try:
            now = asyncio.get_event_loop().time()
        except RuntimeError:
            now = 0.0
        grace_remaining = max(0.0, self._grace_until - now) if self._grace_model else 0.0
        return {
            "current_model":   self._current_model,
            "active_count":    self._active_count,
            "is_idle":         self._idle_event.is_set(),
            "high_waiting":    self._high_waiting,
            "grace_model":     self._grace_model,
            "grace_remaining": grace_remaining,
        }

    @asynccontextmanager
    async def acquire_for(self, model: Optional[str], priority: str = "high"):
        """Attend que le modèle ``model`` soit disponible (même modèle
        que l'actif, ou aucun actif), puis incrémente le compteur.
        Libère à la sortie du contexte.

        :param priority: "high" (chat user) ou "low" (pipeline/agentic).
            Voir la docstring de la classe pour les règles d'arbitrage.
        """
        target = model or LLAMA_MODEL or "default"
        is_high = (priority == "high")

        # Comptabilise ce high comme "en attente" dès le début pour que
        # les low concurrents le voient et lui cèdent la place. On le
        # décrémente une fois acquis (ou en cas d'exception).
        # Pour les low, pas d'inscription : ils sont les yielders.
        registered_high = False

        try:
            while True:
                # ── Étape 1 : si je suis "low", attendre qu'aucun "high"
                # ne soit en attente d'un autre modèle ET que la fenêtre
                # de grâce ne pointe pas vers un autre modèle. Sinon je
                # risque de m'emparer du verrou et de casser un chat MCP
                # entre deux de ses tool calls. Cette attente n'est pas
                # active quand le modèle courant matche déjà ma cible
                # (rejoindre le groupe sans switch ne pose aucun problème).
                if not is_high:
                    # AUDIT 2026-08-23 — cette boucle n'avait AUCUN plafond.
                    #
                    # Le niveau 2 porte un correctif documenté (« sous trafic
                    # de chat soutenu, la grâce est rafraîchie en continu → un
                    # acquire low était affamé indéfiniment ») avec un break de
                    # sécurité à 30 s. La MÊME boucle existe ici, au niveau 1 —
                    # qui est acquis AVANT le niveau 2 : un « low » bloqué ici
                    # n'atteignait donc jamais ce plafond, qui devenait
                    # inopérant. Mesuré avec GRACE_S=0.5 : une routine « low »
                    # jamais servie en 6 s pendant qu'un chat bouclait toutes
                    # les 200 ms ; en production GRACE_S vaut 8 s, il suffit
                    # donc d'un message toutes les 8 s pour geler une routine
                    # des heures — sans log, sans échéance, sans annulation
                    # possible (l'appelant routine ne passe ni ``on_wait`` ni
                    # ``cancel_probe``, et le heartbeat continue de la marquer
                    # « en cours »).
                    from llm_core._scheduling._concurrency import LOW_WAIT_CAP_S
                    _wait_start = time.monotonic()
                    while True:
                        async with self._lock:
                            same_model_ok = (
                                (self._active_count > 0
                                 and self._current_model == target)
                                or (self._grace_model == target)
                            )
                            grace_remaining = self._grace_active_for_other(target)
                            if same_model_ok or (
                                self._high_waiting == 0 and grace_remaining <= 0
                            ):
                                # Voie libre : aucun high pendant, pas de
                                # grâce sur un autre modèle, OU le modèle
                                # demandé matche celui en cours/en grâce.
                                break
                            wait_high = self._high_waiting > 0
                        # Hors lock : on attend.
                        # — Si un high est en file, on attend qu'il passe.
                        # — Sinon c'est juste la grâce : on dort la durée
                        #   restante (capée à 1 s pour rechecker au cas où
                        #   un high s'inscrit pendant qu'on dort).
                        _reste = LOW_WAIT_CAP_S - (time.monotonic() - _wait_start)
                        if _reste <= 0:
                            logger.info(
                                "[model_lock] acquisition 'low' sur %r : "
                                "plafond d'attente de %.0fs atteint au portail "
                                "de grâce — on passe (anti-famine).",
                                target, LOW_WAIT_CAP_S)
                            break
                        if wait_high:
                            # Borné : sans cela, un flux ininterrompu de high
                            # laissait ce ``wait()`` sans échéance.
                            try:
                                await asyncio.wait_for(
                                    self._no_high_waiting.wait(), timeout=_reste)
                            except asyncio.TimeoutError:
                                continue
                        else:
                            # Plancher 50 ms : avec grace_remaining == 0 (état
                            # incohérent transitoire), sleep(0) busy-loopait
                            # l'event loop à 100 % CPU.
                            await asyncio.sleep(min(max(grace_remaining, 0.05), 1.0))

                # ── Étape 2 : tentative d'acquisition.
                async with self._lock:
                    if self._active_count == 0:
                        # Terrain vide : on s'empare. Si la cible matche
                        # le modèle en grâce, on s'empare quel que soit
                        # le priority. Sinon (low + grâce sur autre modèle)
                        # l'étape 1 nous aura déjà fait attendre.
                        self._current_model = target
                        self._active_count = 1
                        self._idle_event.clear()
                        # Acquisition annule la grâce — on est de nouveau
                        # actif, pas en pause inter-call.
                        self._grace_model = None
                        self._grace_until = 0.0
                        if registered_high:
                            # BUG FIX (famine permanente des low) — remettre
                            # registered_high à False après avoir retiré
                            # l'inscription (aligné sur la version Redis,
                            # post-PROMOTE). Sans ça, une exception traversant
                            # le yield (CancelledError d'un Stop, timeout
                            # httpx) re-décrémentait _high_waiting dans
                            # l'except BaseException → compteur négatif →
                            # ``_high_waiting == 0`` plus jamais vrai → tous
                            # les acquires priority="low" (Routines) gelés
                            # en busy-loop jusqu'au restart du worker.
                            self._high_waiting = max(0, self._high_waiting - 1)
                            if self._high_waiting <= 0:
                                self._no_high_waiting.set()
                            registered_high = False
                        return_now = True
                    elif self._current_model == target:
                        # Même modèle : on rejoint le groupe actif.
                        self._active_count += 1
                        if registered_high:
                            # Cf. BUG FIX ci-dessus (même logique).
                            self._high_waiting = max(0, self._high_waiting - 1)
                            if self._high_waiting <= 0:
                                self._no_high_waiting.set()
                            registered_high = False
                        return_now = True
                    else:
                        # Modèle différent : on doit attendre. Si je suis
                        # high et pas encore inscrit, je m'inscris pour
                        # bloquer les low concurrents.
                        if is_high and not registered_high:
                            self._high_waiting += 1
                            self._no_high_waiting.clear()
                            registered_high = True
                        return_now = False

                if return_now:
                    break
                # Modèle différent → attendre que le groupe actif ait fini.
                await self._idle_event.wait()

            # Section critique acquise.
            try:
                yield
            finally:
                async with self._lock:
                    self._active_count = max(0, self._active_count - 1)
                    if self._active_count == 0:
                        # Si c'était un high, on ouvre la fenêtre de grâce
                        # sur le modèle qui vient d'être utilisé. Pour un
                        # low, pas de grâce — ça permet aux pipelines de
                        # s'enchaîner sans se geler eux-mêmes.
                        last_model = self._current_model
                        self._current_model = None
                        self._idle_event.set()
                        if is_high and last_model:
                            try:
                                self._grace_until = (
                                    asyncio.get_event_loop().time() + self.GRACE_S
                                )
                                self._grace_model = last_model
                            except RuntimeError:
                                # No running loop (shouldn't happen here)
                                pass
                        # Si on est low, on n'écrase PAS une grâce préexistante :
                        # un high a pu libérer juste avant nous et la grâce
                        # tient encore — c'est ce qu'on veut.
        except BaseException:
            # En cas d'exception PENDANT l'attente (ex: cancel, timeout),
            # on doit décrémenter notre inscription de high pour ne pas
            # bloquer les low indéfiniment. registered_high est remis à
            # False dès l'acquisition (cf. plus haut) : une exception qui
            # traverse le yield n'arrive plus ici avec une inscription
            # déjà retirée (c'était la cause de la corruption du compteur).
            if registered_high:
                async with self._lock:
                    self._high_waiting = max(0, self._high_waiting - 1)
                    if self._high_waiting <= 0:
                        self._no_high_waiting.set()
            raise


# ──────────────────────────────────────────────────────────────────────────────
# DistributedModelExclusivityLock (v4.32+) — multi-worker safe
# ──────────────────────────────────────────────────────────────────────────────
#
# Le lock local précédent est un singleton PAR PROCESS Python. Si l'app tourne
# avec gunicorn/uvicorn en multi-worker (workers > 1), chaque worker a sa
# propre instance, donc :
#   - Worker A : user alice en chat MCP sur Qwen-35B
#   - Worker B : user admin lance un pipeline qui veut un autre modèle
#   - Le lock du worker B ne voit PAS l'activité du worker A
#   - Le pipeline force un switch et casse le chat d'alice
#
# Solution : stocker l'état du lock dans Redis (qui est déjà utilisé par
# pipeline_events). Tous les workers voient le même état. Un script Lua
# atomique gère l'arbitrage (priorité, grâce) côté serveur Redis sans race
# condition. Pub/Sub réveille les workers en attente quand le lock se libère.
#
# Si Redis est indisponible, on retombe automatiquement sur l'implémentation
# locale ci-dessus (mode mono-worker uniquement).

# Script Lua : tente d'acquérir le lock atomiquement.
# KEYS[1] = state key (JSON pickled)
# ARGV    = target_model, priority ('high'|'low'), grace_s, now_ts, lock_id,
#           [gate_lifted] ('1' = plafond d'attente « low » atteint : l'étape 1
#           — portail grâce/high — est sautée ; l'attente du MODÈLE demeure)
# Returns un JSON: {"acquired": bool, "wait_for": "model"|"high"|"grace"|"none", ...}
_LUA_ACQUIRE = """
local key = KEYS[1]
local target = ARGV[1]
local priority = ARGV[2]
local grace_s = tonumber(ARGV[3])
local now = tonumber(ARGV[4])
local lock_id = ARGV[5]
local gate_lifted = (ARGV[6] == '1')

local raw = redis.call('GET', key)
local state
if raw then
    state = cjson.decode(raw)
else
    state = {
        current_model = nil,
        active_count = 0,
        active_locks = {},
        high_waiting = 0,
        grace_model = nil,
        grace_until = 0,
    }
end

local is_high = (priority == 'high')

-- Garbage collect stale active locks (worker crashed mid-execution).
-- Each lock entry has an expires_at field. If now > expires_at, drop it.
local kept = {}
local kept_count = 0
local kept_model = state.current_model
for _, entry in ipairs(state.active_locks or {}) do
    if entry.expires_at > now then
        table.insert(kept, entry)
        kept_count = kept_count + 1
    end
end
state.active_locks = kept
state.active_count = kept_count
if kept_count == 0 then
    state.current_model = nil
end

-- GC des high_waiting orphelins :
-- Si on a high_waiting > 0 mais que ça fait longtemps qu'aucun lock
-- actif n'existe (active_count == 0 ET grace expirée), c'est qu'un
-- registered_high a fui (cancel non propre, worker crashé pendant
-- l'attente, etc.). On reset le compteur. Sinon les low restent
-- bloqués éternellement.
-- On utilise high_waiting_ts comme dernier "movement" : à chaque
-- ++/--/promote, on remet high_waiting_ts = now. Si now - ts > 60s
-- ET active_count == 0, on reset.
if state.high_waiting and state.high_waiting > 0 then
    local last_move = state.high_waiting_ts or 0
    if state.active_count == 0
       and (state.grace_until or 0) < now
       and now - last_move > 60 then
        state.high_waiting = 0
        state.high_waiting_ts = now
    end
end

-- Step 1 : low must wait if a high is waiting OR grace points to another model
-- (sauf portail levé par le plafond anti-famine : cf. ARGV[6])
if not is_high and not gate_lifted then
    local same_model_ok = (
        (state.active_count > 0 and state.current_model == target)
        or (state.grace_model == target)
    )
    local grace_blocking = (
        state.grace_model and state.grace_model ~= target
        and state.grace_until > now
    )
    if not same_model_ok and ((state.high_waiting or 0) > 0 or grace_blocking) then
        redis.call('SET', key, cjson.encode(state))
        if grace_blocking then
            return cjson.encode({acquired=false, wait_for='grace',
                                 grace_remaining=state.grace_until - now})
        else
            return cjson.encode({acquired=false, wait_for='high'})
        end
    end
end

-- Step 2 : try to acquire
if state.active_count == 0 then
    state.current_model = target
    state.active_count = 1
    state.grace_model = nil
    state.grace_until = 0
    table.insert(state.active_locks, {
        lock_id = lock_id,
        priority = priority,
        expires_at = now + 600,  -- 10min watchdog (renewed on heartbeat)
    })
    redis.call('SET', key, cjson.encode(state))
    return cjson.encode({acquired=true})
elseif state.current_model == target then
    state.active_count = state.active_count + 1
    table.insert(state.active_locks, {
        lock_id = lock_id,
        priority = priority,
        expires_at = now + 600,
    })
    redis.call('SET', key, cjson.encode(state))
    return cjson.encode({acquired=true})
else
    -- Different model in use: must wait
    if is_high then
        -- Register as a waiting high so lows yield
        state.high_waiting = (state.high_waiting or 0) + 1
        state.high_waiting_ts = now
        redis.call('SET', key, cjson.encode(state))
        return cjson.encode({acquired=false, wait_for='model', registered_high=true})
    else
        redis.call('SET', key, cjson.encode(state))
        return cjson.encode({acquired=false, wait_for='model', registered_high=false})
    end
end
"""

# Script Lua : libère le lock atomiquement.
# KEYS[1] = state key
# ARGV    = lock_id, was_high, grace_s, now_ts
# Returns true si le lock était bien actif (pour signaler aux waiters).
_LUA_RELEASE = """
local key = KEYS[1]
local lock_id = ARGV[1]
local was_high = (ARGV[2] == '1')
local grace_s = tonumber(ARGV[3])
local now = tonumber(ARGV[4])

local raw = redis.call('GET', key)
if not raw then return 'noop' end
local state = cjson.decode(raw)

local new_locks = {}
local found = false
for _, entry in ipairs(state.active_locks or {}) do
    if entry.lock_id == lock_id then
        found = true
    else
        table.insert(new_locks, entry)
    end
end
state.active_locks = new_locks
state.active_count = #new_locks

if state.active_count == 0 then
    local last_model = state.current_model
    state.current_model = nil
    if was_high and last_model then
        state.grace_model = last_model
        state.grace_until = now + grace_s
    end
    -- Note: we don't clear grace if was_high=false ; an earlier high may have
    -- set a grace that's still relevant.
end

redis.call('SET', key, cjson.encode(state))
return found and 'released' or 'not-found'
"""

# Script Lua : décrémente le compteur high_waiting (acquire annulé/erreur).
_LUA_DEREGISTER_HIGH = """
local key = KEYS[1]
local now = tonumber(ARGV[1] or '0')
local raw = redis.call('GET', key)
if not raw then return 0 end
local state = cjson.decode(raw)
if (state.high_waiting or 0) > 0 then
    state.high_waiting = state.high_waiting - 1
    state.high_waiting_ts = now
    redis.call('SET', key, cjson.encode(state))
end
return state.high_waiting
"""

# Script Lua : décrémente high_waiting + transfère vers actif quand un high
# acquire après son attente (passe de waiting à actif).
_LUA_PROMOTE_HIGH = """
local key = KEYS[1]
local target = ARGV[1]
local now = tonumber(ARGV[2])
local lock_id = ARGV[3]

local raw = redis.call('GET', key)
if not raw then return cjson.encode({acquired=false}) end
local state = cjson.decode(raw)

-- Same GC pass as in acquire to avoid stale entries blocking us.
local kept = {}
for _, entry in ipairs(state.active_locks or {}) do
    if entry.expires_at > now then table.insert(kept, entry) end
end
state.active_locks = kept
state.active_count = #kept
if state.active_count == 0 then state.current_model = nil end

if state.active_count == 0 then
    state.current_model = target
    state.active_count = 1
    state.grace_model = nil
    state.grace_until = 0
    if (state.high_waiting or 0) > 0 then
        state.high_waiting = state.high_waiting - 1
        state.high_waiting_ts = now
    end
    table.insert(state.active_locks, {
        lock_id = lock_id, priority = 'high', expires_at = now + 600,
    })
    redis.call('SET', key, cjson.encode(state))
    return cjson.encode({acquired=true})
elseif state.current_model == target then
    state.active_count = state.active_count + 1
    if (state.high_waiting or 0) > 0 then
        state.high_waiting = state.high_waiting - 1
        state.high_waiting_ts = now
    end
    table.insert(state.active_locks, {
        lock_id = lock_id, priority = 'high', expires_at = now + 600,
    })
    redis.call('SET', key, cjson.encode(state))
    return cjson.encode({acquired=true})
end
return cjson.encode({acquired=false})
"""


class DistributedModelExclusivityLock:
    """Lock distribué via Redis : tous les workers Python du déploiement
    voient le même état du lock. Indispensable en mode multi-worker
    (gunicorn/uvicorn workers > 1).

    Si Redis est inaccessible à l'instanciation (ou crashé en cours
    d'exécution), on retombe sur ``ModelExclusivityLock`` local — mode
    dégradé qui ne fonctionne correctement qu'en mono-worker.

    Mêmes sémantiques que la version locale :
      - Priorité high (chat) > low (pipeline) pour les switches
      - Fenêtre de grâce de GRACE_S secondes après release-high
      - Same-model = parallélisme normal

    L'arbitrage est entièrement déporté côté Redis via scripts Lua
    atomiques pour éviter les races entre workers.
    """

    GRACE_S: float = 8.0
    REDIS_KEY = "elpis:model_excl:state"
    PUBSUB_CHANNEL = "elpis:model_excl:wakeup"
    # Durée du repli local après une panne Redis (audit 2026-08-23). Passé ce
    # délai, la prochaine acquisition retente la connexion — comme le fait
    # déjà l'abonné avec son back-off.
    FALLBACK_COOLDOWN_S = 30.0
    LOCK_TTL_S = 600  # max active duration before garbage-collected
    HEARTBEAT_S = 60  # how often active locks refresh their TTL

    def __init__(self, namespace: str = "") -> None:
        # AUDIT 2026-09-16 — un verrou PAR SERVEUR llama.cpp. ``namespace``
        # vide = serveur intégré (clés Redis historiques) ; sinon la clé du
        # moteur (``conn:<id>``) suffixe l'état et le canal de réveil : deux
        # serveurs ne se bloquent plus l'un l'autre au changement de modèle.
        if namespace:
            self.REDIS_KEY = f"{type(self).REDIS_KEY}:{namespace}"
            self.PUBSUB_CHANNEL = f"{type(self).PUBSUB_CHANNEL}:{namespace}"
        self.namespace = namespace
        self._redis = None  # set on first use
        self._redis_url = os.environ.get("REDIS_URL", "redis://127.0.0.1:6379/0")
        self._init_lock = asyncio.Lock()
        self._sub_task: Optional[asyncio.Task] = None
        # List of pending one-shot futures, resolved by the pub/sub listener
        # when a wakeup arrives. Each waiter creates its own future to avoid
        # the set/clear race that an Event would have.
        self._wakeup_waiters: list = []
        # Local fallback used if Redis dies. Same semantics, single-worker only.
        self._local_fallback = ModelExclusivityLock()
        # AUDIT 2026-08-23 — repli local RÉVERSIBLE.
        #
        # Ce drapeau était posé à True par la moindre erreur ``eval`` et
        # n'était JAMAIS remis à False : après un ``systemctl restart redis``
        # d'une seconde, l'abonné se rétablissait (il porte un back-off de
        # reconnexion explicite) et croyait veiller, tandis que TOUTES les
        # acquisitions du worker étaient passées en local, en silence, jusqu'au
        # recyclage du process. Deux workers arbitraient alors selon deux
        # politiques différentes : l'un pouvait déclencher un switch de modèle
        # sous la génération de l'autre — la panne exacte que ce verrou existe
        # pour empêcher. Effet de bord : ``is_distributed()`` devenait False,
        # donc la grâce process-locale se réactivait sur CE worker seulement.
        #
        # On date le repli au lieu de le figer. ``ImportError`` (redis absent)
        # reste définitif : celui-là ne se répare pas à chaud.
        self._fallback_until = 0.0
        self._fallback_permanent = False

    @property
    def current_model(self) -> Optional[str]:
        """Best-effort, sync getter — used by debug code only."""
        if self._fallback_active:
            return self._local_fallback.current_model
        return None  # async snapshot is the real source

    @property
    def active_count(self) -> int:
        if self._fallback_active:
            return self._local_fallback.active_count
        return 0

    def is_distributed(self) -> bool:
        """True si le lock distribué Redis est EFFECTIVEMENT actif (client
        connecté, pas en fallback local).

        AUDIT 2026-06 — utilisé par LLMConcurrencyManager pour ne pas poser
        une fenêtre de grâce process-locale EN PLUS de la grâce Redis (les
        deux s'appliquaient en cascade, incohérentes entre workers).
        Best-effort et sans I/O : si Redis vient de tomber, le subscriber
        gérera la reconnexion ; entre-temps le pire cas est l'absence d'une
        grâce locale redondante.
        """
        try:
            return self._redis is not None and not self._fallback_active
        except Exception:
            return False

    @property
    def _fallback_active(self) -> bool:
        return bool(self._fallback_permanent
                    or time.monotonic() < self._fallback_until)

    def _enter_fallback(self, *, permanent: bool = False) -> None:
        """Bascule en verrou local, pour ``FALLBACK_COOLDOWN_S`` ou à vie."""
        if permanent:
            self._fallback_permanent = True
            return
        self._fallback_until = time.monotonic() + self.FALLBACK_COOLDOWN_S
        # Sans cela, la garde de ``_ensure_redis`` (``self._redis is not
        # None``) empêcherait toute reconnexion une fois le délai écoulé.
        _old, self._redis = self._redis, None
        if _old is not None:
            try:
                _t = asyncio.create_task(_old.aclose())
                _FALLBACK_CLOSERS.add(_t)
                _t.add_done_callback(_FALLBACK_CLOSERS.discard)
            except Exception:                                   # noqa: BLE001
                pass

    async def _ensure_redis(self):
        """Init the Redis client + subscriber on first use. Safe to call many
        times — only the first one connects."""
        if self._redis is not None or self._fallback_active:
            return
        async with self._init_lock:
            if self._redis is not None or self._fallback_active:
                return
            try:
                import redis.asyncio as aioredis
            except ImportError:
                logger.warning(
                    "[MODEL_EXCL] redis.asyncio non disponible — fallback local "
                    "mono-worker. Tu n'es PAS protégé contre les crashs en "
                    "multi-worker."
                )
                self._enter_fallback(permanent=True)
                return
            try:
                client = aioredis.from_url(
                    self._redis_url,
                    encoding="utf-8",
                    decode_responses=True,
                    socket_connect_timeout=2.0,
                    socket_keepalive=True,
                    health_check_interval=30,
                )
                await asyncio.wait_for(client.ping(), timeout=2.0)
                self._redis = client
                # Subscribe in a background task to receive wakeup events.
                self._sub_task = asyncio.create_task(self._subscriber_loop())
                logger.info(
                    "[MODEL_EXCL] Lock distribué Redis actif (%s)", self._redis_url,
                )
            except Exception as e:
                logger.warning(
                    "[MODEL_EXCL] Redis indisponible (%s) — fallback local. "
                    "Multi-worker NON protégé.", e,
                )
                self._enter_fallback()

    async def _subscriber_loop(self):
        """Listen for wakeup notifications. When something releases the lock
        anywhere in the cluster, we set the per-waiter events so each one
        re-checks Redis.

        Implementation note: we use a list of futures rather than a single
        Event because Event.set() + Event.clear() in quick succession can
        race with waiters that haven't reached their await yet — a waiter
        registered AFTER set/clear would miss the signal entirely. A list
        of one-shot futures avoids this : each waiter creates its future,
        registers it, then awaits. The notifier resolves all current
        futures atomically.

        BUG FIX — reconnexion automatique avec back-off exponentiel.
        Avant, une simple coupure Redis (blip réseau, restart) faisait
        sortir cette boucle DÉFINITIVEMENT : ``_notify_waiters`` n'était
        plus jamais appelé et tous les waiters du lock retombaient sur
        leur seul timeout de 2 s — pour toujours, jusqu'au recyclage du
        worker. On boucle désormais avec retry, comme ``_relay`` et
        ``_events_bus``. Au ré-abonnement, on réveille une fois les
        waiters en attente : ceux qui auraient manqué un release pendant
        la coupure re-vérifient Redis immédiatement au lieu d'attendre
        jusqu'à 2 s.
        """
        backoff = 1.0
        while True:
            pubsub = None
            try:
                if self._redis is None:
                    return
                pubsub = self._redis.pubsub()
                await pubsub.subscribe(self.PUBSUB_CHANNEL)
                backoff = 1.0  # reset après un subscribe réussi
                # Réveil best-effort : un release a pu survenir pendant la
                # coupure. Inoffensif au tout premier abonnement (aucun
                # waiter, ou ils re-checkent simplement Redis une fois).
                self._notify_waiters()
                async for msg in pubsub.listen():
                    if msg.get("type") == "message":
                        self._notify_waiters()
            except asyncio.CancelledError:
                return
            except Exception as e:
                logger.warning(
                    "[MODEL_EXCL] subscriber loop crashed: %s — retry in %.0fs",
                    e, backoff,
                )
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 30.0)  # back-off exponentiel, max 30s
            finally:
                # Ferme le pubsub de CETTE itération (sinon chaque crash/retry —
                # ou l'annulation — fuit un abonnement Redis). Tolérant aux versions
                # de redis-py : aclose() (5+) sinon close() (4.x), sync ou coroutine.
                if pubsub is not None:
                    try:
                        _closer = getattr(pubsub, "aclose", None) or getattr(pubsub, "close", None)
                        if _closer is not None:
                            _res = _closer()
                            if asyncio.iscoroutine(_res):
                                await _res
                    except Exception:
                        pass

    def _notify_waiters(self):
        """Resolve all pending wakeup futures (called from subscriber)."""
        waiters = self._wakeup_waiters
        self._wakeup_waiters = []
        for fut in waiters:
            if not fut.done():
                fut.set_result(None)

    async def _wait_wakeup(self, timeout: float):
        """Wait for a wakeup notification or until timeout. Returns True if
        a wakeup arrived, False on timeout. Each waiter has its own future
        so a notification reaches everyone."""
        loop = asyncio.get_event_loop()
        fut = loop.create_future()
        self._wakeup_waiters.append(fut)
        try:
            await asyncio.wait_for(fut, timeout=timeout)
            return True
        except asyncio.TimeoutError:
            return False
        finally:
            # AUDIT 2026-08-02 (M7) — le retrait n'était fait que sur
            # TimeoutError : un Stop utilisateur pendant l'attente du verrou
            # modèle lève CancelledError et laissait la future dans la liste
            # jusqu'au prochain _notify_waiters — qui n'arrive que sur
            # message Redis. Redis muet/mort = croissance monotone.
            try:
                self._wakeup_waiters.remove(fut)
            except ValueError:
                pass  # déjà retirée par _notify_waiters

    async def _publish_wakeup(self, client: Any = None):
        try:
            _c = client or self._redis
            if _c is not None:
                await _c.publish(self.PUBSUB_CHANNEL, "wake")
        except Exception:
            pass

    @asynccontextmanager
    async def acquire_for(self, model: Optional[str], priority: str = "high"):
        """Acquire the distributed lock for *model* with the given priority.

        Falls back to local-only lock if Redis is unavailable.
        """
        await self._ensure_redis()
        if self._fallback_active or self._redis is None:
            async with self._local_fallback.acquire_for(model, priority=priority):
                yield
            return
        # Client CAPTURÉ pour toute la durée du verrou : ``_enter_fallback``
        # (déclenché par une AUTRE coroutine sur un simple hoquet) remet
        # ``self._redis`` à None pendant 30 s ; le RELEASE et le heartbeat
        # appelaient alors ``None.eval`` — erreur avalée, verrou tenu jusqu'à
        # son TTL de 10 min, tous les changements de modèle bloqués (passe
        # robustesse 2026-09-24). Un client fermé se reconnecte seul.
        client = self._redis

        target = model or LLAMA_MODEL or "default"
        is_high = (priority == "high")
        lock_id = f"{os.getpid()}:{id(asyncio.current_task())}:{time.monotonic()}"
        registered_high = False
        heartbeat_task: Optional[asyncio.Task] = None

        # Échéance anti-famine des acquisitions « low » (audit 2026-08-23),
        # miroir de celle du chemin local et du niveau 2.
        from llm_core._scheduling._concurrency import LOW_WAIT_CAP_S as _LOW_CAP_S
        _lo_start = None if is_high else time.monotonic()
        _gate_lifted = False
        try:
            # Acquire loop: try, wait if blocked, retry.
            while True:
                # Si on est déjà registered_high, ne PAS rappeler ACQUIRE
                # (qui ferait un 2e high_waiting++). On va directement à
                # PROMOTE qui gère la transition waiting → actif.
                if registered_high and is_high:
                    try:
                        promo_raw = await client.eval(
                            _LUA_PROMOTE_HIGH, 1, self.REDIS_KEY,
                            target, str(time.time()), lock_id,
                        )
                        promo = json.loads(promo_raw)
                        if promo.get("acquired"):
                            registered_high = False
                            break
                        # PROMOTE n'a pas pu acquire (modèle toujours actif).
                        # On attend un nouveau wakeup et on retentera PROMOTE
                        # — surtout PAS ACQUIRE qui ferait un nouveau ++.
                        await self._wait_wakeup(timeout=2.0)
                        continue
                    except Exception as e:
                        # BUG FIX — avant, ce ``except: pass`` laissait
                        # l'exécution RETOMBER sur le bloc ``_LUA_ACQUIRE``
                        # ci-dessous AVEC ``registered_high`` toujours True.
                        # ``_LUA_ACQUIRE`` pour un high sur un autre modèle
                        # ré-incrémentait ``state.high_waiting`` → le ++ que
                        # le commentaire ci-dessus interdit explicitement.
                        # Le compteur passait à 2 pour un seul waiter et
                        # bloquait les ``low`` jusqu'au GC d'orphelins 60s.
                        #
                        # On bascule désormais proprement en fallback local,
                        # comme le fait le handler d'erreur de ``_LUA_ACQUIRE``.
                        # Tentative best-effort de déregister le high_waiting
                        # fantôme (échouera sans doute si Redis est down —
                        # auquel cas le GC d'orphelins côté Lua le nettoiera).
                        logger.warning(
                            "[MODEL_EXCL] Redis EVAL PROMOTE failed: %s — "
                            "fallback local", e,
                        )
                        try:
                            await client.eval(
                                _LUA_DEREGISTER_HIGH, 1, self.REDIS_KEY,
                                str(time.time()),
                            )
                        except Exception:
                            pass
                        registered_high = False
                        self._enter_fallback()
                        async with self._local_fallback.acquire_for(
                            model, priority=priority,
                        ):
                            yield
                        return

                try:
                    res_raw = await client.eval(
                        _LUA_ACQUIRE, 1, self.REDIS_KEY,
                        target, priority, str(self.GRACE_S),
                        str(time.time()), lock_id,
                        "1" if _gate_lifted else "0",
                    )
                except Exception as e:
                    logger.warning(
                        "[MODEL_EXCL] Redis EVAL ACQUIRE failed: %s — fallback local",
                        e,
                    )
                    self._enter_fallback()
                    async with self._local_fallback.acquire_for(model, priority=priority):
                        yield
                    return

                res = json.loads(res_raw)
                if res.get("acquired"):
                    break

                # Track if Lua promoted us to "registered high" so we know to
                # call PROMOTE on the next attempt instead of ACQUIRE.
                if res.get("registered_high"):
                    registered_high = True

                wait_for = res.get("wait_for")
                # Même échéance qu'en local (audit 2026-08-23) : le chemin
                # Redis rebouclait lui aussi sans borne sur la grâce.
                # AUDIT 2026-09-24 (n° 3) — le plafond faisait un ``break``
                # quel que soit ``wait_for`` : la routine passait donc SANS
                # être inscrite dans ``active_locks``, y compris quand un
                # AUTRE modèle tournait (``wait_for == "model"``) — le routeur
                # chargeait B en plein flux de A. Aligné sur la version
                # locale : le plafond ne lève que le PORTAIL (grâce / high en
                # file), et l'acquisition repasse par le script, qui inscrit
                # le verrou ; l'attente d'un autre modèle, elle, demeure.
                if (_lo_start is not None and not _gate_lifted
                        and wait_for in ("grace", "high")
                        and (time.monotonic() - _lo_start) > _LOW_CAP_S):
                    logger.info(
                        "[model_lock/redis] acquisition 'low' sur %r : plafond "
                        "d'attente de %.0fs atteint au portail de grâce — on "
                        "passe (anti-famine).", model, _LOW_CAP_S)
                    _gate_lifted = True
                    continue
                if wait_for == "grace":
                    rem = res.get("grace_remaining", 1.0)
                    await asyncio.sleep(min(max(0.1, rem), 1.0))
                else:
                    await self._wait_wakeup(timeout=2.0)

            # Heartbeat task: refresh the active lock TTL periodically so a
            # long-running acquire doesn't get garbage-collected mid-flight.
            heartbeat_task = asyncio.create_task(self._heartbeat(lock_id, client))
            try:
                yield
            finally:
                heartbeat_task.cancel()
                try:
                    await heartbeat_task
                except (asyncio.CancelledError, Exception):
                    pass
                # Release atomically + publish wakeup so others retry.
                try:
                    await client.eval(
                        _LUA_RELEASE, 1, self.REDIS_KEY,
                        lock_id, "1" if is_high else "0",
                        str(self.GRACE_S), str(time.time()),
                    )
                    await self._publish_wakeup(client)
                except Exception as e:
                    logger.warning("[MODEL_EXCL] release failed: %s", e)

        except BaseException:
            # On exception during wait, deregister our high-waiting count
            # to avoid blocking lows forever.
            if registered_high:
                try:
                    await client.eval(
                        _LUA_DEREGISTER_HIGH, 1, self.REDIS_KEY,
                        str(time.time()),
                    )
                    await self._publish_wakeup(client)
                except Exception:
                    pass
            if heartbeat_task is None:
                # Annulation APRÈS l'exécution du script ACQUIRE/PROMOTE mais
                # avant la lecture de sa réponse : le verrou peut être inscrit
                # sans que nous le sachions (fantôme de 10 min, sans
                # heartbeat). RELEASE par ``lock_id`` : sans effet s'il n'est
                # pas inscrit (``was_high=0`` : aucune grâce posée).
                try:
                    await client.eval(
                        _LUA_RELEASE, 1, self.REDIS_KEY,
                        lock_id, "0", str(self.GRACE_S), str(time.time()),
                    )
                except BaseException:
                    pass
            if heartbeat_task and not heartbeat_task.done():
                heartbeat_task.cancel()
            raise

    async def _heartbeat(self, lock_id: str, client: Any = None):
        """Refresh the lock TTL every HEARTBEAT_S seconds. If the worker
        crashes, the lock auto-expires after LOCK_TTL_S (10min) and gets
        garbage-collected by the next acquire's GC pass."""
        client = client or self._redis
        while True:
            try:
                await asyncio.sleep(self.HEARTBEAT_S)
                # We re-write the state with bumped expires_at for our entry
                # via a Lua script. Inline here to avoid yet another constant.
                lua_bump = """
                local raw = redis.call('GET', KEYS[1])
                if not raw then return 0 end
                local state = cjson.decode(raw)
                local found = 0
                for _, entry in ipairs(state.active_locks or {}) do
                    if entry.lock_id == ARGV[1] then
                        entry.expires_at = tonumber(ARGV[2])
                        found = 1
                    end
                end
                if found == 1 then
                    redis.call('SET', KEYS[1], cjson.encode(state))
                end
                return found
                """
                await client.eval(
                    lua_bump, 1, self.REDIS_KEY,
                    lock_id, str(time.time() + self.LOCK_TTL_S),
                )
            except asyncio.CancelledError:
                raise
            except Exception:
                pass  # heartbeat failures aren't fatal — just less GC safety

    async def snapshot_async(self) -> Dict[str, Any]:
        """Async snapshot from Redis. Used by get_queue_status_for() in
        async contexts. Falls back to local snapshot if Redis is down."""
        await self._ensure_redis()
        if self._fallback_active or self._redis is None:
            return self._local_fallback.snapshot()
        try:
            raw = await self._redis.get(self.REDIS_KEY)
            if not raw:
                return {
                    "current_model": None, "active_count": 0,
                    "is_idle": True, "high_waiting": 0,
                    "grace_model": None, "grace_remaining": 0.0,
                }
            state = json.loads(raw)
            now = time.time()
            grace_remaining = (
                max(0.0, state.get("grace_until", 0) - now)
                if state.get("grace_model") else 0.0
            )
            return {
                "current_model":   state.get("current_model"),
                "active_count":    state.get("active_count", 0),
                "is_idle":         state.get("active_count", 0) == 0,
                "high_waiting":    state.get("high_waiting", 0),
                "grace_model":     state.get("grace_model"),
                "grace_remaining": grace_remaining,
            }
        except Exception:
            return self._local_fallback.snapshot()

    def snapshot(self) -> Dict[str, Any]:
        """Sync wrapper. In an async context, prefer snapshot_async().
        This sync version returns the local fallback's view, which is
        correct in single-worker deployments and a best-effort in
        multi-worker (it sees only this worker's locks, not the cluster).
        """
        return self._local_fallback.snapshot()


# Fermetures de clients Redis en vol pendant un repli : référence forte pour
# que le GC ne les ramasse pas avant l'aboutissement.
_FALLBACK_CLOSERS: set = set()


# Singleton global, utilisé par llm_scheduling_guard et get_queue_status_for.
# Choix Redis vs local fait à la première acquisition.
MODEL_EXCLUSIVITY = DistributedModelExclusivityLock()
