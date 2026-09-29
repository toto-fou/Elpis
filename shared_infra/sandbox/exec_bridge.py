# SPDX-License-Identifier: MIT
"""
shared_infra.sandbox.exec_bridge — écritures de l'éditeur dans la sandbox,
faites par l'agent de la sandbox (L4.3) : tout /work appartient à l'UID du
conteneur, comme ce que crée le terminal.

Public API
----------
- ``sandbox_write_text`` / ``sandbox_write_bytes`` — écriture atomique.
- ``sandbox_append_chunk`` — un morceau d'un import par morceaux.
- ``sandbox_mkdir``, ``sandbox_delete``, ``sandbox_rename``, ``sandbox_copy``,
  ``sandbox_clear``, ``sandbox_stat_mtime``.
- ``agent_for(user_id)`` / ``agent_http(e, libellé)`` — client de l'agent et
  traduction de ses refus pour les routes.
- ``ensure_container_running(user_id)`` — 503 si le conteneur ne tourne pas.
- ``sandbox_grant_access`` — réaligne les droits d'un chemin écrit par le git
  de l'hôte (jusqu'à L4.4).

Error model
-----------
Chaque helper lève ``HTTPException`` avec un ``detail`` lisible (mêmes
statuts qu'avant : 409 cible existante ou dossier, 403 lien hors /work, 503
conteneur indisponible — le front propose alors de réessayer, 504 délai).
"""
from __future__ import annotations

import asyncio
import logging
import os
import shutil
from pathlib import Path
from typing import Optional

from fastapi import HTTPException

from shared_infra.accounts.users import get_user_settings, get_username_by_id
from shared_infra.sandbox.agent_client import AgentError
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


# ─────────────────────────────────────────────────────────────────────────
#  Opérations par l'agent de la sandbox (L4.3)
# ─────────────────────────────────────────────────────────────────────────
# Refus de l'agent → réponse HTTP de l'éditeur : mêmes statuts et messages
# que les scripts ``docker exec`` d'avant (le front s'y fie ; le détail finit
# tel quel dans un toast).
_HTTP_AGENT = {
    "not_found": (404, "Introuvable"),
    "exists": (409, "Un élément porte déjà ce nom"),
    "is_dir": (409, {"code": "is_dir", "message": "Un dossier porte ce nom"}),
    "not_dir": (409, {"code": "not_dir",
                      "message": "Un élément du chemin est un fichier, pas un dossier"}),
    "not_file": (409, {"code": "not_file",
                       "message": "Ce chemin n'est pas un fichier ordinaire"}),
    "outside_root": (403, "Lien symbolique hors sandbox : écriture refusée"),
    "inside": (400, "Impossible de copier ou déplacer un dossier dans lui-même"),
    "denied": (403, "Accès refusé dans la sandbox"),
    "read_only": (403, "Emplacement en lecture seule"),
    "no_space": (507, "Espace disque de la sandbox épuisé"),
    "too_large": (413, "Contenu trop volumineux"),
    "bad_path": (400, "Chemin invalide"),
    "name_too_long": (400, "Nom trop long"),
    "invalid": (400, "Nom ou chemin invalide"),
    "loop": (400, "Trop de liens symboliques imbriqués"),
    "bad_regex": (400, "Expression régulière invalide"),
    "bad_request": (400, "Requête invalide"),
    "not_empty": (409, "Dossier non vide"),
    "cross_device": (409, "Déplacement impossible entre deux volumes"),
    "changed": (412, {"code": "conflict", "message": "Le fichier a changé sur le disque"}),
}
_INDISPONIBLE = ("agent_unavailable", "container_down", "transport")
#: Pannes de l'agent ou du conteneur — pas un refus portant sur le chemin demandé.
PANNES_AGENT = _INDISPONIBLE + ("bad_response", "timeout")


def agent_http(e: AgentError, err_label: str) -> HTTPException:
    """``AgentError`` → ``HTTPException`` de l'éditeur."""
    if e.code in _INDISPONIBLE:
        return HTTPException(503, "Environnement sandbox arrêté — "
                                  "nouvelle tentative dans quelques instants.")
    if e.code == "bad_response":
        return HTTPException(502, f"{err_label} : réponse invalide de l'environnement sandbox")
    if e.code == "timeout":
        return HTTPException(504, f"{err_label} : délai dépassé")
    statut, detail = _HTTP_AGENT.get(e.code, (500, f"{err_label} : {e.code}"))
    return HTTPException(statut, detail)


def agent_for(user_id: int):
    """Client de l'agent de la sandbox du compte (démarré au besoin)."""
    return _get_sandbox_for_user(user_id).agent


