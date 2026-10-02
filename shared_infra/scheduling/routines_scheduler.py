# SPDX-License-Identifier: MIT
"""
shared_infra.scheduling.routines_scheduler — Scheduler + exécuteur des routines planifiées.

Service de fond (démarré dans le lifespan de l'app, sur chaque worker) qui, sur
le worker LEADER uniquement, évalue les crons des routines actives et lance leur
exécution headless via la boucle d'outils du chatbot (``run_chat_multi_mcp``).

Concurrence (multi-worker, gunicorn ``preload_app=False``, workers recyclés) :
  • Élection de leader : ``try_acquire_cron_lock()`` est RE-SONDÉ à chaque tick
    → bascule automatique si le leader meurt/recycle (le flock se libère).
  • Un seul leader évalue/lance les runs planifiés ⇒ pas de double-fire.
  • Admission atomique gardée par un cap de runs simultanés / utilisateur
    (``admit_and_insert_run`` en ``BEGIN IMMEDIATE``) ⇒ correct même cross-worker
    et même mêlé aux « run-now » servis par d'autres workers.
  • Skip-catch-up : seule la minute courante est évaluée ; ``claim_minute_fire``
    empêche un double-fire dans la même minute lors d'un handoff.
  • Réconciliation des runs orphelins par péremption du heartbeat.

Les runs s'exécutent ``priority="low"`` → ils cèdent le pas aux chats live dans
``llm_scheduling_guard``.
"""
from __future__ import annotations

import asyncio
import contextvars
import logging
import os
import secrets
import time
from datetime import datetime
from typing import Any, Dict, List, Optional

from shared_infra.config import LLAMA_MODEL
from shared_infra.db import log_metric
from shared_infra.observability.usage_ctx import set_usage_context
from shared_infra.scheduling.cron_lock import try_acquire_cron_lock
from shared_infra.scheduling.routines_store import (
    admit_and_insert_run,
    claim_minute_fire,
    count_running_for_routine,
    get_routine_internal,
    heartbeat_run,
    insert_skipped_run,
    list_chained_routines,
    list_enabled_routines,
    mark_run_cancelled,
    mark_run_error,
    mark_run_ok,
    mark_run_skipped,
    reconcile_orphans,
    routine_notification_title,
)

logger = logging.getLogger("uvicorn.error")

# ── Réglages ──────────────────────────────────────────────────────────────────
PER_USER_CAP = max(1, int(os.environ.get("ROUTINES_PER_USER_CAP", "5")))
TICK_SECONDS = 60
HEARTBEAT_SECONDS = 60
RECONCILE_EVERY_TICKS = 5      # ~ toutes les 5 min
ORPHAN_STALE_AFTER_S = 300.0   # heartbeat figé > 5 min ⇒ orphelin

# Reprise automatique bornée d'un run en échec (fiabilité — « reprises »). Une
# exception qui s'ÉCHAPPE de la boucle d'outils est presque toujours un échec
# PRÉCOCE (LLM injoignable au démarrage, 5xx fatal) AVANT tout effet de bord
# d'outil — les erreurs d'outil, elles, sont rattrapées et réinjectées au modèle
# sans remonter. Une reprise est donc sûre et absorbe les coupures transitoires
# (le LLM tombe puis revient). On NE retente JAMAIS une annulation (shutdown).
# Tunable par env ; 1 ⇒ aucune reprise.
RUN_MAX_ATTEMPTS = max(1, int(os.environ.get("ROUTINES_RUN_MAX_ATTEMPTS", "2")))
RUN_RETRY_BACKOFF_S = max(0.0, float(os.environ.get("ROUTINES_RUN_RETRY_BACKOFF_S", "3.0")))

# Identité de ce processus (diagnostic ; PAS un déclencheur de réconciliation).
_BOOT_ID = secrets.token_hex(8)
# Runs lancés par CE worker (run_id → Task) — drainés au shutdown par
# ``drain_running_runs()`` (lifespan, AVANT la fermeture du pool MCP/client LLM).
_running_tasks: "Dict[int, asyncio.Task]" = {}
_scheduler_started = False

# Timestamp (monotone-wall) du dernier tour de ``_routines_loop`` sur CE worker.
# Sert au watchdog ``scheduler_alive()`` : un leader dont la boucle est
# silencieusement morte garde le flock (donc reste « leader ») mais cesse de
# ticker → détectable. None = la boucle n'a pas encore tourné.
_last_tick: Optional[float] = None

# Garde-fou heartbeat : nb d'échecs consécutifs avant avertissement (cf. _heartbeat_loop).
_HEARTBEAT_MAX_FAILURES = 3
_HEARTBEAT_OP_TIMEOUT = 10.0


# Enchaînement « à la Jenkins » : profondeur max d'une chaîne A→B→C… — coupe
# les cycles (A→B→A relancerait à l'infini : la garde anti-chevauchement de
# ``launch_run`` ne voit plus A une fois son run terminé) et les chaînes
# déraisonnables.
CHAIN_MAX_DEPTH = max(1, int(os.environ.get("ROUTINES_CHAIN_MAX_DEPTH", "5")))


def _denied_for_routine() -> set:
    """Outils retirés à une ROUTINE (sans UI ni message suivant) : la politique
    ``meta.policy.deny_for: ["routine"]`` déclarée par les outils fait foi ;
    ``{"ask_user"}`` reste le repli d'un registre vide."""
    try:
        from llm_core._mcp_categories import tools_denied_for
        return set(tools_denied_for("routine", fallback={"ask_user"}))
    except Exception:                                           # noqa: BLE001
        return {"ask_user"}


async def _fire_chained_routines(routine: Dict[str, Any], run_id: int, *,
                                 status: str, summary: str = "",
                                 chain_depth: int = 0) -> None:
    """Déclenche les routines AVAL configurées « après » celle-ci.

    À la Jenkins : la routine aval porte le pointeur (``trigger_after_id``)
    et sa condition (``trigger_after_on`` : ok | error | always). Appelée aux
    fins de run RÉELLES (transition posée) — jamais sur shutdown/drain ni sur
    un arrêt utilisateur (un stop volontaire ne doit pas propager la chaîne).
    Best-effort : un échec de lookup/lancement n'affecte pas le run amont.
    Le run aval part in-process sur CE worker (même contrat que run-now)."""
    try:
        downstream = await asyncio.to_thread(
            list_chained_routines, int(routine.get("id") or 0))
    except Exception as e:                              # noqa: BLE001
        logger.warning("[ROUTINES] enchaînement run %s : lookup KO : %s", run_id, e)
        return
    if not downstream:
        return
    for d in downstream:
        cond = d.get("trigger_after_on") or "ok"
        if cond == "ok" and status != "ok":
            continue
        if cond == "error" and status != "error":
            continue
        # Cloisonnement : validé à la sauvegarde, re-vérifié ici (une ligne DB
        # modifiée à la main ne doit pas faire traverser les tenants).
        if int(d.get("owner_user_id") or 0) != int(routine.get("owner_user_id") or -1):
            continue
        if chain_depth + 1 > CHAIN_MAX_DEPTH:
            logger.warning("[ROUTINES] chaîne coupée (profondeur > %d) : %s → %s",
                           CHAIN_MAX_DEPTH, routine.get("id"), d.get("id"))
            try:
                await asyncio.to_thread(
                    insert_skipped_run, int(d["id"]), int(d["owner_user_id"]),
                    trigger="chain",
                    reason=f"profondeur d'enchaînement max ({CHAIN_MAX_DEPTH})")
            except Exception:
                pass
            continue
        context = (f"- routine amont : {routine.get('name') or ''} (run #{run_id})\n"
                   f"- statut : {status}")
        if summary:
            context += f"\n- résumé :\n{summary[:1000]}"
        try:
            await launch_run(d, trigger="chain", context=context,
                             chain_depth=chain_depth + 1)
        except Exception as e:                          # noqa: BLE001
            logger.warning("[ROUTINES] enchaînement %s → %s KO : %s",
                           routine.get("id"), d.get("id"), e)


