# SPDX-License-Identifier: MIT
"""
backend.routes.sandbox_snapshots — Per-user sandbox snapshot/restore.

Use case
--------
Quand le modèle (LLM) écrit ou modifie des fichiers via les outils
``write_file`` / ``edit_file`` / shell, l'utilisateur peut vouloir
revenir à un état précédent connu pour bon. Ce module ajoute un
mécanisme de snapshot complet de la sandbox par utilisateur,
exposé dans l'éditeur via un bouton dédié.

Endpoints (4)
-------------
- ``POST   /api/sandbox/snapshots/create``         — crée une snapshot,
   réponse en flux NDJSON avec progression réelle (1 event JSON par
   ligne ; même format de stream que ``/api/chat``).
- ``GET    /api/sandbox/snapshots``                — liste les snapshots
   de l'utilisateur courant (newest-first).
- ``POST   /api/sandbox/snapshots/{snap_id}/restore`` — restore, réponse
   en flux NDJSON avec progression réelle.
- ``DELETE /api/sandbox/snapshots/{snap_id}``      — supprime une snapshot.

Storage layout
--------------
::

    user_sandboxes/
        _snapshots/
            <safe_username>/
                <snap_id>.tar.gz       # archive gzippée
                <snap_id>.json         # métadonnées (id, name, ts, size,
                                       # file_count, src_bytes)

``snap_id`` est un UUID4 hex (32 caractères ``[0-9a-f]``) ; toute autre
forme est rejetée pour bloquer le path traversal.

Concurrence
-----------
Un ``asyncio.Lock`` par utilisateur est gardé pour tout le cycle
create/restore. Un user qui clique deux fois sur "Créer" ne déclenche
pas deux snapshots concurrentes ; le 2e appel reçoit ``409`` immédiat.

Rétention
---------
``MAX_SNAPSHOTS_PER_USER`` (10 par défaut) — quand on dépasse, la plus
ancienne est supprimée après une création réussie.

Sécurité
--------
- Tous les chemins sont resolve()-és et vérifiés sous le sandbox root.
- Les membres d'archive lus via ``tarfile.extract`` sont filtrés pour
  rejeter les chemins absolus, les ``..``, les liens, les devices.
  (CVE-style protection contre les "tar slip".)
- Les snapshots sont stockées HORS du dossier sandbox de l'utilisateur
  pour ne pas se snapshoter elles-mêmes ni être listées dans le tree.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import tarfile
import tempfile
import time
import uuid
from pathlib import Path
from typing import AsyncGenerator, Dict, List, Optional, Tuple

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

from shared_infra.accounts.users import get_username_by_id
from shared_infra.config import SANDBOX_DIR, read_config_json
from shared_infra.routes._state import router
from shared_infra.sandbox.paths import SandboxPathError, open_beneath, widen_beneath
from shared_infra.security.deps import require_user_id


# ── Réutilisation du helper de path sandbox défini dans _legacy.
#
#    Important : on importe via ``backend.routes._legacy`` (i.e. le
#    SOUS-MODULE), PAS via ``backend.routes`` puis ``._legacy``. Le
#    package ``backend.routes`` réexporte tous les symboles publics
#    de ses submodules dans son propre namespace via une boucle
#    ``for _name in dir(_mod): globals()[_name] = …`` ; si on définissait
#    un helper local nommé ``_legacy`` (ou tout autre symbole partagé),
#    il écraserait la référence au submodule, et ``backend.routes._legacy``
#    pointerait soudain sur notre fonction au lieu du module.
#
#    On utilise donc un import différé qui passe par ``sys.modules``
#    (clef ``"backend.routes._legacy"``) et qui est insensible à ce
#    shadowing du namespace de package.
def _resolve_sandbox_root(user_id):
    # Snapshots capture/restore ONLY the WORK root (``P/work`` = ``/work``).
    # Using ``P`` would bundle — and on restore ``rmtree`` — the protected
    # ``skills``/``.memory`` siblings that live outside the mount.
    from shared_infra.routes._legacy import _get_work_path
    return _get_work_path(user_id)


# ─────────────────────────────────────────────────────────────────────
#  Constantes
# ─────────────────────────────────────────────────────────────────────
MAX_SNAPSHOTS_PER_USER_DEFAULT = 10
SNAPSHOTS_ROOT = (SANDBOX_DIR / "_snapshots").resolve()
SNAPSHOTS_ROOT.mkdir(parents=True, exist_ok=True)

# Throttling des events SSE — évite de spammer 5000 lignes pour 5000 fichiers.
PROGRESS_MIN_INTERVAL_SEC = 0.080   # au moins 80 ms entre 2 events
PROGRESS_MIN_PCT_DELTA    = 1.0     # OU au moins 1 % de variation

# Snap_id format : UUID4 hex (32 [0-9a-f]). Validation stricte = pas de
# path traversal possible via le paramètre d'URL.
_SNAP_ID_RE = re.compile(r"^[0-9a-f]{32}$")

# Nom optionnel donné par l'user — borné, sanitizé pour affichage.
# (Stocké dans le JSON de méta, jamais utilisé comme chemin.)
_NAME_MAX_LEN = 80

# AUDIT 2026-06 — caps anti zip-bomb à la restauration. Une archive (gzip)
# peut annoncer des membres de taille démesurée pour un coût disque minime :
# sans cap, l'extraction remplit le disque hôte. Env-overridable.
#   - par membre : un fichier de sandbox légitime > 1 Go est improbable
#   - total      : vérifié AVANT la phase 'clearing' (on ne vide JAMAIS la
#     sandbox pour échouer ensuite sur une archive abusive)
_MAX_MEMBER_BYTES = int(os.environ.get("SNAPSHOT_MAX_MEMBER_MB", "1024")) * 1024 * 1024
_MAX_TOTAL_BYTES  = int(os.environ.get("SNAPSHOT_MAX_TOTAL_GB", "8")) * 1024 * 1024 * 1024


# ─────────────────────────────────────────────────────────────────────
#  Verrous par utilisateur
# ─────────────────────────────────────────────────────────────────────
# Dict user_id → asyncio.Lock. Empêche deux snapshots OU un
# snapshot + un restore concurrents pour le même user — sinon on
# corromprait l'archive ou on extraierait par-dessus une création
# en cours.
# ⚠ Per-PROCESS : la garde cross-worker est assurée par le flock
# ``chat_locks`` (kind="snapshot") pris dans les deux streams —
# audit 2026-08-02 (W6).
_user_locks: Dict[int, asyncio.Lock] = {}

# Marqueur d'incomplétude de restore (W6) : présent dans la racine sandbox
# entre le vidage et la fin d'extraction ; s'il survit, le restore a été
# interrompu (worker tué) et /work est partiel.
_RESTORE_MARKER_NAME = ".elpis_restore_incomplete"


def _restore_marker(root: Path) -> Path:
    """Marqueur de restauration interrompue."""
    return root / _RESTORE_MARKER_NAME


def _get_user_lock(user_id: int) -> asyncio.Lock:
    """Lock paresseusement créé par utilisateur."""
    lk = _user_locks.get(user_id)
    if lk is None:
        lk = asyncio.Lock()
        _user_locks[user_id] = lk
    return lk


# ─────────────────────────────────────────────────────────────────────
#  Helpers chemins
# ─────────────────────────────────────────────────────────────────────
def _safe_username(user_id: int) -> str:
    """Mêmes règles que ``_legacy._get_sandbox_path`` : on garde alphanum,
    tiret, underscore. Évite tout caractère sensible au shell ou au
    parsing de chemin."""
    raw = get_username_by_id(user_id) or f"user_{user_id}"
    return "".join(c for c in raw if c.isalnum() or c in ("-", "_")) or f"user_{user_id}"


def _user_snap_dir(user_id: int) -> Path:
    """Dossier de snapshots de l'utilisateur. Créé à la demande."""
    p = (SNAPSHOTS_ROOT / _safe_username(user_id)).resolve()
    # Garde-fou : doit rester sous SNAPSHOTS_ROOT (sécurité défensive
    # même si _safe_username l'assure déjà).
    # Containment robuste via relative_to (PAS startswith, vulnérable au préfixe
    # frère : /snap/al vs /snap/alice) ; les deux côtés sont resolve()'d.
    try:
        p.relative_to(SNAPSHOTS_ROOT.resolve())
    except ValueError:
        raise HTTPException(403, "Snapshot path escape")
    p.mkdir(parents=True, exist_ok=True)
    return p


