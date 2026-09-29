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
- L'hôte ne lit ni n'écrit ``/work`` (L4.5) : l'archive est produite, puis
  extraite, par l'agent de la sandbox, dans le conteneur. À l'extraction,
  l'agent ne garde que fichiers ordinaires et dossiers aux noms contenus (ni
  absolus, ni ``..``) et vérifie les bornes avant de remplacer ``/work``.
- Les snapshots sont stockées HORS du dossier sandbox de l'utilisateur
  pour ne pas se snapshoter elles-mêmes ni être listées dans le tree.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import os
import re
import tempfile
import time
import uuid
from pathlib import Path
from typing import AsyncGenerator, Dict, List, Optional

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

from shared_infra.accounts.users import get_username_by_id
from shared_infra.config import SANDBOX_DIR, read_config_json
from shared_infra.routes._state import router
from shared_infra.sandbox.agent_client import AgentError
from shared_infra.sandbox.exec_bridge import PANNES_AGENT, agent_for
from shared_infra.security.deps import require_user_id

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
# sans cap, l'extraction remplit le disque. Env-overridable.
#   - par membre : un fichier de sandbox légitime > 1 Go est improbable
#   - total      : aussi le plafond d'une création.
# L'agent les vérifie en extrayant dans un dossier provisoire : /work n'est
# jamais vidé pour une archive refusée ensuite.
_MAX_MEMBER_BYTES = int(os.environ.get("SNAPSHOT_MAX_MEMBER_MB", "1024")) * 1024 * 1024
_MAX_TOTAL_BYTES  = int(os.environ.get("SNAPSHOT_MAX_TOTAL_GB", "8")) * 1024 * 1024 * 1024
_MAX_ENTREES = 500_000             # fichiers et dossiers d'une snapshot


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

# Marqueur d'incomplétude de restore (W6) : posé dans le dossier des
# snapshots du compte (sur l'hôte, hors de /work) avant l'extraction, retiré
# une fois la réponse de l'agent reçue ; s'il survit, le restore a été
# interrompu (worker ou conteneur tué) et /work peut être partiel.
_RESTORE_MARKER_NAME = ".elpis_restore_incomplete"


def _restore_marker(user_id: int) -> Path:
    """Marqueur de restauration interrompue du compte."""
    return _user_snap_dir(user_id) / _RESTORE_MARKER_NAME


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


# ─────────────────────────────────────────────────────────────────────
#  Métadonnées
# ─────────────────────────────────────────────────────────────────────
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
def _message_agent(e: AgentError, quoi: str) -> str:
    """Message d'erreur d'une snapshot ou d'une restauration refusée par l'agent."""
    mo = 1024 * 1024
    if e.code == "too_large":
        limite = e.data.get("limit")                 # extraction : quelle borne
        if limite == "member":
            return (f"Archive refusée : un fichier dépasse le cap par membre "
                    f"({_MAX_MEMBER_BYTES // mo} Mo ; SNAPSHOT_MAX_MEMBER_MB pour ajuster)")
        if limite == "total":
            return (f"Archive refusée : taille décompressée totale au-delà du cap "
                    f"({_MAX_TOTAL_BYTES // mo} Mo ; SNAPSHOT_MAX_TOTAL_GB pour ajuster)")
        if limite == "count":
            return f"Archive refusée : plus de {_MAX_ENTREES} entrées"
        return (f"Sandbox trop volumineuse pour une snapshot (plus de {_MAX_TOTAL_BYTES // mo} Mo "
                f"ou {_MAX_ENTREES} entrées ; SNAPSHOT_MAX_TOTAL_GB pour ajuster)")
    if e.code == "bad_archive":
        return f"Archive invalide : {e.message}"
    if e.code == "timeout":
        return f"Erreur {quoi} : délai dépassé"
    if e.code in PANNES_AGENT:
        return "Environnement sandbox indisponible — réessayez dans un instant."
    return f"Erreur {quoi} : {e.code}{' — ' + e.message if e.message else ''}"


