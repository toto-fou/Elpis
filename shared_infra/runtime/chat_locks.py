# SPDX-License-Identifier: MIT
"""shared_infra.runtime.chat_locks — présence d'activité par chat, VISIBLE DE TOUS LES
WORKERS.

Pourquoi ce module
------------------
``_active_chat_tasks`` (génération en cours) et ``_manual_compressions``
(compaction manuelle en vol) sont des structures **module-level**, donc PAR
PROCESS. Or l'app tourne sous gunicorn avec plusieurs workers et
``reuse_port`` (``server/gunicorn_conf.py`` : ``workers = cpu-1`` dès 3 vCPU)
et le noyau distribue les requêtes **sans aucune affinité** — exactement le
constat qui a motivé ``shared_infra/cancel_bus``.

Conséquence AVANT ce module : les garde-fous 409 ``generation_running`` /
``compression_running`` étaient borgnes. Un ``/compact`` lancé pendant une
génération hébergée par un AUTRE worker passait au lieu d'être refusé ; la
concurrence optimiste (``expected_updated_at``) empêchait bien la perte de
données, mais au prix du tour de l'utilisateur : le stream se terminait sur un
conflit et n'était PAS persisté. Le pré-vol existe précisément pour éviter ça.

Fonctionnement
--------------
Un fichier vide par (kind, user, chat) dans ``/tmp``, verrouillé en
``flock(LOCK_EX | LOCK_NB)`` pour toute la durée de l'activité :

  * ``acquire`` rend un fd (verrou pris ici) ou ``None`` (déjà tenu ailleurs) ;
  * ``release`` ferme le fd — le noyau libère ;
  * ``is_held`` sonde sans effet de bord.

``flock`` porte sur l'**open file description**, pas sur le process : la sonde
voit donc aussi bien le verrou d'un autre worker que celui de ce process-ci
(vérifié). Et surtout, un worker qui MEURT libère automatiquement — pas de
verrou fantôme à réconcilier, contrairement à un marqueur posé en base.

Modes de défaillance
--------------------
  * ``/tmp`` plein/non inscriptible → ``acquire`` rend ``None`` et ``is_held``
    rend ``False`` : on retombe exactement sur le comportement per-worker
    d'avant ce module (fail-open — un garde-fou de confort ne doit jamais
    empêcher un chat de fonctionner).
  * fichiers résiduels : purge opportuniste des entrées périmées ET non
    tenues (jamais celles d'un verrou vivant), au-delà d'un seuil de volume.
"""
from __future__ import annotations

import fcntl
import hashlib
import logging
import os
import re
import time
from pathlib import Path
from typing import Optional

logger = logging.getLogger("uvicorn.error")

# Racine commune aux canaux inter-process (cf. shared_infra.runtime.runtime_dir) ;
# ``ELPIS_CHAT_LOCK_DIR`` reste prioritaire pour les déploiements qui la posent.
from shared_infra.runtime.runtime_dir import runtime_path as _runtime_path  # noqa: E402

LOCK_DIR = _runtime_path("chat_locks", "ELPIS_CHAT_LOCK_DIR",
                         "/tmp/elpis_chat_locks")

# Purge : au-delà de ce nombre d'entrées, on retire celles périmées ET libres.
_PRUNE_WHEN_OVER = 200
_STALE_AFTER_S = 24 * 3600

_KIND_RE = re.compile(r"[^a-z0-9_]")


def _key_path(kind: str, user_id: int, chat_id: Optional[str]) -> Path:
    """Chemin du fichier-verrou. Le couple (user, chat) est HACHÉ : un chat_id
    est une donnée client (longueur et charset arbitraires) — hors de question
    de la laisser construire un nom de fichier."""
    safe_kind = _KIND_RE.sub("_", str(kind).lower())[:16] or "lock"
    cid = str(chat_id) if chat_id else "__none__"
    h = hashlib.sha256(f"{int(user_id)}\x00{cid}".encode("utf-8")).hexdigest()[:24]
    # AUDIT 2026-08-22 (D4) — l'identifiant d'utilisateur figure EN CLAIR dans
    # le nom (c'est un entier, sans danger pour un nom de fichier) alors que le
    # chat reste haché. Sans lui, le dossier ne se balaye que globalement : on
    # pouvait compter les générations en cours, jamais celles d'un utilisateur
    # donné — donc aucun moyen de plafonner ce qu'UN compte peut lancer.
    return LOCK_DIR / f"{safe_kind}-u{int(user_id)}-{h}.lock"


def _ensure_dir() -> bool:
    try:
        LOCK_DIR.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        logger.warning("[chat_locks] %s inutilisable (%r) — garde per-worker seule",
                       LOCK_DIR, exc)
        return False
    try:
        os.chmod(LOCK_DIR, 0o700)
    except OSError:
        pass          # dossier préexistant d'un autre propriétaire : sans effet ici
    return True


