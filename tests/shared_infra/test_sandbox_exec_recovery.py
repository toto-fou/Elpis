# SPDX-License-Identifier: MIT
"""Écritures de l'éditeur par l'agent de la sandbox : un agent ou un
conteneur injoignable donne 503 (le front propose de réessayer), un délai
dépassé 504, une vraie erreur 500 avec le libellé de l'opération ; la racine
n'est jamais supprimée, un chemin réel l'est (absent : rien)."""
import pytest
from fastapi import HTTPException

from shared_infra.sandbox import exec_bridge as sx
from shared_infra.sandbox.agent_client import AgentError


@pytest.mark.parametrize("code,statut", [
    ("agent_unavailable", 503), ("container_down", 503), ("transport", 503),
    ("bad_response", 502), ("timeout", 504), ("io_error", 500),
    ("exists", 409), ("is_dir", 409), ("outside_root", 403), ("not_found", 404),
    ("name_too_long", 400), ("invalid", 400), ("loop", 400), ("bad_regex", 400),
])
def test_refus_de_l_agent_en_statut_http(code, statut):
    e = sx.agent_http(AgentError(code, "détail"), "Sauvegarde")
    assert e.status_code == statut
    if statut in (500, 502):
        assert "Sauvegarde" in e.detail
    if code == "bad_response":
        assert "arrêté" not in e.detail


@pytest.fixture()
def root(tmp_path, monkeypatch):
    from shared_infra.sandbox.executors import get_user_sandbox
    work = tmp_path / "u" / "work"
    work.mkdir(parents=True)
    sb = get_user_sandbox(1, "u", work)
    monkeypatch.setattr(sx, "_get_sandbox_for_user", lambda uid: sb)
    return work


async def test_delete_root_alias_message(root):
    for alias in ("/work", "work", "./work", ""):
        with pytest.raises(HTTPException) as ei:
            await sx.sandbox_delete(1, alias)
        assert ei.value.status_code == 400
        assert "suppression" in ei.value.detail.lower()


async def test_delete_real_path_proceeds(root):
    (root / "notes.txt").write_text("x")
    (root / "d").mkdir()
    (root / "d" / "f").write_text("y")
    await sx.sandbox_delete(1, "notes.txt")
    await sx.sandbox_delete(1, "d")
    await sx.sandbox_delete(1, "absent.txt")             # comme rm -rf : rien
    assert sorted(p.name for p in root.iterdir()) == []


async def test_clear_et_stat_mtime(root):
    (root / ".cache").mkdir()
    (root / "a").write_text("a")
    assert await sx.sandbox_stat_mtime(1, "a") == pytest.approx((root / "a").stat().st_mtime)
    assert await sx.sandbox_stat_mtime(1, "absent") is None
    assert await sx.sandbox_clear(1) == 2
    assert list(root.iterdir()) == []
