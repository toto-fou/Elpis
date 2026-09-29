# SPDX-License-Identifier: MIT
"""
backend.routes._sandbox_exec — Funnel FS mutations through the user's
Docker container so all files in the sandbox share UID 10001 ownership.

Why this exists
---------------
The /work bind-mount is shared between two writers:

  • the FastAPI host process (running as the operator's UID, e.g. ``elpis``
    or root), which used to call ``Path.write_text`` / ``shutil.rmtree``
    directly for save/upload/mkdir/delete/rename routes, AND
  • the per-user Docker container (running as UID 10001) used by the
    integrated terminal, by ``docker exec`` from MCP tools, and by the
    agentic executors.

Different UIDs → different ownership on each side. Default umask + 0644
permissions meant the container could only READ host-written files
(no write/delete), and the host could not remove container-created
directories. Symptom : "I created the folder in terminal, can't delete
it from the editor" or vice versa.

The fix this module implements
------------------------------
All write/delete/rename operations from the editor routes go through
``UserSandbox.exec()`` (which is ``docker exec --user 10001:10001 …``).
Every file produced is then owned by UID 10001 — same as everything the
terminal creates. The mismatch class disappears.

Reads (download, tree walk, stat) stay on the host because :
  - they don't need write permission ;
  - the container-side umask wrapper makes new files 0664 / dirs 0775
    (mode 0002), so "other" has at least read access.

If a file is stuck at 0600 (rare, only if the agent explicitly
chmod'd), the read fallback is to ``docker exec cat`` it — handled
in ``sandbox_read_bytes``.

Public API
----------
- ``sandbox_write_text(user_id, rel_path, content)`` — atomic-ish text write.
- ``sandbox_write_bytes(user_id, rel_path, data)`` — atomic-ish binary write.
- ``sandbox_mkdir(user_id, rel_path)`` — recursive mkdir.
- ``sandbox_delete(user_id, rel_path)`` — rm -rf (file or directory).
- ``sandbox_rename(user_id, old_rel, new_rel)`` — mv (with mkdir -p of parent).
- ``sandbox_read_bytes(user_id, rel_path)`` — read with docker-cat fallback.
- ``sandbox_stat_mtime(user_id, rel_path)`` — best-effort mtime probe.
- ``ensure_container_running(user_id)`` — raises HTTPException(503) if not.

Error model
-----------
Every helper raises ``HTTPException`` on failure with a human-readable
``detail``. The 503 path tells the frontend the container needs starting
— the editor already has a UX for that (overlay + retry in
``_ensureSandboxContainerReady``).
"""
from __future__ import annotations

import asyncio
import logging
import os
import secrets
import shutil
from pathlib import Path
from typing import Optional

from fastapi import HTTPException

from shared_infra.accounts.users import get_user_settings, get_username_by_id
from shared_infra.sandbox.executors import get_user_sandbox
from shared_infra.sandbox.paths import strip_work_prefix

logger = logging.getLogger("uvicorn.error")


# Cap each individual docker exec — most FS ops finish in <100 ms, but
# upload of a large file or a wide rmtree may legitimately take longer.
_DEFAULT_TIMEOUT_S = 60

# UID/GID du user in-container (elpis). Tout /work est censé lui appartenir
# (cf. docstring module) ; les écritures HOST (git clone/init) le violent.
_SANDBOX_UID = 10001
_SANDBOX_GID = 10001