def run_chat_key(routine_id: int, run_id: int) -> str:
    """Chat_id synthétique d'un run = clé d'annulation.

    SOURCE UNIQUE : partagée entre l'exécuteur (flag ``is_cancelled`` de la
    boucle d'outils) et la route « stop » (``mark_chat_cancelled`` → cancel_bus
    cross-worker). Ne pas reformater à la main ailleurs — une divergence rend
    le bouton Arrêter silencieusement inopérant."""
    return f"routine:{int(routine_id)}:run:{int(run_id)}"


def scheduler_alive() -> bool:
    """True si ce worker est le leader cron ET que sa boucle a tické récemment.

    Read-only (n'acquiert pas le lock). Sur un non-leader → False (normal).
    Sur le leader dont ``_routines_loop`` est mort → False (le signal recherché :
    « routines silencieusement mortes jusqu'au restart »)."""
    try:
        from shared_infra.scheduling.cron_lock import is_cron_leader
        if not is_cron_leader():
            return False
    except Exception:
        return False
    if _last_tick is None:
        return False
    # Tolérance : 2 ticks + marge (le tick dort TICK_SECONDS puis travaille).
    return (time.time() - _last_tick) < (TICK_SECONDS * 2 + 30)


def _ms(t0: float) -> int:
    return int((time.time() - t0) * 1000)


def _files_written(events: Any) -> List[str]:
    """Chemins écrits/modifiés pendant un run, dans l'ordre d'écriture.

    Source = 2e valeur de retour de la boucle d'outils, qui n'y consigne que les
    mutations de fichiers (cf. ``RunRecord.record_file_mutation``,
    ``llm_core/engine/run.py``). On ne PEUT pas passer
    un ``on_event`` ici pour les récupérer : la boucle ne re-streame la réponse
    finale en content_token QUE si un ``on_event`` est branché — soit plusieurs
    secondes de sleep artificiel ajoutées à chaque run headless.

    Les écritures en ÉCHEC sont écartées : elles n'ont produit aucun fichier.
    """
    out: List[str] = []
    if not isinstance(events, list):
        return out
    for ev in events:
        if not isinstance(ev, dict) or ev.get("type") != "tool_result":
            continue
        if not ev.get("ok", True):
            continue
        path = ev.get("path")
        if not isinstance(path, str) or not path.strip():
            continue
        path = path.strip()
        if path not in out:
            out.append(path)
    return out


def _rehydrate_mcp_secrets(snapshot: List[Dict[str, Any]],
                           user_settings: Dict[str, Any], *,
                           allow_stdio: bool = False) -> List[Dict[str, Any]]:
    """Re-fusionne les champs secrets (auth/headers/token…) dans chaque config
    MCP du snapshot, depuis les serveurs MCP enregistrés de l'utilisateur
    (appariés par ``url`` puis ``name``). Le snapshot n'en contient jamais
    (cf. ``routines_store._strip_mcp_secrets``) → rotation de clé honorée, pas de
    credential figé dans la routine.

    Bibliothèque MCP PARTAGÉE : une entrée ``shared:<n>`` est RÉSOLUE PAR ID,
    pas appariée. L'appariement url/name ne peut pas marcher pour elle — le
    navigateur ne détient ni l'URL faisant autorité ni le secret, donc le
    snapshot ne porte qu'une référence. Même règle que la route de chat : la
    config vient de la base, et une entrée dépubliée, désactivée ou que ce
    compte n'affiche plus est JETÉE (une routine ne doit pas continuer à
    joindre un serveur retiré de la bibliothèque).

    Le snapshot n'est qu'une liste de RÉFÉRENCES : outils locaux (sentinelle
    reconstruite), entrée du manifeste par nom, serveur partagé ou perso de
    l'utilisateur. Une entrée qui ne se résout en rien est JETÉE. Ne jamais la
    laisser partir telle quelle : un ``type: "stdio"`` + ``command`` posté par
    n'importe quel compte s'exécuterait sur l'hôte, et une ``url`` interne
    rouvrirait la SSRF fermée côté chat."""
    from shared_infra.mcp.servers import (
        client_builtin_ref,
        personal_to_config,
        resolve_config,
        shared_id,
    )
    user_servers = list((user_settings or {}).get("mcp_servers") or [])
    visible_shared = {str(v) for v in
                      ((user_settings or {}).get("shared_mcp_visible") or [])}
    by_id: Dict[str, Dict[str, Any]] = {}
    by_url: Dict[str, Dict[str, Any]] = {}
    by_name: Dict[str, Dict[str, Any]] = {}
    for s in user_servers:
        if not isinstance(s, dict):
            continue
        if s.get("id"):
            by_id[str(s["id"])] = s
        if s.get("url"):
            by_url[s["url"]] = s
        if s.get("name"):
            by_name[s["name"]] = s
    out: List[Dict[str, Any]] = []
    for cfg in (snapshot or []):
        if not isinstance(cfg, dict):
            continue
        cfg = dict(cfg)
        rid = shared_id(cfg.get("id"))
        if rid is not None:
            if str(cfg.get("id")) not in visible_shared:
                continue
            resolved = resolve_config(rid)
            if resolved:
                out.append(resolved)
            continue
        ref = client_builtin_ref(cfg)
        if ref is not None:
            out.append(ref)
            continue
        if not cfg.get("id") and cfg.get("manifest"):
            from shared_infra.mcp.manifest import resolve_external_cfg
            mcfg = resolve_external_cfg(str(cfg.get("manifest")))
            if mcfg:
                if isinstance(cfg.get("filter_categories"), list):
                    mcfg["filter_categories"] = cfg["filter_categories"]
                out.append(mcfg)
            continue
        # Appariement par id d'abord (stable si l'URL change), puis url/name
        # pour les snapshots antérieurs aux ids.
        match = None
        if cfg.get("id") and str(cfg["id"]) in by_id:
            match = by_id[str(cfg["id"])]
        elif cfg.get("url") and cfg["url"] in by_url:
            match = by_url[cfg["url"]]
        elif cfg.get("name") and cfg["name"] in by_name:
            match = by_name[cfg["name"]]
        if match:
            # Config COMPLÈTE déchiffrée — surtout pas une recopie clé-à-clé de
            # ``_MCP_SECRET_KEYS`` : ``auth_enc`` y figure, et copier
            # le chiffré tel quel livrerait du Fernet à ``_resolve_mcp_client``.
            cfg = personal_to_config(match, allow_stdio=allow_stdio)
            if not cfg:
                # ``stdio`` d'un propriétaire non admin : jamais spawné.
                continue
            out.append(cfg)
        else:
            logger.warning("[ROUTINES] serveur MCP du snapshot sans correspondance "
                           "(%r) : ignoré", str(cfg.get("name") or cfg.get("id") or "?")[:80])
    return out


