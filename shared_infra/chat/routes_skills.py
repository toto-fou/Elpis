# SPDX-License-Identifier: MIT
"""
shared_infra/chat/routes_skills.py — endpoints API CRUD pour les skills (mémoire procédurale).

Alimente l'UI de gestion des skills. Un skill = un fichier markdown avec
frontmatter (cf. ``skills/_TEMPLATE.md``) réparti sur trois scopes :

* ``global``  — curé, versionné au repo (``skills/``)              — admin
* ``learned`` — proposé par l'agent, en attente de promotion (``skills/learned/``)
* ``user``    — perso, dans la sandbox de l'appelant (``<sandbox>/skills/``)

Pas de stockage parallèle : toute mutation passe par les écrivains de
``llm_core.skills`` qui émettent des ``.md`` aux emplacements canoniques. Pas de
router local : on accroche les endpoints sur le ``router`` partagé de ``_state``.

Permissions
-----------
* Lecture (list/get) : tout utilisateur authentifié (``require_user_id``).
* Perso (``user``) create/update/delete : authentifié — ne touche QUE sa sandbox.
* ``learned``/``global`` create/update/delete + promotion : ADMIN
  (``_require_admin``) — visibles cross-user dans le system prompt de tous (audit
  CRIT-1) : acte de curation/modération.

Le *chargement* des skills (injection déterministe dans le system prompt) vit
ailleurs (``llm_core/_system_prompts.py``). Routes d'INFRA : chargées quel que
soit le profil applicatif (le chatbot utilise la fonctionnalité skills).
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from fastapi import File, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, Response

from llm_core import skills as _skills
from llm_core.skills import SkillExistsError, SkillSaveError
from shared_infra.routes._state import router
from shared_infra.security.deps import require_user_id

# ─────────────────────────────────────────────────────────────────────────
#  Helpers
# ─────────────────────────────────────────────────────────────────────────

def _require_admin(request: Request) -> int:
    """Délègue au gate admin partagé (401 non-loggé / 403 non-admin)."""
    from shared_infra.routes._legacy import _require_admin as _ra
    return _ra(request)


def _user_sandbox_root(user_id: Optional[int]) -> Optional[Path]:
    """Racine de la sandbox perso (où vit le MIROIR ``skills/``). Best-effort."""
    if user_id is None:
        return None
    try:
        from shared_infra.routes._legacy import _get_sandbox_path
        root = _get_sandbox_path(user_id)
        return Path(root) if root else None
    except Exception:
        return None


def _user_skills_dir(user_id: Optional[int]) -> Optional[Path]:
    """STORE protégé des skills perso (HORS sandbox). Best-effort → None.

    La sandbox ne contient qu'une copie de travail ``<sandbox>/skills/``
    (miroir, re-synchronisé par ``_sync_user_mirror`` après chaque mutation).
    Migre l'ancien emplacement sandbox à la première résolution."""
    if user_id is None:
        return None
    try:
        from llm_core.skills import ensure_user_skills_store
        from shared_infra.accounts.users import get_username_by_id
        from shared_infra.config import USER_SKILLS_DIR, safe_sandbox_name
        username = get_username_by_id(user_id) or f"user_{user_id}"
        store = Path(USER_SKILLS_DIR) / safe_sandbox_name(username)
        return ensure_user_skills_store(store, _user_sandbox_root(user_id))
    except Exception:
        return None


def _sync_user_mirror(user_id: Optional[int]) -> None:
    """Rafraîchit la copie sandbox depuis le store (après une mutation user).
    (2026-09-12, P4) et la POUSSE vers l'hôte d'outils du compte s'il est
    distant (``skill_run_script`` y lit le miroir)."""
    try:
        from llm_core.skills import sync_user_skills_mirror
        sync_user_skills_mirror(_user_skills_dir(user_id), _user_sandbox_root(user_id))
    except Exception:                                  # best-effort, jamais bloquant
        pass
    try:
        from shared_infra.sandbox.relay import push_skills_mirror
        if user_id is not None:
            push_skills_mirror(int(user_id), _user_skills_dir(user_id))
    except Exception:                                  # best-effort, jamais bloquant
        pass


