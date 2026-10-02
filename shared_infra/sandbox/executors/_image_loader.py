# SPDX-License-Identifier: MIT
"""
shared_infra/sandbox/executors/_image_loader.py — Auto-chargement de l'image sandbox.

L'image livrée (``DEFAULT_IMAGE``) est buildée UNE FOIS sur une machine
connectée à Internet (cf. ``deploy/docker/sandbox/build_offline.sh``)
puis l'archive ``.tar.gz`` est commitée dans le repo de l'app.

Au runtime, dès qu'un user active le mode Docker, on s'assure que
l'image est présente sur le daemon. Si elle ne l'est pas, on lance
``docker load -i <archive>`` en arrière-plan et on retourne un état
de progression à l'UI.

Mécanique :

* État global ``ImageLoadState`` (singleton process-wide).
* ``ensure_image_loaded()`` est idempotent et thread-safe :
    - Si déjà ``LOADED`` → retour immédiat
    - Si ``LOADING`` → état courant (``blocking=True`` : attente de la fin)
    - Sinon → on déclenche ``docker load`` et on bascule en LOADING

L'archive est cherchée dans, par ordre :
  1. ``$ELPIS_SANDBOX_IMAGE_TAR``
  2. ``<app_root>/sandbox_images/<image_name>.tar.gz``
  3. ``<app_root>/deploy/docker/sandbox/<image_name>.tar.gz``
"""
from __future__ import annotations

import asyncio
import logging
import shutil
import time
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Optional

logger = logging.getLogger("uvicorn.error")


class ImageLoadStatus(str, Enum):
    NOT_CHECKED = "not_checked"   # pas encore tenté de charger
    LOADED      = "loaded"         # ok, image dispo
    LOADING     = "loading"        # docker load en cours
    NOT_FOUND   = "not_found"      # archive introuvable côté disk
    ERROR       = "error"          # docker load a échoué


@dataclass
class ImageLoadState:
    status:     ImageLoadStatus = ImageLoadStatus.NOT_CHECKED
    started_at: Optional[float] = None
    finished_at: Optional[float] = None
    error:      Optional[str] = None
    archive_path: Optional[str] = None
    image:      Optional[str] = None
    progress_msg: str = ""

    def to_dict(self) -> dict:
        d = {
            "status": self.status.value,
            "image": self.image,
            "archive_path": self.archive_path,
            "progress_msg": self.progress_msg,
        }
        if self.error:
            d["error"] = self.error
        if self.started_at and self.status == ImageLoadStatus.LOADING:
            d["elapsed_s"] = round(time.time() - self.started_at, 1)
        if self.started_at and self.finished_at:
            d["duration_s"] = round(self.finished_at - self.started_at, 1)
        return d


# Singleton process-wide
_STATE = ImageLoadState()
_LOCK = asyncio.Lock()

# Cycle de vie du chargement de fond :
#   • _LOAD_TASK : référence FORTE sur la tâche (asyncio ne tient qu'une
#     WeakSet — sans ref, la tâche peut être GC avant son premier await
#     et l'état resterait LOADING pour toujours, spinner infini sans issue).
#   • _LOAD_DONE : Event posé à la fin du chargement — c'est LUI que les
#     appelants ``blocking=True`` attendent. Ne pas attendre le verrou
#     (``async with _LOCK: pass``) : il est relâché au ``return`` qui suit
#     le create_task, pas à la fin du chargement.
#   • _LOADING_STALE_S : TTL anti-wedge — un LOADING plus vieux que le
#     timeout docker load (300 s) + marge est forcément mort (tâche tuée,
#     exception avalée) : on le requalifie en ERROR et on retente.
_LOAD_TASK: Optional[asyncio.Task] = None
_LOAD_DONE: Optional[asyncio.Event] = None
_LOADING_STALE_S = 400.0


def get_state() -> ImageLoadState:
    return _STATE


def reset_state() -> None:
    """Force re-vérification au prochain ensure_image_loaded()."""
    global _STATE
    _STATE = ImageLoadState()


def _candidate_tar_paths(image_name: str) -> list[Path]:
    """Liste des chemins possibles pour l'archive de l'image, par priorité."""
    # ``image_name`` typique : ``elpis/sandbox:1.7.0``
    # On en dérive un nom de fichier : ``elpis-sandbox-1.7.0.tar.gz``
    safe = image_name.replace(":", "-").replace("/", "-")
    file_candidates = [f"{safe}.tar.gz", f"{safe}.tar"]

    # Racine de l'app : shared_infra/sandbox/executors/_image_loader.py → parents[3].
    here = Path(__file__).resolve()
    app_root = here.parents[3]

    paths: list[Path] = []

    # 1. Override explicite par env var
    from shared_infra.env_compat import env
    env_path = env("ELPIS_SANDBOX_IMAGE_TAR")
    if env_path:
        paths.append(Path(env_path))

    # 2. Conventionnel : <app>/sandbox_images/
    for fname in file_candidates:
        paths.append(app_root / "sandbox_images" / fname)

    # 3. Build dir : <app>/deploy/docker/sandbox/
    for fname in file_candidates:
        paths.append(app_root / "deploy" / "docker" / "sandbox" / fname)

    return paths