# ─────────────────────────────────────────────────────────────────────────────
#  Exécuteur d'un run
# ─────────────────────────────────────────────────────────────────────────────
async def _heartbeat_loop(run_id: int) -> None:
    # Garde-fou : si la DB devient injoignable (verrou prolongé, disque plein),
    # ``heartbeat_run`` peut bloquer. On le borne par ``wait_for`` pour ne pas
    # saturer le ThreadPoolExecutor par défaut (un thread bloqué par run × N
    # runs concurrents → épuisement → tout ``to_thread`` finit par traîner).
    #
    # On NE quitte JAMAIS après N échecs consécutifs : une contention DB
    # transitoire de quelques cycles (p.ex. pendant le wal_checkpoint(TRUNCATE)
    # de maintenance sous charge) priverait de heartbeat le reste d'un run long
    # → reconcile_orphans marquerait « orphaned » un run VIVANT → faux échec +
    # notif de succès perdue (mark_run_ok gardé WHERE status='running' → no-op).
    # On continue à battre (le run reprend l'horloge dès que la DB récupère) ;
    # la task est de toute façon annulée à la fin du run. Un warning au
    # franchissement du seuil signale la contention sans tuer le heartbeat.
    failures = 0
    warned = False
    try:
        while True:
            await asyncio.sleep(HEARTBEAT_SECONDS)
            try:
                await asyncio.wait_for(
                    asyncio.to_thread(heartbeat_run, run_id),
                    timeout=_HEARTBEAT_OP_TIMEOUT,
                )
                if warned:
                    logger.info("[ROUTINES] heartbeat run %s rétabli après contention DB", run_id)
                failures = 0
                warned = False
            except asyncio.CancelledError:
                raise
            except (asyncio.TimeoutError, Exception):
                failures += 1
                if failures >= _HEARTBEAT_MAX_FAILURES and not warned:
                    warned = True
                    logger.warning(
                        "[ROUTINES] heartbeat run %s : %d échecs consécutifs (contention "
                        "DB ?) — on continue de battre pour ne pas orpheliner un run vivant",
                        run_id, failures,
                    )
    except asyncio.CancelledError:
        pass


def _emit_run_notification(uid: int, routine_id: int, name: str, *, ok: bool, detail: str) -> None:
    """Crée une notification de fin de run + pousse un event SSE live (best-effort).

    Sync (appelée via ``asyncio.to_thread``). Ne lève jamais : une notif est du
    sucre, elle ne doit pas faire échouer un run. Imports tardifs pour éviter un
    cycle au chargement (comme le reste de ce module).
    """
    try:
        from shared_infra.notifications.push import push_notification

        # Titre = source unique partagée avec le renommage (le récap affiche
        # toujours le nom courant de la routine).
        kind = "routine_ok" if ok else "routine_error"
        title = routine_notification_title(name, routine_id, ok=ok)
        # Persiste + event live enrichi (badge + aperçu toast/OS) en best-effort.
        push_notification(uid, kind, title, body=detail or "",
                          ref_type="routine", ref_id=routine_id)
    except Exception as exc:  # noqa: BLE001 — best-effort
        logger.debug("[ROUTINES] notification non émise (run routine %s) : %r", routine_id, exc)


def _notify_wanted(routine: Dict[str, Any], *, ok: bool) -> bool:
    """Politique ``notify_on`` de la routine : ``all`` (défaut) notifie chaque
    fin de run, ``error`` seulement les échecs, ``none`` jamais. Une valeur
    inconnue vaut ``all`` (même normalisation que le store)."""
    mode = str(routine.get("notify_on") or "all").strip().lower()
    if mode == "none":
        return False
    if mode == "error":
        return not ok
    return True


async def _notify_run_end(routine: Dict[str, Any], uid: int, *, ok: bool,
                          detail: str) -> None:
    """Fin de run → notification SELON la politique de la routine, puis cap
    ``notify_keep`` (« garder les X dernières notifications de cette routine »).

    Sans cette politique, une routine minute remplirait à elle seule le
    centre de notifications. ``_emit_run_notification`` garde sa signature
    (les tests la stubbent) ;
    la politique vit ici, au-dessus. Best-effort : la purge ne fait jamais
    échouer le run."""
    if not _notify_wanted(routine, ok=ok):
        return
    rid = int(routine["id"])
    await asyncio.to_thread(_emit_run_notification, uid, rid,
                            routine.get("name") or "", ok=ok, detail=detail)
    try:
        keep = int(routine.get("notify_keep") or 0)
    except (TypeError, ValueError):
        keep = 0
    if keep > 0:
        try:
            from shared_infra.notifications.store import prune_ref_notifications
            await asyncio.to_thread(prune_ref_notifications, uid, "routine", rid, keep)
        except Exception as exc:  # noqa: BLE001 — best-effort
            logger.debug("[ROUTINES] purge notify_keep non appliquée (routine %s) : %r",
                         rid, exc)


async def _execute_routine_run_mesure(routine: Dict[str, Any], run_id: int,
                                      **kw: Any) -> None:
    """``execute_routine_run`` dans son exécution (``runs``) : ce que le
    run consomme y est versé ; son statut final est celui du run de routine
    (``ok``, ``error``, ``skipped``, ``cancelled``)."""
    from shared_infra.observability.runs import new_run_id, run_scope
    from shared_infra.scheduling.routines_store import get_run as _ligne_du_run
    rid = int(routine["id"])
    async with run_scope("routine", run_id=new_run_id("routine"),
                         user_id=routine.get("owner_user_id"), routine_id=rid,
                         chat_id=run_chat_key(rid, run_id),
                         model=str(routine.get("model") or "")) as e:
        await execute_routine_run(routine, run_id, **kw)
        try:
            from llm_core.engines import current_engine
            e.engine = current_engine().key              # cible posée par le run
            ligne = await asyncio.to_thread(_ligne_du_run, run_id,
                                            int(routine["owner_user_id"]))
            if ligne and ligne.get("status") in ("ok", "error", "skipped", "cancelled"):
                e.finish(ligne["status"])
        except Exception:                                       # noqa: BLE001
            logger.debug("[ROUTINES] issue du run %s non relue", run_id, exc_info=True)