def _require_user_skills_dir(user_id: Optional[int]) -> Path:
    """Comme ``_user_skills_dir`` mais lève 500 si le store est introuvable."""
    d = _user_skills_dir(user_id)
    if d is None:
        raise HTTPException(500, "store de skills utilisateur introuvable")
    return d


async def _json_body(request: Request) -> Dict[str, Any]:
    try:
        data = await request.json()
    except Exception:
        data = {}
    if not isinstance(data, dict):
        raise HTTPException(400, "body JSON attendu")
    return data


def _validate_scope(scope: Optional[str], default: str = "user") -> str:
    scope = (scope or default).strip().lower()
    if scope not in ("user", "learned", "global"):
        raise HTTPException(400, "scope doit être user, learned ou global")
    return scope


def _find_spec(name: str, user_id: Optional[int], scope: Optional[str] = None):
    """SkillSpec pour ``name`` ou None. Match sur le ``name`` exact OU le slug.

    Sans ``scope`` : vue fusionnée (précédence user>learned>global). Avec
    ``scope`` : inventaire RÉEL de ce scope (un-merged) — indispensable pour que
    View/Edit ciblent l'entrée réellement cliquée (un ``global`` masqué par un
    ``user`` homonyme reste consultable sous ``scope=global``).
    """
    slug = _skills.slugify_name(name)
    if scope:
        specs = _skills.discover_skills_by_source(scope, _user_skills_dir(user_id))
    else:
        specs = _skills.discover_skills(_user_skills_dir(user_id))
    # id QUALIFIÉ (``pkg/child``) d'abord, puis name exact, puis slug.
    for spec in specs:
        if getattr(spec, "id", spec.name) == name:
            return spec
    for spec in specs:
        if spec.name == name or _skills.slugify_name(spec.name) == slug:
            return spec
    return None


# ─────────────────────────────────────────────────────────────────────────
#  READ
# ─────────────────────────────────────────────────────────────────────────

@router.get("/api/skills")
async def list_skills(request: Request) -> Dict[str, Any]:
    """Liste les skills visibles par l'appelant (résumés légers, sans corps).

    Query param optionnel ``scope`` (user|learned|global) pour filtrer. Le corps
    complet d'un skill s'obtient via ``GET /api/skills/{name}``.
    """
    user_id = require_user_id(request)
    scope = request.query_params.get("scope")
    # AUDIT 2026-09-01 (passe 5, B8) — sur un miss du cache 15 s, le scan
    # complet de l'arbre (frontmatter par SKILL.md, linéaire en taille de
    # bibliothèque) tournait SUR la boucle : déport en thread.
    if scope:
        scope = _validate_scope(scope)
        # Scoped listing = the REAL inventory of that source (un-merged), so a
        # global skill shadowed by a same-named user skill stays visible under
        # ``scope=global``. The management UI manages each scope independently.
        specs = await asyncio.to_thread(
            _skills.discover_skills_by_source, scope, _user_skills_dir(user_id))
    else:
        specs = await asyncio.to_thread(
            _skills.discover_skills, _user_skills_dir(user_id))
    return {"skills": [s.to_summary_dict() for s in specs], "count": len(specs)}


