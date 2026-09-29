# SPDX-License-Identifier: MIT
"""llm_core.engine.tool_exec — exécution d'un lot de tool_calls (canal unifié).

Extrait la « harness » d'exécution qui était copiée-collée entre le canal
NATIF (``_exec_one`` + walk) et le canal LEGACY (``_exec_one_legacy`` + walk)
de ``run_chat_multi_mcp`` — ~110 lignes verbatim, à la callback progress/log
près (que le legacy n'avait pas et gagne ici).

Responsabilité UNIQUE : ordonnancer l'exécution de ``prepared`` (série pour
les outils mutants, parallèle borné sinon, ordre LLM préservé), exécuter
chaque appel, émettre progress/log, écrire les métriques, et renvoyer
``results_by_idx``. Le POST-traitement (events tool_result, append role=tool,
injection vision) reste dans la boucle : il diffère entre canaux (vision
native, fallback_wrapper legacy) et dépend de l'ordre d'émission LLM.

Dépendances de ``_chat_with_tools`` (``execute_single``, ``record_metric``,
``is_tool_failure``) INJECTÉES en paramètres : évite un cycle d'import
(``_chat_with_tools`` importe ce module).
"""
from __future__ import annotations

import asyncio
import contextvars
import json
import logging
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Awaitable, Callable, Dict, List, Optional

from llm_core._constants import LLAMA_TOOL_PARALLELISM
from llm_core._scheduling._guard import _emit
from llm_core._tool_traits import tool_traits
from shared_infra.db import log_metric

# Attente maximale de la télémétrie d'un appel d'outil (cf. ``_exec_one``).
_TELEMETRY_WAIT_S = 0.25
_TELEMETRY_POOL: Optional[ThreadPoolExecutor] = None


def _telemetry_pool() -> ThreadPoolExecutor:
    """Pool DÉDIÉ (2 threads) aux écritures télémétriques. AUDIT 2026-09-26 —
    n'étant plus attendues au-delà de ``_TELEMETRY_WAIT_S``, elles
    s'empilaient dans le pool PAR DÉFAUT sous contention SQLite (jusqu'à 10 s
    chacune) — celui-là même qui exécute les outils intégrés
    (``to_thread``) : ces derniers attendaient un thread libre jusqu'à leur
    propre délai. Ici l'attente ne pénalise que la télémétrie."""
    global _TELEMETRY_POOL
    if _TELEMETRY_POOL is None:
        _TELEMETRY_POOL = ThreadPoolExecutor(max_workers=2,
                                             thread_name_prefix="tool-telemetry")
    return _TELEMETRY_POOL


def _consume_telemetry_result(fut: "asyncio.Future") -> None:
    """Rappel de fin de l'écriture télémétrique : récupère son exception pour
    qu'elle ne remonte pas en « exception never retrieved »."""
    if not fut.cancelled():
        fut.exception()

logger = logging.getLogger("uvicorn.error")


class _BatchCancelled(Exception):
    """Annulation RÉELLE remontée d'un outil, sous une forme ORDINAIRE.

    Existe uniquement pour que ``asyncio.wait(FIRST_EXCEPTION)`` se réveille :
    il ignore les tâches qui finissent *annulées*. Reconvertie en
    ``asyncio.CancelledError`` par ``_gather_batch`` — jamais visible dehors."""


def flatten_exception_message(exc: BaseException, limit: int = 300) -> str:
    """Message d'erreur UTILE pour le modèle, ExceptionGroup déplié.

    Les transports MCP (anyio task groups) enveloppent l'exception réelle —
    typiquement une ``ValidationError`` pydantic sur les arguments — dans un
    ``(Base)ExceptionGroup`` dont ``str()`` vaut « unhandled errors in a
    TaskGroup (1 sub-exception) » : le détail (champ en faute, valeur
    attendue) était perdu et le modèle retentait à l'aveugle. On descend
    jusqu'aux feuilles et on les concatène (dédupliquées, bornées).

    Contrat : pour une exception SIMPLE avec message, retourne ``str(e)``
    telle quelle (même enveloppe qu'avant — les tests/consommateurs matchent
    le message) ; le nom du type ne sert que de secours (message vide)."""
    leaves: List[str] = []

    def _walk(e: BaseException, depth: int) -> None:
        subs = getattr(e, "exceptions", None)
        if subs and depth < 5:
            for s in subs:
                _walk(s, depth + 1)
            return
        _msg = str(e).strip()
        leaves.append(_msg if _msg else type(e).__name__)

    _walk(exc, 0)
    return (" | ".join(dict.fromkeys(leaves)) or type(exc).__name__)[:limit]


