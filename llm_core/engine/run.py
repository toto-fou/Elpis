# SPDX-License-Identifier: MIT
"""llm_core.engine.run — l'état d'un run de la boucle agentique.

Trois objets, chacun avec un propriétaire clair :

  - ``LoopDeps`` — les deux dépendances que la boucle injecte dans ses
    sous-routines : la fonction de flux (``_llama_chat_with_tools_stream``) et
    la métrique d'appel d'outil. L'orchestrateur les lit dans SES globales au
    début du run : c'est là que les tests les substituent.
  - ``RunContext`` — les constantes du run (identité, cible, réglages, outils,
    budgets), figées une fois le prélude passé.
  - ``RunRecord`` — la trace du run, que chaque phase complète : événements
    rendus à l'appelant, ``tool_history`` (le delta persisté), raisonnement
    cumulé, usage, lot d'outils en cours, fenêtre de contexte et marques
    d'élagage relues en sortie.

Les compteurs d'itérations restent des entiers de l'orchestrateur : les
sous-routines lui rendent une décision, il l'applique (cf.
``llm_core.engine``).
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Awaitable, Callable, Dict, List, Optional, Tuple

from llm_core._scheduling._guard import _emit
from llm_core.engine.result_contract import result_is_tool_failure
from shared_infra import config as _bk_config
from shared_infra.observability.tracing import swallow

logger = logging.getLogger("uvicorn.error")


# ── Raisonnement cumulé du run : borne dure ──────────────────────────────────
# ``RunRecord.all_thinking`` accumule le raisonnement de toutes les itérations puis le
# concatène en fin de run. Sans borne, une mission de plusieurs heures avec un
# modèle raisonneur (~20 Ko de <think> par itération × 200 itérations) produit
# des mégaoctets : gardés en heap pendant tout le run, joints en UNE string,
# POSTés à /tokenize pour la décomposition thinking/réponse (le timeout de 5 s
# expire → aller-retour payé pour retomber sur l'estimation), puis renvoyés
# dans ``metrics["thinking"]``, donc dans une ligne NDJSON unique.
#
# Le raisonnement est ÉPHÉMÈRE (jamais re-soumis au modèle, strippé à la
# persistance — cf. la règle « thinking hors budget contexte ») : sa seule
# consommation est l'accordéon de l'UI, où le récent est le plus utile. On
# garde donc le SUFFIXE, avec un marqueur explicite en tête.
THINKING_HISTORY_MAX_CHARS = max(0, int(
    getattr(_bk_config, "THINKING_HISTORY_MAX_CHARS", 400_000) or 0))
THINKING_HISTORY_TRUNC_MARKER = (
    "[…raisonnement des itérations antérieures omis (trop volumineux)…]")




def _clip_thinking_history(parts: List[str]) -> None:
    """Borne EN PLACE le raisonnement cumulé d'un run (suffixe conservé).

    Mute ``parts`` pour que les ``pop()`` de dédoublonnage de la boucle
    (qui portent sur le DERNIER élément) restent valides."""
    if THINKING_HISTORY_MAX_CHARS <= 0 or len(parts) <= 1:
        return
    total = sum(len(p) for p in parts)
    if total <= THINKING_HISTORY_MAX_CHARS:
        return
    kept: List[str] = []
    acc = 0
    # On repart de la fin : le dernier bloc est toujours conservé entier
    # (c'est celui de l'itération courante, que la boucle peut re-pop).
    for p in reversed(parts):
        if kept and acc + len(p) > THINKING_HISTORY_MAX_CHARS:
            break
        kept.append(p)
        acc += len(p)
    kept.reverse()
    if len(kept) < len(parts):
        kept.insert(0, THINKING_HISTORY_TRUNC_MARKER)
    parts[:] = kept


# Budget d'octets de la ``tool_history`` d'UN run (le « delta » renvoyé à la
# route, persisté sur le message assistant et renvoyé au client).
#
# Cette liste grossit de deux messages par itération (le tour assistant + un
# résultat par outil), et chaque résultat peut peser jusqu'au plafond
# d'émission dérivé de n_ctx (25 000 tokens, soit ~100 Ko, davantage pour les
# outils desktop). Sans borne, une mission de trois cents itérations fait des
# dizaines de mégaoctets, que la fin du tour sérialise puis pousse au
# navigateur DANS UNE SEULE LIGNE NDJSON — au moment où l'utilisateur attend
# sa réponse.
#
# La QUEUE est protégée (jusqu'à la moitié du budget : le travail récent, le
# seul que le modèle relira sur un « Continuer ») ; les contenus des résultats
# les plus ANCIENS sont élagués d'abord, remplacés par un repère, puis, si cela
# ne suffit pas, les arguments des plus anciens ``assistant.tool_calls``. Aucun
# message n'est retiré : les ``assistant.tool_calls`` gardent leurs ``id`` et
# noms, qui seuls portent l'appariement id ↔ résultat qu'un « Continuer »
# ré-expanse.
RUN_TOOL_HISTORY_MAX_BYTES = max(
    262_144, int(os.environ.get("RUN_TOOL_HISTORY_MAX_BYTES", str(8 * 1024 * 1024))))




def _tool_call_args_weight(msg: Dict[str, Any]) -> int:
    """Poids des ``tool_calls`` d'un message (noms + arguments)."""
    total = 0
    for tc in (msg.get("tool_calls") or []):
        if not isinstance(tc, dict):
            continue
        fn = tc.get("function") or {}
        if not isinstance(fn, dict):
            continue
        nm = fn.get("name")
        if isinstance(nm, str):
            total += len(nm)
        args = fn.get("arguments")
        if isinstance(args, str):
            total += len(args)
        elif args is not None:
            try:
                total += len(json.dumps(args, ensure_ascii=False))
            except Exception:                                   # noqa: BLE001 — poids indicatif
                pass
    return total