async def sandbox_grant_access(user_id: int, rel_path: str) -> None:
    """Ré-aligne un chemin écrit côté HÔTE (ex. ``git clone`` host-side) sur le
    modèle d'ownership UID-10001 du sandbox, pour que le user in-container puisse
    le modifier.

    Le sous-système git tourne sur l'HÔTE (``_git_run``) sous l'UID du process
    app : un dossier fraîchement cloné appartient donc à cet UID et le container
    (UID 10001) se prend un « permission denied » en édition/suppression
    (« j'ai cloné un repo mais je ne peux pas l'éditer »). Tout le reste de /work
    est en UID 10001 (cf. docstring module) — on rétablit l'invariant.

    Best-effort, ne lève JAMAIS (l'opération git a déjà réussi) :
      1. ACL POSIX (côté hôte ; l'app possède les fichiers frais → pas besoin de
         root) : accorde rwX à l'UID sandbox ET à l'UID hôte, AVEC une ACL
         ``default`` pour que les fichiers créés ENSUITE par le git host-side
         (checkout/pull/merge) héritent du droit et restent éditables des deux
         côtés. C'est CE qui lève le « permission denied », durablement.
      2. ``chown -R 10001:10001`` via ``docker exec -u 0`` quand le container
         tourne, pour que l'ownership colle cosmétiquement au reste de /work.
         L'ACL de l'étape 1 garde le panneau git host-side fonctionnel sur le
         repo désormais 10001.
    """
    # ⚠ RÉSOLUTION — passer par ``_get_sandbox_for_user`` (arité 1), JAMAIS par
    # ``get_user_sandbox`` directement : celui-ci exige ``(user_id, username,
    # sandbox_path)``. L'appel historique ``get_user_sandbox(user_id)`` levait un
    # TypeError avalé par ce ``except`` → grant TOTALEMENT inerte (aucune ACL,
    # aucun chmod, aucun chown) après chaque clone/init/pull host-side, d'où le
    # « j'ai cloné mais je ne peux pas éditer » côté conteneur.
    try:
        sb = _get_sandbox_for_user(user_id)
        root = Path(sb.sandbox_path).resolve()
    except Exception as e:                                        # noqa: BLE001
        # Plus JAMAIS silencieux : un échec de résolution rend le grant inerte.
        logger.warning("[sandbox] grant_access: sandbox introuvable pour "
                       "user_id=%s (%s) — permissions NON réalignées", user_id, e)
        return
    rel = (strip_work_prefix(rel_path) or "").strip("/")
    target = (root / rel).resolve() if rel else root
    # Anti-traversée : la cible DOIT rester dans /work.
    try:
        target.relative_to(root)
    except ValueError:
        return
    if not target.exists():
        return

    # 1. ACL host-side (le fix fonctionnel fiable, sans root, survit au durcissement).
    setfacl = shutil.which("setfacl")
    if setfacl:
        acl_spec = f"u:{_SANDBOX_UID}:rwX,u:{os.getuid()}:rwX"
        for extra in ([], ["-d"]):          # ACL d'accès, puis ACL default (héritage)
            await _run_bounded([setfacl, "-R", *extra, "-m", acl_spec, str(target)], 120)

    # 1bis. Fallback chmod host-side — ne dépend NI de setfacl (souvent absent)
    # NI du container (docker down = étape 2 muette). L'app POSSÈDE les
    # fichiers fraîchement écrits côté hôte → chmod permis. On rétablit
    # l'invariant /work « cross-writable » (0666/0777 : hôte et conteneur
    # n'ont aucun groupe commun) — c'est CE qui rend le repo éditable et
    # supprimable par le shell in-container même si le chown de l'étape 2
    # n'a pas pu s'exécuter. Best-effort : fichiers d'autrui → skip.
    try:
        from shared_infra.sandbox.paths import widen_beneath
        await asyncio.wait_for(asyncio.to_thread(
            widen_beneath, root, target.relative_to(root).as_posix(), recursive=True),
            timeout=120)
    except Exception:
        pass

    # 2. chown cosmétique via root in-container (best-effort ; skip si container down).
    docker = shutil.which("docker") or "/usr/bin/docker"
    # ``timeout -k`` CÔTÉ CONTENEUR : tuer le client ``docker exec`` ne tue
    # pas le ``chown -R`` qui tourne dedans.
    await _run_bounded([docker, "exec", "-u", "0:0", sb.container_name,
                        "timeout", "-k", "5", "110",
                        "chown", "-R", f"{_SANDBOX_UID}:{_SANDBOX_GID}",
                        ("/work/" + rel) if rel else "/work"], 120)