def _archive_path(user_id: int, snap_id: str) -> Path:
    if not _SNAP_ID_RE.match(snap_id):
        raise HTTPException(400, "Invalid snapshot id")
    return _user_snap_dir(user_id) / f"{snap_id}.tar.gz"


def _meta_path(user_id: int, snap_id: str) -> Path:
    if not _SNAP_ID_RE.match(snap_id):
        raise HTTPException(400, "Invalid snapshot id")
    return _user_snap_dir(user_id) / f"{snap_id}.json"


def _sandbox_root_for(user_id: int) -> Path:
    """Retourne la racine de la sandbox personnelle. Délègue à _legacy
    pour rester aligné avec le reste de l'app (mêmes conventions de
    nommage, mêmes droits)."""
    return _resolve_sandbox_root(user_id)


# ─────────────────────────────────────────────────────────────────────
#  Énumération + métadonnées
# ─────────────────────────────────────────────────────────────────────
def _walk_sandbox(root: Path) -> Tuple[List[Tuple[Path, str, int]], int]:
    """Liste tous les fichiers réguliers sous ``root``.

    Renvoie ``(entries, total_bytes)`` où ``entries`` est une liste de
    tuples ``(path_absolu, path_relatif_posix, size)``.

    On ignore les liens symboliques (``is_symlink()``) — sur le
    déploiement courant la sandbox ne devrait pas en contenir, mais si
    un user en crée un, on ne veut pas le suivre (boucle, ou sortie de
    sandbox via target arbitraire).
    """
    entries: List[Tuple[Path, str, int]] = []
    total = 0
    if not root.exists():
        return entries, 0
    root_resolved = root.resolve()
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        # Sécurité : trier pour un ordre déterministe (utile aux tests
        # et pour un progress reproductible).
        dirnames.sort()
        filenames.sort()
        for name in filenames:
            full = Path(dirpath) / name
            try:
                # Skip symlinks — voir docstring.
                if full.is_symlink():
                    continue
                # Skip non-fichiers (sockets, fifos, devices…).
                if not full.is_file():
                    continue
                size = full.stat().st_size
            except OSError:
                continue
            try:
                rel = full.resolve().relative_to(root_resolved).as_posix()
            except ValueError:
                # Fichier sorti de la racine (lien suivi par accident,
                # ou résolution d'un chemin bizarre) → on skippe.
                continue
            entries.append((full, rel, size))
            total += size
    return entries, total