@router.get("/api/skills/file")
async def get_skill_file(request: Request, id: str, path: str = "SKILL.md",
                         scope: Optional[str] = None) -> Dict[str, Any]:
    """Contenu brut (lecture seule) d'un fichier groupé d'un skill.

    Déclaré AVANT ``/api/skills/{name}`` (sinon ``file`` matcherait ``{name}``).
    ``id`` = id du skill (qualifié pour un sous-skill, ex. ``pkg/child``) ;
    ``path`` = chemin relatif au dossier du skill (défaut ``SKILL.md``).
    Containment vérifié ; lecture plafonnée (256 Ko).
    """
    user_id = require_user_id(request)
    # (passe 5, B8) — _find_spec = scan potentiel de tout l'arbre : thread.
    spec = await asyncio.to_thread(
        _find_spec, id, user_id, _validate_scope(scope) if scope else None)
    if spec is None:
        raise HTTPException(404, f"skill introuvable : {id}")
    rel = (path or "SKILL.md").replace("\\", "/").lstrip("/")
    if ".." in Path(rel).parts:
        raise HTTPException(400, "chemin invalide")
    if not spec.skill_dir:   # legacy mono-fichier : seul son .md est servable
        if spec.path and rel in ("SKILL.md", Path(spec.path).name):
            return {"id": getattr(spec, "id", spec.name), "path": rel,
                    "content": await asyncio.to_thread(_read_text_capped, Path(spec.path))}
        raise HTTPException(404, "fichier introuvable")
    base = Path(spec.skill_dir)
    # AUDIT 2026-08-30 (S3a) — ``resolve()`` / ``is_file()`` lèvent ``OSError``
    # sur un segment de plus de 255 caractères (ENAMETOOLONG) : c'était un 500.
    # Un nom que le système de fichiers refuse est un chemin invalide → 400,
    # cohérent avec le rejet ci-dessus.
    try:
        target = (base / rel).resolve()
        if target != base.resolve() and not _skills._is_under(target, base):
            raise HTTPException(400, "chemin hors du skill")
        is_file = target.is_file()
    except OSError:
        raise HTTPException(400, "chemin invalide")
    if not is_file:
        raise HTTPException(404, f"fichier introuvable : {rel}")
    try:
        # (passe 5, B8) — avant : ``read_bytes()`` chargeait le fichier ENTIER
        # (archive de plusieurs Go déposée dans le dossier comprise) puis
        # tronquait. Lecture BORNÉE aux 256 Ko, en thread.
        content = await asyncio.to_thread(_read_text_capped, target)
    except OSError as e:
        raise HTTPException(503, f"lecture échouée : {e}")
    return {"id": getattr(spec, "id", spec.name), "path": rel, "content": content}


def _read_text_capped(p: Path, cap: int = 256 * 1024) -> str:
    """Lit AU PLUS ``cap`` octets (jamais le fichier entier en RAM)."""
    with open(p, "rb") as fh:
        return fh.read(cap).decode("utf-8", errors="replace")


@router.get("/api/skills/{name}")
async def get_skill(name: str, request: Request) -> Dict[str, Any]:
    """Détail complet d'un skill — INCLUANT le corps markdown. 404 si absent.

    Query params optionnels : ``scope`` (user|learned|global) cible l'entrée de
    ce scope précis (symétrique de ``GET /api/skills?scope=``) ; ``id`` = id
    QUALIFIÉ (``pkg/child``) qui prime sur ``{name}`` pour viser un sous-skill
    sans ambiguïté (un ``/`` dans le path ne matche pas la route).
    """
    user_id = require_user_id(request)
    scope = request.query_params.get("scope")
    if scope:
        scope = _validate_scope(scope)
    ident = str(request.query_params.get("id") or name).strip()
    spec = await asyncio.to_thread(_find_spec, ident, user_id, scope)   # (passe 5, B8)
    if spec is None:
        raise HTTPException(404, f"Skill introuvable : {ident}")
    out = spec.to_summary_dict()
    out["body"] = spec.body
    return out


# ─────────────────────────────────────────────────────────────────────────
#  CREATE / UPDATE (idempotent par slug)
# ─────────────────────────────────────────────────────────────────────────

def _parse_payload(data: Dict[str, Any]) -> Tuple:
    """Extrait soit des champs, soit un import brut.

    Retourne ``("fields", name, description, body, tags, domain)`` ou
    ``("raw", raw_md, filename)``.
    """
    raw_md = data.get("raw_md")
    if isinstance(raw_md, str) and raw_md.strip():
        return ("raw", raw_md, data.get("filename"))
    name = str(data.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "champ 'name' requis")
    body = str(data.get("body") or "").strip()
    if not body:
        raise HTTPException(400, "champ 'body' requis")
    description = str(data.get("description") or "").strip()
    domain = str(data.get("domain") or "").strip()
    tags = _skills._parse_tags(data.get("tags"))
    return ("fields", name, description, body, tags, domain)


def _raw_md_fields(raw_md: str, filename: Optional[str]) -> Tuple[str, str, str, list, str]:
    """Parse un markdown complet (frontmatter + corps) → champs validés."""
    meta, body = _skills.split_frontmatter(raw_md or "")
    body = (body or "").strip()
    name = str(meta.get("name") or "").strip()
    if not name and filename:
        fname = str(filename).rsplit("/", 1)[-1]
        name = fname[:-3] if fname.lower().endswith(".md") else fname
    if not name:
        raise SkillSaveError("name introuvable : ajoute un frontmatter 'name:' ou un nom de fichier valide")
    if not body:
        raise SkillSaveError("body requis (la procédure ne peut pas être vide)")
    return (
        name,
        str(meta.get("description") or "").strip(),
        body,
        _skills._parse_tags(meta.get("tags")),
        str(meta.get("domain") or "").strip(),
    )