def _tool_msg_weight(msg: Dict[str, Any]) -> int:
    """Poids d'un message de la ``tool_history``, ARGUMENTS COMPRIS.

    Un message ``assistant.tool_calls`` a ``content=None`` : ne lire que
    ``content`` donnerait un poids de 4 (« null ») quel que soit le volume de
    ses arguments. C'est pourtant là que vit la masse : l'argument ``content``
    d'un ``write_file`` porte le fichier ENTIER (mesuré : 54 % du contexte =
    les arguments des tool_calls). Sans eux, 200 ``write_file`` de 200 Ko
    pèseraient 40 Mo réels pour 1 200 octets « vus », et
    ``_cap_run_tool_history`` n'élaguerait rien.
    """
    total = 0
    c = msg.get("content")
    if isinstance(c, str):
        total += len(c)
    elif c is not None:
        try:
            total += len(json.dumps(c, ensure_ascii=False))
        except Exception:                                       # noqa: BLE001 — poids indicatif
            pass
    return total + _tool_call_args_weight(msg)


def _cap_run_tool_history(hist: List[Dict[str, Any]],
                          max_bytes: int = RUN_TOOL_HISTORY_MAX_BYTES
                          ) -> List[Dict[str, Any]]:
    """Borne la taille de la ``tool_history`` d'un run (cf. constante ci-dessus).

    Élague les CONTENUS des résultats d'outils les plus anciens (jamais les
    messages eux-mêmes) : la structure de l'historique reste exacte, seul le
    texte des vieilles sorties est remplacé par un repère.
    """
    total = sum(_tool_msg_weight(m) for m in hist)
    if total <= max_bytes:
        return hist
    # Queue protégée jusqu'à la moitié du budget.
    keep_tail = max_bytes // 2
    out = [dict(m) for m in hist]
    # 1) Queue protégée : on remonte depuis la fin jusqu'à épuiser keep_tail.
    tail_budget = keep_tail
    protected = set()
    for i in range(len(out) - 1, -1, -1):
        if out[i].get("role") != "tool":
            continue
        w = _tool_msg_weight(out[i])
        if w > tail_budget:
            break
        tail_budget -= w
        protected.add(i)
    # 2) Tête : on élague les plus ANCIENS résultats non protégés jusqu'à
    #    repasser sous le budget.
    for i in range(len(out)):
        if total <= max_bytes:
            break
        if i in protected or out[i].get("role") != "tool":
            continue
        w = _tool_msg_weight(out[i])
        if w < 2048:            # inutile d'élaguer des miettes
            continue
        out[i]["content"] = (
            f"[résultat élagué — {w} caractères ; l'historique d'outils de ce "
            f"run a dépassé son budget de {max_bytes // (1024 * 1024)} Mo]")
        out[i]["content_elided"] = True
        total -= (w - _tool_msg_weight(out[i]))
    # 3) Toujours au-dessus du budget : la masse est dans les ARGUMENTS des
    #    ``assistant.tool_calls`` (write_file & co). On les élague à leur tour,
    #    des plus ANCIENS aux plus récents, en gardant ``id``/``name`` — eux
    #    seuls portent l'appariement, qu'un « Continuer » ré-expanse. Le
    #    remplacement reste du JSON VALIDE : les arguments sont ré-parsés par
    #    certains gabarits, un repère en texte brut les casserait.
    if total > max_bytes:
        _tail_guard = max(0, len(out) - 8)   # les 8 derniers messages intacts
        for i in range(_tail_guard):
            if total <= max_bytes:
                break
            if out[i].get("role") != "assistant" or not out[i].get("tool_calls"):
                continue
            w = _tool_call_args_weight(out[i])
            if w < 2048:
                continue
            _new_calls = []
            for tc in out[i]["tool_calls"]:
                if not isinstance(tc, dict):
                    _new_calls.append(tc)
                    continue
                fn = dict(tc.get("function") or {})
                _args = fn.get("arguments")
                _n = len(_args) if isinstance(_args, str) else 0
                if _n >= 512:
                    fn["arguments"] = json.dumps(
                        {"_elided": f"arguments élagués — {_n} caractères "
                                    f"(budget de tool_history atteint)"},
                        ensure_ascii=False)
                _new_calls.append({**tc, "function": fn})
            out[i] = {**out[i], "tool_calls": _new_calls, "args_elided": True}
            total -= (w - _tool_call_args_weight(out[i]))
    if total > max_bytes:
        logger.warning(
            "[run_chat_multi_mcp] tool_history encore à %d o après élagage "
            "(budget %d o)", total, max_bytes)
    return out