async def _agent(user_id: int, err_label: str, op):
    """``await op(agent)`` ; un refus de l'agent en ``HTTPException``."""
    try:
        return await op(agent_for(user_id))
    except AgentError as e:
        raise agent_http(e, err_label) from None


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
async def sandbox_write_text(user_id: int, rel_path: str, content: str) -> None:
    """Écriture atomique d'un texte par l'agent : un lien est suivi sous /work
    (sa cible est écrite, le lien reste — E17), un dossier à ce nom est
    refusé (E25), le mode d'un fichier existant est gardé."""
    rp = _validate_rel_path(rel_path)
    try:
        data = content.encode("utf-8")
    except UnicodeEncodeError:
        # E27 — surrogate isolé (JSON ``"\ud800"``) : 400, pas une 500.
        raise HTTPException(400, "Contenu invalide (caractère non encodable)")
    await _agent(user_id, "Sauvegarde", lambda a: a.write(rp, data, parents=True))


async def sandbox_write_bytes(user_id: int, rel_path: str, data: bytes) -> None:
    """Écriture atomique d'octets par l'agent (mêmes règles)."""
    rp = _validate_rel_path(rel_path)
    await _agent(user_id, "Upload", lambda a: a.write(rp, data, parents=True))


async def sandbox_append_chunk(user_id: int, rel_path: str, data: bytes, *, truncate: bool) -> int:
    """Un morceau d'un import par morceaux, écrit par l'agent dans le fichier
    provisoire : ni le client ni le serveur ne gardent le fichier entier en
    mémoire. ``truncate`` : 1er morceau (dossiers créés, fichier vidé) ;
    sinon ajout au fichier existant (absent : 404). Jamais rejoué une fois
    envoyé (F24). Rend la taille du fichier provisoire."""
    rp = _validate_rel_path(rel_path)
    r = await _agent(user_id, "Upload (chunk)",
                     lambda a: a.append(rp, data, parents=truncate, truncate=truncate))
    return int(r.get("size") or 0)


async def sandbox_mkdir(user_id: int, rel_path: str) -> None:
    rp = _validate_rel_path(rel_path)
    await _agent(user_id, "Création dossier", lambda a: a.fsop("mkdir", path=rp, parents=True))


async def sandbox_delete(user_id: int, rel_path: str) -> None:
    """Supprime un fichier, un lien (lui-même) ou un dossier (récursivement) ;
    absent : rien. La racine est refusée."""
    # Alias de la racine ('/work'|'work'|'./work'|'') AVANT _validate_rel_path,
    # qui les réduit à '' avec le refus générique « Chemin requis ».
    if strip_work_prefix(rel_path).strip() in ("", "."):
        raise HTTPException(400, "Cible invalide pour suppression")
    rp = _validate_rel_path(rel_path)
    norm = rp.strip("/")
    if not norm or norm in (".", "/work", "work"):
        raise HTTPException(400, "Cible invalide pour suppression")
    await _agent(user_id, "Suppression",
                 lambda a: a.fsop("remove", path=rp, recursive=True, missing_ok=True))


async def sandbox_rename(user_id: int, old_rel: str, new_rel: str, *,
                         overwrite: bool = False) -> None:
    """Renommage par l'agent (dossiers de la destination créés). Une cible
    existante est refusée ; ``overwrite=True`` (promotion du ``.part`` d'un
    import par morceaux, E4) : un FICHIER est remplacé, jamais un dossier."""
    old = _validate_rel_path(old_rel)
    new = _validate_rel_path(new_rel)
    await _agent(user_id, "Renommage", lambda a: a.fsop(
        "rename", src=old, dst=new, overwrite=overwrite, parents=True))


async def sandbox_copy(user_id: int, src_rel: str, dst_rel: str) -> None:
    """Copie d'un fichier ou d'un dossier (modes gardés, liens copiés tels
    quels, comme ``cp -a``) ; une cible existante est refusée."""
    src = _validate_rel_path(src_rel)
    dst = _validate_rel_path(dst_rel)
    await _agent(user_id, "Copie", lambda a: a.fsop("copy", src=src, dst=dst, parents=True))


async def sandbox_clear(user_id: int) -> int:
    """Vide /work (pas /work lui-même), au mieux : ce qui résiste reste en
    place (journalisé) ; nombre d'entrées retirées."""
    r = await _agent(user_id, "Vidage sandbox", lambda a: a.fsop("clear"))
    if r.get("failed"):
        logger.warning("[sandbox] vidage de la sandbox %s : %s entrée(s) non supprimée(s)",
                       user_id, r.get("failed"))
    return int(r.get("removed") or 0)


async def sandbox_stat_mtime(user_id: int, rel_path: str) -> Optional[float]:
    """mtime (s) par l'agent ; ``None`` sur toute erreur."""
    rp = _validate_rel_path(rel_path)
    try:
        (e,) = await agent_for(user_id).stat([rp])
    except (AgentError, ValueError):
        return None
    ns = e.get("mtime_ns")
    if not isinstance(ns, int):
        return None
    return float(ns // 1_000_000_000) + (ns % 1_000_000_000) * 1e-9   # comme st_mtime