def find_image_archive(image_name: str) -> Optional[Path]:
    """Retourne le premier chemin d'archive existant, ou None."""
    for p in _candidate_tar_paths(image_name):
        if p.is_file():
            return p
    return None


async def _is_image_loaded(image_name: str) -> bool:
    """Vérifie via ``docker image inspect`` si l'image existe localement."""
    docker_bin = shutil.which("docker") or "/usr/bin/docker"
    proc = await asyncio.create_subprocess_exec(
        docker_bin, "image", "inspect", image_name,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        await asyncio.wait_for(proc.wait(), timeout=10)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return False
    return proc.returncode == 0


async def _docker_load(archive_path: Path, image_name: str) -> tuple[bool, str]:
    """Lance ``docker load -i <archive>``. Retourne (ok, message)."""
    docker_bin = shutil.which("docker") or "/usr/bin/docker"
    logger.info("[image-loader] docker load -i %s ...", archive_path)
    proc = await asyncio.create_subprocess_exec(
        docker_bin, "load", "-i", str(archive_path),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        # docker load peut être long sur grosse image (~60s pour 600 MB)
        out, err = await asyncio.wait_for(proc.communicate(), timeout=300)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.communicate()
        return False, f"Timeout (>5min) sur docker load {archive_path}"

    if proc.returncode != 0:
        msg = err.decode("utf-8", errors="replace").strip()[:500]
        return False, f"docker load échec : {msg}"

    # Vérifier que l'image est bien là après le load
    if not await _is_image_loaded(image_name):
        return False, (
            f"docker load OK mais l'image '{image_name}' n'est pas listée. "
            f"L'archive contient-elle bien cette image ?"
        )
    return True, out.decode("utf-8", errors="replace").strip()[:300]


async def ensure_image_loaded(image_name: str,
                               *, blocking: bool = False) -> ImageLoadState:
    """Garantit que l'image est chargée sur le daemon Docker.

    * Si ``blocking=True`` : attend la fin du chargement (peut prendre
      jusqu'à 5 min). Utile pour les scripts/tests.
    * Si ``blocking=False`` (défaut) : lance le chargement en arrière-plan
      et retourne immédiatement l'état actuel (LOADING). L'UI poll
      ensuite ``get_state()`` pour suivre l'avancement.
    """
    global _STATE, _LOAD_TASK, _LOAD_DONE

    # Fast path : image déjà chargée ?
    if _STATE.status == ImageLoadStatus.LOADED and _STATE.image == image_name:
        return _STATE

    # Si un load est déjà en cours pour la même image → attendre ou retourner
    if _STATE.status == ImageLoadStatus.LOADING and _STATE.image == image_name:
        # TTL anti-wedge : un LOADING plus vieux que le timeout docker load
        # est mort (tâche GC/exception). Le retourner TEL QUEL figerait le
        # spinner pour toujours — seule issue : redémarrer le worker.
        if _STATE.started_at and (time.time() - _STATE.started_at) > _LOADING_STALE_S:
            logger.error("[image-loader] LOADING périmé (%.0fs) pour %s — "
                         "requalifié en ERROR, nouvel essai",
                         time.time() - _STATE.started_at, image_name)
            _STATE = ImageLoadState(
                status=ImageLoadStatus.ERROR,
                image=image_name,
                error="Chargement interrompu (tâche morte) — nouvel essai en cours.",
                progress_msg="Échec",
            )
            # on retombe dans la section verrouillée ci-dessous pour retenter
        elif blocking:
            # Attendre RÉELLEMENT la fin du
            # chargement (Event posé par _load_in_background), comme la
            # docstring le promet. 330 s > timeout docker load (300 s).
            if _LOAD_DONE is not None:
                try:
                    await asyncio.wait_for(_LOAD_DONE.wait(), timeout=330)
                except asyncio.TimeoutError:
                    pass
            return _STATE
        else:
            return _STATE

    async with _LOCK:
        # Re-check après acquisition du lock
        if _STATE.status == ImageLoadStatus.LOADED and _STATE.image == image_name:
            return _STATE
        if _STATE.status == ImageLoadStatus.LOADING and _STATE.image == image_name:
            # Un autre appelant a lancé le chargement pendant qu'on attendait
            # le lock : ne PAS relancer un second docker load.
            return _STATE

        # 1. Tester si l'image est déjà chargée sur le daemon
        if await _is_image_loaded(image_name):
            _STATE = ImageLoadState(
                status=ImageLoadStatus.LOADED,
                image=image_name,
                progress_msg="Image déjà présente",
            )
            return _STATE

        # 2. Image absente → trouver l'archive
        archive = find_image_archive(image_name)
        if archive is None:
            candidates = _candidate_tar_paths(image_name)
            _STATE = ImageLoadState(
                status=ImageLoadStatus.NOT_FOUND,
                image=image_name,
                error=(
                    "Archive de l'image introuvable. Cherché dans :\n"
                    + "\n".join(f"  • {p}" for p in candidates)
                    + "\n\nBuild l'image avec deploy/docker/sandbox/build_offline.sh "
                    "et place le .tar.gz dans <app>/sandbox_images/."
                ),
                progress_msg="Archive introuvable",
            )
            return _STATE

        # 3. Lancer docker load
        _STATE = ImageLoadState(
            status=ImageLoadStatus.LOADING,
            image=image_name,
            archive_path=str(archive),
            started_at=time.time(),
            progress_msg=f"Chargement de l'image ({archive.stat().st_size // (1024*1024)} MB)…",
        )

        _LOAD_DONE = asyncio.Event()
        done = _LOAD_DONE
        # Référence FORTE obligatoire (même motif que ``chatbot_app.turn.tasks.keep``
        # et le registre ``_BG_TASKS`` de ``shared_infra/routes/tools.py``) :
        # sans elle la tâche peut être ramassée par le GC avant son premier
        # await → _STATE resterait LOADING à vie.
        #
        # Le chargement part TOUJOURS dans cette tâche de fond suivie, même en
        # ``blocking=True`` ; l'appelant bloquant l'attend (hors du verrou), et
        # son annulation n'interrompt que son attente. Ne pas faire le
        # ``docker load`` DANS la coroutine de l'appelant : annulée (requête
        # abandonnée, ``wait_for`` de ``_create``), elle laisserait le load de
        # 600 Mo tourner en orphelin, ``_STATE`` bloqué en LOADING jusqu'au TTL
        # (400 s) et ``_LOAD_DONE`` jamais posé — les autres appelants
        # bloquants attendraient 330 s pour rien.
        _LOAD_TASK = asyncio.create_task(
            _load_in_background(archive, image_name))

    if blocking:
        try:
            await asyncio.wait_for(asyncio.shield(done.wait()), timeout=330)
        except asyncio.TimeoutError:
            pass
    return _STATE


async def _load_in_background(archive: Path, image_name: str) -> None:
    global _STATE
    started_at = _STATE.started_at
    try:
        try:
            ok, msg = await _docker_load(archive, image_name)
        except asyncio.CancelledError:
            # Shutdown du worker pendant le chargement : état honnête plutôt
            # qu'un LOADING éternel si ce worker survit (SIGHUP partiel).
            _STATE = ImageLoadState(
                status=ImageLoadStatus.ERROR, image=image_name,
                archive_path=str(archive), started_at=started_at,
                finished_at=time.time(),
                error="Chargement interrompu par un redémarrage.",
                progress_msg="Échec",
            )
            raise
        except Exception as exc:
            # Toute exception (fork EAGAIN sous pression mémoire, binaire
            # docker disparu…) finit en ERROR : sinon _STATE resterait en
            # LOADING pour toujours, spinner « Chargement de l'image… » infini
            # sans aucune erreur affichée ni issue possible.
            ok, msg = False, f"Exception pendant docker load : {exc!r}"
            logger.exception("[image-loader] docker load a levé")
        _STATE = ImageLoadState(
            status=ImageLoadStatus.LOADED if ok else ImageLoadStatus.ERROR,
            image=image_name,
            archive_path=str(archive),
            started_at=started_at,
            finished_at=time.time(),
            error=None if ok else msg,
            progress_msg="Image chargée" if ok else "Échec du chargement",
        )
        if ok:
            logger.info("[image-loader] ✓ %s chargée en %.1fs",
                        image_name, _STATE.duration_s if hasattr(_STATE, "duration_s") else 0)
        else:
            logger.error("[image-loader] ✗ %s : %s", image_name, msg)
    finally:
        # Réveille TOUS les waiters blocking=True, quel que soit le chemin.
        if _LOAD_DONE is not None:
            _LOAD_DONE.set()


__all__ = [
    "ImageLoadStatus",
    "ImageLoadState",
    "get_state",
    "reset_state",
    "ensure_image_loaded",
    "find_image_archive",
]