async def execute_routine_run(routine: Dict[str, Any], run_id: int,
                              context: Optional[str] = None,
                              chain_depth: int = 0,
                              trigger: str = "schedule") -> None:
    """Exécute UN run de routine en headless, puis journalise le résultat.

    ``routine`` est un dict (mcp_snapshot déjà parsé en liste). Re-valide
    l'existence/activation au démarrage, rehydrate les secrets MCP, lance la
    boucle d'outils ``priority="low"``, puis ``mark_run_ok``/``mark_run_error``.
    ``context`` (webhook / routine amont) est APPENDU au message user — le
    task_prompt stocké reste inchangé. ``chain_depth`` = position dans un
    enchaînement (0 = déclenchement direct) — propagé aux routines aval,
    borné par ``CHAIN_MAX_DEPTH``. ``trigger`` sert au registre d'usage : un
    run cron et un run webhook consomment pareil, mais ne se pilotent pas
    pareil — les distinguer est tout l'intérêt d'une vue « hors heures ».
    """
    t0 = time.time()
    hb_task: Optional[asyncio.Task] = None
    uid: Optional[int] = None
    synthetic_chat_id: Optional[str] = None
    _reg_task: Optional[asyncio.Task] = None
    try:
        uid = int(routine["owner_user_id"])
        # Registre d'usage : sans ce scope, tout ce que consomme un run
        # nocturne s'enregistre en « unknown » et n'est rattachable ni à son
        # propriétaire ni à son mode de déclenchement : l'activité hors heures
        # de bureau serait invisible.
        set_usage_context(
            "webhook" if trigger == "webhook" else "routine",
            user_id=uid,
            origin_id=run_chat_key(int(routine["id"]), run_id),
        )

        # Import tardif : évite un cycle au chargement + reflète l'état courant.
        from shared_infra.accounts.users import get_user_by_id, get_user_settings, get_username_by_id

        username = await asyncio.to_thread(get_username_by_id, uid)
        if not username:
            await asyncio.to_thread(mark_run_error, run_id,
                                    error="utilisateur introuvable", duration_ms=_ms(t0))
            return
        # Supprimée/désactivée entre l'admission et le démarrage : 'skipped',
        # pas 'error' — un « Échec » rouge pour une désactivation volontaire
        # serait la même incohérence que pour un arrêt utilisateur ('cancelled').
        fresh = await asyncio.to_thread(get_routine_internal, int(routine["id"]))
        if fresh is None:
            await asyncio.to_thread(mark_run_skipped, run_id,
                                    reason="routine supprimée avant démarrage", duration_ms=_ms(t0))
            return
        if not fresh.get("enabled"):
            await asyncio.to_thread(mark_run_skipped, run_id,
                                    reason="routine désactivée avant démarrage", duration_ms=_ms(t0))
            return
        routine = fresh

        # Jamais de réglages VIDES par défaut : le run partirait sans secrets
        # MCP, sans serveurs partagés, sans mémoire ni agents perso, et pourrait
        # être noté « ok ». Deux relectures (base verrouillée un instant), puis
        # échec explicite.
        user_settings = None
        for _try in range(3):
            try:
                user_settings = await asyncio.to_thread(get_user_settings, uid) or {}
                break
            except Exception as exc:                            # noqa: BLE001
                _settings_err = exc
                if _try < 2:
                    await asyncio.sleep(0.5 * (_try + 1))
        if user_settings is None:
            logger.warning("[ROUTINES] run %s : réglages illisibles (%r)", run_id, _settings_err)
            await asyncio.to_thread(mark_run_error, run_id,
                                    error="réglages du compte illisibles — run non lancé",
                                    duration_ms=_ms(t0))
            return
        # Un serveur perso ``stdio`` n'est exécuté que si le PROPRIÉTAIRE de la
        # routine est administrateur plein.
        try:
            _owner = await asyncio.to_thread(get_user_by_id, uid)
            _stdio_ok = bool(_owner and _owner["is_admin"] == 1)
        except Exception:
            _stdio_ok = False
        mcp_configs = _rehydrate_mcp_secrets(routine.get("mcp_snapshot") or [], user_settings,
                                             allow_stdio=_stdio_ok)

        # La politique d'accès du propriétaire s'applique AUSSI ici (sinon la
        # restriction se contournerait en planifiant le travail).
        # La routine part sur LE serveur de sa fiche (``connector_id``, NULL =
        # intégré) : la cible est posée dans le contexte de la tâche, donc tout
        # le run la suit (sondes, comptage de tokens, ordonnanceur, disjoncteur,
        # appels).
        _conn_id = routine.get("connector_id") or None
        _routine_allowed = True             # fail-open documenté dans engine_access
        try:
            from shared_infra.llm import engine_access as _ea
            _ekey = _ea.connector_key(_conn_id) if _conn_id else _ea.BUILTIN_KEY
            _routine_allowed = await asyncio.to_thread(_ea.can_use_engine, uid, _ekey)
        except Exception:                                       # noqa: BLE001
            _routine_allowed = True
        if not _routine_allowed:
            await asyncio.to_thread(
                mark_run_error, run_id,
                error=("serveur non autorisé pour ce compte" if _conn_id
                       else "serveur intégré non autorisé pour ce compte"),
                duration_ms=_ms(t0))
            return

        model = routine.get("model") or (None if _conn_id else LLAMA_MODEL)
        if _conn_id:
            from llm_core import set_llm_target
            from llm_core._target import EngineUnavailable, resolve_llm_target
            try:
                _target = await asyncio.to_thread(resolve_llm_target, uid, _conn_id,
                                                  model, strict=True, touch=False)
            except EngineUnavailable as _eu:
                await asyncio.to_thread(mark_run_error, run_id,
                                        error=f"serveur indisponible : {_eu.message}",
                                        duration_ms=_ms(t0))
                return
            set_llm_target(_target)         # contextvar : propre à cette tâche
            model = _target.model or LLAMA_MODEL
        model = model or LLAMA_MODEL
        messages: List[Dict[str, Any]] = []
        if routine.get("system_prompt"):
            messages.append({"role": "system", "content": routine["system_prompt"]})
        user_content = routine.get("task_prompt") or ""
        if context:
            user_content = (f"{user_content}\n\n### Événement déclencheur\n"
                            f"{context}") if user_content else str(context)
        messages.append({"role": "user", "content": user_content})

        # Skills attachés : l'agent headless n'a ni index de skills ni outil
        # ``skill_get`` (builtin_tools=None) → on injecte les corps ENTIERS des
        # skills choisis dans le message système. Résolution fraîche à chaque
        # run (user > global, learned exclu) ; ids inconnus ignorés ; best-effort
        # (un skill illisible ne doit pas faire échouer le run).
        skill_ids = routine.get("skills") or []
        if skill_ids:
            try:
                from llm_core._system_prompts import build_attached_skills_block
                skills_block = await asyncio.to_thread(
                    build_attached_skills_block, uid, skill_ids)
            except Exception as exc:  # noqa: BLE001 — best-effort
                logger.warning("[ROUTINES] run %s : bloc skills non construit : %r",
                               run_id, exc)
                skills_block = None
            if skills_block:
                if messages and messages[0].get("role") == "system":
                    messages[0]["content"] = f"{messages[0]['content']}\n\n{skills_block}"
                else:
                    messages.insert(0, {"role": "system", "content": skills_block})

        synthetic_chat_id = run_chat_key(int(routine["id"]), run_id)

        def _is_cancelled() -> bool:
            try:
                from shared_infra.routes._state import is_chat_cancelled
                return is_chat_cancelled(uid, synthetic_chat_id)
            except Exception:
                return False

        # Annulation DURE : la route « stop » diffuse sur cancel_bus, et le
        # tailer du worker hébergeur fait ``task.cancel()`` — mais seulement
        # si la task est ENREGISTRÉE sous la clé. Sans ça, le stop reste
        # purement coopératif : un run bloqué dans un outil long (shell, MCP
        # HTTP) ne s'arrêterait qu'au retour de l'outil. L'unregister du
        # ``finally`` purge aussi le flag (sinon fuite : ``is_chat_cancelled
        # (uid)`` legacy verrait ce vieux flag de routine indéfiniment).
        try:
            from shared_infra.routes._state import register_chat_task
            _reg_task = asyncio.current_task()
            if _reg_task is not None:
                # presence_lock=False : le verrou de présence sert à la garde
                # 409 du /compact sur un CHAT — inutile pour une clé de run
                # synthétique, et chaque run créerait un fichier de verrou
                # distinct (clé unique) purgé après 24 h seulement (une
                # routine minute = 1440 fichiers/jour).
                register_chat_task(uid, _reg_task, synthetic_chat_id,
                                   presence_lock=False)
        except Exception:                              # noqa: BLE001
            _reg_task = None

        hb_task = asyncio.create_task(_heartbeat_loop(run_id))

        # Même contrat que le tour de chat (chatbot_app/turn/execution.py) : v2
        # si mode "optimized" (sémaphore inline), sinon classic sous le guard.
        from llm_core import (
            llm_scheduling_guard,
            resolve_scheduling_mode,
            run_chat_multi_mcp,
            run_chat_multi_mcp_v2,
        )
        # Résolu UNE fois et réutilisé (sélection du runner ET mode passé aux
        # sous-agents), comme la route chat. ``resolve_scheduling_mode`` lit la
        # config VIVANTE : deux appels peuvent différer si un admin bascule le
        # mode entre les deux — le parent tiendrait alors le sémaphore pour
        # tout le run (classic) pendant que l'enfant croirait devoir
        # l'acquérir (optimized) : deadlock à LLAMA_MAX_CONCURRENCY=1, jusqu'au
        # timeout de 30 min de l'enfant.
        _sched_mode = resolve_scheduling_mode()
        _mcp_fn = run_chat_multi_mcp_v2 if _sched_mode == "optimized" else run_chat_multi_mcp

        # Mémoire long-terme : MÊME résolution que le tour de chat
        # (``_memory_on``, chatbot_app/turn/preparation.py). Ne pas omettre
        # ``memory_enabled`` : son défaut True côté run_chat_multi_mcp
        # exposerait ``memory`` / ``session_search`` (écriture
        # USER.md/MEMORY.md + lecture des sessions) MALGRÉ un opt-out
        # ``memory_enabled=False`` du propriétaire.
        try:
            from shared_infra.config import MEMORY_ENABLED as _MEM_MASTER
            _mem_on = bool(_MEM_MASTER and (user_settings or {}).get("memory_enabled", False))
        except Exception:
            _mem_on = False

        # ── Sous-agents (outil ``task``) : opt-in PAR ROUTINE ─────────────────
        # Gate = interrupteur maître d'instance ET le champ de la routine. PAS
        # le toggle de chat du propriétaire : celui-ci gouverne ce que le modèle
        # peut faire pendant qu'on lui parle, alors qu'une routine est un
        # programme validé une fois pour toutes — on veut un opt-in visible
        # dans la routine elle-même (onglet Agents), pas un réglage à distance
        # qui rendrait le champ silencieusement inerte.
        #
        # ``is_cancelled`` = celui de la routine : arrêter le run tue aussi ses
        # enfants. ``on_event=None`` (headless) : le relais UI du task_tool est
        # gardé partout, les enfants tournent muets. Le sink sert au rollup des
        # tokens ci-dessous — sans lui, le coût des enfants (leurs propres
        # appels LLM) n'apparaîtrait NULLE PART dans le journal.
        _task_usage: Dict[str, Any] = {}
        _builtins = None
        if routine.get("agents_enabled"):
            try:
                from shared_infra.config import AGENTS_ENABLED as _AGENTS_MASTER
            except Exception:
                _AGENTS_MASTER = True
            if _AGENTS_MASTER:
                try:
                    from llm_core import build_task_builtin_tool
                    from shared_infra.mcp.servers import resolve_for_agents
                    # Résolution des serveurs de la bibliothèque partagée : c'est
                    # une requête SQLite, elle part au threadpool comme TOUS les
                    # accès DB de cet exécuteur (la boucle sert aussi les
                    # requêtes HTTP du worker).
                    _agent_servers = await asyncio.to_thread(
                        resolve_for_agents, user_settings, allow_stdio=_stdio_ok)
                    _builtins = build_task_builtin_tool(
                        parent_mcp_configs=mcp_configs,
                        parent_builtin_tools=None,
                        username=username,
                        chat_id=synthetic_chat_id,
                        model=model,
                        sampling_override=None,
                        memory_enabled=_mem_on,
                        is_cancelled=_is_cancelled,
                        on_event=None,
                        scheduling_mode=_sched_mode,
                        usage_sink=_task_usage,
                        custom_agents=(user_settings or {}).get("custom_agents") or [],
                        user_mcp_configs=_agent_servers,
                        user_id=uid,
                        # Les sous-agents d'une routine cèdent le pas aux chats
                        # interactifs, comme la routine elle-même.
                        priority="low",
                    ) or None                   # banque vide : aucun outil task
                except Exception as exc:                        # noqa: BLE001
                    logger.warning("[ROUTINES] run %s : sous-agents non câblés (%r)",
                                   run_id, exc)
                    _builtins = None
            else:
                logger.info("[ROUTINES] run %s : sous-agents demandés mais coupés "
                            "au niveau instance (AGENTS_ENABLED)", run_id)

        # Reprise auto bornée sur échec transitoire (cf. RUN_MAX_ATTEMPTS). Le
        # heartbeat lancé plus haut reste actif pendant les tentatives.
        assistant = _events = metrics = None
        for _attempt in range(1, RUN_MAX_ATTEMPTS + 1):
            try:
                async with llm_scheduling_guard(model, use_mcp_path=True, priority="low"):
                    assistant, _events, metrics = await _mcp_fn(
                        messages,
                        mcp_configs=mcp_configs,
                        on_event=None,                 # headless : aucun flux SSE
                        username=username,
                        model=model,
                        builtin_tools=_builtins,
                        is_cancelled=_is_cancelled,
                        chat_id=synthetic_chat_id,
                        thinking_mode=bool(routine.get("thinking_mode")),
                        priority="low",
                        memory_enabled=_mem_on,   # respecte l'opt-out du propriétaire
                        # ``ask_user`` ne peut STRUCTURELLEMENT pas fonctionner
                        # ici : sa docstring promet au modèle que « les réponses
                        # arrivent dans le PROCHAIN message user » et lui dit de
                        # finir son tour aussitôt. Un run headless n'a ni
                        # panneau ni message suivant — la routine se terminerait
                        # donc sur une question posée dans le vide, travail non
                        # fait. Même raison que le deny chez les sous-agents
                        # (``task_tool._DENY_BASE``), même remède.
                        deny_tool_names=_denied_for_routine(),
                    )
                break  # succès
            except asyncio.CancelledError:
                raise  # shutdown / cancel : jamais de reprise
            except Exception as exc:  # noqa: BLE001
                # Stop utilisateur arrivé entre l'échec et la reprise (fenêtre
                # du backoff, ou hard-cancel non délivré) : basculer sur le
                # chemin CancelledError — sinon l'exception ordinaire filerait
                # dans ``except Exception`` → run 'error' + notif d'échec +
                # CHAÎNE AVAL DÉCLENCHÉE, pour un geste volontaire.
                if _is_cancelled():
                    raise asyncio.CancelledError() from exc
                # Dernière tentative → on laisse remonter vers le handler qui
                # journalise l'échec + notifie.
                if _attempt >= RUN_MAX_ATTEMPTS:
                    raise
                logger.warning(
                    "[ROUTINES] run %s tentative %d/%d échouée (%s) — reprise dans %.0fs",
                    run_id, _attempt, RUN_MAX_ATTEMPTS, exc, RUN_RETRY_BACKOFF_S,
                )
                await asyncio.sleep(RUN_RETRY_BACKOFF_S)

        m = metrics or {}
        # Réponse finale de l'agent, conservée pour le journal (« voir les réponses
        # finales » côté UI). On PRÉSERVE les retours à la ligne (affichés en
        # pre-wrap) et on garde jusqu'à 4000 caractères au lieu d'un aperçu plat.
        #
        # ⚠ Thinking : quand le contenu visible d'un tour est vide, la boucle
        # renvoie le texte BRUT — raisonnement ``<think>…`` inclus. Sans
        # nettoyage, le journal afficherait ce markup illisible, tronqué à 4000
        # en plein milieu. On ne journalise que la partie VISIBLE (même
        # découpage que le chat).
        summary_raw = (assistant or "").strip()
        try:
            from llm_core._chat_classic import _extract_thinking
            _think, _visible = _extract_thinking(summary_raw) if summary_raw else ("", "")
            summary = (_visible or "").strip()[:4000]
        except Exception:                       # best-effort : jamais bloquant
            summary = summary_raw[:4000]
        # Tokens des SOUS-AGENTS ajoutés à ceux du run : leurs appels LLM sont
        # invisibles dans ``metrics`` (boucles séparées). Sans ce rollup, une
        # routine qui délègue afficherait le coût du seul orchestrateur — soit
        # une fraction de ce qu'elle a réellement consommé.
        # La boucle d'outils ne LÈVE pas quand l'appel LLM meurt après ses
        # reprises internes : elle RETOURNE le partiel avec
        # ``ended_with_error``. La boucle de reprise ci-dessus n'y voit aucune
        # exception (« break # succès ») : sans ce contrôle, le run serait
        # journalisé 'ok', notifié en succès, et déclencherait la chaîne aval
        # — une routine qui alimente la suivante propagerait un travail
        # interrompu comme s'il était complet. (Le chat, lui, ne lit pas ce
        # drapeau : l'erreur lui parvient par l'événement ``error`` et le
        # partiel par ``truncated`` ; les sous-agents le lisent.)
        if m.get("ended_with_error"):
            err_marked = await asyncio.to_thread(
                mark_run_error, run_id,
                error="génération interrompue (erreur LLM) — "
                      "réponse partielle conservée",
                duration_ms=_ms(t0),
                summary=summary,
                input_tokens=int(m.get("input_tokens", 0) or 0)
                             + int(_task_usage.get("input_tokens", 0) or 0),
                output_tokens=int(m.get("output_tokens", 0) or 0)
                              + int(_task_usage.get("output_tokens", 0) or 0),
                files=_files_written(_events),
            )
            if err_marked:
                await _notify_run_end(routine, uid, ok=False, detail=summary[:300])
                await _fire_chained_routines(routine, run_id, status="error",
                                             summary=summary,
                                             chain_depth=chain_depth)
            return

        ok_marked = await asyncio.to_thread(
            mark_run_ok, run_id,
            input_tokens=int(m.get("input_tokens", 0) or 0)
                         + int(_task_usage.get("input_tokens", 0) or 0),
            output_tokens=int(m.get("output_tokens", 0) or 0)
                          + int(_task_usage.get("output_tokens", 0) or 0),
            duration_ms=_ms(t0),
            summary=summary,
            tool_limit_reached=bool(m.get("tool_limit_reached")),
            files=_files_written(_events),
        )
        # Notif liée à la TRANSITION d'état effective : si le run n'était plus
        # 'running' (déjà réconcilié orphelin), pas de notification — le journal
        # fait foi, pas de doublon.
        if ok_marked:
            await _notify_run_end(routine, uid, ok=True, detail=summary[:300])
            await _fire_chained_routines(routine, run_id, status="ok",
                                         summary=summary,
                                         chain_depth=chain_depth)
    except asyncio.CancelledError:
        # Arrêt UTILISATEUR (flag posé par la route stop) vs shutdown/drain :
        # le premier a son statut terminal dédié « cancelled » (un « Échec »
        # rouge serait faux pour un geste délibéré), le second reste une
        # erreur d'infrastructure.
        user_stop = False
        if uid is not None and synthetic_chat_id is not None:
            try:
                from shared_infra.routes._state import is_chat_cancelled
                user_stop = is_chat_cancelled(uid, synthetic_chat_id)
            except Exception:
                pass
        try:
            if user_stop:
                # Un stop volontaire NE propage PAS l'enchaînement : arrêter A
                # ne doit pas lancer B (même logique que Jenkins « aborted »).
                await asyncio.to_thread(mark_run_cancelled, run_id,
                                        duration_ms=_ms(t0))
            else:
                await asyncio.to_thread(mark_run_error, run_id,
                                        error="annulé (shutdown / cancel)", duration_ms=_ms(t0))
        except Exception:
            pass
        raise
    except Exception as e:
        # Ceinture : une exception peut être la CONSÉQUENCE d'un stop
        # utilisateur (outil avorté par le flag coopératif, transport coupé).
        # Dans ce cas → 'cancelled', pas de notif d'échec, pas de chaîne.
        _user_stop = False
        if uid is not None and synthetic_chat_id is not None:
            try:
                from shared_infra.routes._state import is_chat_cancelled
                _user_stop = is_chat_cancelled(uid, synthetic_chat_id)
            except Exception:
                pass
        if _user_stop:
            logger.info("[ROUTINES] run %s arrêté par l'utilisateur (%s)", run_id, e)
            try:
                await asyncio.to_thread(mark_run_cancelled, run_id,
                                        duration_ms=_ms(t0))
            except Exception:
                pass
            return
        logger.warning("[ROUTINES] run %s échoué : %s", run_id, e)
        err_marked = False
        try:
            err_marked = bool(await asyncio.to_thread(
                mark_run_error, run_id,
                error=f"{type(e).__name__}: {e}", duration_ms=_ms(t0)))
        except Exception:
            pass
        # Notif d'échec UNIQUEMENT si ce chemin a réellement fait passer le run
        # 'running'→'error'. Un run déjà finalisé (ex. mark_run_ok passé puis
        # exception pendant l'émission de la notif OK au shutdown, ou run déjà
        # réconcilié orphelin) ne doit pas produire une notif « en échec »
        # contredisant le journal. Déduite défensivement du param ``routine``
        # (``uid`` peut ne pas être défini si l'exception est survenue très tôt).
        if err_marked:
            try:
                _owner = int(routine.get("owner_user_id"))
                await _notify_run_end(routine, _owner, ok=False,
                                      detail=f"{type(e).__name__}: {e}"[:300])
            except Exception:
                pass
            await _fire_chained_routines(routine, run_id, status="error",
                                         summary=f"{type(e).__name__}: {e}",
                                         chain_depth=chain_depth)
    finally:
        if hb_task is not None:
            hb_task.cancel()
        # Purge le registre ET le flag d'annulation (cf. register plus haut).
        # Garde d'identité ``task=`` : ne pop jamais l'entrée d'un run plus
        # récent qui aurait ré-utilisé la clé (impossible aujourd'hui — run_id
        # unique — mais le contrat de unregister_chat_task l'exige).
        if _reg_task is not None and uid is not None:
            try:
                from shared_infra.routes._state import unregister_chat_task
                unregister_chat_task(uid, synthetic_chat_id, _reg_task)
            except Exception:                          # noqa: BLE001
                pass