async def _run_bounded(argv, timeout_s: float) -> None:
    """Lance ``argv`` sans sortie, borné : au délai (ou à l'annulation) le
    process est TUÉ et récolté. Passe sandbox 2026-09-26 — avant, le
    ``wait_for`` expirait, l'exception était avalée et le ``setfacl -R`` /
    ``chown -R`` continuait en orphelin sur un gros dépôt (node_modules),
    passes récursives empilées à chaque action git. Best-effort, ne lève pas
    (sauf annulation, propagée)."""
    try:
        p = await asyncio.create_subprocess_exec(
            *argv, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
    except Exception:                                            # noqa: BLE001
        return
    try:
        await asyncio.wait_for(p.wait(), timeout=timeout_s)
    except BaseException as e:
        try:
            p.kill()
        except ProcessLookupError:
            pass
        try:
            await asyncio.shield(asyncio.wait_for(p.wait(), timeout=5))
        except Exception:                                        # noqa: BLE001
            pass
        if not isinstance(e, asyncio.TimeoutError):
            raise


def _user_sandbox_dir(username: str) -> Path:
    """Mirror of routes.user_sandbox._user_sandbox_dir. Re-declared here
    to avoid an import cycle (this module is imported by sandbox_files,
    which is imported indirectly by user_sandbox transitively)."""
    # The mount source is the WORK root ``P/work``; the caller resolves it via
    # ``_get_work_path(user_id)`` directly (we don't have a user_id here).
    # Kept as documentation only.
    raise NotImplementedError("Use _get_work_path(user_id) instead")


def _get_sandbox_for_user(user_id: int):
    """Resolve a UserSandbox for ``user_id`` using the user's EFFECTIVE
    network profile (admin override > user choice), mirroring
    routes.user_sandbox._user_sandbox_for without importing it (would cycle)."""
    from shared_infra.routes._helpers import _get_work_path
    from shared_infra.sandbox.executors import resolve_network_profile_id
    settings = get_user_settings(user_id) or {}
    profile_id = resolve_network_profile_id(settings)
    username = get_username_by_id(user_id) or f"user_{user_id}"
    # The mount source is the WORK root ``P/work`` (resolved BEFORE building
    # the UserSandbox, so the one-time flat→work migration runs first).
    sandbox_dir = _get_work_path(user_id)
    return get_user_sandbox(
        user_id, username, sandbox_dir,
        network_profile_id=profile_id,
    )


async def ensure_container_running(user_id: int) -> None:
    """Raise HTTPException(503) if the user's container is not running.

    Does NOT attempt to start it — the editor frontend has a dedicated UX
    flow for that (`_ensureSandboxContainerReady`). We just gate writes
    on a clean error so the frontend can prompt the user to spin up the
    container if they bypassed the editor open path."""
    sb = _get_sandbox_for_user(user_id)
    try:
        st = await asyncio.wait_for(sb.status(), timeout=5)
    except (asyncio.TimeoutError, Exception):
        st = None
    if not st or not st.running:
        raise HTTPException(
            503,
            "Sandbox container non démarré. Ouvrez le terminal pour le lancer "
            "(POST /api/sandbox/me).",
        )


def _looks_dead(stderr) -> bool:
    """True if a docker-exec stderr indicates the container is gone/stopped.

    Happens when the readiness cache served a stale "running" for a container
    that has since crashed or been idle-stopped within its TTL window.
    """
    s = stderr.decode("utf-8", "replace") if isinstance(stderr, (bytes, bytearray)) else str(stderr or "")
    s = s.lower()
    return "no such container" in s or "is not running" in s


async def _exec_in_sandbox(
    user_id: int,
    cmd: list[str],
    *,
    stdin_bytes: Optional[bytes] = None,
    timeout: int = _DEFAULT_TIMEOUT_S,
    err_label: str = "Opération",
    retry_on_dead: bool = True,
) -> bytes:
    """Run ``cmd`` inside the user's container as UID 10001 and return
    stdout bytes on success. Raises HTTPException on non-zero rc / timeout.

    NB: we call ``sb.exec`` which already wraps with ``sh -c 'umask 0000;
    exec "$@"' --`` so any files we create have mode 0666/0777 (other-
    writable → the host UID can also overwrite/delete them; host and
    container share no group, so group-writable would not suffice).
    """
    sb = _get_sandbox_for_user(user_id)
    # Make sure the container is running before exec (auto-start if needed).
    # ensure_running is idempotent and cached.
    try:
        st = await asyncio.wait_for(sb.ensure_running(), timeout=30)
    except asyncio.TimeoutError:
        raise HTTPException(503, "Timeout démarrage container sandbox")
    except Exception as e:
        raise HTTPException(503, f"Container sandbox indisponible : {e}")
    if not st.running:
        raise HTTPException(503, "Sandbox container non démarré")

    try:
        result = await sb.exec(
            cmd,
            stdin_bytes=stdin_bytes,
            timeout_s=timeout,
        )
    except Exception as e:
        raise HTTPException(500, f"{err_label} : exec failed ({e})")

    # Stale-readiness recovery: the cache can report "running" for a container
    # that has since died, so this exec hit "no such container". MOST
    # _sandbox_exec ops are IDEMPOTENT (write-tmp+mv, mkdir -p, rm -rf, mv), and
    # sb.exec() has already invalidated the readiness cache on this stderr, so
    # a fresh ensure_running() recreates the container. Retry exactly ONCE so
    # the editor save/upload succeeds transparently instead of erroring.
    # F24 — SAUF si l'op N'EST PAS idempotente (append `cat >>`) : si le
    # conteneur meurt après avoir consommé une PARTIE du stdin, rejouer le chunk
    # ENTIER le ré-appende → fichier corrompu (préfixe partiel + chunk complet).
    # Pour ces ops on remonte l'erreur (503) et le client relance l'upload.
    if (retry_on_dead and not result.timed_out and result.returncode != 0
            and _looks_dead(result.stderr)):
        try:
            st = await asyncio.wait_for(sb.ensure_running(), timeout=30)
            if st.running:
                result = await sb.exec(cmd, stdin_bytes=stdin_bytes, timeout_s=timeout)
        except Exception:
            pass  # fall through to the 503 mapping below

    if result.timed_out:
        raise HTTPException(504, f"{err_label} : timeout après {timeout}s")
    if result.returncode != 0:
        err_txt = (result.stderr or b"").decode("utf-8", errors="replace").strip()
        # A dead/stopped container maps to 503 (not 500): the frontend
        # branches on 503 (saveEditorContent invalidates its readiness cache
        # and shows a user-facing retry message) — instead of a confusing
        # raw 500. The detail stays user-readable: it can end up verbatim
        # in a toast, so no API instructions here.
        if _looks_dead(err_txt):
            raise HTTPException(
                503, "Environnement sandbox arrêté — "
                     "nouvelle tentative dans quelques instants.")
        # Convention des scripts de ce module : ``exit 17`` = la cible existe
        # déjà (re-vérification DANS le conteneur, juste avant ``mv``/``cp``).
        if result.returncode == 17:
            raise HTTPException(409, "Un élément porte déjà ce nom")
        # ``exit 18`` : lien symbolique dont la cible sort de /work ;
        # ``exit 21`` : la cible est un dossier (audit éditeur 2026-09-23,
        # E17 / E25 — re-vérifiés dans le conteneur, au plus près du ``mv``).
        if result.returncode == 18:
            raise HTTPException(403, "Lien symbolique hors sandbox : écriture refusée")
        if result.returncode == 21:
            raise HTTPException(409, {"code": "is_dir",
                                      "message": "Un dossier porte ce nom"})
        # Couper le message pour ne pas laisser fuite verbeuse vers le client.
        snippet = err_txt[:300] or f"rc={result.returncode}"
        raise HTTPException(500, f"{err_label} : {snippet}")
    return result.stdout or b""


def _validate_rel_path(rel_path: str) -> str:
    """Reject obvious attempts to escape /work via ``..`` or absolute paths.
    Container side ALSO can't escape thanks to the mount, but we keep this
    as a fail-fast at the route boundary so we don't even spawn docker exec
    for malformed requests.
    """
    if not isinstance(rel_path, str) or not rel_path.strip():
        raise HTTPException(400, "Chemin requis")
    # Normalize the container view (/work, work, ./work) using the shared
    # rule so the editor and the MCP tools agree on what a path means. This
    # only ADDS acceptance of the /work-prefixed forms; the string-level
    # rejections below are unchanged (container ops run as $1 inside the
    # mount, so the kernel boundary — not this check — is the real fence).
    rp = strip_work_prefix(rel_path)
    if not rp.strip():
        raise HTTPException(400, "Chemin requis")
    if rp.startswith("/") or rp.startswith("\\"):
        raise HTTPException(400, "Chemin absolu refusé — utiliser un chemin relatif")
    # Block any segment that resolves up. /work/.. would escape the bind
    # mount to the container root.
    parts = rp.replace("\\", "/").split("/")
    if any(p == ".." for p in parts):
        raise HTTPException(403, "Chemin avec '..' refusé")
    return rp


# ─────────────────────────────────────────────────────────────────────────
#  Public helpers
# ─────────────────────────────────────────────────────────────────────────
# Écriture « tmp puis mv ». Le fichier temporaire est NEUF : sans le ``chmod
# --reference``, réenregistrer un script exécutable lui faisait perdre son bit
# ``x`` (git voyait un changement de mode, le script ne se lançait plus) — un
# remplacement multi-fichiers l'aurait fait sur tout un dépôt. Best-effort
# (``|| true``) : une image sans coreutils garde l'ancien comportement.
#
# Audit éditeur 2026-09-23 :
# * E17 — un LIEN SYMBOLIQUE est suivi : on écrit DANS sa cible et le lien
#   reste (``mv tmp "$1"`` remplaçait le lien par une copie ordinaire, alors
#   que l'outil de l'assistant écrit bien la cible). La cible résolue doit
#   rester sous la racine (``$2``, ``/work`` dans le conteneur) : sinon refus
#   (``exit 18``).
# * E25 — une cible devenue DOSSIER est refusée (``exit 21``) : ``mv`` y
#   rangeait le fichier sous un nom temporaire, réponse 200.
# * E29 — le temporaire (``<cible>.tmp.<jeton>``, jeton fourni en ``$3``) est
#   supprimé sur tout échec (``trap``) ; si le conteneur meurt en route,
#   l'appelant le retire par son nom exact (``_WRITE_CLEANUP_SCRIPT``).
_CONTAINER_ROOT = "/work"

_RESOLVE_TARGET = (
    't="$1"; r="$(cd "$2" && pwd -P)"; '
    'if [ -L "$t" ]; then '
    't="$(readlink -f -- "$t")" || { echo "lien symbolique illisible" >&2; exit 18; }; '
    'case "$t" in "$r"/*) ;; *) echo "lien symbolique hors sandbox" >&2; exit 18;; esac; '
    'fi; '
)

_WRITE_SCRIPT = (
    'set -e; '
    + _RESOLVE_TARGET +
    'if [ -d "$t" ]; then echo "un dossier porte ce nom" >&2; exit 21; fi; '
    'mkdir -p "$(dirname "$t")"; '
    'tmp="$t.tmp.$3"; '
    "trap 'rm -f -- \"$tmp\"' EXIT HUP INT TERM; "
    'cat > "$tmp"; '
    'if [ -f "$t" ]; then '
    'chmod --reference="$t" "$tmp" 2>/dev/null || true; fi; '
    'mv -f -- "$tmp" "$t"; '
    'trap - EXIT HUP INT TERM'
)

# Nettoyage du temporaire d'une écriture interrompue (E29) : même résolution
# de la cible que l'écriture, puis ``rm -f`` du SEUL nom exact.
_WRITE_CLEANUP_SCRIPT = (
    _RESOLVE_TARGET + 'rm -f -- "$t.tmp.$3"'
)


async def _write_via_container(user_id: int, rp: str, data: bytes, err_label: str) -> None:
    """Écriture atomique commune (texte et binaire) — cf. ``_WRITE_SCRIPT``."""
    token = f"{os.getpid()}-{secrets.token_hex(4)}"
    try:
        await _exec_in_sandbox(
            user_id,
            ["sh", "-c", _WRITE_SCRIPT, "_", rp, _CONTAINER_ROOT, token],
            stdin_bytes=data,
            err_label=err_label,
        )
    except HTTPException as he:
        # E29 — le ``trap`` couvre l'échec DANS le script ; un conteneur tué
        # ou un délai dépassé (504/503) peuvent laisser le temporaire. Retrait
        # best-effort, sans jamais masquer l'erreur d'origine.
        if he.status_code in (500, 503, 504):
            try:
                await _exec_in_sandbox(
                    user_id,
                    ["sh", "-c", _WRITE_CLEANUP_SCRIPT, "_", rp, _CONTAINER_ROOT, token],
                    timeout=10, err_label="Nettoyage", retry_on_dead=False,
                )
            except Exception:                                   # noqa: BLE001
                pass
        raise


async def sandbox_write_text(user_id: int, rel_path: str, content: str) -> None:
    """Atomic-ish text write inside the container. UID 10001 ownership.

    Pattern: ``mkdir -p $(dirname …) && cat > path.tmp && mv path.tmp path``.
    cat-from-stdin is the simplest way to plumb arbitrary content through
    docker exec without arg-list length limits or quoting headaches.
    """
    rp = _validate_rel_path(rel_path)
    # The path is passed as a POSITIONAL argument ($1) — never interpolated
    # into the shell string — so it can contain spaces, quotes, $, ;, etc.
    # without injection risk.
    try:
        data = content.encode("utf-8")
    except UnicodeEncodeError:
        # E27 — surrogate isolé (JSON ``"\ud800"``) : 400, pas une 500.
        raise HTTPException(400, "Contenu invalide (caractère non encodable)")
    await _write_via_container(user_id, rp, data, "Sauvegarde")


async def sandbox_write_bytes(user_id: int, rel_path: str, data: bytes) -> None:
    """Atomic-ish binary write inside the container."""
    rp = _validate_rel_path(rel_path)
    await _write_via_container(user_id, rp, data, "Upload")


async def sandbox_append_chunk(user_id: int, rel_path: str, data: bytes, *, truncate: bool) -> None:
    """Écrit un chunk d'octets dans un fichier du container, en streaming.

    Utilisé par l'upload chunké des GROS fichiers : ni le client ni le serveur
    ne bufferisent le fichier entier en RAM (chaque appel ne porte qu'un chunk
    borné, ~8 Mo). Le ``sandbox_write_bytes`` aurait chargé 1 Go en mémoire
    côté serveur (read complet) ET re-passé 1 Go via stdin → OOM du worker.

    truncate=True  → 1er chunk : mkdir -p du parent puis création/écrasement.
    truncate=False → chunks suivants : append (``>>``).
    """
    rp = _validate_rel_path(rel_path)
    if truncate:
        # Idempotent (écrasement) → retry-once OK.
        script = 'set -e; mkdir -p "$(dirname "$1")"; cat > "$1"'
        _idempotent = True
    else:
        # Append NON idempotent : pas de retry silencieux (F24).
        script = 'set -e; cat >> "$1"'
        _idempotent = False
    await _exec_in_sandbox(
        user_id,
        ["sh", "-c", script, "_", rp],
        stdin_bytes=data,
        err_label="Upload (chunk)",
        retry_on_dead=_idempotent,
    )


async def sandbox_mkdir(user_id: int, rel_path: str) -> None:
    rp = _validate_rel_path(rel_path)
    await _exec_in_sandbox(
        user_id,
        ["mkdir", "-p", rp],
        err_label="Création dossier",
    )


async def sandbox_delete(user_id: int, rel_path: str) -> None:
    """rm -rf the path. Refuses to delete the sandbox root itself."""
    # Catch the root aliases ('/work'|'work'|'./work'|'') BEFORE _validate_rel_path
    # strips them to '' and raises the generic "Chemin requis": deleting the
    # sandbox root is a distinct, clearer refusal.
    if strip_work_prefix(rel_path).strip() in ("", "."):
        raise HTTPException(400, "Cible invalide pour suppression")
    rp = _validate_rel_path(rel_path)
    # /work IS the bind mount root inside the container. Refuse to rm it.
    norm = rp.strip("/")
    if not norm or norm in (".", "/work", "work"):
        raise HTTPException(400, "Cible invalide pour suppression")
    await _exec_in_sandbox(
        user_id,
        ["rm", "-rf", "--", rp],
        timeout=120,   # large trees can take longer
        err_label="Suppression",
    )


async def sandbox_rename(user_id: int, old_rel: str, new_rel: str, *,
                         overwrite: bool = False) -> None:
    """``mv`` dans le conteneur. ``overwrite=True`` (réservé à la promotion
    du ``.part`` d'un import chunké, audit éditeur 2026-09-23, E4) : un
    FICHIER existant est remplacé, un dossier reste refusé (``exit 21``)."""
    old = _validate_rel_path(old_rel)
    new = _validate_rel_path(new_rel)
    # mkdir parent then mv. Atomic at filesystem level (same /work).
    # La route refuse une cible existante ; on le RE-vérifie ici, au plus près
    # du ``mv`` (une cible créée entre-temps par le terminal ou l'assistant
    # était écrasée). ``-T`` : ne jamais déplacer DANS un dossier homonyme.
    if overwrite:
        script = (
            'set -e; '
            'if [ -d "$2" ] && [ ! -L "$2" ]; then echo "un dossier porte ce nom" >&2; exit 21; fi; '
            'mkdir -p "$(dirname "$2")"; '
            'mv -f -T -- "$1" "$2" 2>/dev/null || mv -f -- "$1" "$2"'
        )
    else:
        script = (
            'set -e; '
            'if [ -e "$2" ] || [ -L "$2" ]; then echo "cible existante" >&2; exit 17; fi; '
            'mkdir -p "$(dirname "$2")"; '
            'mv -T -- "$1" "$2" 2>/dev/null || mv -- "$1" "$2"'
        )
    await _exec_in_sandbox(
        user_id,
        ["sh", "-c", script, "_", old, new],
        err_label="Renommage",
    )


async def sandbox_copy(user_id: int, src_rel: str, dst_rel: str) -> None:
    """Copie un fichier ou un dossier (``cp -a``) dans le conteneur. La cible
    ne doit pas exister : la route le vérifie, le script le re-vérifie
    (``-e`` suit la même vue que ``cp``)."""
    src = _validate_rel_path(src_rel)
    dst = _validate_rel_path(dst_rel)
    script = (
        'set -e; '
        'if [ -e "$2" ] || [ -L "$2" ]; then echo "cible existante" >&2; exit 17; fi; '
        'mkdir -p "$(dirname "$2")"; '
        'cp -a -- "$1" "$2"'
    )
    await _exec_in_sandbox(
        user_id,
        ["sh", "-c", script, "_", src, dst],
        timeout=120,
        err_label="Copie",
    )


async def sandbox_clear(user_id: int) -> int:
    """Wipe /work content (NOT /work itself — that's the bind mount
    point). Returns the number of top-level entries removed. Best-effort
    on individual failures inside the loop, but the whole call fails if
    the exec itself can't run."""
    # Use shell glob; * doesn't match dotfiles so we use .[!.]* and ..?* to
    # catch them too. ``rm -rf`` on a non-existent glob expands to literal
    # which rm -f silently ignores (no error).
    script = (
        'set -e; '
        'before=$(ls -A /work 2>/dev/null | wc -l); '
        'rm -rf /work/* /work/.[!.]* /work/..?* 2>/dev/null || true; '
        'echo "$before"'
    )
    out = await _exec_in_sandbox(
        user_id, ["sh", "-c", script],
        timeout=300, err_label="Vidage sandbox",
    )
    try:
        return int(out.decode().strip() or "0")
    except (ValueError, AttributeError):
        return 0


async def sandbox_stat_mtime(user_id: int, rel_path: str) -> Optional[float]:
    """Probe st_mtime via the container. Useful when host stat fails on a
    file with no "other" read perm. Returns None on any error."""
    rp = _validate_rel_path(rel_path)
    try:
        out = await _exec_in_sandbox(
            user_id,
            # GNU stat is available in the base image; -c %Y prints mtime
            # as Unix seconds (integer).
            ["stat", "-c", "%Y", "--", rp],
            timeout=10,
            err_label="Stat",
        )
        return float(out.decode().strip())
    except (HTTPException, ValueError):
        return None