def _content_text(content: Any) -> str:
    """``content`` d'un message en texte : chaîne telle quelle, liste de blocs
    (fournisseur multimodal OpenAI-compat) réduite à ses blocs texte."""
    if isinstance(content, list):
        return "".join(
            (b.get("text") or "") if isinstance(b, dict) else str(b)
            for b in content)
    return content if isinstance(content, str) else ("" if content is None else str(content))


@dataclass(frozen=True, slots=True)
class LoopDeps:
    """Dépendances injectées dans les sous-routines de la boucle."""

    stream: Callable[..., Awaitable[Dict[str, Any]]]
    record_metric: Callable[..., Any]


@dataclass(frozen=True, slots=True)
class RunContext:
    """Constantes d'un run, résolues par le prélude de la boucle.

    Gel superficiel : les tables d'outils et les réglages restent des dicts,
    que personne ne modifie pendant le run."""

    on_event: Optional[Callable]
    username: str
    model: Optional[str]
    chat_id: Optional[str]
    user_id: Optional[int]
    sampling_override: Optional[Dict[str, Any]]
    thinking_mode: bool
    is_cancelled: Optional[Callable[[], bool]]
    compression_enabled: Optional[bool]
    compaction_max_rounds: Optional[int]
    inline_semaphore: bool
    priority: str
    live_shell: bool
    start_time: float
    model_has_vision: bool
    chat_key_suffix: str
    run_log_tok: str
    tools_payload: List[Dict[str, Any]]
    tool_cfg_map: Dict[str, Any]
    builtin_handlers: Dict[str, Any]
    tools_payload_chars: int
    max_iter: int
    effective_iter_budget: int
    hard_iter_cap: int

    def cancelled(self) -> bool:
        """Annulation demandée par l'appelant (Stop, client parti) ?"""
        return bool(self.is_cancelled and self.is_cancelled())