# ─────────────────────────────────────────────────────────────────────────────
#  Lancement (admission cap + création de la task)
# ─────────────────────────────────────────────────────────────────────────────
async def launch_run(routine: Dict[str, Any], *, trigger: str,
                     context: Optional[str] = None,
                     chain_depth: int = 0) -> Optional[int]:
    """Admet (cap atomique) puis lance un run. Utilisé par le scheduler (leader),
    l'endpoint « run-now », la route webhook ET l'enchaînement de routines
    (in-process sur le worker appelant).

    ``context`` : texte additionnel joint au message user du run (résumé de
    l'événement webhook / bilan de la routine amont) — en mémoire seulement,
    jamais persisté dans la routine. ``chain_depth`` : position dans un
    enchaînement (cf. CHAIN_MAX_DEPTH).

    Retourne le run_id lancé, ou None si le cap est atteint (run 'skipped'
    journalisé)."""
    uid = int(routine["owner_user_id"])
    # Garde anti-chevauchement PAR ROUTINE : ``claim_minute_fire`` n'évite que
    # le double-fire d'UNE minute. Une routine minute (``* * * * *``) dont un
    # run dépasse 60 s verrait la minute suivante lancer un 2ᵉ run EN PARALLÈLE
    # → effets de bord (mail/post/écriture) exécutés en double. La garde vit
    # dans la transaction d'admission (``overlap_fresh_after_s``) : en deux
    # transactions séparées, deux livraisons webhook simultanées sur deux
    # workers liraient toutes deux count=0 (TOCTOU) → double run.
    run_id = await asyncio.to_thread(
        admit_and_insert_run, int(routine["id"]), uid,
        trigger=trigger, cap=PER_USER_CAP, worker_boot_id=_BOOT_ID,
        overlap_fresh_after_s=ORPHAN_STALE_AFTER_S)
    if run_id is None:
        # Raison best-effort (hors transaction — n'influe que sur le libellé du
        # journal, jamais sur la décision d'admettre, elle, atomique).
        reason = "cap de runs simultanés atteint"
        try:
            _active = await asyncio.to_thread(
                count_running_for_routine, int(routine["id"]),
                fresh_after_s=ORPHAN_STALE_AFTER_S)
            if _active > 0:
                reason = "run déjà en cours pour cette routine"
        except Exception:
            pass
        try:
            await asyncio.to_thread(insert_skipped_run, int(routine["id"]), uid,
                                    trigger=trigger, reason=reason)
        except Exception:
            pass
        logger.info("[ROUTINES] SKIP routine=%s user=%s (%s)",
                    routine.get("id"), uid, reason)
        return None
    # Contexte NEUF : lancée depuis une routine amont (chaînage), la tâche
    # hériterait sinon de son exécution (parent_id) et de sa cible LLM ;
    # une routine enchaînée est indépendante.
    task = asyncio.get_running_loop().create_task(
        _execute_routine_run_mesure(routine, run_id, context=context,
                                    chain_depth=chain_depth, trigger=trigger),
        context=contextvars.Context())
    _running_tasks[run_id] = task
    task.add_done_callback(lambda t, rid=run_id: _running_tasks.pop(rid, None))
    return run_id