def _resolve_fields(payload: Tuple) -> Tuple[str, str, str, list, str]:
    """Normalise un payload (champs OU import brut) en champs concrets."""
    if payload[0] == "raw":
        return _raw_md_fields(payload[1], payload[2])
    _, name, description, body, tags, domain = payload
    return name, description, body, tags, domain


def _skill_exists(scope: str, user_id: Optional[int], slug: str) -> bool:
    """``True`` si un skill de ce slug existe déjà dans le scope ciblé.

    Folder-aware (legacy ``<slug>.md`` ET dossiers-skills, sous-skills inclus) :
    un name de feuille doit rester unique — sinon ``skill_get``/pins/GET par
    name deviennent ambigus."""
    if scope == "user":
        d = _user_skills_dir(user_id)
        return d is not None and _skills.find_user_entry(d, slug) is not None
    if scope == "learned":
        return _skills._find_learned_entry(slug) is not None
    return _skills._find_global_entry(slug) is not None


def _write_skill(
    scope: str,
    user_id: Optional[int],
    payload: Tuple,
    *,
    prev_name: Optional[str] = None,
) -> Tuple[Path, str]:
    """Dispatch d'un create/update vers le bon scope. Retourne (path, name).

    ``prev_name`` (chemin PUT, id qualifié accepté) est passé aux écrivains de
    ``llm_core.skills`` : c'est EUX qui réalisent le renommage (rename du
    dossier-skill en place / réécriture+unlink d'un legacy) sous le même verrou
    que l'écriture — la route ne fait plus de cleanup après coup (un delete
    par slug ici re-supprimerait le dossier fraîchement renommé).
    """
    name, description, body, tags, domain = _resolve_fields(payload)

    if scope == "user":
        skills_dir = _require_user_skills_dir(user_id)
        dest = _skills.save_user_skill(skills_dir, name, description, body, tags,
                                       domain or None, prev_name=prev_name)
    elif scope == "learned":
        dest = _skills.save_learned_skill(name, description, body, tags,
                                          domain or None, prev_name=prev_name)
    else:  # global
        dest = _skills.save_global_skill(name, description, body, tags,
                                         domain or None, prev_name=prev_name)
    return dest, name


@router.post("/api/skills")
async def create_skill(request: Request) -> Dict[str, Any]:
    """Crée / met à jour un skill. ``scope`` (défaut ``user``) choisit la cible.

    Body : ``{scope?, name, description?, body, tags?, domain?}`` OU
    ``{scope?, raw_md, filename?}`` (import d'un markdown complet).
    ``learned``/``global`` exigent l'admin ; ``user`` la simple auth.
    """
    user_id = require_user_id(request)
    data = await _json_body(request)
    scope = _validate_scope(data.get("scope"), default="user")
    if scope in ("learned", "global"):
        _require_admin(request)
    payload = _parse_payload(data)
    # Sémantique CREATE : on refuse d'écraser un slug existant (utiliser PUT pour
    # mettre à jour). Évite l'écrasement SILENCIEUX quand deux names distincts
    # slugifient pareil ("Foo Bar" vs "foo-bar").
    try:
        name_in, *_ = _resolve_fields(payload)
        slug = _skills.slugify_name(name_in)
    except SkillSaveError as e:
        raise HTTPException(400, str(e))
    # ATOMIQUE (anti-TOCTOU) : check d'existence + write sous le MÊME verrou que
    # les écritures de llm_core.skills (RLock réentrant) → deux create concurrents
    # du même slug ne peuvent plus passer tous les deux le 409 puis s'écraser.
    #
    # AUDIT 2026-08-31 — en threadpool (to_thread) : le _write_lock spinne un
    # flock avec ``time.sleep`` (jusqu'à 5 s sous contention) et l'écriture fait
    # de l'I/O disque ; exécutés dans le handler ``async``, ils gelaient TOUS
    # les flux NDJSON du worker. Le RLock + flock sont thread-safe — même
    # contrat depuis un thread. Idem pour les autres mutations du module.
    def _create_locked():
        with _skills._write_lock:
            if slug and _skill_exists(scope, user_id, slug):
                raise HTTPException(409, f"un skill '{slug}' existe déjà ({scope}) — utilise PUT pour le mettre à jour")
            return _write_skill(scope, user_id, payload)
    try:
        dest, name = await asyncio.to_thread(_create_locked)
    except SkillSaveError as e:
        raise HTTPException(400, str(e))
    if scope == "user":
        await asyncio.to_thread(_sync_user_mirror, user_id)
    return {"ok": True, "name": name, "path": str(dest), "source": scope}