# AUDIT moteur d'événements 2026-09-25 (B1) — ``is_held`` sonde en PRENANT le
# flock quelques microsecondes. Un ``acquire`` qui tombait pile pendant une
# sonde (le suivi /run/events en fait une toutes les ~150 ms par onglet) se
# croyait devant un verrou tenu ; la suite (« is_held ? non → verrouillage
# indisponible ») concluait au fail-open et lançait le run SANS verrou. Une
# sonde relâche en microsecondes : quelques reprises espacées de 2 ms suffisent
# à la distinguer d'un vrai détenteur, qui tient pendant tout un run.
_PROBE_RETRIES = 3
_PROBE_RETRY_S = 0.002


def _flock_nb_patient(fd: int) -> bool:
    for i in range(_PROBE_RETRIES + 1):
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except OSError:
            if i < _PROBE_RETRIES:
                time.sleep(_PROBE_RETRY_S)
    return False


def lock_dir_usable() -> bool:
    """Le verrouillage cross-worker fonctionne-t-il ?

    C'est LA question du fail-open. Un ``acquire`` qui rend ``None`` signifie
    « tenu » OU « indisponible » ; les départager avec ``is_held`` était faux
    (le détenteur peut relâcher entre les deux appels, ou une sonde peut
    occuper le verrou) — seul l'état du dossier dit si la garde existe."""
    return _ensure_dir() and os.access(str(LOCK_DIR), os.W_OK | os.X_OK)


def acquire(kind: str, user_id: int, chat_id: Optional[str]) -> Optional[int]:
    """Prend le verrou pour (kind, user, chat).

    Retourne le fd à conserver jusqu'à ``release``, ou ``None`` si le verrou
    est DÉJÀ tenu (ici ou dans un autre worker) — ou si ``/tmp`` est
    inutilisable (fail-open : l'appelant continue sans garde cross-worker).
    """
    if not _ensure_dir():
        return None
    path = _key_path(kind, user_id, chat_id)
    # AUDIT 2026-08-02 (M2) — anti-race avec le balayeur de maintenance et
    # ``_maybe_prune`` : entre notre ``os.open`` et notre ``flock``, un sweep a
    # pu unlink ce chemin puis un autre acquéreur le recréer sur un NOUVEL
    # inode. Notre fd tiendrait alors l'inode ORPHELIN tout en croyant détenir
    # le verrou → deux détenteurs du même verrou logique (exclusion rompue).
    # On revérifie donc que l'inode tenu est bien celui du chemin ; sinon on
    # relâche et on reboucle (borné). Estampille ``utime`` : voir plus bas.
    for _ in range(6):
        try:
            fd = os.open(str(path), os.O_RDWR | os.O_CREAT, 0o600)
        except OSError as exc:
            logger.warning("[chat_locks] open %s échoué (%r)", path, exc)
            return None
        if not _flock_nb_patient(fd):
            os.close(fd)
            return None                   # verrou DÉJÀ tenu (ici ou ailleurs)
        try:
            same = os.fstat(fd).st_ino == os.stat(str(path)).st_ino
        except OSError:
            same = False                  # chemin disparu sous nos pieds
        if same:
            # mtime = usage RÉEL : ``flock`` ne touche pas mtime, donc sans ceci
            # un verrou créé il y a > 24 h mais pris quotidiennement resterait
            # « périmé » aux yeux du sweep. On l'estampille à chaque prise (on
            # tient le flock : aucun sweep conforme ne peut unlink entre-temps).
            try:
                os.utime(str(path), None)
            except OSError:
                pass
            _maybe_prune()
            return fd
        os.close(fd)                      # inode orphelin/recréé → on reboucle
    return None


def release(fd: Optional[int]) -> None:
    """Libère un verrou pris par ``acquire``. Tolère ``None`` (fail-open)."""
    if fd is None:
        return
    try:
        fcntl.flock(fd, fcntl.LOCK_UN)
    except OSError:
        pass
    try:
        os.close(fd)
    except OSError:
        pass


def is_held(kind: str, user_id: int, chat_id: Optional[str]) -> bool:
    """Le verrou est-il tenu — par CE worker ou par un autre ?

    Sonde non destructive : si on parvient à le prendre, c'est que personne ne
    le tenait ; on le relâche immédiatement et on répond ``False``.
    """
    path = _key_path(kind, user_id, chat_id)
    try:
        fd = os.open(str(path), os.O_RDWR)
    except OSError:
        return False                      # pas de fichier → personne ne tient
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(fd)
        return True                       # tenu (ici ou ailleurs)
    release(fd)
    return False


