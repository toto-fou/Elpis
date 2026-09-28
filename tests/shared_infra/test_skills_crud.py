# SPDX-License-Identifier: MIT
"""End-to-end CRUD tests for the skills HTTP API (shared_infra/chat/routes_skills.py).

We mount the real shared router on a bare FastAPI app and exercise the real
handlers and the real on-disk markdown writers in ``llm_core.skills``. Auth is
faked by monkeypatching the route module's ``require_user_id`` / ``_require_admin``
gates to read test headers — this keeps the SessionMiddleware/DB/config stack out
of the test while still proving the scope-based permission branching.

Isolation:
* global/learned roots  -> a temp dir, by patching ``llm_core.skills``'s root
  *resolvers* (NOT ``$APP_SKILLS_DIR``): Starlette's TestClient runs handlers on
  a worker thread that does not reliably see ``monkeypatch.setenv``, so the env
  var would be MISSING inside the handler and ``_global_skills_root`` would fall
  back to the real repo ``skills/``. Patching the functions is thread-safe.
* per-user sandbox dir   -> ``<tmp>/sandboxes/<uid>/skills`` by patching
  ``shared_infra.chat.routes_skills._user_skills_dir``.

NB: we never ``importlib.reload`` either module — reloading the route module
would re-run its ``@router.*`` decorators against the shared singleton router
(DUPLICATE routes), and reloading ``llm_core.skills`` would mint a second
``SkillSaveError`` class the route's ``except`` clause no longer matches.
"""
from __future__ import annotations

from contextvars import ContextVar
from pathlib import Path

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient


# Per-request auth carried via headers, surfaced to the patched gates.
_CUR_UID: "ContextVar[str | None]" = ContextVar("_CUR_UID", default=None)
_CUR_ADMIN: "ContextVar[bool]" = ContextVar("_CUR_ADMIN", default=False)


# ---------------------------------------------------------------------------
# App / client fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def skills_env(tmp_path, monkeypatch):
    """Isolate global/learned roots and the per-user sandbox under tmp_path."""
    global_root = tmp_path / "skills_global"
    (global_root / "learned").mkdir(parents=True)
    sandbox_root = tmp_path / "sandboxes"
    sandbox_root.mkdir()

    import llm_core.skills as llm_skills
    import shared_infra.chat.routes_skills as routes_skills

    # Point the root resolvers at the temp tree (thread-safe; see module docstring).
    monkeypatch.setattr(llm_skills, "_global_skills_root", lambda: global_root)
    monkeypatch.setattr(llm_skills, "_learned_skills_root", lambda: global_root / "learned")

    # ── Fake auth gates: read the ContextVars set by the middleware. ──
    def _fake_require_user_id(request):
        uid = _CUR_UID.get()
        if not uid:
            raise HTTPException(401, "Authentification requise")
        return uid

    def _fake_require_admin(request):
        uid = _fake_require_user_id(request)
        if not _CUR_ADMIN.get():
            raise HTTPException(403, "Admin required")
        return uid

    # ── Per-user sandbox skills dir under tmp. ──
    def _fake_user_skills_dir(user_id):
        if user_id is None:
            return None
        return Path(sandbox_root) / str(user_id) / "skills"

    monkeypatch.setattr(routes_skills, "require_user_id", _fake_require_user_id)
    monkeypatch.setattr(routes_skills, "_require_admin", _fake_require_admin)
    monkeypatch.setattr(routes_skills, "_user_skills_dir", _fake_user_skills_dir)

    return {
        "global_root": str(global_root),
        "learned_root": str(global_root / "learned"),
        "sandbox_root": str(sandbox_root),
        "routes_skills": routes_skills,
        "llm_skills": llm_skills,
    }


@pytest.fixture()
def client(skills_env):
    """A TestClient whose middleware publishes user_id / is_admin from headers."""
    from shared_infra.routes._state import router

    app = FastAPI()

    @app.middleware("http")
    async def _inject_auth(request: Request, call_next):
        tok_uid = _CUR_UID.set(request.headers.get("x-test-user") or None)
        tok_admin = _CUR_ADMIN.set(request.headers.get("x-test-admin") == "1")
        try:
            return await call_next(request)
        finally:
            _CUR_UID.reset(tok_uid)
            _CUR_ADMIN.reset(tok_admin)

    app.include_router(router)
    return TestClient(app)


def _user(uid="alice"):
    return {"x-test-user": uid}


def _admin(uid="root"):
    return {"x-test-user": uid, "x-test-admin": "1"}


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------


def test_list_requires_auth(client):
    r = client.get("/api/skills")
    assert r.status_code == 401


def test_list_empty_for_authenticated_user(client):
    r = client.get("/api/skills", headers=_user())
    assert r.status_code == 200
    data = r.json()
    assert data["count"] == 0
    assert data["skills"] == []


# ---------------------------------------------------------------------------
# Create / Read / List (user scope)
# ---------------------------------------------------------------------------