def _tar_add_beneath(tf, root: Path, rel: str) -> None:
    """Ajoute à ``tf`` le fichier régulier ``rel`` (sous ``root``), lu sur son
    inode ouvert sans suivre de lien : un dossier remplacé par un lien après
    le parcours ne fait pas entrer un fichier de l'hôte dans l'instantané."""
    with os.fdopen(open_beneath(root, rel), "rb") as f:
        tf.addfile(tf.gettarinfo(arcname=rel, fileobj=f), f)


def _read_meta(meta_path: Path) -> Optional[dict]:
    try:
        return json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _list_user_snapshots(user_id: int) -> List[dict]:
    """Lit toutes les méta JSON dans le dossier de l'user, retourne
    triées du plus récent au plus ancien (clé ``ts``)."""
    snap_dir = _user_snap_dir(user_id)
    out: List[dict] = []
    for f in snap_dir.iterdir():
        if not f.name.endswith(".json"):
            continue
        meta = _read_meta(f)
        if not meta:
            continue
        # Sanity : on ne renvoie que les snapshots dont l'archive
        # existe encore (cas où la suppression aurait échoué partiellement).
        snap_id = meta.get("id")
        if not snap_id or not _SNAP_ID_RE.match(snap_id):
            continue
        if not (snap_dir / f"{snap_id}.tar.gz").exists():
            continue
        out.append(meta)
    out.sort(key=lambda m: m.get("ts", 0), reverse=True)
    return out


def _max_snapshots() -> int:
    cfg = read_config_json() or {}
    n = cfg.get("app", {}).get("sandbox_max_snapshots", MAX_SNAPSHOTS_PER_USER_DEFAULT)
    try:
        n = int(n)
    except (TypeError, ValueError):
        n = MAX_SNAPSHOTS_PER_USER_DEFAULT
    return max(1, min(50, n))


def _prune_old_snapshots(user_id: int, keep: Optional[int] = None) -> int:
    """Supprime les snapshots les plus anciennes au-delà de ``keep``.
    Retourne le nombre supprimé. Best-effort : une erreur d'IO sur
    une snap n'empêche pas la suppression des autres."""
    if keep is None:
        keep = _max_snapshots()
    snaps = _list_user_snapshots(user_id)
    deleted = 0
    for old in snaps[keep:]:
        snap_id = old.get("id")
        try:
            arch = _archive_path(user_id, snap_id)
            meta = _meta_path(user_id, snap_id)
            if arch.exists():
                arch.unlink()
            if meta.exists():
                meta.unlink()
            deleted += 1
        except Exception:
            # Best-effort
            pass
    return deleted


# ─────────────────────────────────────────────────────────────────────
#  Sérialisation des events SSE
# ─────────────────────────────────────────────────────────────────────
def _ev(payload: dict) -> str:
    """Sérialise un event en NDJSON : 1 ligne JSON terminée par \\n.
    Format strictement aligné avec ce que consomme app-chat.js
    (``response.body.getReader()`` + ``split('\\n')``)."""
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n"


