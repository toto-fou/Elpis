# SPDX-License-Identifier: MIT
"""
backend/cron_lock.py — Verrou fichier pour le scheduler cron.

En multi-worker, chaque processus tente de lancer le cron.
Ce module garantit qu'un seul worker à la fois détient le verrou
et exécute le scheduler. Les autres ignorent silencieusement.

Le verrou est automatiquement libéré si le processus meurt
(propriété des file locks POSIX).

BUG FIX C1 — robustesse du pattern lockfile :
─────────────────────────────────────────────────────────────
Avant cette passe :
  • mode "w" → truncate du fichier au moment de l'open, AVANT
    le flock. Si un autre worker détenait déjà le lock et
    avait écrit son PID dedans, ce PID était écrasé par le
    challenger qui finissait par échouer → fichier vide.
  • release_cron_lock() faisait unlink() après release. Pattern
    TOCTOU classique : entre le moment où le worker A a unlink
    le fichier et le moment où le worker B fait `open(..., "w")`,
    si un worker C arrive entre temps il ouvre un fichier différent
    (inode différent) et peut acquérir un flock orthogonal au B.
    Résultat possible (rarissime mais réel) : 2 leaders simultanés.

Pattern correct :
  • mode "a" (append) → ne truncate pas, donc le PID du leader
    courant reste lisible pour debug.
  • Pas d'unlink au release : le fichier reste, son flock se
    libère naturellement à la fermeture du fd. Tous les workers
    qui retentent acquièrent ou non sur le MÊME inode.
"""
import fcntl
import logging
import os

logger = logging.getLogger("uvicorn.error")

# Racine commune (cf. shared_infra.runtime.runtime_dir) ; ``CRON_LOCK_PATH`` reste
# prioritaire pour les déploiements qui la posent.
from shared_infra.runtime.runtime_dir import runtime_path as _runtime_path  # noqa: E402

_LOCK_PATH = _runtime_path("cron.lock", "CRON_LOCK_PATH",
                           "/tmp/.elpis_cron.lock")

_lock_fd = None
_acquired = False


def _is_draining() -> bool:
    """True si ce worker entame son arrêt/recyclage (``AppStatus.should_exit``).

    AUDIT 2026-08-02 (M3) — un worker en drain (recyclage max_requests /
    shutdown) ne doit NI prendre NI garder le leadership cron : sinon il claime
    une minute puis se fait annuler au lifespan-shutdown (occurrence PERDUE via
    skip-catch-up), et son maintien du verrou pendant tout le drain (jusqu'à
    300 s) empêche un worker sain de reprendre. Refuser ici fait basculer le
    leadership au prochain tick d'un autre worker → la routine part chez lui.
    """
    try:
        from sse_starlette.sse import AppStatus
        return bool(AppStatus.should_exit)
    except Exception:
        return False


def try_acquire_cron_lock() -> bool:
    """Tente d'acquérir le verrou cron (non-bloquant).

    Retourne True si ce worker est le leader cron.
    Retourne False si un autre worker détient déjà le verrou.
    """
    global _lock_fd, _acquired
    if _is_draining():
        # AUDIT 2026-08-02 (M3) — en drain : relâcher un lock éventuellement tenu
        # et refuser le leadership (re-sondé à chaque tick par les schedulers).
        if _acquired:
            release_cron_lock()
        return False
    if _acquired:
        return True
    fd = None
    try:
        # Mode "a" : append au lieu de "w" (truncate). Le contenu existant
        # — typiquement le PID du leader actuel — reste lisible pour debug.
        # Si on devient leader on écrit notre PID en append (pas idéal mais
        # acceptable, le fichier reste petit).
        fd = open(_LOCK_PATH, "a")  # noqa: SIM115 (verrou de leader tenu)
        fcntl.flock(fd.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        # Maintenant qu'on détient le lock, on peut truncate proprement et
        # écrire NOTRE PID. Sécurité : on truncate APRÈS le flock, donc
        # personne ne peut être en train de lire à mi-écriture.
        try:
            fd.seek(0)
            fd.truncate()
            fd.write(str(os.getpid()))
            fd.flush()
        except OSError:
            # Truncate/write failure n'invalide pas le lock — on continue.
            pass
        _lock_fd = fd
        _acquired = True
        logger.info(f"[CRON] Ce worker (PID {os.getpid()}) est le leader cron.")
        return True
    except (BlockingIOError, OSError):
        # Quelqu'un d'autre détient le lock OU erreur d'ouverture (perms).
        # Cleanup propre du fd qu'on n'utilisera pas.
        if fd is not None:
            try: fd.close()
            except OSError: pass
        return False


def is_cron_leader() -> bool:
    """Read-only : ce worker détient-il actuellement le verrou leader ?

    Ne tente PAS d'acquérir (contrairement à ``try_acquire_cron_lock``) — sûr
    à appeler depuis n'importe quel contexte (ex. le sampler de métriques) sans
    effet de bord sur l'élection de leader."""
    return _acquired


def release_cron_lock():
    """Libère le verrou (appelé au shutdown).

    On ne fait PAS unlink — le fichier doit rester pour préserver
    l'inode unique vu par tous les workers. Le flock se libère
    automatiquement quand le fd est fermé (POSIX).
    """
    global _lock_fd, _acquired
    if _lock_fd is not None:
        try:
            fcntl.flock(_lock_fd.fileno(), fcntl.LOCK_UN)
        except OSError:
            pass
        try:
            _lock_fd.close()
        except OSError:
            pass
        _lock_fd = None
    _acquired = False
    # IMPORTANT : pas d'unlink. Le fichier persiste sur disque pour
    # garantir que tous les workers (ce processus en cas de redémarrage,
    # ou les workers concurrents en multi-worker) voient le même inode
    # quand ils tentent d'acquire. Le contenu (PID) sera écrasé par le
    # prochain leader.