def test_create_read_list_user_skill(client):
    body = {
        "name": "Deploy Widget",
        "description": "how to deploy the widget service",
        "body": "1. build\n2. ship\n3. profit",
        "tags": ["deploy", "widget"],
        "domain": "ops",
    }
    r = client.post("/api/skills", headers=_user(), json=body)
    assert r.status_code == 200, r.text
    created = r.json()
    assert created["ok"] is True
    assert created["source"] == "user"
    assert created["name"] == "Deploy Widget"
    assert Path(created["path"]).is_file()
    # Création = format DOSSIER (Agent Skill) : [<domain>/]<slug>/SKILL.md.
    assert created["path"].endswith("ops/deploy-widget/SKILL.md")

    # List shows it with source=user and a body preview (no full body).
    r = client.get("/api/skills", headers=_user())
    assert r.status_code == 200
    skills = r.json()["skills"]
    assert len(skills) == 1
    s = skills[0]
    assert s["source"] == "user"
    assert s["domain"] == "ops"
    assert "deploy" in s["tags"]
    assert "build" in s["body_preview"]
    assert "body" not in s  # summary only

    # Read returns the full body.
    r = client.get("/api/skills/deploy-widget", headers=_user())
    assert r.status_code == 200
    full = r.json()
    assert full["body"].strip().startswith("1. build")
    assert full["source"] == "user"


def test_read_missing_skill_404(client):
    r = client.get("/api/skills/does-not-exist", headers=_user())
    assert r.status_code == 404


def test_create_via_generic_endpoint_defaults_to_user(client):
    body = {"name": "note", "body": "just a note"}
    r = client.post("/api/skills", headers=_user(), json=body)
    assert r.status_code == 200, r.text
    assert r.json()["source"] == "user"
    r = client.get("/api/skills/note", headers=_user())
    assert r.status_code == 200
    assert r.json()["body"].strip() == "just a note"


def test_create_requires_name_and_body(client):
    assert client.post("/api/skills", headers=_user(), json={"body": "x"}).status_code == 400
    assert client.post("/api/skills", headers=_user(), json={"name": "x"}).status_code == 400


def test_create_from_raw_md(client):
    raw = (
        "---\n"
        "name: imported\n"
        "description: imported via raw md\n"
        "tags: [a, b]\n"
        "---\n\n"
        "Imported body here.\n"
    )
    r = client.post("/api/skills", headers=_user(), json={"raw_md": raw})
    assert r.status_code == 200, r.text
    r = client.get("/api/skills/imported", headers=_user())
    assert r.status_code == 200
    data = r.json()
    assert data["description"] == "imported via raw md"
    assert "Imported body here." in data["body"]


# ---------------------------------------------------------------------------
# Update (idempotent by slug)
# ---------------------------------------------------------------------------


