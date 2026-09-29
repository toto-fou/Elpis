# SPDX-License-Identifier: MIT
"""
server.uvicorn_worker — Worker uvicorn durci pour gunicorn.

AUDIT 2026-08-02 (W1/W2) — deux défauts de la chaîne gunicorn → uvicorn
figeaient ou tuaient brutalement les workers :

1. **Recyclage ``max_requests`` : worker figé jusqu'à 600 s.**
   Sur ce chemin, uvicorn sort de ``main_loop`` SANS poser ``should_exit``
   (donc sans déclencher le drain sse-starlette), ferme la socket d'écoute,
   puis attend les requêtes en vol avec ``timeout_graceful_shutdown=None``
   → attente INFINIE tant qu'un SSE (``/api/system-events``, ouvert par
   chaque onglet) est actif. Plus de heartbeat (``callback_notify`` vit dans
   ``on_tick``) → gunicorn ne SIGABRT qu'à ``timeout=600 s``, sans spawner
   de remplaçant entre-temps : 1/N de capacité perdue ~10 min, et sous
   trafic soutenu les N workers pouvaient se figer ensemble (502 total).
   → ``CONFIG_KWARGS["timeout_graceful_shutdown"]`` borne l'attente : les
   flux restants sont annulés proprement (CancelledError → finally des
   générateurs, persistance du partiel comprise) puis le lifespan shutdown
   s'exécute et le worker sort — gunicorn en respawn un immédiatement.

2. **Aucun signal applicatif sur ce même chemin.**
   ``Server.shutdown`` est patché pour poser ``AppStatus.should_exit``
   (sse-starlette draine alors ses EventSourceResponse) AVANT la fermeture
   des connexions, avec un court délai pour laisser le watcher applicatif
   (server/app.py) ÉVACUER SILENCIEUSEMENT les flux — sentinelle de fin propre
   → reconnexion en ~1 s sur un worker sain, SANS bannière (règle « recyclage
   invisible » détaillée sous ``GRACEFUL_SHUTDOWN_S``). AUDIT 2026-08-02 (F11) :
   surtout PAS de bannière « restart » sur un simple recyclage.

AUDIT 2026-08-22 (A1/A2) — le drain devient un DRAIN APPLICATIF (« linger »).
Voir ``_announced_shutdown`` : la borne n'est plus une durée d'attente des
connexions HTTP, mais la fin RÉELLE des runs de ce worker, avec un heartbeat
maintenu pendant toute la manœuvre.

Utilisé par ``worker_class`` dans gunicorn_conf.py / gunicorn_admin_conf.py.
"""
from __future__ import annotations

import asyncio
import logging
import os

# Import TOLÉRANT : ``uvicorn.workers`` tire ``gunicorn.arbiter``, absent des
# environnements qui n'exécutent pas le serveur (une suite de tests, un
# outillage). Le drain applicatif ci-dessous est de la logique ORDINAIRE et
# doit rester importable — et donc testable — sans la pile de production.
try:
    from uvicorn.server import Server
    from uvicorn.workers import UvicornWorker
    _SERVER_STACK = True
except Exception:                                               # noqa: BLE001
    UvicornWorker = object                                      # type: ignore
    Server = None                                               # type: ignore
    _SERVER_STACK = False

logger = logging.getLogger("uvicorn.error")

# Durée maximale (s) laissée aux requêtes en vol une fois le drain applicatif
# terminé. Il ne reste alors QUE des connexions inertes (les flux infinis ont
# été évacués, les runs sont finis) : 30 s suffisent largement.
#
# RECYCLAGE INVISIBLE (demande user 2026-08-02) — le recyclage d'un worker
# ne doit produire AUCUN symptôme côté utilisateur. Déroulé :
#   1. ``Server.shutdown`` patché pose ``AppStatus.should_exit`` ;
#   2. le watcher applicatif (server/app.py) ÉVACUE les flux infinis :
#      sentinelle de fin propre sur les SSE (le client se rebranche en ~1 s
#      sur un worker sain, sans bannière), kill des PTY (le shell meurt avec
#      le worker de toute façon — fermer tôt = le client rouvre un shell neuf
#      sur un worker sain, avec le séparateur) ;
#   3. la socket d'écoute ferme → les NOUVELLES requêtes vont aux autres
#      workers : le drain long est INVISIBLE ;
#   4. il ne reste que le travail LONG (générations LLM, routines, rejeux de
#      scénario) : on le laisse aller AU BOUT (cf. DRAIN_MAX_S).
GRACEFUL_SHUTDOWN_S = 30