# ─────────────────────────────────────────────────────────────────────
#  Création — implémentation cœur
# ─────────────────────────────────────────────────────────────────────
async def _create_snapshot_stream(user_id: int, name: str) -> AsyncGenerator[str, None]:
    """Génère le flux NDJSON de progression d'une création de snapshot.

    Sequence
    --------
    1. ``start``     : total_files, total_bytes
    2. ``progress``  : 1..N selon throttling
    3. ``done``      : metadata complète (renvoyée tel quel à la liste)
    """
    # First yield happens BEFORE any potentially-slow work (sandbox walk,
    # archive open). This flushes the HTTP response head immediately so:
    #   - reverse proxies (nginx, traefik, cloudflare) start streaming
    #     instead of buffering until the first chunk;
    #   - the browser's fetch() sees the response is alive and doesn't
    #     trip a default timeout.
    # Without this, a sandbox of a few thousand files would walk for
    # several seconds before the first byte hits the wire — long enough
    # for proxies on remote setups to consider the connection dead and
    # drop it (which surfaces in the JS catch as "Erreur réseau").
    yield _ev({"event": "preparing", "phase": "snapshot"})

    lock = _get_user_lock(user_id)
    if lock.locked():
        # Un autre create/restore est déjà en cours pour cet user.
        yield _ev({"event": "error", "message": "Une opération est déjà en cours sur la sandbox"})
        return

    # AUDIT 2026-08-02 (W6) — garde cross-worker (cf. restore).
    from shared_infra.runtime import chat_locks as _clk
    _xfd = _clk.acquire("snapshot", user_id, None)
    if _xfd is None and _clk.is_held("snapshot", user_id, None):
        yield _ev({"event": "error", "message":
                   "Une opération est déjà en cours sur la sandbox (autre onglet ou session)"})
        return

    try:
      async with lock:
        try:
            sandbox_root = _sandbox_root_for(user_id)

            # 1. Énumération (sync, mais hors event loop pour ne pas bloquer
            #    sur grosse sandbox).
            entries, total_bytes = await asyncio.to_thread(_walk_sandbox, sandbox_root)
            total_files = len(entries)

            yield _ev({
                "event": "start",
                "phase": "snapshot",
                "total_files": total_files,
                "total_bytes": total_bytes,
            })

            # 2. Préparer chemin destination + temp.
            snap_id = uuid.uuid4().hex
            snap_dir = _user_snap_dir(user_id)
            archive_final = snap_dir / f"{snap_id}.tar.gz"
            # tempfile.mkstemp sous le même répertoire → os.replace atomique
            # (même filesystem). Préfixe pour facilement nettoyer un .tmp
            # orphelin si le worker meurt en plein vol.
            tmp_fd, tmp_path = tempfile.mkstemp(
                prefix=f"{snap_id}.", suffix=".tar.gz.tmp", dir=str(snap_dir)
            )
            os.close(tmp_fd)  # tarfile rouvrira en écriture
            tmp_path_p = Path(tmp_path)

            ts_start = time.time()
            bytes_done = 0
            files_done = 0
            last_emit_ts = 0.0
            last_emit_pct = -1.0

            try:
                # tarfile.open en mode "w:gz" écrit en streaming dans le
                # fichier de destination — pas de RAM-explosion sur grosse
                # sandbox. compresslevel=6 = défaut gzip, bon compromis.
                tf = await asyncio.to_thread(tarfile.open, str(tmp_path_p), "w:gz")
                try:
                    # AUDIT 2026-08-02 (F2) — archiver aussi les RÉPERTOIRES
                    # (membres ``isdir``, taille 0). ``_walk_sandbox`` ne remonte
                    # que des fichiers : sans ceci, un dossier vide (``build/``,
                    # ``logs/``) ou ne contenant que des symlinks DISPARAÎT au
                    # restore. On les ajoute AVANT les fichiers pour que la
                    # structure existe à l'extraction. Progress inchangé (les
                    # dirs n'incrémentent pas ``files_done``).
                    # AUDIT 2026-08-31 (passe 4, B11) — la MARCHE elle-même
                    # (os.walk + is_symlink + resolve PAR répertoire) tournait
                    # sur la boucle ; seule l'écriture tar était déportée. Sur
                    # une sandbox à milliers de dossiers, ça gelait le worker.
                    # L'énumération part en thread, l'ajout tar garde son
                    # to_thread par membre (yield de progress entre deux).
                    _sroot_res = sandbox_root.resolve()
                    def _walk_dirs():
                        out = []
                        for _dp, _dnames, _ in os.walk(str(sandbox_root), followlinks=False):
                            _dnames.sort()
                            for _dn in _dnames:
                                _dfull = Path(_dp) / _dn
                                try:
                                    if _dfull.is_symlink():
                                        continue
                                    out.append((str(_dfull),
                                                _dfull.resolve().relative_to(_sroot_res).as_posix()))
                                except (OSError, IOError, ValueError):
                                    continue
                        return out
                    for _dfull_s, _drel in await asyncio.to_thread(_walk_dirs):
                        try:
                            await asyncio.to_thread(tf.add, _dfull_s, arcname=_drel, recursive=False)
                        except (OSError, IOError, ValueError):
                            continue
                    for _full, rel, size in entries:
                        try:
                            # arcname = chemin relatif posix → portable et
                            # évite tout absolute path dans l'archive. Contenu
                            # lu sur l'inode, sans suivre de lien (2026-09-29).
                            await asyncio.to_thread(_tar_add_beneath, tf, sandbox_root, rel)
                        except (OSError, IOError, SandboxPathError):
                            # Fichier disparu pendant l'archivage (concurrent
                            # write par un MCP shell, par exemple). On le
                            # skippe silencieusement plutôt que d'avorter.
                            continue

                        bytes_done += size
                        files_done += 1

                        # Throttle des events
                        pct = (bytes_done / total_bytes * 100.0) if total_bytes > 0 else \
                              (files_done / total_files * 100.0) if total_files > 0 else 100.0
                        now = time.time()
                        if (now - last_emit_ts >= PROGRESS_MIN_INTERVAL_SEC) or \
                           (pct - last_emit_pct >= PROGRESS_MIN_PCT_DELTA) or \
                           (files_done == total_files):
                            last_emit_ts = now
                            last_emit_pct = pct
                            yield _ev({
                                "event": "progress",
                                "phase": "snapshot",
                                "files_done": files_done,
                                "total_files": total_files,
                                "bytes_done": bytes_done,
                                "total_bytes": total_bytes,
                                "pct": round(pct, 1),
                                "current_file": rel,
                            })
                finally:
                    await asyncio.to_thread(tf.close)

                # 3. Écriture des métadonnées + atomic rename.
                archive_size = tmp_path_p.stat().st_size
                meta = {
                    "id": snap_id,
                    "name": (name or "").strip()[:_NAME_MAX_LEN] or _default_name(),
                    "ts": int(time.time()),
                    "duration_sec": round(time.time() - ts_start, 2),
                    "file_count": files_done,
                    "src_bytes": bytes_done,        # taille avant compression
                    "archive_bytes": archive_size,  # taille du .tar.gz
                }
                # rename atomique (même FS) — garantit qu'on n'expose
                # jamais un .tar.gz tronqué dans la liste.
                await asyncio.to_thread(os.replace, str(tmp_path_p), str(archive_final))
                tmp_path_p = None  # plus à nettoyer
                meta_file = _meta_path(user_id, snap_id)
                await asyncio.to_thread(meta_file.write_text,
                                        json.dumps(meta, ensure_ascii=False, indent=2),
                                        encoding="utf-8")

                # 4. Pruning best-effort.
                pruned = await asyncio.to_thread(_prune_old_snapshots, user_id)
                if pruned:
                    meta["pruned"] = pruned

                yield _ev({"event": "done", "phase": "snapshot", "snapshot": meta})

            finally:
                # Nettoyage du .tmp si on a échoué avant le rename.
                if tmp_path_p is not None:
                    try:
                        if tmp_path_p.exists():
                            tmp_path_p.unlink()
                    except OSError:
                        pass

        except Exception as e:
            # On capture tout ici pour garantir au moins un event
            # "error" côté client — sans ça le frontend voit juste un
            # stream qui se termine sans done et reste coincé.
            yield _ev({"event": "error", "message": f"Erreur snapshot : {e}"})
    finally:
        _clk.release(_xfd)   # W6 : libère le verrou cross-worker