@router.put("/api/skills/{name}")
async def update_skill(name: str, request: Request) -> Dict[str, Any]:
    """Met à jour un skill (create-or-replace idempotent par slug).

    Mêmes body/permissions que ``POST /api/skills``. ``{name}`` = name de
    feuille ; pour un SOUS-SKILL, passer l'id qualifié via ``?id=pkg/child``
    (un ``/`` dans le path ne matche pas la route) — il prime pour la
    résolution. Le name de feuille est pris par défaut si le body n'en fournit
    pas. Si le body renomme le skill (slug-feuille différent), l'écrivain
    renomme l'entrée (dossier inclus) sans laisser d'orphelin.
    """
    user_id = require_user_id(request)
    data = await _json_body(request)
    # Identité ciblée : id qualifié (query) > name d'URL. La comparaison de
    # renommage se fait sur le DERNIER segment — slugifier ``pkg/child`` en
    # entier donnerait ``pkgchild`` et fabriquerait un faux rename.
    ident = str(request.query_params.get("id") or name).strip().strip("/")
    prev_leaf = ident.rsplit("/", 1)[-1]
    data.setdefault("name", prev_leaf)
    scope = _validate_scope(data.get("scope"), default="user")
    if scope in ("learned", "global"):
        _require_admin(request)
    payload = _parse_payload(data)
    # Renommage (slug du body != slug-feuille ciblé) : refuse d'ÉCRASER un AUTRE
    # skill existant qui porte déjà le slug cible (perte de données silencieuse).
    try:
        new_name, *_ = _resolve_fields(payload)
        new_slug = _skills.slugify_name(new_name)
    except SkillSaveError as e:
        raise HTTPException(400, str(e))
    # ATOMIQUE (anti-TOCTOU) : collision-check du nouveau slug + write sous le
    # même verrou (RLock) que les écritures llm_core.skills. En threadpool —
    # cf. le commentaire AUDIT 2026-08-31 de ``create_skill``.
    def _update_locked():
        with _skills._write_lock:
            if new_slug and new_slug != _skills.slugify_name(prev_leaf) and _skill_exists(scope, user_id, new_slug):
                raise HTTPException(409, f"un skill '{new_slug}' existe déjà ({scope}) — choisis un nom libre")
            return _write_skill(scope, user_id, payload, prev_name=ident)
    try:
        dest, out_name = await asyncio.to_thread(_update_locked)
    except SkillSaveError as e:
        raise HTTPException(400, str(e))
    if scope == "user":
        await asyncio.to_thread(_sync_user_mirror, user_id)
    return {"ok": True, "name": out_name, "path": str(dest), "source": scope}


# ─────────────────────────────────────────────────────────────────────────
#  DELETE (scopé)
# ─────────────────────────────────────────────────────────────────────────

@router.delete("/api/skills/{name}")
async def delete_skill(name: str, request: Request) -> Dict[str, Any]:
    """Supprime un skill. ``scope`` (query, défaut ``user``) choisit la cible.

    * ``user``    — auth seule, sandbox de l'appelant.
    * ``learned`` — admin (rejet d'une proposition non promue).
    * ``global``  — admin (retrait d'un skill curé).

    ``?id=pkg/child`` (query) prime sur ``{name}`` pour viser un SOUS-SKILL
    précis. Supprimer un dossier-skill emporte son bundle et ses sous-skills.
    """
    user_id = require_user_id(request)
    scope = _validate_scope(request.query_params.get("scope"), default="user")
    ident = str(request.query_params.get("id") or name).strip()
    if scope == "user":
        skills_dir = _require_user_skills_dir(user_id)
        deleted = await asyncio.to_thread(_skills.delete_user_skill, skills_dir, ident)
    elif scope == "learned":
        _require_admin(request)
        deleted = await asyncio.to_thread(_skills.delete_learned_skill, ident)
    else:  # global
        _require_admin(request)
        deleted = await asyncio.to_thread(_skills.delete_global_skill, ident)
    if not deleted:
        raise HTTPException(404, f"skill introuvable : {ident}")
    if scope == "user":
        await asyncio.to_thread(_sync_user_mirror, user_id)
    return {"ok": True, "name": ident, "scope": scope, "deleted": True}