async def drain_running_runs(timeout: float = 10.0) -> int:
    """Annule et attend les runs encore actifs sur CE worker (appelé au shutdown).

    DOIT tourner AVANT ``shutdown_mcp_pool()`` (qui ferme le client httpx/MCP
    partagé) : annulés ici, les runs prennent le chemin ``CancelledError``
    (journal « annulé (shutdown / cancel) », PAS de notification). Sans ce
    drain, la fermeture du transport sous leurs pieds lèverait une exception
    ≠ CancelledError → ``except Exception`` → fausse notification « Routine en
    échec » persistée à CHAQUE restart / recycle de worker (gunicorn
    ``max_requests``).

    Retourne le nombre de runs annulés.

    Boucle sur snapshots : un run qui se termine pendant le drain peut encore
    lancer son AVAL (``_fire_chained_routines`` après ``mark_run_ok``) — un
    snapshot unique le manquerait, et le process mourrait avec l'aval
    'running' en base (faux « Interrompu » 5 min plus tard)."""
    total = 0
    # Monotonic : c'est le drain d'ARRÊT. Un saut d'horloge y couperait le
    # drain avant terme (runs tués en vol, aval laissé 'running' en base) ou
    # le prolongerait au-delà du délai d'arrêt systemd.
    deadline = time.monotonic() + max(0.0, float(timeout))
    while True:
        tasks = [t for t in _running_tasks.values() if not t.done()]
        if not tasks:
            return total
        for t in tasks:
            t.cancel()
        total += len(tasks)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            logger.warning("[ROUTINES] drain shutdown : %d run(s) toujours actif(s) après %.0fs",
                           len(tasks), timeout)
            return total
        _done, pending = await asyncio.wait(tasks, timeout=remaining)
        if pending:
            logger.warning("[ROUTINES] drain shutdown : %d run(s) toujours actif(s) après %.0fs",
                           len(pending), timeout)
            return total