def _default_name() -> str:
    return time.strftime("Snapshot %d/%m/%Y %H:%M")


# ─────────────────────────────────────────────────────────────────────
#  Restore — implémentation cœur
# ─────────────────────────────────────────────────────────────────────
def _is_safe_member(member: tarfile.TarInfo, dest_root: Path) -> bool:
    """Filtre 'tar slip' : un membre malveillant pourrait avoir un
    ``name`` absolu, contenir ``..``, ou être un device/symlink/hardlink
    pointant hors de la cible.

    On accepte uniquement les fichiers réguliers et les répertoires.
    Le chemin résolu doit rester strictement sous ``dest_root``.
    """
    name = member.name
    if not name or name.startswith("/") or "\\" in name:
        return False
    # Bloque les types non-fichier/répertoire
    if not (member.isfile() or member.isdir()):
        return False
    try:
        target = (dest_root / name).resolve()
    except (OSError, RuntimeError):
        return False
    dest_resolved = dest_root.resolve()
    return str(target) == str(dest_resolved) or \
           str(target).startswith(str(dest_resolved) + os.sep)


def _clear_sandbox_contents(root: Path) -> None:
    """Vide le contenu de la sandbox SANS supprimer la racine elle-même.
    Conserver la racine évite les races avec des handles ouverts qui
    pointeraient sur l'inode du dossier."""
    if not root.exists():
        return
    for child in list(root.iterdir()):
        try:
            if child.is_symlink() or child.is_file():
                child.unlink()
            elif child.is_dir():
                shutil.rmtree(child, ignore_errors=False)
        except OSError:
            # Best-effort — on continue, l'extract suivant écrasera ce
            # qu'il peut écraser.
            pass