# ─────────────────────────────────────────────────────────────────────────
#  PROMOTE (learned → global) — ADMIN
# ─────────────────────────────────────────────────────────────────────────

@router.post("/api/skills/promote")
async def promote_skill(request: Request) -> Dict[str, Any]:
    """Promeut un skill ``learned`` vers la bibliothèque curée ``skills/``.

    Body JSON : ``{"name": "<slug>"}``. Déplace ``skills/learned/<slug>.md`` vers
    ``skills/<slug>.md`` (sous-dossier de domaine préservé). Refuse si le learned
    n'existe pas ou si un skill global de même nom existe déjà.

    RÉSERVÉ ADMIN (audit CRIT-1) : la promotion rend un skill visible dans le
    system prompt de TOUS les utilisateurs — acte de curation/modération.
    """
    _require_admin(request)   # 401 si non-loggé, 403 si non-admin
    data = await _json_body(request)
    name = str(data.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "champ 'name' requis")
    try:
        dest = await asyncio.to_thread(_skills.promote_learned_skill, name)
    except SkillSaveError as e:
        raise HTTPException(409, str(e))
    return {"ok": True, "name": dest.stem, "path": str(dest), "source": "global"}


# ─────────────────────────────────────────────────────────────────────────
#  PACKAGING .zip (Agent Skills) — import (upload) / export (download)
# ─────────────────────────────────────────────────────────────────────────

@router.post("/api/skills/import")
async def import_skill(request: Request, file: UploadFile = File(...),
                       scope: str = "user", overwrite: bool = False) -> Any:
    """Installe un skill depuis un ``.zip`` (layout ``<name>/SKILL.md`` + bundle ;
    TOLÉRANT : un SKILL.md à la racine de l'archive est ré-emballé d'après son
    frontmatter, la casse ``skill.md`` est récupérée).

    ``scope=user`` (défaut) → sandbox perso ; ``scope=global`` → bibliothèque
    curée (RÉSERVÉ ADMIN, audit CRIT-1 : visible de tous). Durci côté loader
    (anti zip-slip, caps taille/nombre, SKILL.md requis, containment).
    ``overwrite`` absent/false → 409 ``{detail, name, names}`` si le skill
    existe déjà (l'UI confirme puis relance avec ``overwrite=1``).
    """
    user_id = require_user_id(request)
    scope, dest = _skill_scope_dest(request, scope)
    try:
        blob = await file.read()
    except Exception:
        raise HTTPException(400, "lecture du fichier envoyé échouée — réessaie l'upload")
    try:
        imported = await asyncio.to_thread(
            _skills.install_skill_zip, blob, dest, source=scope, strict=False,
            overwrite=overwrite)
    except SkillExistsError as e:
        return JSONResponse(status_code=409, content={
            "detail": str(e), "name": (e.names[0] if e.names else ""),
            "names": e.names, "scope": scope})
    except SkillSaveError as e:
        raise HTTPException(400, str(e))
    if scope == "user":
        await asyncio.to_thread(_sync_user_mirror, user_id)
    return {"ok": True, "imported": imported, "count": len(imported),
            "name": (imported[0] if imported else ""), "scope": scope}


def _skill_scope_dest(request: Request, scope: str) -> Tuple[str, Path]:
    """Valide le scope d'un import et résout son répertoire cible.

    ``user`` (défaut) → store perso ; ``global`` → bibliothèque curée (ADMIN) ;
    ``learned`` refusé (réservé aux propositions de l'agent)."""
    user_id = require_user_id(request)
    scope = _validate_scope(scope, default="user")
    if scope == "learned":
        raise HTTPException(400, "import vers 'learned' non supporté (scope: user|global)")
    if scope == "global":
        _require_admin(request)          # 401 si non-loggé, 403 si non-admin
        return scope, _skills._global_skills_root()
    return scope, _require_user_skills_dir(user_id)


