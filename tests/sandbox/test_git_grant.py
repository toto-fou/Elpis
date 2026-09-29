# SPDX-License-Identifier: MIT
"""``_grant_after_git`` — reconcile ownership/perms after a host-side git op.

git runs on the HOST (UID 1000); pull/checkout/merge/discard/resolve rewrite
the working tree as host-owned files the container (UID 10001) then can't edit.
The helper forwards the repo's path (relative to the work root) to
``sandbox_grant_access``. These tests lock the rel-path computation without the
full route stack (sandbox_grant_access is stubbed).
"""
import pytest

import shared_infra.sandbox.routes_git as gitmod


@pytest.mark.asyncio
async def test_grant_after_git_forwards_repo_rel(tmp_path, monkeypatch):
    work = tmp_path / "work"
    (work / "myrepo").mkdir(parents=True)
    calls = []

    async def _fake_grant(uid, rel):
        calls.append((uid, rel))

    monkeypatch.setattr(
        "shared_infra.sandbox.exec_bridge.sandbox_grant_access", _fake_grant
    )
    await gitmod._grant_after_git(7, work, work / "myrepo")
    assert calls == [(7, "myrepo")]


@pytest.mark.asyncio
async def test_grant_after_git_root_repo_uses_empty_rel(tmp_path, monkeypatch):
    work = tmp_path / "work"
    work.mkdir()
    calls = []

    async def _fake_grant(uid, rel):
        calls.append((uid, rel))

    monkeypatch.setattr(
        "shared_infra.sandbox.exec_bridge.sandbox_grant_access", _fake_grant
    )
    # repo == work root → rel "" → sandbox_grant_access reconciles all of /work.
    await gitmod._grant_after_git(7, work, work)
    assert calls == [(7, "")]


@pytest.mark.asyncio
async def test_grant_after_git_out_of_root_falls_back_to_empty_rel(tmp_path, monkeypatch):
    work = tmp_path / "work"
    work.mkdir()
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    calls = []

    async def _fake_grant(uid, rel):
        calls.append((uid, rel))

    monkeypatch.setattr(
        "shared_infra.sandbox.exec_bridge.sandbox_grant_access", _fake_grant
    )
    # repo not under work → relative_to() raises → helper falls back to "".
    await gitmod._grant_after_git(7, work, outside)
    assert calls == [(7, "")]


# ── Fallback chmod host-side (audit 2026-07-26, retour n°3) ──────────────
# setfacl est souvent absent et le chown docker exige un container UP : le
# grant restait alors un no-op silencieux → repo UID-app en 0644/0755,
# inutilisable par le shell (index.lock, rm -rf impossible). L'étape 1bis
# chmod-walk (host-side, sans dépendance) rétablit 0666/0777.

@pytest.mark.asyncio
async def test_grant_access_chmod_fallback_without_setfacl_or_docker(tmp_path, monkeypatch):
    import os
    import stat

    import shared_infra.sandbox.exec_bridge as se

    work = tmp_path / "work"
    repo = work / "proj" / ".git"
    repo.mkdir(parents=True)
    f = repo / "config"
    f.write_text("[core]\n")
    script = work / "proj" / "run.sh"
    script.write_text("#!/bin/sh\n")
    os.chmod(work / "proj", 0o755)
    os.chmod(repo, 0o755)
    os.chmod(f, 0o644)
    os.chmod(script, 0o744)                      # exécutable → doit le rester

    class _SB:
        sandbox_path = str(work)
        container_name = "nope"

    monkeypatch.setattr(se, "_get_sandbox_for_user", lambda uid: _SB())
    monkeypatch.setattr(se.shutil, "which", lambda name: None)   # ni setfacl ni docker

    await se.sandbox_grant_access(7, "proj")

    def m(p):
        return stat.S_IMODE(os.stat(p).st_mode) & 0o777

    assert m(work / "proj") == 0o777
    assert m(repo) == 0o777
    assert m(f) == 0o666
    assert m(script) == 0o777                    # bit x préservé


# ── Résolution de la sandbox (bug 2026-07-30) ────────────────────────────
# ``sandbox_grant_access`` appelait ``get_user_sandbox(user_id)`` alors que la
# vraie signature est ``(user_id, username, sandbox_path, network_profile_id=)``
# → TypeError levé AVANT toute action et avalé par le ``except Exception`` →
# grant TOTALEMENT inerte (ni ACL, ni chmod, ni chown) après CHAQUE clone /
# init / pull host-side, panneau git comme outils MCP. Symptôme : « j'ai cloné
# le dépôt mais je ne peux pas l'éditer depuis le terminal » (repo laissé à
# l'UID app en 0644/0755, conteneur en « other »).
#
# L'ancien test ci-dessus masquait le bug : il monkeypatchait get_user_sandbox
# par un lambda à UN argument — une arité qui n'existe nulle part.

@pytest.mark.asyncio
async def test_grant_access_resolver_call_matches_real_signature(tmp_path, monkeypatch):
    import inspect
    import os
    import stat

    import shared_infra.sandbox.exec_bridge as se
    from shared_infra.sandbox.executors import get_user_sandbox as _real_factory

    work = tmp_path / "work"
    (work / "proj").mkdir(parents=True)
    f = work / "proj" / "a.txt"
    f.write_text("x")
    os.chmod(work / "proj", 0o755)
    os.chmod(f, 0o644)

    class _SB:
        sandbox_path = str(work)
        container_name = "nope"

    seen = {}

    def _factory(*args, **kwargs):
        # Contrat : l'appel DOIT être valide pour la vraie factory. Un retour
        # à ``get_user_sandbox(user_id)`` lève ici → grant inerte → les
        # assertions de mode ci-dessous échouent.
        inspect.signature(_real_factory).bind(*args, **kwargs)
        seen["args"] = args
        return _SB()

    monkeypatch.setattr(se, "get_user_sandbox", _factory)
    monkeypatch.setattr(se, "get_user_settings", lambda uid: {})
    monkeypatch.setattr(se, "get_username_by_id", lambda uid: "alice")
    monkeypatch.setattr("shared_infra.routes._helpers._get_work_path", lambda uid: work)
    monkeypatch.setattr(se.shutil, "which", lambda name: None)   # ni setfacl ni docker

    await se.sandbox_grant_access(7, "proj")

    assert seen.get("args"), "la sandbox n'a jamais été résolue → grant inerte"
    m = lambda p: stat.S_IMODE(os.stat(p).st_mode) & 0o777        # noqa: E731
    assert m(work / "proj") == 0o777
    assert m(f) == 0o666