def test_update_user_skill(client):
    client.post("/api/skills", headers=_user(), json={"name": "calc", "body": "v1"})
    r = client.put(
        "/api/skills/calc",
        headers=_user(),
        json={"description": "now better", "body": "v2 contents"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["source"] == "user"

    r = client.get("/api/skills/calc", headers=_user())
    assert r.status_code == 200
    data = r.json()
    assert data["body"].strip() == "v2 contents"
    assert data["description"] == "now better"

    # Still exactly one skill (update, not duplicate).
    assert client.get("/api/skills", headers=_user()).json()["count"] == 1


# ---------------------------------------------------------------------------
# Delete (user scope)
# ---------------------------------------------------------------------------


def test_delete_user_skill(client):
    client.post("/api/skills", headers=_user(), json={"name": "temp", "body": "x"})
    r = client.delete("/api/skills/temp?scope=user", headers=_user())
    assert r.status_code == 200, r.text
    assert r.json()["deleted"] is True
    assert client.get("/api/skills/temp", headers=_user()).status_code == 404


def test_delete_user_skill_via_generic_endpoint(client):
    client.post("/api/skills", headers=_user(), json={"name": "temp2", "body": "x"})
    r = client.delete("/api/skills/temp2", headers=_user())  # scope defaults to user
    assert r.status_code == 200, r.text
    assert r.json()["scope"] == "user"
    assert client.get("/api/skills/temp2", headers=_user()).status_code == 404


def test_delete_missing_user_skill_404(client):
    assert client.delete("/api/skills/nope?scope=user", headers=_user()).status_code == 404


# ---------------------------------------------------------------------------
# Per-user isolation
# ---------------------------------------------------------------------------


def test_user_skills_are_isolated(client):
    client.post("/api/skills", headers=_user("alice"), json={"name": "secret", "body": "alice only"})
    # Bob does not see Alice's personal skill.
    assert client.get("/api/skills", headers=_user("bob")).json()["count"] == 0
    assert client.get("/api/skills/secret", headers=_user("bob")).status_code == 404
    # Alice does.
    assert client.get("/api/skills/secret", headers=_user("alice")).status_code == 200


# ---------------------------------------------------------------------------
# Scope gating: learned / global require admin
# ---------------------------------------------------------------------------


def test_create_learned_requires_admin(client):
    body = {"scope": "learned", "name": "learned-skill", "body": "proposed"}
    assert client.post("/api/skills", headers=_user(), json=body).status_code == 403

    r = client.post("/api/skills", headers=_admin(), json=body)
    assert r.status_code == 200, r.text
    assert r.json()["source"] == "learned"
    # Now visible to a plain user (learned is cross-user).
    listed = client.get("/api/skills?scope=learned", headers=_user()).json()
    assert listed["count"] == 1
    assert listed["skills"][0]["source"] == "learned"


def test_create_global_requires_admin(client):
    body = {"scope": "global", "name": "global-skill", "body": "curated"}
    assert client.post("/api/skills", headers=_user(), json=body).status_code == 403

    r = client.post("/api/skills", headers=_admin(), json=body)
    assert r.status_code == 200, r.text
    assert r.json()["source"] == "global"
    listed = client.get("/api/skills?scope=global", headers=_user()).json()
    assert listed["count"] == 1


def test_update_global_requires_admin(client):
    client.post("/api/skills", headers=_admin(), json={"scope": "global", "name": "g1", "body": "v1"})
    # Non-admin cannot update a global.
    assert client.put("/api/skills/g1", headers=_user(),
                      json={"scope": "global", "body": "v2"}).status_code == 403
    # Admin can.
    r = client.put("/api/skills/g1", headers=_admin(), json={"scope": "global", "body": "v2 done"})
    assert r.status_code == 200, r.text
    assert client.get("/api/skills/g1", headers=_user()).json()["body"].strip() == "v2 done"


def test_delete_learned_requires_admin(client):
    client.post("/api/skills", headers=_admin(), json={"scope": "learned", "name": "todrop", "body": "x"})
    # Non-admin cannot delete a learned proposal.
    assert client.delete("/api/skills/todrop?scope=learned", headers=_user()).status_code == 403
    # Admin can (reject the proposal).
    r = client.delete("/api/skills/todrop?scope=learned", headers=_admin())
    assert r.status_code == 200, r.text
    assert r.json()["deleted"] is True
    assert client.get("/api/skills?scope=learned", headers=_user()).json()["count"] == 0


def test_delete_global_requires_admin(client):
    client.post("/api/skills", headers=_admin(), json={"scope": "global", "name": "gdrop", "body": "x"})
    assert client.delete("/api/skills/gdrop?scope=global", headers=_user()).status_code == 403
    r = client.delete("/api/skills/gdrop?scope=global", headers=_admin())
    assert r.status_code == 200, r.text
    assert client.get("/api/skills?scope=global", headers=_user()).json()["count"] == 0


# ---------------------------------------------------------------------------
# Promote learned -> global (admin)
# ---------------------------------------------------------------------------


def test_promote_learned_to_global(client):
    client.post("/api/skills", headers=_admin(),
                json={"scope": "learned", "name": "promote-me", "body": "good stuff"})

    # Non-admin cannot promote.
    assert client.post("/api/skills/promote", headers=_user(),
                       json={"name": "promote-me"}).status_code == 403

    r = client.post("/api/skills/promote", headers=_admin(), json={"name": "promote-me"})
    assert r.status_code == 200, r.text
    assert r.json()["source"] == "global"

    # It is now global, and no longer learned.
    assert client.get("/api/skills?scope=global", headers=_user()).json()["count"] == 1
    assert client.get("/api/skills?scope=learned", headers=_user()).json()["count"] == 0


def test_promote_missing_learned_409(client):
    r = client.post("/api/skills/promote", headers=_admin(), json={"name": "ghost"})
    assert r.status_code == 409


def test_promote_requires_name(client):
    r = client.post("/api/skills/promote", headers=_admin(), json={})
    assert r.status_code == 400


# ---------------------------------------------------------------------------
# Scope filter + precedence
# ---------------------------------------------------------------------------


def test_scope_filter_and_precedence(client):
    # global + user with same name -> user wins in the merged listing.
    client.post("/api/skills", headers=_admin(),
                json={"scope": "global", "name": "shared", "body": "global version"})
    client.post("/api/skills", headers=_user("alice"),
                json={"name": "shared", "body": "alice override"})

    # Unfiltered list (alice): one entry, user precedence.
    merged = client.get("/api/skills", headers=_user("alice")).json()
    assert merged["count"] == 1
    assert merged["skills"][0]["source"] == "user"
    full = client.get("/api/skills/shared", headers=_user("alice")).json()
    assert full["body"].strip() == "alice override"

    # scope=global still shows the global one.
    g = client.get("/api/skills?scope=global", headers=_user("alice")).json()
    assert g["count"] == 1
    assert g["skills"][0]["source"] == "global"


def test_invalid_scope_400(client):
    assert client.get("/api/skills?scope=bogus", headers=_user()).status_code == 400
    assert client.post("/api/skills", headers=_user(),
                       json={"scope": "bogus", "name": "x", "body": "y"}).status_code == 400


# ---------------------------------------------------------------------------
# Intégrité : renommage / changement de domaine / collision / caps
# ---------------------------------------------------------------------------


def _user_files(skills_env, uid="alice"):
    root = Path(skills_env["sandbox_root"]) / uid / "skills"
    return sorted(str(p.relative_to(root)) for p in root.rglob("*.md")) if root.is_dir() else []


def test_rename_via_put_removes_orphan(client, skills_env):
    client.post("/api/skills", headers=_user("alice"), json={"name": "old-name", "body": "v1"})
    r = client.put("/api/skills/old-name", headers=_user("alice"),
                   json={"name": "new-name", "body": "v2"})
    assert r.status_code == 200, r.text
    # Le DOSSIER a été renommé (pas de doublon, pas d'orphelin).
    assert _user_files(skills_env, "alice") == ["new-name/SKILL.md"]
    assert client.get("/api/skills/old-name", headers=_user("alice")).status_code == 404
    assert client.get("/api/skills/new-name", headers=_user("alice")).json()["body"].strip() == "v2"
    assert client.get("/api/skills", headers=_user("alice")).json()["count"] == 1


def test_domain_change_via_put_no_orphan(client, skills_env):
    client.post("/api/skills", headers=_user("alice"),
                json={"name": "mover", "domain": "ops", "body": "v1"})
    r = client.put("/api/skills/mover", headers=_user("alice"),
                   json={"name": "mover", "domain": "infra", "body": "v2"})
    assert r.status_code == 200, r.text
    # Un dossier-skill n'est JAMAIS déplacé : le changement de domaine pose la
    # surcharge frontmatter (autoritaire à la découverte), le dir reste en place.
    assert _user_files(skills_env, "alice") == ["ops/mover/SKILL.md"]
    full = client.get("/api/skills/mover", headers=_user("alice")).json()
    assert full["body"].strip() == "v2"
    assert full["domain"] == "infra"
    assert client.get("/api/skills", headers=_user("alice")).json()["count"] == 1


def test_create_slug_collision_409(client):
    assert client.post("/api/skills", headers=_user(),
                       json={"name": "Foo Bar", "body": "x"}).status_code == 200
    # 'foo-bar' slugifie comme 'Foo Bar' → CREATE doit refuser (pas d'écrasement).
    r = client.post("/api/skills", headers=_user(), json={"name": "foo-bar", "body": "y"})
    assert r.status_code == 409
    # PUT reste un upsert (mise à jour explicite autorisée).
    assert client.put("/api/skills/foo-bar", headers=_user(),
                      json={"name": "foo-bar", "body": "z"}).status_code == 200
    assert client.get("/api/skills/foo-bar", headers=_user()).json()["body"].strip() == "z"


def test_body_is_capped(client):
    huge = "X" * 30000
    client.post("/api/skills", headers=_user(), json={"name": "huge", "body": huge})
    body = client.get("/api/skills/huge", headers=_user()).json()["body"]
    assert len(body) <= 20000


def test_tags_sanitized_no_frontmatter_injection(client):
    # Un tag avec saut de ligne tentait d'injecter name/domain au re-parse.
    client.post("/api/skills", headers=_user(), json={
        "name": "safe", "body": "b",
        "tags": ["good", "evil]\ndomain: hacked\nname: forged\nmalicious: z"],
    })
    data = client.get("/api/skills/safe", headers=_user()).json()
    assert data["name"] == "safe"        # name NON surchargé
    assert data["domain"] == ""          # domain NON injecté
    # Le slug reste 'safe' (pas 'forged').
    assert client.get("/api/skills/forged", headers=_user()).status_code == 404


def test_description_carriage_return_no_injection(client):
    # \r (et autres coupures de ligne) dans la description tentaient d'injecter
    # name/domain au re-parse (splitlines coupe sur \r). Doit être neutralisé.
    client.post("/api/skills", headers=_user(), json={
        "name": "legit",
        "description": "hi\rname: forged\rdomain: hacked",
        "body": "b",
    })
    data = client.get("/api/skills/legit", headers=_user()).json()
    assert data["name"] == "legit"
    assert data["domain"] == ""
    assert client.get("/api/skills/forged", headers=_user()).status_code == 404


def test_put_rename_to_existing_slug_409(client):
    client.post("/api/skills", headers=_user(), json={"name": "a-one", "body": "A"})
    client.post("/api/skills", headers=_user(), json={"name": "b-two", "body": "B"})
    # Renommer b-two → a-one (slug occupé par un AUTRE skill) doit 409, pas écraser.
    r = client.put("/api/skills/b-two", headers=_user(), json={"name": "a-one", "body": "B2"})
    assert r.status_code == 409
    # Les deux skills restent intacts.
    assert client.get("/api/skills/a-one", headers=_user()).json()["body"].strip() == "A"
    assert client.get("/api/skills/b-two", headers=_user()).json()["body"].strip() == "B"


def test_get_skill_honors_scope(client):
    client.post("/api/skills", headers=_admin(),
                json={"scope": "global", "name": "shared", "body": "GLOBAL"})
    client.post("/api/skills", headers=_user("alice"),
                json={"name": "shared", "body": "ALICE"})
    # ?scope=global cible le global même s'il est masqué par le user homonyme.
    g = client.get("/api/skills/shared?scope=global", headers=_user("alice")).json()
    assert g["body"].strip() == "GLOBAL" and g["source"] == "global"
    u = client.get("/api/skills/shared?scope=user", headers=_user("alice")).json()
    assert u["body"].strip() == "ALICE" and u["source"] == "user"
    # Sans scope : vue fusionnée, précédence user.
    m = client.get("/api/skills/shared", headers=_user("alice")).json()
    assert m["body"].strip() == "ALICE"


# ---------------------------------------------------------------------------
# Folder-aware : dossiers-skills (Agent Skill), sous-skills, dédup cross-modèle
# ---------------------------------------------------------------------------


def _write_folder_skill(root, rel, *, fm_extra="", body="corps", files=None):
    """Pose un dossier-skill ``<root>/<rel>/SKILL.md`` (+ fichiers bundlés)."""
    d = Path(root) / rel
    d.mkdir(parents=True, exist_ok=True)
    name = d.name
    (d / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: d-{name}\ntags: [t]\n{fm_extra}---\n\n{body}\n",
        encoding="utf-8")
    for f in (files or []):
        p = d / f
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("#!/usr/bin/env bash\necho ok\n", encoding="utf-8")
    return d


def test_post_409_against_folder_skill_and_subskill(client, skills_env):
    root = Path(skills_env["global_root"])
    _write_folder_skill(root, "pkg", files=["util.txt"])
    _write_folder_skill(root, "pkg/child")
    # Collision contre le package ET contre le name de feuille du sous-skill.
    assert client.post("/api/skills", headers=_admin(),
                       json={"scope": "global", "name": "pkg", "body": "x"}).status_code == 409
    assert client.post("/api/skills", headers=_admin(),
                       json={"scope": "global", "name": "child", "body": "x"}).status_code == 409


def test_put_folder_updates_in_place_preserves_extra_frontmatter(client, skills_env):
    root = Path(skills_env["global_root"])
    d = _write_folder_skill(
        root, "tool",
        fm_extra="license: Apache-2.0\ncompatibility: needs curl\nallowed-tools: shell\n"
                 "metadata:\n  author: acme\n  version: 1.0\n",
        files=["scripts/x.sh"])
    r = client.put("/api/skills/tool", headers=_admin(),
                   json={"scope": "global", "name": "tool",
                         "description": "maj", "body": "nouveau corps", "tags": ["a", "b"]})
    assert r.status_code == 200, r.text
    # Update IN PLACE : pas de doublon legacy `tool.md`, le bundle est intact.
    assert not (root / "tool.md").exists()
    assert (d / "scripts/x.sh").is_file()
    full = client.get("/api/skills/tool?scope=global", headers=_admin()).json()
    assert full["body"].strip() == "nouveau corps"
    assert full["description"] == "maj"
    assert full["tags"] == ["a", "b"]
    # Champs NON gérés par le formulaire : préservés.
    assert full["license"] == "Apache-2.0"
    assert full["compatibility"] == "needs curl"
    assert full["allowed_tools"] == "shell"
    assert full["metadata"] == {"author": "acme", "version": 1.0}
    assert client.get("/api/skills?scope=global", headers=_admin()).json()["count"] == 1


def test_put_subskill_stays_in_parent(client, skills_env):
    root = Path(skills_env["global_root"])
    _write_folder_skill(root, "pkg")
    _write_folder_skill(root, "pkg/child")
    # PUT par name de feuille (URL) + id qualifié (query) : update in place.
    r = client.put("/api/skills/child?id=pkg/child", headers=_admin(),
                   json={"scope": "global", "body": "maj enfant"})
    assert r.status_code == 200, r.text
    assert (root / "pkg/child/SKILL.md").is_file()      # toujours sous le parent
    assert not (root / "child").exists()                 # pas extrait à la racine
    assert not (root / "child.md").exists()              # pas de doublon legacy
    listed = client.get("/api/skills?scope=global", headers=_admin()).json()["skills"]
    child = next(s for s in listed if s["name"] == "child")
    assert child["id"] == "pkg/child" and child["parent_id"] == "pkg"
    assert client.get("/api/skills/child?scope=global",
                      headers=_admin()).json()["body"].strip() == "maj enfant"


def test_put_rename_folder_renames_dir(client, skills_env):
    sandbox = Path(skills_env["sandbox_root"]) / "alice/skills"
    _write_folder_skill(sandbox, "oldy", files=["scripts/keep.sh"])
    r = client.put("/api/skills/oldy", headers=_user("alice"),
                   json={"name": "newy", "body": "v2"})
    assert r.status_code == 200, r.text
    assert not (sandbox / "oldy").exists()
    assert (sandbox / "newy/SKILL.md").is_file()
    assert (sandbox / "newy/scripts/keep.sh").is_file()   # bundle préservé
    full = client.get("/api/skills/newy", headers=_user("alice")).json()
    assert full["name"] == "newy" and full["body"].strip() == "v2"


def test_delete_package_removes_children_subskill_keeps_parent(client, skills_env):
    root = Path(skills_env["global_root"])
    _write_folder_skill(root, "pkg", files=["util.txt"])
    _write_folder_skill(root, "pkg/child")
    # Supprimer le SOUS-skill seul (?id= qualifié) : le parent reste.
    r = client.delete("/api/skills/child?scope=global&id=pkg/child", headers=_admin())
    assert r.status_code == 200, r.text
    assert not (root / "pkg/child").exists()
    assert (root / "pkg/SKILL.md").is_file()
    # Supprimer le package : tout l'arbre part (bundle inclus).
    _write_folder_skill(root, "pkg/child2")
    r = client.delete("/api/skills/pkg?scope=global", headers=_admin())
    assert r.status_code == 200, r.text
    assert not (root / "pkg").exists()
    assert client.get("/api/skills?scope=global", headers=_admin()).json()["count"] == 0


def test_delete_legacy_and_folder_same_slug(client, skills_env):
    sandbox = Path(skills_env["sandbox_root"]) / "alice/skills"
    sandbox.mkdir(parents=True, exist_ok=True)
    (sandbox / "dup.md").write_text("---\nname: dup\n---\n\nlegacy\n", encoding="utf-8")
    _write_folder_skill(sandbox, "dup")
    r = client.delete("/api/skills/dup", headers=_user("alice"))
    assert r.status_code == 200, r.text
    assert not (sandbox / "dup.md").exists()
    assert not (sandbox / "dup").exists()


def test_save_over_folder_purges_legacy_twin(client, skills_env):
    # État transitoire « legacy ET dossier du même slug » : un save résout en
    # faveur du dossier (update in place) et purge la copie legacy.
    sandbox = Path(skills_env["sandbox_root"]) / "alice/skills"
    sandbox.mkdir(parents=True, exist_ok=True)
    (sandbox / "twin.md").write_text("---\nname: twin\n---\n\nlegacy\n", encoding="utf-8")
    _write_folder_skill(sandbox, "twin", body="dossier")
    r = client.put("/api/skills/twin", headers=_user("alice"), json={"body": "résolu"})
    assert r.status_code == 200, r.text
    assert not (sandbox / "twin.md").exists()
    assert (sandbox / "twin/SKILL.md").is_file()
    assert client.get("/api/skills", headers=_user("alice")).json()["count"] == 1


def test_promote_learned_folder_moves_dir(client, skills_env):
    learned = Path(skills_env["learned_root"])
    _write_folder_skill(learned, "jen/pack", files=["scripts/s.sh"])
    _write_folder_skill(learned, "jen/pack/sub")
    r = client.post("/api/skills/promote", headers=_admin(), json={"name": "pack"})
    assert r.status_code == 200, r.text
    # ``name`` = slug du dossier (PAS « SKILL ») ; domaine préservé ; bundle+sous-skill suivent.
    assert r.json()["name"] == "pack"
    root = Path(skills_env["global_root"])
    assert (root / "jen/pack/SKILL.md").is_file()
    assert (root / "jen/pack/scripts/s.sh").is_file()
    assert (root / "jen/pack/sub/SKILL.md").is_file()
    assert not (learned / "jen/pack").exists()


def test_promote_subskill_rejected(client, skills_env):
    learned = Path(skills_env["learned_root"])
    _write_folder_skill(learned, "pack")
    _write_folder_skill(learned, "pack/sub")
    r = client.post("/api/skills/promote", headers=_admin(), json={"name": "sub"})
    assert r.status_code == 409
    assert "package racine" in r.json()["detail"]


def test_create_global_named_learned_rejected(client):
    r = client.post("/api/skills", headers=_admin(),
                    json={"scope": "global", "name": "learned", "body": "x"})
    assert r.status_code == 400
    r = client.post("/api/skills", headers=_admin(),
                    json={"scope": "global", "name": "ok-name", "domain": "learned", "body": "x"})
    assert r.status_code == 400


def test_create_into_legacy_domain_dir_rejected(client, skills_env):
    # Poser un SKILL.md dans un dossier de DOMAINE contenant des legacy les
    # masquerait (ils deviendraient « internes » au dossier-skill) → refus.
    root = Path(skills_env["global_root"])
    (root / "ops").mkdir(parents=True)
    (root / "ops/old.md").write_text("---\nname: old\n---\n\nlegacy\n", encoding="utf-8")
    r = client.post("/api/skills", headers=_admin(),
                    json={"scope": "global", "name": "ops", "body": "x"})
    assert r.status_code == 400
    assert "mono-fichier" in r.json()["detail"]
    # Le legacy est toujours là et toujours découvert.
    assert (root / "ops/old.md").is_file()
    listed = client.get("/api/skills?scope=global", headers=_admin()).json()
    assert listed["count"] == 1 and listed["skills"][0]["name"] == "old"


# ---------------------------------------------------------------------------
# Import DOSSIER (POST /api/skills/import-folder — <input webkitdirectory>)
# ---------------------------------------------------------------------------


def _folder_upload(entries):
    """(files=, data=) multipart pour import-folder : un champ ``paths`` par fichier."""
    files = [("files", (p.split("/")[-1], blob, "application/octet-stream"))
             for p, blob in entries]
    return files, {"paths": [p for p, _ in entries]}


def _skill_md(name, body="corps"):
    return f"---\nname: {name}\ndescription: d-{name}\n---\n\n{body}\n".encode()


def test_import_folder_installs_bundle(client, skills_env):
    files, data = _folder_upload([
        ("impeccable/SKILL.md", _skill_md("impeccable")),
        ("impeccable/reference/product.md", b"# ref\n"),
        ("impeccable/scripts/context.mjs", b"// js\n"),
    ])
    r = client.post("/api/skills/import-folder", headers=_user("alice"),
                    files=files, data=data)
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["count"] == 1 and d["name"] == "impeccable"
    store = Path(skills_env["sandbox_root"]) / "alice/skills"
    assert (store / "impeccable/SKILL.md").is_file()
    assert (store / "impeccable/reference/product.md").is_file()
    assert (store / "impeccable/scripts/context.mjs").is_file()
    listed = client.get("/api/skills", headers=_user("alice")).json()
    assert listed["count"] == 1 and listed["skills"][0]["name"] == "impeccable"


def test_import_folder_loose_files_wrapped_from_frontmatter(client, skills_env):
    # Sélection « en vrac » (contenu du dossier sans le dossier racine) :
    # ré-emballé sous le slug du frontmatter du SKILL.md racine.
    files, data = _folder_upload([
        ("SKILL.md", _skill_md("Mon Skill Vrac")),
        ("scripts/run.sh", b"#!/bin/sh\n"),
    ])
    r = client.post("/api/skills/import-folder", headers=_user("alice"),
                    files=files, data=data)
    assert r.status_code == 200, r.text
    store = Path(skills_env["sandbox_root"]) / "alice/skills"
    assert (store / "mon-skill-vrac/SKILL.md").is_file()
    assert (store / "mon-skill-vrac/scripts/run.sh").is_file()


def test_import_folder_requires_skill_md(client):
    files, data = _folder_upload([("stuff/readme.txt", b"pas un skill")])
    r = client.post("/api/skills/import-folder", headers=_user("alice"),
                    files=files, data=data)
    assert r.status_code == 400
    files, data = _folder_upload([("notes.txt", b"vrac sans SKILL.md")])
    r = client.post("/api/skills/import-folder", headers=_user("alice"),
                    files=files, data=data)
    assert r.status_code == 400


def test_import_folder_rejects_traversal(client, skills_env):
    files, data = _folder_upload([
        ("pkg/SKILL.md", _skill_md("pkg")),
        ("pkg/../../evil.sh", b"#!/bin/sh\n"),
    ])
    r = client.post("/api/skills/import-folder", headers=_user("alice"),
                    files=files, data=data)
    assert r.status_code == 400
    assert not (Path(skills_env["sandbox_root"]) / "alice/skills/pkg").exists()


def test_import_folder_global_requires_admin(client, skills_env):
    files, data = _folder_upload([("pkg/SKILL.md", _skill_md("pkg"))])
    r = client.post("/api/skills/import-folder?scope=global", headers=_user("alice"),
                    files=files, data=data)
    assert r.status_code == 403
    r = client.post("/api/skills/import-folder?scope=global", headers=_admin(),
                    files=files, data=data)
    assert r.status_code == 200, r.text
    assert (Path(skills_env["global_root"]) / "pkg/SKILL.md").is_file()


def test_import_folder_ignores_hidden_files(client, skills_env):
    files, data = _folder_upload([
        ("pkg/SKILL.md", _skill_md("pkg")),
        ("pkg/.git/config", b"[core]\n"),
        ("pkg/.DS_Store", b"\x00"),
    ])
    r = client.post("/api/skills/import-folder", headers=_user("alice"),
                    files=files, data=data)
    assert r.status_code == 200, r.text
    store = Path(skills_env["sandbox_root"]) / "alice/skills"
    assert (store / "pkg/SKILL.md").is_file()
    assert not (store / "pkg/.git").exists()
    assert not (store / "pkg/.DS_Store").exists()


def test_import_folder_conflict_409_then_overwrite(client, skills_env):
    files, data = _folder_upload([("pkg/SKILL.md", _skill_md("pkg")),
                                  ("pkg/old.txt", b"v1")])
    r = client.post("/api/skills/import-folder", headers=_user("alice"),
                    files=files, data=data)
    assert r.status_code == 200, r.text
    # Ré-import sans overwrite → 409 {detail, name}, rien n'est écrasé.
    files, data = _folder_upload([("pkg/SKILL.md", _skill_md("pkg"))])
    r = client.post("/api/skills/import-folder", headers=_user("alice"),
                    files=files, data=data)
    assert r.status_code == 409
    d = r.json()
    assert "existe déjà" in d["detail"] and d["name"] == "pkg"
    store = Path(skills_env["sandbox_root"]) / "alice/skills"
    assert (store / "pkg/old.txt").is_file()
    # Confirmé côté UI → overwrite=1 : clean install (old.txt disparaît).
    r = client.post("/api/skills/import-folder?overwrite=1", headers=_user("alice"),
                    files=files, data=data)
    assert r.status_code == 200, r.text
    assert not (store / "pkg/old.txt").exists()


# ---------------------------------------------------------------------------
# Import .zip (POST /api/skills/import) — layout tolérant + overwrite
# ---------------------------------------------------------------------------


def _zip_upload(entries, name="skill.zip"):
    """Kwarg ``files=`` multipart pour l'import .zip (champ ``file``)."""
    import io
    import zipfile
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for arc, blob in entries:
            z.writestr(arc, blob)
    return {"file": (name, buf.getvalue(), "application/zip")}


def test_import_zip_installs_bundle(client, skills_env):
    r = client.post("/api/skills/import", headers=_user("alice"),
                    files=_zip_upload([
                        ("impeccable/SKILL.md", _skill_md("impeccable")),
                        ("impeccable/scripts/run.sh", b"#!/bin/sh\n"),
                    ]))
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["ok"] is True and d["count"] == 1
    assert d["name"] == "impeccable" and d["imported"] == ["impeccable"]
    store = Path(skills_env["sandbox_root"]) / "alice/skills"
    assert (store / "impeccable/SKILL.md").is_file()
    assert (store / "impeccable/scripts/run.sh").is_file()
    listed = client.get("/api/skills", headers=_user("alice")).json()
    assert listed["count"] == 1 and listed["skills"][0]["name"] == "impeccable"


def test_import_zip_root_level_skillmd(client, skills_env):
    # LE bug utilisateur : zipper le CONTENU du dossier (SKILL.md à la racine
    # de l'archive) → désormais accepté, ré-emballé d'après le frontmatter.
    r = client.post("/api/skills/import", headers=_user("alice"),
                    files=_zip_upload([
                        ("SKILL.md", _skill_md("Mon Skill Racine")),
                        ("reference/notes.md", b"# notes\n"),
                    ]))
    assert r.status_code == 200, r.text
    assert r.json()["name"] == "mon-skill-racine"
    store = Path(skills_env["sandbox_root"]) / "alice/skills"
    assert (store / "mon-skill-racine/SKILL.md").is_file()
    assert (store / "mon-skill-racine/reference/notes.md").is_file()


def test_import_zip_conflict_409_then_overwrite(client, skills_env):
    r = client.post("/api/skills/import", headers=_user("alice"),
                    files=_zip_upload([("pkg/SKILL.md", _skill_md("pkg")),
                                       ("pkg/old.txt", b"v1")]))
    assert r.status_code == 200, r.text
    up2 = [("pkg/SKILL.md", _skill_md("pkg"))]
    r = client.post("/api/skills/import", headers=_user("alice"), files=_zip_upload(up2))
    assert r.status_code == 409
    d = r.json()
    assert "existe déjà" in d["detail"] and d["name"] == "pkg"
    store = Path(skills_env["sandbox_root"]) / "alice/skills"
    assert (store / "pkg/old.txt").is_file()
    r = client.post("/api/skills/import?overwrite=1", headers=_user("alice"),
                    files=_zip_upload(up2))
    assert r.status_code == 200, r.text
    assert not (store / "pkg/old.txt").exists()


def test_import_zip_bad_archive_400(client):
    r = client.post("/api/skills/import", headers=_user("alice"),
                    files={"file": ("skill.zip", b"pas un zip du tout", "application/zip")})
    assert r.status_code == 400
    assert ".zip" in r.json()["detail"]


def test_import_zip_without_skillmd_400(client):
    r = client.post("/api/skills/import", headers=_user("alice"),
                    files=_zip_upload([("pkg/readme.txt", b"rien")]))
    assert r.status_code == 400
    assert "SKILL.md" in r.json()["detail"]


def test_import_zip_global_requires_admin(client, skills_env):
    up = [("pkg/SKILL.md", _skill_md("pkg"))]
    r = client.post("/api/skills/import?scope=global", headers=_user("alice"),
                    files=_zip_upload(up))
    assert r.status_code == 403
    r = client.post("/api/skills/import?scope=global", headers=_admin(),
                    files=_zip_upload(up))
    assert r.status_code == 200, r.text
    assert (Path(skills_env["global_root"]) / "pkg/SKILL.md").is_file()


def test_import_zip_learned_scope_rejected(client):
    r = client.post("/api/skills/import?scope=learned", headers=_admin(),
                    files=_zip_upload([("pkg/SKILL.md", _skill_md("pkg"))]))
    assert r.status_code == 400