@dataclass(slots=True)
class RunRecord:
    """Trace d'un run, complétée par chaque phase de la boucle."""

    # Cumul d'usage partagé avec l'enveloppe du run : elle l'enregistre si le
    # run meurt annulé ; les retours le marquent « recorded ».
    usage_acc: Optional[Dict[str, Any]] = None
    # 2e valeur de retour de la boucle : les mutations de fichiers seulement
    # (outil + chemin + succès), sans le contenu ni le résultat : quelques
    # dizaines d'octets par écriture, pas un second journal. La route chat
    # l'ignore (elle reçoit tout en direct), mais un appelant HEADLESS — les
    # routines — n'a aucun autre moyen de savoir ce que le run a produit.
    events: List[Dict[str, Any]] = field(default_factory=list)
    # tool_history de CE run — le DELTA persisté sur le message assistant.
    # Liste parallèle à ``working_messages`` : chaque ajout « persistable »
    # (rounds assistant, résultats d'outils, textes assistant conservés)
    # pousse dans les deux ; les messages de contrôle injectés mi-tour
    # (harness_status, relances, diagnostics de parse, frame vision base64)
    # restent dans ``working_messages`` seul — éphémères, jamais rejoués aux
    # tours suivants. Liste séparée : immunisée contre les réassignations de
    # ``working_messages`` (compaction, aplatissement). Les dicts partagés avec
    # ``working_messages`` ne sont jamais mutés
    # (``tests/llm_core/test_no_mutation_pipeline.py``) ; seule
    # ``materialize_interrupted_batch`` modifie sur place ses propres messages
    # sentinelles (vrai résultat à la place de la sentinelle), qui sont
    # partagés avec les instantanés déjà émis. C'est CE delta, et non une
    # capture cumulative depuis le premier message agentique, qui borne la
    # croissance : la route ré-expanse chaque bulle, une capture cumulative
    # doublerait le contexte à chaque tour.
    run_tool_history: List[Dict[str, Any]] = field(default_factory=list)
    all_thinking: List[str] = field(default_factory=list)
    last_raw: Dict[str, Any] = field(default_factory=dict)
    cumul_in: int = 0
    cumul_out: int = 0
    cumul_cache_read: int = 0
    cumul_cache_creation: int = 0
    # Raisonnement DÉCLARÉ par le backend (o-series, vLLM récents), cumulé
    # comme le reste du tour. ``None`` tant qu'aucune itération ne l'a déclaré
    # — la mesure de fin de tour prend alors le relais (tokenisation).
    cumul_reasoning: Optional[int] = None
    # Lot d'outils EN COURS, posé par ``ouvrir_lot``. ``execute_tool_batch``
    # remplit ``batch_partial`` en place ; sur annulation réelle elle relève,
    # donc le post-traitement ne s'exécute jamais pour ce round, alors que les
    # outils mutants du lot ont appliqué leur effet de bord (sérialisés, donc
    # exécutés en premier).
    batch_partial: Dict[int, str] = field(default_factory=dict)
    batch_prepared: List[Dict[str, Any]] = field(default_factory=list)
    # Itération dont des ``tool_call_delta`` sont partis SANS ``tool_call``
    # derrière (encore) ; consommé en tête de boucle (event ``reset``) ou
    # effacé quand le round s'exécute.
    delta_pending_iter: Optional[int] = None
    # Fenêtre de contexte de la cible (0 = inconnue) et total affiché par la
    # jauge (0 = jauge masquée : jamais de pourcentage inventé).
    ctx_size: int = 0
    gauge_ctx_total: int = 0
    # Tokens du schéma d'outils : le jeu d'outils est stable sur tout le run,
    # compté une fois (paresseusement).
    tools_tok_counted: Optional[Tuple[int, bool]] = None
    # Groupes que le budget dur a retirés à l'itération précédente : ils le
    # restent (hystérésis, cf. ``enforce_context_budget``).
    budget_drop_floor: int = 0
    # Marques d'élagage actives (persistées pour ce chat + sélectionnées
    # pendant ce run) et celles de ce run seul, à persister en fin de tour.
    run_prune_keys: set = field(default_factory=set)
    prune_keys_new: List[str] = field(default_factory=list)

    def record_file_mutation(self, evt: Dict[str, Any], result_str: Any) -> None:
        """Note une mutation de fichier (``evt["path"]``) dans ``events``."""
        path = evt.get("path")
        if not path:
            return
        self.events.append({
            "type": "tool_result",
            "name": evt.get("name"),
            "path": path,
            "ok":   not result_is_tool_failure(result_str),
        })

    def usage_note(self, *, effective_iter: int, model: Any, recorded: bool = False) -> None:
        """Recopie les cumuls d'usage dans le cumul partagé avec l'enveloppe."""
        if self.usage_acc is None:
            return
        self.usage_acc.update({
            "in": self.cumul_in, "out": self.cumul_out,
            "cache_read": self.cumul_cache_read,
            "cache_creation": self.cumul_cache_creation,
            "iterations": effective_iter,
            "model": model,
            "inflight_in": 0,
        })
        if recorded:
            self.usage_acc["recorded"] = True

    def delta_snapshot(self) -> List[Dict[str, Any]]:
        """Delta du run, débarrassé d'un ``assistant.tool_calls`` terminal
        orphelin (annulation en PLEINE exécution d'outil : l'assistant a été
        appendé, les ``tool`` results pas encore). Ré-expandé par un
        « Continuer », un tool_calls sans sortie déroute le modèle."""
        hist = list(self.run_tool_history)
        while hist and hist[-1].get("role") == "assistant" and hist[-1].get("tool_calls"):
            hist.pop()
        return _cap_run_tool_history(hist)

    def ouvrir_lot(self, prepared: List[Dict[str, Any]]) -> Dict[int, str]:
        """Pose le lot EN COURS avant son exécution et rend le dict de
        résultats à remplir (le ``results_out`` d'``execute_tool_batch``).

        ``batch_prepared`` et ``batch_partial`` sont posés ENSEMBLE, avant
        l'attente : l'instantané d'une annulation en plein lot y lit ce qui
        a déjà tourné. Rien ne les remet à zéro après le lot : le lot terminé
        reste en place jusqu'au suivant, sans effet sur un instantané
        ultérieur (``materialize_interrupted_batch`` est idempotente)."""
        self.batch_partial = {}
        self.batch_prepared = prepared
        return self.batch_partial

    def materialize_interrupted_batch(self) -> None:
        """Matérialise le round interrompu dans ``run_tool_history``.

        Chaque appel du lot reçoit un message ``tool`` : son VRAI résultat
        s'il a abouti, une sentinelle explicite sinon. L'appariement
        id ↔ résultat reste donc complet — condition pour que
        l'``assistant.tool_calls`` survive au dépilage de ``delta_snapshot``
        et pour que le tour ré-expansé soit valide côté gabarit. Sans cette
        matérialisation, le round ne laisserait AUCUNE trace et « Continuer »
        rejouerait les écritures, commits et commandes déjà appliqués.

        Idempotente : un appel qui a déjà son message ``tool`` n'en reçoit
        pas un second (seule une sentinelle y est remplacée par le vrai
        résultat). C'est ce qui rend sans effet un ``batch_prepared``
        PÉRIMÉ : le post-traitement d'un lot terminé a apparié chacun de ses
        appels, et ``ouvrir_lot`` ne le remet à zéro qu'au lot suivant."""
        if not self.batch_prepared:
            return
        # « Sans résultat » recouvre DEUX cas : jamais lancé, ou EN VOL au Stop
        # (l'annulation côté client ne défait pas l'effet déjà appliqué par le
        # serveur : commit, push, écriture). Affirmer « NON exécuté » pousserait
        # le modèle à tout relancer au « Continuer » ; on dit la vérité : état
        # inconnu, à vérifier.
        _sentinelle = json.dumps(
            {"error": "interrompu par l'utilisateur avant la fin — exécution "
                      "NON confirmée (l'outil a pu agir en partie) : vérifier "
                      "l'état avant de le relancer"},
            ensure_ascii=False)
        _deja = {m.get("tool_call_id"): m for m in self.run_tool_history
                 if m.get("role") == "tool"}
        _n_reels = 0
        for _i, _p in enumerate(self.batch_prepared):
            _cid = _p.get("call_id")
            if not _cid:
                continue
            _res = self.batch_partial.get(_i)
            _prev = _deja.get(_cid)
            if _prev is not None:
                # Un instantané ANTÉRIEUR (tâche A du lot) a posé la
                # sentinelle pour cet appel alors que sa tâche a terminé
                # ``execute_single`` entre-temps : le vrai résultat remplace la
                # sentinelle (sinon le partiel affirme qu'un outil n'a pas
                # tourné alors qu'il a tourné).
                if _res is not None and _prev.get("content") == _sentinelle:
                    _prev["content"] = _res
                    _n_reels += 1
                continue
            if _res is None:
                _res = _sentinelle
            else:
                _n_reels += 1
            self.run_tool_history.append({
                "role":         "tool",
                "tool_call_id": _cid,
                "content":      _res,
            })
        if _n_reels:
            logger.warning(
                "[run_chat_multi_mcp] annulation en plein lot : %d outil(s) "
                "déjà exécuté(s) matérialisé(s) dans la tool_history du "
                "partiel (sinon « Continuer » les rejouait).", _n_reels)

    async def emit_partial_snapshot(self, on_event: Optional[Callable]) -> None:
        """Instantané best-effort de la tool_history, émis quand le run est
        ANNULÉ en pleine boucle d'outils (event interne
        ``tool_history_partial``, que la route attache au partiel). Sans lui,
        un « Continuer » repartirait aveugle et pourrait rejouer des outils
        mutants déjà appliqués. Émission ``shield``ée pour survivre à
        l'annulation en cours ; tout échec est avalé."""
        with swallow("harness.emit_partial_tool_history_snapshot"):
            self.materialize_interrupted_batch()
            _ph = self.delta_snapshot()
            if _ph:
                await asyncio.shield(_emit(on_event, {
                    "type": "tool_history_partial", "tool_history": _ph,
                }))

    async def guard_cancel(self, on_event: Optional[Callable], coro: Awaitable[Any]) -> Any:
        """Point de suspension hors des ``try`` d'annulation (tête de boucle,
        backoffs, post-traitement d'un lot, fin de tour) : une annulation
        délivrée ici déclenche l'instantané avant de se propager, comme aux
        autres points d'annulation. À n'utiliser QUE hors d'un bloc qui
        instantanéise déjà, sinon l'event partirait deux fois."""
        try:
            return await coro
        except asyncio.CancelledError:
            await self.emit_partial_snapshot(on_event)
            raise

    def last_assistant_text(self) -> str:
        """Dernier texte assistant produit par CE run (``run_tool_history``),
        jamais par ``working_messages`` : celle-ci porte tout l'historique du
        chat, et un run sans prose rendrait alors la réponse du TOUR PRÉCÉDENT.
        ``content`` en liste de blocs toléré (fournisseur multimodal)."""
        for m in reversed(self.run_tool_history):
            if isinstance(m, dict) and m.get("role") == "assistant":
                _t = _content_text(m.get("content"))
                if _t.strip():
                    return _t
        return ""