async def _restore_snapshot_stream(user_id: int, snap_id: str) -> AsyncGenerator[str, None]:
    """Génère le flux NDJSON de progression d'un restore.

    Sequence
    --------
    1. ``start``    : total_files, total_bytes (uncompressed)
    2. ``phase``    : "clearing"
    3. ``progress`` : 1..N selon throttling, phase="extract"
    4. ``done``     : phase="restore"
    """
    # Early flush — see same comment in _create_snapshot_stream. Restoring
    # may have to read+validate a large archive before the first useful
    # event; without this, proxies kill the connection mid-validation.
    yield _ev({"event": "preparing", "phase": "restore"})

    lock = _get_user_lock(user_id)
    if lock.locked():
        yield _ev({"event": "error", "message": "Une opération est déjà en cours sur la sandbox"})
        return

    # AUDIT 2026-08-02 (W6) — garde CROSS-worker : l'asyncio.Lock ci-dessus
    # est per-process ; deux onglets tombant sur deux workers gunicorn
    # passaient TOUS LES DEUX le garde et restauraient/écrivaient en même
    # temps. Le flock (chat_locks) couvre tous les workers ; fail-open si
    # /tmp est indisponible (comportement d'avant).
    from shared_infra.runtime import chat_locks as _clk
    _xfd = _clk.acquire("snapshot", user_id, None)
    if _xfd is None and _clk.is_held("snapshot", user_id, None):
        yield _ev({"event": "error", "message":
                   "Une opération est déjà en cours sur la sandbox (autre onglet ou session)"})
        return

    try:
      async with lock:
        try:
            archive = _archive_path(user_id, snap_id)
            if not archive.exists():
                yield _ev({"event": "error", "message": "Snapshot introuvable"})
                return

            sandbox_root = _sandbox_root_for(user_id)

            # 1. Pré-validation : ouvrir l'archive, calculer total bytes,
            #    et filtrer les membres dangereux. On rejette l'opération
            #    AVANT de toucher à la sandbox courante si l'archive est
            #    corrompue ou suspecte.
            def _scan():
                with tarfile.open(str(archive), "r:gz") as tf:
                    members = tf.getmembers()
                    safe = [m for m in members if _is_safe_member(m, sandbox_root)]
                    total = sum(m.size for m in safe if m.isfile())
                    biggest = max((m.size for m in safe if m.isfile()), default=0)
                    return safe, total, biggest

            try:
                safe_members, total_bytes, biggest_member = await asyncio.to_thread(_scan)
            except (tarfile.TarError, OSError) as e:
                yield _ev({"event": "error", "message": f"Archive invalide : {e}"})
                return

            # AUDIT 2026-06 — caps anti zip-bomb, vérifiés AVANT le clearing
            # (la sandbox courante n'est pas touchée). Erreur EXPLICITE plutôt
            # que filtrage silencieux : skipper un membre = restaurer un état
            # incomplet sans le dire (perte de données déguisée en succès).
            if biggest_member > _MAX_MEMBER_BYTES:
                yield _ev({"event": "error", "message":
                           f"Archive refusée : un fichier dépasse le cap par membre "
                           f"({biggest_member // (1024*1024)} Mo > "
                           f"{_MAX_MEMBER_BYTES // (1024*1024)} Mo ; "
                           f"SNAPSHOT_MAX_MEMBER_MB pour ajuster)"})
                return
            if total_bytes > _MAX_TOTAL_BYTES:
                yield _ev({"event": "error", "message":
                           f"Archive refusée : taille décompressée totale "
                           f"({total_bytes // (1024*1024)} Mo) au-delà du cap "
                           f"({_MAX_TOTAL_BYTES // (1024*1024)} Mo ; "
                           f"SNAPSHOT_MAX_TOTAL_GB pour ajuster)"})
                return

            total_files = sum(1 for m in safe_members if m.isfile())
            yield _ev({
                "event": "start",
                "phase": "restore",
                "total_files": total_files,
                "total_bytes": total_bytes,
            })

            # AUDIT 2026-08-02 (W6) — marqueur de transaction : si le worker
            # meurt (SIGKILL, W2) entre le vidage et la fin de l'extraction,
            # l'utilisateur retrouvait un /work amputé SANS AUCUN indice.
            # Le marqueur est retiré après extraction complète ; sa présence
            # est exposée par GET /api/sandbox/snapshots
            # (``last_restore_incomplete``).
            _marker = sandbox_root / _RESTORE_MARKER_NAME
            def _write_marker():
                _marker.write_text(json.dumps(
                    {"snap_id": snap_id, "ts": time.time()}), encoding="utf-8")
            try:
                await asyncio.to_thread(_write_marker)
            except OSError:
                pass  # best-effort : ne bloque pas le restore

            # 2. Vidage de la sandbox courante.
            yield _ev({"event": "phase", "phase": "clearing"})
            await asyncio.to_thread(_clear_sandbox_contents, sandbox_root)
            try:
                await asyncio.to_thread(_write_marker)   # recréé après vidage
            except OSError:
                pass

            # 3. Extraction membre par membre, avec progress.
            bytes_done = 0
            files_done = 0
            last_emit_ts = 0.0
            last_emit_pct = -1.0

            def _open_tar():
                return tarfile.open(str(archive), "r:gz")

            tf = await asyncio.to_thread(_open_tar)

            def _close_and_widen():
                # Invariant /work « cross-writable » (PASSE 15 B7, AUDIT
                # 2026-08-02 C2) : membres extraits avec les modes du snapshot
                # (parfois 0600) et dossiers recréés en 0755 par l'hôte — le
                # conteneur (UID 10001, « other », aucun groupe commun) ne
                # pourrait plus rien modifier. Tout l'arbre passe en 0666/0777
                # (bits x conservés), sans suivre de lien.
                try:
                    tf.close()
                finally:
                    widen_beneath(sandbox_root, "", recursive=True)

            try:
                # Important : itérer sur ``safe_members`` (déjà filtrés)
                # plutôt que sur tf — on ne veut PAS rejouer les membres
                # malveillants.
                for m in safe_members:
                    try:
                        await asyncio.to_thread(tf.extract, m, str(sandbox_root))
                    except (OSError, tarfile.TarError):
                        # Skip ce membre, continue le reste — l'user
                        # préfère un restore partiel à un échec total.
                        continue

                    if m.isfile():
                        bytes_done += m.size
                        files_done += 1

                        pct = (bytes_done / total_bytes * 100.0) if total_bytes > 0 else \
                              (files_done / total_files * 100.0) if total_files > 0 else 100.0
                        now = time.time()
                        if (now - last_emit_ts >= PROGRESS_MIN_INTERVAL_SEC) or \
                           (pct - last_emit_pct >= PROGRESS_MIN_PCT_DELTA) or \
                           (files_done == total_files):
                            last_emit_ts = now
                            last_emit_pct = pct
                            yield _ev({
                                "event": "progress",
                                "phase": "extract",
                                "files_done": files_done,
                                "total_files": total_files,
                                "bytes_done": bytes_done,
                                "total_bytes": total_bytes,
                                "pct": round(pct, 1),
                                "current_file": m.name,
                            })
            finally:
                # Un seul travail, protégé de l'annulation : une déconnexion du
                # client annule le flux, et l'annulation revient à CHAQUE
                # ``await`` — un second n'aurait jamais tourné (2026-09-29).
                await asyncio.shield(asyncio.to_thread(_close_and_widen))

            # Extraction terminée → le marqueur d'incomplétude est levé (W6).
            try:
                await asyncio.to_thread(_marker.unlink)
            except OSError:
                pass

            # Tout /work vient d'être remplacé : le compteur d'usage disque en
            # cache est périmé (jauge de quota). Delta inconnu → invalidation.
            try:
                from shared_infra.routes._helpers import invalidate_sandbox_usage
                invalidate_sandbox_usage(user_id)
            except Exception:                                   # noqa: BLE001
                pass

            yield _ev({
                "event": "done",
                "phase": "restore",
                "files_restored": files_done,
                "bytes_restored": bytes_done,
            })

        except Exception as e:
            yield _ev({"event": "error", "message": f"Erreur restore : {e}"})
    finally:
        _clk.release(_xfd)   # W6 : libère le verrou cross-worker