# ── Drain applicatif (« linger ») ───────────────────────────────────────────
#
# AUDIT 2026-08-22 (A1) — l'ancien drain de 300 s ANNULAIT les runs longs :
# un reload admin (ou un recyclage) tombé pendant une mission de six heures la
# tuait au bout de cinq minutes, partiel + « Continuer » en pleine autonomie.
# Deux faits vérifiés dans les paquets installés (gunicorn 26, uvicorn 0.47)
# expliquent pourquoi il fallait reprendre la mécanique de zéro :
#
#   • ``Server.notify`` ne part que depuis ``on_tick``, appelé UNIQUEMENT par
#     ``main_loop`` — qui rend la main dès que ``should_exit`` est posé. Pendant
#     TOUT le shutdown, le worker ne bat donc plus, et ``murder_workers``
#     (gunicorn ``timeout`` = 600 s) finit par le SIGABRT en plein drain :
#     partiel non persisté, subprocess MCP orphelins.
#   • ``graceful_timeout`` n'est lu QUE par ``Arbiter.stop()``. Le chemin
#     reload (SIGHUP — c'est celui du bouton « Redémarrer » de la console)
#     passe par ``reload()`` → ``manage_workers()`` → SIGTERM, SANS aucune
#     borne. Un ancien worker qui continue de battre peut donc vivre aussi
#     longtemps qu'il le faut : gunicorn ne le retue pas.
#
# On tient donc le heartbeat pendant le drain (``_heartbeat_during_drain``) et
# on attend la fin NATURELLE des runs (``_state.active_run_count``). Contrepartie
# assumée : l'ancien worker garde sa RAM tant qu'il finit ses runs — d'où le
# plafond, réglable par l'exploitant.
# ⚠ Ce linger ne s'applique QU'AUX chemins gracieux (reload SIGHUP, recyclage).
# Un ARRÊT franc du service (``Arbiter.stop()`` : systemctl stop, Ctrl-C) reste
# borné par ``graceful_timeout`` puis SIGKILL — c'est le comportement voulu :
# on ne fait pas attendre douze heures un opérateur qui arrête le service.
DRAIN_MAX_S = max(0, int(os.environ.get("APP_DRAIN_MAX_S", str(12 * 3600))))
# Période du heartbeat pendant le drain. gunicorn tue à ``timeout`` (600 s par
# défaut) sans nouvelle du worker : 30 s laissent 20 battements de marge.
DRAIN_HEARTBEAT_S = 30.0
# Période de la journalisation « il reste N run(s) » pendant le drain.
DRAIN_LOG_EVERY_S = 60.0


if _SERVER_STACK:
    class ElpisUvicornWorker(UvicornWorker):
        CONFIG_KWARGS = {
            **UvicornWorker.CONFIG_KWARGS,
            "timeout_graceful_shutdown": GRACEFUL_SHUTDOWN_S,
        }


def _active_run_count() -> int:
    """Runs longs encore en vol sur CE worker (0 si l'app n'est pas chargée)."""
    try:
        from shared_infra.routes._state import active_run_count
        return int(active_run_count())
    except Exception:                                           # noqa: BLE001
        return 0


async def _heartbeat_during_drain(server: "Server") -> None:
    """Bat le cœur gunicorn tant que le drain dure.

    ``callback_notify`` est le pont vers ``Worker.notify()`` (écriture du
    fichier temporaire que ``murder_workers`` inspecte). Il n'est appelé que
    par ``on_tick``, qui ne tourne plus une fois ``should_exit`` posé — sans
    cette tâche, le worker cesse de battre à la seconde où le drain commence.
    """
    cb = getattr(server.config, "callback_notify", None)
    if cb is None:
        return
    while True:
        try:
            await cb()
        except Exception:                                       # noqa: BLE001
            pass
        try:
            await asyncio.sleep(DRAIN_HEARTBEAT_S)
        except asyncio.CancelledError:
            raise