async def execute_tool_batch(
    prepared: List[Dict[str, Any]],
    *,
    execute_single: Callable[..., Awaitable[Any]],
    record_metric: Callable[..., None],
    is_tool_failure: Callable[[Any], bool],
    on_event: Optional[Callable],
    username: str,
    chat_id: Optional[str],
    on_cancel_snapshot: Callable[[], Awaitable[None]],
    iteration: int,
    emit_progress_log: bool = True,
    is_cancelled: Optional[Callable[[], bool]] = None,
    results_out: Optional[Dict[int, str]] = None,
) -> Dict[int, str]:
    """Exécute ``prepared`` (liste de ``{call_id, tool_name, final_args, meta}``)
    et renvoie ``{index → résultat JSON string}``.

    Ordonnancement : parcourt dans l'ordre LLM, exécute les outils mutants un
    par un (barrière de synchro implicite « read → write → read »), et batche
    en parallèle les outils sûrs consécutifs (borné par
    ``LLAMA_TOOL_PARALLELISM``). Le POST-traitement ordonné (events
    tool_result, append) est fait par l'appelant sur ce dict.

    ``emit_progress_log`` : câble les callbacks MCP ``report_progress`` /
    ``ctx.info`` en events ``tool_progress`` / ``tool_log`` (auparavant
    natif-seulement ; le legacy en bénéficie désormais aussi).

    Annulation : ``CancelledError`` déclenche ``on_cancel_snapshot`` (shielded
    par l'appelant) puis se propage. Un outil qui échoue autrement renvoie un
    ``{"error": …}`` — la boucle continue (le modèle voit l'échec).

    ``results_out`` (audit 2026-08-23) : dict FOURNI par l'appelant, rempli EN
    PLACE. Sans lui, le dict de résultats était purement local : sur annulation
    réelle on relevait, et les résultats des outils DÉJÀ TERMINÉS du round
    étaient perdus avec la pile — alors que ce sont précisément les outils
    MUTANTS (write_file, git_*, execute_shell), sérialisés donc exécutés EN
    PREMIER, dont l'effet de bord est déjà appliqué sur le disque. Le
    « Continuer » repartait aveugle et les rejouait.
    """
    results_by_idx: Dict[int, str] = results_out if results_out is not None else {}
    _parallelism = max(1, LLAMA_TOOL_PARALLELISM)
    _exec_sem = asyncio.Semaphore(_parallelism)

    def _real_cancellation() -> bool:
        """Distingue l'annulation RÉELLE (Stop utilisateur, drain worker —
        propagée par ``task.cancel()`` ou signalée par ``is_cancelled``) d'un
        ``CancelledError`` FUI d'un cancel-scope anyio des transports MCP
        (cf. le même piège documenté dans ``_mcp_wrappers`` : scope entré et
        sorti dans des tâches différentes). Le second n'est PAS une exception
        « ordinaire » (BaseException) : sans ce tri, il traversait tous les
        ``except Exception`` et terminait le run comme si l'utilisateur avait
        appuyé sur Stop."""
        if is_cancelled is not None and is_cancelled():
            return True
        t = asyncio.current_task()
        return bool(t is not None and t.cancelling())

    # (passe 8, B9) — dans un lot parallèle, le snapshot d'annulation est pris
    # UNE fois par ``_gather_batch`` APRÈS le drain des frères (résultats
    # terminés inclus), pas par chaque frère annulé (N snapshots idempotents
    # mais bruyants, et pris AVANT que les frères aient fini).
    _batch_snapshot = [False]

    async def _exec_one(idx: int, p: Dict[str, Any]) -> None:
        _tool_name_local = p["tool_name"]

        async def _progress_cb(progress: float,
                               total: Optional[float] = None,
                               message: Optional[str] = None) -> None:
            try:
                await _emit(on_event, {
                    "type": "tool_progress",
                    "name": _tool_name_local,
                    "progress": float(progress),
                    "total": float(total) if total is not None else None,
                    "message": message or "",
                })
            except Exception:
                logger.debug("[tool_progress emit] failed", exc_info=True)

        async def _log_cb(params: Any) -> None:
            # params = LoggingMessageNotificationParams (mcp SDK) :
            # {level, logger?, data}. ``data`` est souvent une string mais le
            # spec autorise du JSON arbitraire → stringify défensif.
            # NB fastmcp 3.x enveloppe le message dans un LogData sérialisé
            # ``{"msg": <str>, "extra": <mapping|null>}`` — on déballe.
            try:
                level = getattr(params, "level", None) or "info"
                logger_name = getattr(params, "logger", None) or ""
                data = getattr(params, "data", None)
                # (2026-09-11, P3) notifications STRUCTURÉES (``extra.kind``) :
                #   • heartbeat → consommé ici (flux vivant), AUCUN événement ;
                #   • shell_output → événement NDJSON dédié, comme la sentinelle
                #     JSON legacy ci-dessous (repli, serveur antérieur).
                _extra = data.get("extra") if isinstance(data, dict) else None
                if isinstance(_extra, dict) and _extra.get("kind") == "heartbeat":
                    return
                if isinstance(_extra, dict) and _extra.get("kind") == "shell_output":
                    _ev_s: Dict[str, Any] = {"type": "shell_output",
                                             "name": _tool_name_local,
                                             "call_id": p.get("call_id")}
                    for _k in ("stream", "seq", "done", "returncode",
                               "duration_ms", "timed_out",
                               "bytes_total", "live_truncated"):
                        if _k in _extra:
                            _ev_s[_k] = _extra[_k]
                    if isinstance(_extra.get("chunk"), str):
                        _ev_s["chunk"] = _extra["chunk"][:8192]
                    await _emit(on_event, _ev_s)
                    return
                if isinstance(data, dict) and "msg" in data:
                    data = data["msg"]

                # ── Live shell : notifications taguées shell_output ──────
                # Le bridge exec émet la sortie incrémentale d'execute_shell
                # en ctx.info(logger_name="shell_output") portant un payload
                # JSON sentinelle {"__shell_output__": {...}}. Traduites ici
                # en événements NDJSON dédiés (jamais en tool_log).
                if isinstance(data, str) and "__shell_output__" in data:
                    try:
                        _parsed = json.loads(data)
                    except Exception:
                        _parsed = None
                    _pl = (_parsed or {}).get("__shell_output__") \
                        if isinstance(_parsed, dict) else None
                    if isinstance(_pl, dict):
                        _ev: Dict[str, Any] = {
                            "type": "shell_output",
                            "name": _tool_name_local,
                            # Attribution fiable côté client : deux
                            # execute_shell PARALLÈLES partagent le même
                            # name — le call_id (celui du tool_call) est le
                            # seul discriminant. Le log_callback est par
                            # appel, donc ``p`` est bien le nôtre.
                            "call_id": p.get("call_id"),
                        }
                        for _k in ("stream", "seq", "done", "returncode",
                                   "duration_ms", "timed_out",
                                   "bytes_total", "live_truncated"):
                            if _k in _pl:
                                _ev[_k] = _pl[_k]
                        if isinstance(_pl.get("chunk"), str):
                            # Les batches font ≤ ~2 Ko par construction ;
                            # clip défensif seulement.
                            _ev["chunk"] = _pl["chunk"][:8192]
                        await _emit(on_event, _ev)
                        return

                if isinstance(data, (dict, list)):
                    try:
                        msg = json.dumps(data, ensure_ascii=False)[:1000]
                    except Exception:
                        msg = str(data)[:1000]
                else:
                    msg = str(data)[:1000] if data is not None else ""
                await _emit(on_event, {
                    "type": "tool_log",
                    "name": _tool_name_local,
                    "level": str(level),
                    "logger": str(logger_name),
                    "message": msg,
                })
            except Exception:
                logger.debug("[tool_log emit] failed", exc_info=True)

        _cbs: Dict[str, Any] = (
            {"progress_callback": _progress_cb, "log_callback": _log_cb}
            if emit_progress_log else {}
        )

        async with _exec_sem:
            _t0 = time.perf_counter()
            try:
                if p.get("args_error"):
                    # Arguments illisibles : l'outil ne tourne PAS (avec ``{}``
                    # il s'exécutait sur ses défauts) et le modèle voit
                    # pourquoi — audit 2026-09-24, 2e passe.
                    r = {"ok": False, "error": p["args_error"]}
                else:
                    r = await execute_single(
                        p["tool_name"], p["final_args"],
                        meta=p.get("meta"), **_cbs,
                    )
                results_by_idx[idx] = r if isinstance(r, str) else json.dumps(r)
            except asyncio.CancelledError:
                if _real_cancellation():
                    if not _batch_snapshot[0]:
                        await on_cancel_snapshot()
                    raise
                # CancelledError FUI d'un cancel-scope MCP (pas de Stop
                # utilisateur) : erreur d'outil ORDINAIRE, le run continue.
                results_by_idx[idx] = json.dumps({"error": (
                    f"outil '{_tool_name_local}' : transport MCP interrompu "
                    "(cancel-scope) — réessayez l'appel")})
            except Exception as _ex:
                # execute_single catche déjà en interne et renvoie un JSON
                # d'erreur ; filet ici pour ne pas crasher le gather() entier
                # sur un seul outil en panne. Message DÉPLIÉ : un
                # ExceptionGroup anyio stringifié brut masquait la cause
                # réelle (ex. ValidationError pydantic sur un argument).
                results_by_idx[idx] = json.dumps(
                    {"error": flatten_exception_message(_ex)})
            except BaseException as _bx:
                # BaseExceptionGroup (groupe anyio contenant un
                # CancelledError) : n'est NI CancelledError NI Exception —
                # avant, il traversait tout et TUAIT le run entier. Même tri
                # que ci-dessus : annulation réelle → propager ; sinon,
                # erreur d'outil ordinaire.
                if isinstance(_bx, (KeyboardInterrupt, SystemExit, GeneratorExit)):
                    raise
                if _real_cancellation():
                    if not _batch_snapshot[0]:
                        await on_cancel_snapshot()
                    raise
                results_by_idx[idx] = json.dumps(
                    {"error": flatten_exception_message(_bx)})
            _dur_ms = int((time.perf_counter() - _t0) * 1000)

        # Metric event ``tool_call`` enrichi avec status=ok|error (widget
        # ToolErrorRateProvider) + ligne tool_call_metrics (observabilité).
        try:
            _r = results_by_idx.get(idx, "")
            # Classification OUTIL (pas commande) : un exit≠0 de commande shell
            # n'est PAS un échec d'outil (cf. is_tool_failure).
            _status = "error" if is_tool_failure(_r) else "ok"

            def _write_telemetry() -> None:
                """Les trois écritures BLOQUANTES de ce bloc, hors event loop.

                AUDIT long-run 2026-08-21 — ``log_metric`` et ``record_metric``
                sont des écritures SQLite synchrones, et rien dans
                ``shared_infra/db`` ne les déporte : elles s'exécutaient sur la
                boucle asyncio du worker, à CHAQUE appel d'outil. Avec un
                ``busy_timeout`` de 10 s et plusieurs workers en WAL, une
                écriture en contention gelait tout le worker — donc TOUS les
                flux SSE, les heartbeats et le drain, pas seulement le run
                fautif. Le pool de connexions est thread-local (clé
                ``(pid, DB_PATH)``) : un thread d'exécuteur ouvre naturellement
                la sienne, sans partage illégal.

                ``watch_tool_call`` écrit un fichier — même raison.

                NB : la forme littérale ``log_metric("tool_call", …)`` est
                VERROUILLÉE par tests/llm_core/test_tool_call_metric_once.py
                (analyse AST : un seul point de comptage, et il est ici).
                """
                log_metric("tool_call", 1, {
                    "tool": p["tool_name"], "user": username, "status": _status,
                })
                record_metric(
                    username, chat_id, p["tool_name"],
                    "error" if _status == "error" else "success",
                    _dur_ms,
                    error_short=_r[:500] if _status == "error" else None,
                )
                # Watcher contexte/perf (LLAMA_WATCH=1) : taille entrée/sortie
                # et durée de CHAQUE outil — pour voir ce qui gonfle le contexte.
                from llm_core._watch import watch_tool_call
                _fa = p.get("final_args")
                watch_tool_call(
                    chat_id=chat_id, iteration=iteration, tool=p["tool_name"],
                    args_chars=len(_fa) if isinstance(_fa, str)
                    else len(json.dumps(_fa, ensure_ascii=False, default=str) or "")
                    if _fa is not None else 0,
                    result_chars=len(_r), duration_ms=_dur_ms, status=_status,
                )

            # OPTIM 2026-09-26 — attente BORNÉE : l'écriture part dans un
            # thread, mais l'attendre sans limite retenait le résultat de
            # l'outil (donc l'itération suivante) jusqu'à 10 s de
            # ``busy_timeout`` SQLite en contention. Au-delà de la borne, le
            # thread termine seul (``shield``) ; son éventuelle erreur est
            # consommée par le rappel, comme l'``except`` ci-dessous le fait.
            _tele = asyncio.ensure_future(asyncio.get_running_loop().run_in_executor(
                _telemetry_pool(), contextvars.copy_context().run, _write_telemetry))
            _tele.add_done_callback(_consume_telemetry_result)
            try:
                await asyncio.wait_for(asyncio.shield(_tele), _TELEMETRY_WAIT_S)
            except asyncio.TimeoutError:
                pass

            # Event UX dédié todo-list : le résultat de ``todowrite`` porte la
            # liste normalisée → poussée telle quelle au front (panneau
            # checklist). Émis ici car les DEUX canaux (natif/legacy) passent
            # par cette harness. Best-effort, dans le même try que les metrics.
            if p["tool_name"] == "todowrite" and _status == "ok":
                try:
                    _todo_payload = json.loads(_r) if isinstance(_r, str) else _r
                    if isinstance(_todo_payload, dict) and isinstance(
                            _todo_payload.get("todos"), list):
                        await _emit(on_event, {
                            "type": "todo_updated",
                            "todos": _todo_payload["todos"],
                            "remaining": _todo_payload.get("remaining"),
                        })
                        # (2026-09-19) Le modèle ne voit que la forme courte
                        # (``checklist`` + compteurs) : la liste structurée ne
                        # sert qu'au panneau — la lui renvoyer doublait le
                        # coût en jetons de chaque mise à jour.
                        if "checklist" in _todo_payload:
                            _slim = {k: v for k, v in _todo_payload.items()
                                     if k != "todos"}
                            results_by_idx[idx] = json.dumps(_slim, ensure_ascii=False)
                except Exception:
                    pass
        except asyncio.CancelledError:
            # Un Stop pendant l'écriture télémétrique ne doit pas être avalé
            # par le ``except Exception`` ci-dessous : il doit remonter comme
            # n'importe quelle annulation. AUDIT 2026-09-24 (2e passe) — AVEC
            # snapshot : l'outil a DÉJÀ tourné (son résultat est dans
            # ``results_by_idx``) ; hors lot parallèle, personne d'autre ne le
            # prenait, et « Continuer » rejouait l'écriture.
            if _real_cancellation() and not _batch_snapshot[0]:
                await on_cancel_snapshot()
            raise
        except Exception:
            pass

    async def _exec_one_guarded(idx: int, p: Dict[str, Any]) -> None:
        """``_exec_one`` dont l'annulation RÉELLE sort en exception ORDINAIRE.

        ``asyncio.wait(..., FIRST_EXCEPTION)`` ne se réveille PAS sur une tâche
        qui finit *annulée* (CPython teste explicitement ``not f.cancelled()``)
        — une tâche qui lève ``CancelledError`` compte comme annulée, pas comme
        en erreur. Sans cette conversion, un Stop pendant un lot parallèle
        laissait ``wait`` attendre… la fin de tous les frères : exactement ce
        qu'on cherche à empêcher. ``_gather_batch`` reconvertit en
        ``CancelledError`` à la sortie, le contrat de l'appelant est inchangé."""
        try:
            await _exec_one(idx, p)
        except asyncio.CancelledError:
            if _real_cancellation():
                raise _BatchCancelled() from None
            raise

    async def _gather_batch(items: List[tuple]) -> None:
        """Exécute un lot en parallèle SANS jamais orpheliner un frère.

        AUDIT long-run 2026-08-21 — ``asyncio.gather(...)`` sans
        ``return_exceptions`` propage la PREMIÈRE exception immédiatement mais
        laisse les autres tâches TOURNER, détachées. Sur un Stop utilisateur
        détecté via le flag ``is_cancelled`` (chemin qui lève depuis
        ``_exec_one``, sans ``task.cancel()`` sur le parent), les autres outils
        du lot continuaient jusqu'au bout APRÈS la fin du run — écritures
        fichier, commandes shell et commits git s'exécutaient « après le
        Stop », et leurs résultats atterrissaient dans un ``results_by_idx``
        que plus personne ne lisait. Sur une mission de plusieurs heures c'est
        la source d'effets de bord fantômes la plus difficile à diagnostiquer.

        Ici : on attend le premier échec, on annule les frères encore en vol,
        on les ATTEND vraiment (aucune tâche ne survit à la fonction), puis on
        propage. Le cas « le parent est annulé » (task.cancel) est traité par
        la même voie de nettoyage."""
        tasks = [asyncio.ensure_future(_exec_one_guarded(k, p)) for k, p in items]

        async def _drain(pending) -> None:
            for t in pending:
                t.cancel()
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)

        _batch_snapshot[0] = True
        try:
            try:
                done, pending = await asyncio.wait(
                    tasks, return_when=asyncio.FIRST_EXCEPTION)
            except BaseException:
                # Parent annulé pendant l'attente : ne rien laisser derrière,
                # puis UN snapshot (les résultats des frères terminés sont
                # dans results_by_idx, rempli en place).
                await _drain(tasks)
                if _real_cancellation():
                    await on_cancel_snapshot()
                raise
            exc: Optional[BaseException] = None
            for t in done:
                if t.cancelled():
                    continue
                # (passe 8, B9) — TOUTES les exceptions sont consultées (sinon
                # « Task exception was never retrieved » pour les frères) ; on
                # garde la première.
                e = t.exception()
                if e is not None and exc is None:
                    exc = e
            if exc is None:
                return
            await _drain(pending)
            if isinstance(exc, _BatchCancelled):
                # Annulation réelle : le contrat public reste CancelledError.
                await on_cancel_snapshot()
                raise asyncio.CancelledError("User cancelled")
            raise exc
        finally:
            _batch_snapshot[0] = False

    # Walk dans l'ordre original, batche les parallel-safe consécutifs.
    _i = 0
    _n_tools = len(prepared)
    while _i < _n_tools:
        if tool_traits(prepared[_i]["tool_name"]).serial:
            await _exec_one(_i, prepared[_i])
            _i += 1
            continue
        _j = _i
        while _j < _n_tools and not tool_traits(prepared[_j]["tool_name"]).serial:
            _j += 1
        _batch_size = _j - _i
        if _batch_size == 1:
            await _exec_one(_i, prepared[_i])
        else:
            logger.info(
                "[execute_tool_batch] Iter %d : batch parallèle de %d tools "
                "(parallelism=%d)", iteration, _batch_size, _parallelism,
            )
            await _gather_batch(
                [(_k, prepared[_k]) for _k in range(_i, _j)]
            )
        _i = _j

    return results_by_idx