def count_held(kind: str, user_id: Optional[int] = None) -> int:
    """Nombre de verrous ``kind`` actuellement TENUS, tous workers confondus.

    Sonde non destructive, même principe que ``is_held`` mais sans connaître
    les clés : on balaye le dossier et on compte les fichiers qu'on n'arrive
    pas à verrouiller. Sert aux gardes d'exploitation — savoir combien de
    générations tournent AVANT de redémarrer les workers (audit long-run
    2026-08-21 : un reload gracieux annule les runs en cours au bout du drain
    de 300 s, et rien ne le disait à l'opérateur).

    ``user_id`` (audit 2026-08-22, D4) : restreint le compte à UN utilisateur —
    c'est ce qui permet de plafonner le nombre de générations simultanées d'un
    même compte sans rien partager entre workers.

    Best-effort : ``0`` si le dossier est inutilisable.
    """
    safe_kind = _KIND_RE.sub("_", str(kind).lower())[:16] or "lock"
    pattern = (f"{safe_kind}-u{int(user_id)}-*.lock" if user_id is not None
               else f"{safe_kind}-*.lock")
    try:
        entries = list(LOCK_DIR.glob(pattern))
    except OSError:
        return 0
    n = 0
    for path in entries:
        try:
            fd = os.open(str(path), os.O_RDWR)
        except OSError:
            continue
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            n += 1                        # tenu (ici ou ailleurs)
            try:
                os.close(fd)
            except OSError:
                pass
            continue
        release(fd)
    return n


async def acquire_async(kind: str, user_id: int, chat_id: Optional[str]) -> Optional[int]:
    """``acquire`` hors de la boucle asyncio (AUDIT 2026-09-26) : ses reprises
    patientes (``_flock_nb_patient``, jusqu'à 3 × 2 ms de ``time.sleep``)
    et l'``utime``/élagage gelaient le worker entier — jusqu'à 60 fois de
    suite pendant l'attente d'une passation. Même sémantique, B1 compris."""
    import asyncio
    return await asyncio.to_thread(acquire, kind, user_id, chat_id)


async def count_held_async(kind: str, user_id: Optional[int] = None) -> int:
    """``count_held`` hors de la boucle : ``glob`` + un ``open``/``flock`` par
    verrou du compte, à CHAQUE requête de flux (plafond de runs)."""
    import asyncio
    return await asyncio.to_thread(count_held, kind, user_id)


_last_prune_check = 0.0
_PRUNE_MIN_INTERVAL_S = 30.0


def _maybe_prune(now: Optional[float] = None) -> None:
    """Retire les fichiers périmés ET LIBRES quand le dossier grossit.

    On ne supprime QUE ce qu'on arrive à verrouiller : unlink d'un fichier
    encore tenu ferait repartir le prochain ``acquire`` sur un nouvel inode →
    deux détenteurs simultanés, l'exclusion mutuelle serait rompue.

    AUDIT 2026-09-01 (passe 5, B17) — le ``iterdir()`` complet était payé à
    CHAQUE acquire (démarrage de chaque génération/compaction), y compris
    quand il n'y avait rien à purger. Throttle temporel : au plus un readdir
    toutes les ``_PRUNE_MIN_INTERVAL_S`` par process.
    """
    # ``now`` EXPLICITE = appel délibéré (tests, maintenance) → jamais
    # throttlé ; seul le chemin chaud (acquire, sans argument) l'est.
    global _last_prune_check
    if now is None:
        _wall = time.time()
        if _wall - _last_prune_check < _PRUNE_MIN_INTERVAL_S:
            return
        _last_prune_check = _wall
    try:
        entries = list(LOCK_DIR.iterdir())
    except OSError:
        return
    if len(entries) <= _PRUNE_WHEN_OVER:
        return
    now = now if now is not None else time.time()
    for p in entries:
        try:
            if now - p.stat().st_mtime < _STALE_AFTER_S:
                continue
            fd = os.open(str(p), os.O_RDWR)
        except OSError:
            continue
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            os.close(fd)
            continue                      # verrou vivant → on n'y touche pas
        try:
            # AUDIT 2026-08-02 (M2) — sous le flock, revérifier : (a) le fichier
            # n'a pas été ré-estampillé « frais » par un acquire entre notre
            # stat initial et notre flock ; (b) l'inode tenu est toujours celui
            # du chemin. Sinon on n'unlink pas (un acquire repartirait sinon sur
            # un nouvel inode → double détenteur).
            st = p.stat()
            if now - st.st_mtime >= _STALE_AFTER_S and os.fstat(fd).st_ino == st.st_ino:
                p.unlink()
        except OSError:
            pass
        release(fd)


__all__ = ["LOCK_DIR", "acquire", "release", "is_held"]