async def _create_snapshot_stream(user_id: int, name: str) -> AsyncGenerator[str, None]:
    """Génère le flux NDJSON de progression d'une création de snapshot.

    Sequence
    --------
    1. ``start``     : total_files, total_bytes
    2. ``progress``  : au fil de l'archive (l'agent en rend une par 0,5 s)
    3. ``done``      : metadata complète (renvoyée tel quel à la liste)
    """
    # First yield happens BEFORE any potentially-slow work (sandbox walk,
    # archive open). This flushes the HTTP response head immediately so
    # reverse proxies start streaming and the browser's fetch() sees the
    # response is alive (otherwise: "Erreur réseau" on remote setups).
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
        tmp_path_p: Optional[Path] = None
        try:
            snap_id = uuid.uuid4().hex
            snap_dir = _user_snap_dir(user_id)
            archive_final = snap_dir / f"{snap_id}.tar.gz"
            # tempfile.mkstemp sous le même répertoire → os.replace atomique
            # (même filesystem). Préfixe pour facilement nettoyer un .tmp
            # orphelin si le worker meurt en plein vol.
            tmp_fd, tmp_path = tempfile.mkstemp(
                prefix=f"{snap_id}.", suffix=".tar.gz.tmp", dir=str(snap_dir)
            )
            tmp_path_p = Path(tmp_path)
            ts_start = time.time()
            with os.fdopen(tmp_fd, "wb") as out:
                # L'archive est produite par l'agent, dans le conteneur (L4.5) :
                # dossiers compris (AUDIT 2026-08-02, F2 : un dossier vide
                # survit au restore), liens et fichiers spéciaux omis, rien de
                # /work lu par l'hôte. Au-delà des caps : refus avant tout octet.
                async with agent_for(user_id).archive(
                        [""], format="tgz", dirs=True, max_bytes=_MAX_TOTAL_BYTES,
                        max_files=_MAX_ENTREES, deadline_s=240) as flux:
                    total_files = int(flux.debut.get("files") or 0)
                    total_bytes = int(flux.debut.get("bytes") or 0)
                    yield _ev({"event": "start", "phase": "snapshot",
                               "total_files": total_files, "total_bytes": total_bytes})
                    async for x in flux:
                        if isinstance(x, bytes):
                            await asyncio.to_thread(out.write, x)
                            continue
                        files_done, bytes_done = int(x.get("files") or 0), int(x.get("bytes") or 0)
                        pct = (bytes_done / total_bytes * 100.0) if total_bytes > 0 else \
                              (files_done / total_files * 100.0) if total_files > 0 else 100.0
                        yield _ev({
                            "event": "progress",
                            "phase": "snapshot",
                            "files_done": files_done,
                            "total_files": total_files,
                            "bytes_done": bytes_done,
                            "total_bytes": total_bytes,
                            "pct": round(min(pct, 100.0), 1),
                            "current_file": str(x.get("current") or ""),
                        })
                    fin = flux.fin or {}

            # Métadonnées + rename atomique (même FS) — on n'expose jamais
            # un .tar.gz tronqué dans la liste.
            archive_size = tmp_path_p.stat().st_size
            meta = {
                "id": snap_id,
                "name": (name or "").strip()[:_NAME_MAX_LEN] or _default_name(),
                "ts": int(time.time()),
                "duration_sec": round(time.time() - ts_start, 2),
                "file_count": int(fin.get("files") or 0),
                "src_bytes": int(fin.get("bytes") or 0),   # taille avant compression
                "archive_bytes": archive_size,             # taille du .tar.gz
            }
            await asyncio.to_thread(os.replace, str(tmp_path_p), str(archive_final))
            tmp_path_p = None  # plus à nettoyer
            meta_file = _meta_path(user_id, snap_id)
            await asyncio.to_thread(meta_file.write_text,
                                    json.dumps(meta, ensure_ascii=False, indent=2),
                                    encoding="utf-8")

            # Pruning best-effort.
            pruned = await asyncio.to_thread(_prune_old_snapshots, user_id)
            if pruned:
                meta["pruned"] = pruned

            yield _ev({"event": "done", "phase": "snapshot", "snapshot": meta})

        except AgentError as e:
            yield _ev({"event": "error", "message": _message_agent(e, "snapshot")})
        except Exception as e:
            # On capture tout ici pour garantir au moins un event
            # "error" côté client — sans ça le frontend voit juste un
            # stream qui se termine sans done et reste coincé.
            yield _ev({"event": "error", "message": f"Erreur snapshot : {e}"})
        finally:
            # Nettoyage du .tmp si on a échoué avant le rename.
            if tmp_path_p is not None:
                with contextlib.suppress(OSError):
                    tmp_path_p.unlink()
    finally:
        _clk.release(_xfd)   # W6 : libère le verrou cross-worker


def _default_name() -> str:
    return time.strftime("Snapshot %d/%m/%Y %H:%M")