async def _await_runs_finished() -> None:
    """Attend la fin naturelle des runs de ce worker (borné par DRAIN_MAX_S)."""
    n = _active_run_count()
    if not n:
        return
    logger.info(
        "[DRAIN] %d run(s) en cours — ce worker reste en vie jusqu'à leur fin "
        "(plafond %d s, APP_DRAIN_MAX_S)", n, DRAIN_MAX_S)
    loop = asyncio.get_running_loop()
    started = loop.time()
    last_log = started
    while True:
        n = _active_run_count()
        if n <= 0:
            logger.info("[DRAIN] tous les runs sont terminés (%.0f s) — sortie "
                        "du worker", loop.time() - started)
            return
        elapsed = loop.time() - started
        if DRAIN_MAX_S and elapsed >= DRAIN_MAX_S:
            logger.warning(
                "[DRAIN] plafond de %d s atteint avec %d run(s) encore actif(s) "
                "— annulation propre (partiel persisté + « Continuer »)",
                DRAIN_MAX_S, n)
            return
        if loop.time() - last_log >= DRAIN_LOG_EVERY_S:
            last_log = loop.time()
            logger.info("[DRAIN] %d run(s) encore en cours (%.0f s écoulées)",
                        n, elapsed)
        await asyncio.sleep(1.0)


# ── Patch : annoncer le shutdown à l'app AVANT de couper ────────────────
# Idempotent au niveau module (chaque worker importe ce module une fois).
_orig_shutdown = Server.shutdown if _SERVER_STACK else None


async def _announced_shutdown(self, sockets=None):
    """Drain applicatif puis shutdown uvicorn normal.

    Ordre (chaque étape justifiée dans l'en-tête du module) :
      1. poser ``AppStatus.should_exit`` → le watcher de server/app.py évacue
         les flux infinis (SSE, PTY) vers les workers sains ;
      2. FERMER LES SOCKETS D'ÉCOUTE tout de suite : pendant tout le drain,
         les nouvelles requêtes doivent aller aux workers neufs — c'est ce qui
         rend un drain de plusieurs heures invisible ;
      3. tenir le heartbeat gunicorn (sinon SIGABRT à ``timeout``) ;
      4. attendre la fin RÉELLE des runs (plafond ``DRAIN_MAX_S``) ;
      5. shutdown uvicorn standard (connexions restantes, lifespan).
    """
    try:
        from sse_starlette.sse import AppStatus
        already = AppStatus.should_exit
        AppStatus.should_exit = True
    except Exception:
        already = True

    # (2) Couper l'entrée AVANT le drain. ``Server.shutdown`` le refait plus
    # bas — ``close()`` est idempotent sur un serveur asyncio déjà fermé.
    for _srv in list(getattr(self, "servers", []) or []):
        try:
            _srv.close()
        except Exception:                                       # noqa: BLE001
            pass

    if not already:
        # Chemin max_requests (aucun signal reçu) : laisser un battement au
        # watcher applicatif (server/app.py) pour ÉVACUER les flux infinis
        # (sentinelles SSE + kill PTY) avant d'entamer le drain.
        try:
            await asyncio.sleep(0.5)
        except Exception:
            pass

    # (3)+(4) Heartbeat maintenu pendant toute l'attente des runs.
    _hb = None
    try:
        _hb = asyncio.ensure_future(_heartbeat_during_drain(self))
    except Exception:                                           # noqa: BLE001
        _hb = None
    try:
        await _await_runs_finished()
    except asyncio.CancelledError:
        raise
    except Exception:                                           # noqa: BLE001
        logger.warning("[DRAIN] attente des runs interrompue", exc_info=True)
    finally:
        if _hb is not None and not _hb.done():
            _hb.cancel()
            # ``asyncio.wait`` (et non ``await _hb``) : il ne relève pas
            # l'exception de la tâche attendue, donc le CancelledError qu'on
            # vient de provoquer ne peut pas être confondu avec une annulation
            # de CE shutdown — qui, elle, doit continuer de se propager.
            await asyncio.wait({_hb}, timeout=5)

    await _orig_shutdown(self, sockets=sockets)


if _SERVER_STACK:
    Server.shutdown = _announced_shutdown