# ─────────────────────────────────────────────────────────────────────
#  Endpoints HTTP
# ─────────────────────────────────────────────────────────────────────
@router.post("/api/sandbox/snapshots/create")
async def api_sandbox_snapshot_create(request: Request):
    """Crée une snapshot de la sandbox personnelle de l'utilisateur.

    Body JSON optionnel : ``{"name": "Avant refacto module X"}``

    Réponse : flux NDJSON (1 event JSON par ligne, ``\\n`` séparateur),
    annoncé en ``application/x-ndjson`` — exactement comme ``/api/chat``.
    Annoncer ``text/event-stream`` ferait croire à certains reverse-proxies
    (Cloudflare, nginx en mode SSE strict) qu'ils doivent parser le contenu
    comme du SSE ; ils bufferisent ou coupent quand ils ne trouvent pas les
    ``data: …\\n\\n`` attendus, ce qui produit l'« Erreur réseau » sur les
    clients distants.
    """
    user_id = require_user_id(request)

    name = ""
    try:
        body = await request.json()
        if isinstance(body, dict):
            n = body.get("name")
            if isinstance(n, str):
                name = n
    except Exception:
        # Pas de body / body invalide → ok, on prend le nom par défaut.
        pass

    return StreamingResponse(
        _create_snapshot_stream(user_id, name),
        media_type="application/x-ndjson; charset=utf-8",
        # Header bundle to keep the stream alive end-to-end on remote
        # setups behind a reverse proxy:
        #   - X-Accel-Buffering: no   → tells nginx to disable buffering
        #     for this response (the most common issue in production).
        #   - Cache-Control: no-cache → prevents intermediate caches.
        #   - Connection: keep-alive  → avoids any proxy that interprets
        #     "close" as a hint to consume the body before forwarding.
        #   - Content-Encoding: identity → defeats gzip middleware that
        #     would otherwise accumulate chunks into a compression buffer
        #     before flushing (turns NDJSON streaming into an all-or-
        #     nothing transfer, which surfaces as "Erreur réseau" when
        #     the response takes longer than a proxy's idle timeout).
        headers={
            "X-Accel-Buffering": "no",
            "Cache-Control":     "no-cache",
            "Connection":        "keep-alive",
            "Content-Encoding":  "identity",
        },
    )