# ─────────────────────────────────────────────────────────────────────────────
#  Boucle scheduler (leader-only)
# ─────────────────────────────────────────────────────────────────────────────
async def _llm_reachable() -> bool:
    """True si llama-server répond au /health (check léger, timeout court).

    Garde anti-spam : au boot de la VM, l'app monte souvent AVANT llama-server ;
    lancer un run voué à l'échec dans cette fenêtre produirait une notification
    « Routine en échec » à chaque redémarrage. Fail-open : si le check lui-même
    plante (import, bug), on tente le run — il journalisera l'erreur réelle."""
    try:
        from llm_core import get_llm_health
        h = await get_llm_health()
        return bool((h or {}).get("server_reachable"))
    except Exception:
        return True


async def _evaluate_due_routines(routines: List[Dict[str, Any]], now: datetime,
                                 minute_key: str) -> None:
    """Évalue les routines actives pour LA minute courante (leader only).

    Extrait de ``_routines_loop`` pour testabilité. Par routine : match cron →
    claim atomique anti double-fire → health-gate LLM (un 'skipped'
    journalisé vaut mieux qu'un run condamné + notif d'échec) → lancement."""
    from shared_infra.observability.events_bus import _cron_matches
    llm_up: Optional[bool] = None   # lazy : au plus 1 health-check par tick
    for r in routines:
        try:
            if not _cron_matches(r.get("cron_expr", ""), now):
                continue
            # Claim atomique par routine/minute (anti double-fire).
            if not await asyncio.to_thread(claim_minute_fire, int(r["id"]), minute_key):
                continue
            if llm_up is None:
                llm_up = await _llm_reachable()
            if not llm_up:
                await asyncio.to_thread(
                    insert_skipped_run, int(r["id"]), int(r["owner_user_id"]),
                    trigger="schedule", reason="LLM injoignable au déclenchement (démarrage en cours ?)")
                logger.info("[ROUTINES] SKIP routine=%s : LLM injoignable", r.get("id"))
                continue
            await launch_run(r, trigger="schedule")
        except Exception as e:
            logger.warning("[ROUTINES] évaluation routine %s échouée : %s",
                           r.get("id"), e)