@router.post("/api/skills/import-folder")
async def import_skill_folder(request: Request,
                              files: List[UploadFile] = File(...),
                              paths: List[str] = Form(...),
                              scope: str = "user", overwrite: bool = False) -> Any:
    """Installe un skill depuis un DOSSIER uploadé (``<input webkitdirectory>`` :
    un champ ``paths`` par fichier, chemin relatif ``<dossier>/…`` préservé —
    même contrat multipart que ``/api/mcp/upload``).

    Même pipeline que l'import .zip : l'arborescence est ré-empaquetée en zip
    EN MÉMOIRE puis confiée à ``install_skill_zip`` (anti zip-slip, caps
    taille/nombre, SKILL.md requis, clean-install, containment, layout tolérant :
    la sélection « en vrac » — SKILL.md sans dossier racine — est ré-emballée
    d'après son frontmatter). ``overwrite`` : même contrat 409 que l'import .zip.
    """
    user_id = require_user_id(request)
    scope, dest = _skill_scope_dest(request, scope)
    if not files or not paths or len(files) != len(paths):
        raise HTTPException(400, "upload invalide (files/paths dépareillés)")
    if len(files) > _skills.SKILL_ZIP_MAX_FILES:
        raise HTTPException(400, f"trop de fichiers ({len(files)} > {_skills.SKILL_ZIP_MAX_FILES})")

    import io
    import zipfile
    entries: List[Tuple[str, bytes]] = []
    total = 0
    for f, raw in zip(files, paths):
        arc = str(raw or "").replace("\\", "/")
        parts = [p for p in arc.split("/") if p not in ("", ".")]
        if not parts:
            continue
        if arc.startswith("/") or ".." in parts:
            raise HTTPException(400, f"chemin dangereux refusé : {raw}")
        if any(p.startswith(".") for p in parts):
            continue                     # fichiers/dossiers cachés ignorés (comme le .zip)
        try:
            blob = await f.read()
        except Exception:
            raise HTTPException(400, f"lecture échouée : {arc}")
        total += len(blob)
        if total > _skills.SKILL_ZIP_MAX_UNCOMPRESSED:
            raise HTTPException(
                400, f"dossier trop volumineux (> {_skills.SKILL_ZIP_MAX_UNCOMPRESSED // 1048576} Mo)")
        entries.append(("/".join(parts), blob))
    if not entries:
        raise HTTPException(400, "aucun fichier exploitable dans le dossier")

    def _pack_and_install():
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            for arc, blob in entries:
                z.writestr(arc, blob)
        return _skills.install_skill_zip(buf.getvalue(), dest, source=scope,
                                         strict=False, overwrite=overwrite)
    try:
        imported = await asyncio.to_thread(_pack_and_install)
    except SkillExistsError as e:
        return JSONResponse(status_code=409, content={
            "detail": str(e), "name": (e.names[0] if e.names else ""),
            "names": e.names, "scope": scope})
    except SkillSaveError as e:
        raise HTTPException(400, str(e))
    if scope == "user":
        await asyncio.to_thread(_sync_user_mirror, user_id)
    return {"ok": True, "imported": imported, "count": len(imported),
            "name": (imported[0] if imported else ""), "scope": scope}


@router.get("/api/skills/{name}/export")
async def export_skill(name: str, request: Request, scope: Optional[str] = None):
    """Télécharge un skill empaqueté en ``.zip`` (``<name>/SKILL.md`` + bundle).

    ``?id=pkg/child`` (query) prime sur ``{name}`` pour viser un sous-skill."""
    user_id = require_user_id(request)
    ident = str(request.query_params.get("id") or name).strip()
    spec = _find_spec(ident, user_id, _validate_scope(scope) if scope else None)
    if spec is None:
        raise HTTPException(404, f"skill '{ident}' introuvable")
    try:
        blob = await asyncio.to_thread(_skills.export_skill_zip, spec)
    except SkillSaveError as e:
        raise HTTPException(400, str(e))
    return Response(
        content=blob, media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{spec.name}.zip"'},
    )