@router.get("/api/sandbox/snapshots")
def api_sandbox_snapshots_list(request: Request):
    """Retourne la liste des snapshots de l'utilisateur courant,
    triées du plus récent au plus ancien."""
    user_id = require_user_id(request)
    items = _list_user_snapshots(user_id)
    # AUDIT 2026-08-02 (W6) — expose l'éventuel marqueur d'un restore
    # interrompu (worker tué en pleine extraction) : sans lui, l'utilisateur
    # retrouvait un /work partiel sans aucun moyen de le savoir.
    incomplete = None
    try:
        _mk = _restore_marker(_sandbox_root_for(user_id))
        if _mk.is_file():
            try:
                incomplete = json.loads(_mk.read_text(encoding="utf-8"))
            except (ValueError, OSError):
                incomplete = {}
    except Exception:
        incomplete = None
    return JSONResponse(
        {"items": items, "max": _max_snapshots(),
         "last_restore_incomplete": incomplete},
        headers={"Cache-Control": "no-cache"},
    )


@router.post("/api/sandbox/snapshots/{snap_id}/restore")
async def api_sandbox_snapshot_restore(request: Request, snap_id: str):
    """Restaure la sandbox depuis une snapshot. Réponse en flux NDJSON."""
    user_id = require_user_id(request)
    if not _SNAP_ID_RE.match(snap_id):
        raise HTTPException(400, "Invalid snapshot id")

    return StreamingResponse(
        _restore_snapshot_stream(user_id, snap_id),
        media_type="application/x-ndjson; charset=utf-8",
        # See comment in api_sandbox_snapshot_create — same anti-buffering
        # bundle is needed for remote clients behind a reverse proxy.
        headers={
            "X-Accel-Buffering": "no",
            "Cache-Control":     "no-cache",
            "Connection":        "keep-alive",
            "Content-Encoding":  "identity",
        },
    )


# ⚠ ORDRE DE DÉCLARATION — cette route littérale DOIT rester AVANT
# ``/api/sandbox/snapshots/{snap_id}`` : FastAPI résout dans l'ordre
# d'enregistrement, donc l'inverse ferait matcher ``{snap_id}="restore-marker"``
# (rejeté par ``_SNAP_ID_RE`` → 400).
@router.delete("/api/sandbox/snapshots/restore-marker")
def api_sandbox_clear_restore_marker(request: Request):
    """Acquitte l'alerte « restauration interrompue » (retire le marqueur).

    Sans acquittement, le marqueur posé par ``_restore_snapshot_stream``
    survit indéfiniment : il n'est retiré que par une restauration menée à
    son terme. L'utilisateur qui a vérifié/réparé son ``/work`` à la main
    doit pouvoir éteindre le bandeau.
    """
    user_id = require_user_id(request)
    try:
        mk = _restore_marker(_sandbox_root_for(user_id))
        if mk.is_file():
            mk.unlink()
    except OSError as e:
        raise HTTPException(500, f"Impossible d'effacer le marqueur : {e}")
    return {"ok": True}


@router.delete("/api/sandbox/snapshots/{snap_id}")
def api_sandbox_snapshot_delete(request: Request, snap_id: str):
    """Supprime une snapshot."""
    user_id = require_user_id(request)
    if not _SNAP_ID_RE.match(snap_id):
        raise HTTPException(400, "Invalid snapshot id")

    arch = _archive_path(user_id, snap_id)
    meta = _meta_path(user_id, snap_id)
    if not arch.exists() and not meta.exists():
        raise HTTPException(404, "Snapshot not found")

    # Best-effort : si l'un échoue, on remonte une 500 mais on supprime
    # l'autre quand même pour ne pas laisser un fichier orphelin.
    err = None
    for f in (arch, meta):
        try:
            if f.exists():
                f.unlink()
        except OSError as e:
            err = e
    if err:
        raise HTTPException(500, f"Delete error: {err}")
    return {"ok": True, "id": snap_id}