async def _routines_loop() -> None:
    last_minute_key: Optional[str] = None
    tick = 0
    while True:
        try:
            # Réalignement sur la frontière de minute (+ petite marge). Ne pas
            # dormir ``TICK_SECONDS`` en tête : le temps de travail
            # s'ADDITIONNERAIT à la période → la phase glisserait, et le
            # skip-catch-up interdisant tout rattrapage, une valeur de
            # minute_key finirait par n'être JAMAIS observée (routine nocturne
            # sautée, sans log).
            await asyncio.sleep(max(1.0, TICK_SECONDS - (time.time() % TICK_SECONDS)) + 0.05)
            tick += 1
            # Watchdog : marque que la boucle est vivante (cf. scheduler_alive()).
            # Mis à jour AVANT le re-probe du lock → vrai sur chaque worker, mais
            # scheduler_alive() ne renvoie 1 que pour le leader (is_cron_leader()).
            global _last_tick
            _last_tick = time.time()
            # Re-sonde le lock CHAQUE tick → un seul leader, failover auto.
            if not try_acquire_cron_lock():
                continue
            now = datetime.now()
            minute_key = now.strftime("%Y-%m-%dT%H:%M")

            # Réconciliation orphelins : 1re prise de lead + périodiquement.
            if last_minute_key is None or (tick % RECONCILE_EVERY_TICKS == 0):
                try:
                    n = await asyncio.to_thread(reconcile_orphans, ORPHAN_STALE_AFTER_S)
                    if n:
                        logger.info("[ROUTINES] %d run(s) orphelin(s) réconcilié(s)", n)
                except Exception as e:
                    logger.warning("[ROUTINES] reconcile échoué : %s", e)

            # Skip-catch-up : on n'évalue chaque minute qu'une fois.
            if minute_key == last_minute_key:
                continue
            # Minutes JAMAIS observées (worker recyclé, machine chargée, lock
            # repris ailleurs) : le tick suivant les enjambe en silence. Une
            # routine nocturne peut donc ne jamais partir — sans mesure, sans
            # la moindre trace, le contraire d'un suivi hors heures. On mesure
            # le trou avant de l'oublier. Best-effort, jamais bloquant.
            if last_minute_key:
                try:
                    _gap = int((now - datetime.strptime(
                        last_minute_key, "%Y-%m-%dT%H:%M")).total_seconds() // 60) - 1
                    if _gap > 0:
                        # INSERT + flock du bus : hors boucle.
                        await asyncio.to_thread(
                            log_metric, "scheduler_skip", _gap,
                            {"from": last_minute_key, "to": minute_key})
                        logger.warning("[ROUTINES] %d minute(s) non évaluée(s) "
                                       "entre %s et %s", _gap, last_minute_key, minute_key)
                except Exception:
                    pass
            last_minute_key = minute_key

            try:
                routines = await asyncio.to_thread(list_enabled_routines)
            except Exception as e:
                logger.warning("[ROUTINES] list_enabled_routines échoué : %s", e)
                continue

            await _evaluate_due_routines(routines, now, minute_key)
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.warning("[ROUTINES] erreur de boucle : %s", e)


def start_routines_scheduler() -> None:
    """Démarre la boucle scheduler (idempotent par worker). Enregistrée dans
    ``_bg_tasks`` via ``_register_bg_task`` → cancel propre au shutdown."""
    global _scheduler_started
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    if _scheduler_started:
        return
    _scheduler_started = True
    from shared_infra.observability.events_bus import _register_bg_task
    _register_bg_task(loop.create_task(_routines_loop()))
    logger.info("[ROUTINES] scheduler démarré (boot_id=%s, cap/user=%d)", _BOOT_ID, PER_USER_CAP)
