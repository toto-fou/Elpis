# SPDX-License-Identifier: MIT
"""Tests de l'outil MCP ``skill_get`` (chargement à la demande d'un corps de skill).

Garantie de sécurité centrale (audit CRIT-1) : un utilisateur ne lit JAMAIS le
skill perso d'un autre via cet outil, et les brouillons ``learned/`` ne fuitent
pas. On exerce le tool RÉEL (closure de ``register``) avec un ``ctx`` factice
exposant ``meta.username`` — exactement le chemin ``get_username(ctx)``.
"""
from __future__ import annotations

import pytest

import llm_core.skills as s


# ── Faux MCP / Context (même pattern que tests/memory/test_tools.py) ────────
class FakeMCP:
    def __init__(self):
        self.tools = {}

    def tool(self, **kw):
        def deco(fn):
            self.tools[fn.__name__] = fn
            return fn
        return deco

    def resource(self, *a, **k):
        return lambda fn: fn

    def prompt(self, *a, **k):
        return lambda fn: fn


class FakeRC:
    def __init__(self, meta):
        self.meta = meta


class FakeCtx:
    def __init__(self, **meta):
        self.request_context = FakeRC(meta)

    async def info(self, *a, **k):
        pass

    async def debug(self, *a, **k):
        pass


def _write(root, rel, name, body="B", desc="d"):
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(f"---\nname: {name}\ndescription: {desc}\n---\n\n{body}\n", encoding="utf-8")


@pytest.fixture
def env(tmp_path, monkeypatch):
    g = tmp_path / "skills"
    (g / "learned").mkdir(parents=True)
    sb = tmp_path / "sandboxes"
    sb.mkdir()
    monkeypatch.setattr(s, "_global_skills_root", lambda: g)
    monkeypatch.setattr(s, "_learned_skills_root", lambda: g / "learned")
    monkeypatch.setenv("APP_SANDBOX_DIR", str(sb))
    # Store protégé des skills perso (hors sandbox) — sans cet env, le resolver
    # retomberait sur le VRAI ``user_skills/`` du dépôt (pollution).
    monkeypatch.setenv("APP_USER_SKILLS_DIR", str(tmp_path / "user_skills"))
    from llm_core.tools import skill_tools
    m = FakeMCP()
    skill_tools.register(m)
    return m.tools["skill_get"], g, skill_tools


def _is_err(r):
    return r.__class__.__name__ == "ErrEnvelope"


async def test_get_global_body(env):
    skill_get, g, _ = env
    _write(g, "jenkins/deploy.md", "jenkins-deploy", body="STEP 1\nSTEP 2")
    r = await skill_get(FakeCtx(username="alice"), name="jenkins-deploy")
    assert not _is_err(r)
    assert "STEP 1" in r.body and r.source == "global"


async def test_user_isolation(env):
    skill_get, g, st = env
    s.save_user_skill(st._user_skills_dir("alice"), "alice-secret", "d", "ALICE BODY")
    # Bob ne voit PAS le skill perso d'Alice.
    rb = await skill_get(FakeCtx(username="bob"), name="alice-secret")
    assert _is_err(rb) and rb.error == "skill_not_found"
    # Alice, oui.
    ra = await skill_get(FakeCtx(username="alice"), name="alice-secret")
    assert not _is_err(ra) and ra.body == "ALICE BODY" and ra.source == "user"


async def test_learned_not_exposed(env):
    skill_get, g, _ = env
    _write(g, "learned/staged.md", "staged-learned", body="LEARNED")
    r = await skill_get(FakeCtx(username="alice"), name="staged-learned")
    assert _is_err(r) and r.error == "skill_not_found"


async def test_not_found(env):
    skill_get, *_ = env
    r = await skill_get(FakeCtx(username="alice"), name="nope")
    assert _is_err(r) and r.error == "skill_not_found"


async def test_no_path_leak(env):
    skill_get, g, _ = env
    _write(g, "g1.md", "g1", body="B")
    r = await skill_get(FakeCtx(username="alice"), name="g1")
    assert "path" not in r.model_dump()


async def test_user_precedence_and_exact_name(env):
    skill_get, g, st = env
    _write(g, "shared.md", "shared", body="GLOBAL")
    s.save_user_skill(st._user_skills_dir("alice"), "shared", "d", "ALICE")
    r = await skill_get(FakeCtx(username="alice"), name="shared")
    assert r.body == "ALICE" and r.source == "user"