# ─────────────────────────────────────────────────────────────────────
#  Restore — implémentation cœur
# ─────────────────────────────────────────────────────────────────────
async def _restaurer(user_id: int, archive: Path, envoye: List[int]) -> dict:
    """Extraction par l'agent : le contenu de /work n'est remplacé qu'une fois
    l'archive entière extraite (et bornée) dans un dossier provisoire du
    conteneur. Le marqueur est levé et la jauge invalidée dès la réponse de
    l'agent, même si le client est parti entre-temps ; sans réponse (agent
    injoignable, délai), le marqueur reste : /work peut être partiel."""
    def compter(n: int) -> None:
        envoye[0] += n
    f = await asyncio.to_thread(open, archive, "rb")
    try:
        res = await agent_for(user_id).extract(
            "", f, max_bytes=_MAX_TOTAL_BYTES, max_file=_MAX_MEMBER_BYTES,
            max_members=_MAX_ENTREES, on_sent=compter)
    except AgentError as e:
        if e.status:                                 # refus de l'agent : /work intact
            _lever_marqueur(user_id)
        raise
    finally:
        f.close()
        # Tout /work a pu être remplacé : le compteur d'usage disque en cache
        # est périmé (jauge de quota). Delta inconnu → invalidation.
        try:
            from shared_infra.routes._helpers import invalidate_sandbox_usage
            invalidate_sandbox_usage(user_id)
        except Exception:                                   # noqa: BLE001
            pass
    _lever_marqueur(user_id)
    return res


def _lever_marqueur(user_id: int) -> None:
    with contextlib.suppress(OSError):
        _restore_marker(user_id).unlink()


async def _restore_snapshot_stream(user_id: int, snap_id: str) -> AsyncGenerator[str, None]:
    """Génère le flux NDJSON de progression d'un restore.

    Sequence
    --------
    1. ``start``    : total_files, total_bytes (de la snapshot)
    2. ``phase``    : "extract"
    3. ``progress`` : part de l'archive transmise à l'agent
    4. ``done``     : phase="restore"

    Client parti en route : la restauration va à son terme (les verrous sont
    rendus ensuite), rien n'est laissé à moitié par une déconnexion.
    """
    # Early flush — see same comment in _create_snapshot_stream.
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

    await lock.acquire()
    tache: Optional[asyncio.Future] = None
    try:
        archive = _archive_path(user_id, snap_id)
        if not archive.exists():
            yield _ev({"event": "error", "message": "Snapshot introuvable"})
            return
        meta = _read_meta(_meta_path(user_id, snap_id)) or {}
        taille = max(1, archive.stat().st_size)
        yield _ev({
            "event": "start",
            "phase": "restore",
            "total_files": int(meta.get("file_count") or 0),
            "total_bytes": int(meta.get("src_bytes") or 0),
        })

        # AUDIT 2026-08-02 (W6) — marqueur de transaction : si le worker meurt
        # (SIGKILL, W2) pendant la restauration, l'utilisateur doit le savoir.
        # Exposé par GET /api/sandbox/snapshots (``last_restore_incomplete``).
        def _write_marker():
            _restore_marker(user_id).write_text(json.dumps(
                {"snap_id": snap_id, "ts": time.time()}), encoding="utf-8")
        try:
            await asyncio.to_thread(_write_marker)
        except OSError:
            pass  # best-effort : ne bloque pas le restore

        yield _ev({"event": "phase", "phase": "extract"})
        envoye = [0]
        tache = asyncio.ensure_future(_restaurer(user_id, archive, envoye))
        while not tache.done():
            await asyncio.wait({tache}, timeout=0.25)
            yield _ev({"event": "progress", "phase": "extract",
                       "pct": round(min(99.0, envoye[0] * 100.0 / taille), 1)})
        res = tache.result()
        yield _ev({
            "event": "done",
            "phase": "restore",
            "files_restored": int(res.get("files") or 0),
            "bytes_restored": int(res.get("bytes") or 0),
            # Entrées de /work qui n'ont pu être retirées ou mises en place
            # (fichiers d'un autre propriétaire, par exemple).
            "conflicts": int(res.get("conflicts") or 0),
        })
    except AgentError as e:
        yield _ev({"event": "error", "message": _message_agent(e, "restore")})
    except Exception as e:
        yield _ev({"event": "error", "message": f"Erreur restore : {e}"})
    finally:
        def _liberer(t=None) -> None:
            if t is not None and not t.cancelled():
                t.exception()    # consultée : pas d'avertissement « jamais lue »
            lock.release()
            _clk.release(_xfd)   # W6 : libère le verrou cross-worker
        if tache is not None and not tache.done():
            tache.add_done_callback(_liberer)   # client parti : libérés à la fin
        else:
            _liberer()


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
        incomplete = json.loads(_restore_marker(user_id).read_text(encoding="utf-8"))
    except FileNotFoundError:
        incomplete = None
    except (ValueError, OSError):
        incomplete = {}
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
        _restore_marker(user_id).unlink(missing_ok=True)
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