def engine_semaphore() -> Any:
    """Gestionnaire de concurrence du SERVEUR de la cible :
    ``LLM_SEMAPHORE`` pour l'intégré, le gestionnaire dédié d'un connecteur
    llama.cpp sinon (cf. ``_scheduling._engines``)."""
    from llm_core._scheduling._engines import scheduling_for
    from llm_core.engines import current_engine
    return scheduling_for(current_engine())[1]


@asynccontextmanager
async def llm_slot(ctx: RunContext) -> AsyncIterator[None]:
    """Slot LLM du mode « optimized » ; sans effet en mode classique (le
    caller tient le sémaphore pour tout le run).

    En mode « optimized », le garde d'ordonnancement renonce au niveau 2 : la
    protection est entièrement déléguée à la boucle, sur ses QUATRE points
    d'appel LLM — l'appel outillé, le tour de synthèse et les deux
    compactions (porte d'occupation et rattrapage « contexte dépassé »).
    ``llama_chat`` n'acquiert rien : sans ce slot, sur un serveur à un slot,
    un résumé de 50 s atterrirait à côté de la génération d'un autre
    utilisateur (préfixe KV évincé, et aucun des deux dans le widget de file)."""
    if ctx.inline_semaphore:
        async with engine_semaphore().acquire_for(ctx.model, priority=ctx.priority):
            yield
    else:
        yield
