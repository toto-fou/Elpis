# SPDX-License-Identifier: MIT
"""Audit 2026-09-22 (M2) : accès par machine desktop (``access`` +
``allowed_users``), appliqué au point unique de résolution des cibles."""
import pytest

import shared_infra.config as C
import shared_infra.desktop.access as A


def _t(name, access="all", users=(), default=False):
    return {"name": name, "os": "win", "agent_url": f"http://{name}:8765",
            "default": default, "access": access, "allowed_users": list(users)}


def test_coercion_defaut_ouvert():
    out = C._coerce_desktop_targets([{"name": "vm", "agent_url": "http://x/"},
                                     {"name": "vm2", "agent_url": "http://y", "access": "list",
                                      "allowed_users": ["bob", " ", "alice", "bob"]},
                                     {"name": "vm3", "agent_url": "http://z", "access": "bizarre"}])
    assert out[0]["access"] == "all" and out[0]["allowed_users"] == []
    assert out[1]["access"] == "list" and out[1]["allowed_users"] == ["alice", "bob"]
    assert out[2]["access"] == "all"


def test_regles(monkeypatch):
    monkeypatch.setattr(A, "_is_admin", lambda u: u == "root")
    ouvert, restreint = _t("a"), _t("b", "list", ["alice"])
    assert A.target_allowed(ouvert, "bob")
    assert A.target_allowed(restreint, "alice")
    assert not A.target_allowed(restreint, "bob")
    assert A.target_allowed(restreint, "root")                     # admin : tout
    assert not A.target_allowed(restreint, "")                     # identité inconnue
    assert [t["name"] for t in A.allowed_targets([ouvert, restreint], "bob")] == ["a"]


def test_resolution_outils(monkeypatch):
    """Un nom interdit se comporte comme inconnu ; le défaut retombe sur la
    première machine permise."""
    from llm_core.tools import desktop_tools as D
    monkeypatch.setattr(A, "_is_admin", lambda u: False)
    monkeypatch.setattr(C, "reload_desktop_config_from_disk", lambda *a, **k: False)
    monkeypatch.setattr(C, "get_desktop_targets",
                        lambda reload=True: [_t("prod", "list", ["alice"], default=True), _t("lab")])
    assert D._resolve_target("prod", "bob")["name"] == "lab"
    assert D._resolve_target_strict("prod", "bob") is None
    assert D._resolve_target("", "bob")["name"] == "lab"
    assert D._resolve_target("", "alice")["name"] == "prod"


def test_reglage_par_compte(monkeypatch):
    import shared_infra.routes.admin.users as U
    cfg = {"desktop": {"targets": [_t("prod", "list", ["alice"]), _t("lab"),
                                   _t("qa", "list", [])]}}
    written = {}
    monkeypatch.setattr(U, "read_config_json", lambda: cfg)
    monkeypatch.setattr(C, "write_config_json", lambda c: written.update(c))
    monkeypatch.setattr(C, "reload_desktop_config_from_disk", lambda *a, **k: True)
    changed = U._set_desktop_membership("bob", {"qa"})
    assert changed == ["qa"]
    ts = {t["name"]: t for t in written["desktop"]["targets"]}
    assert ts["qa"]["allowed_users"] == ["bob"] and ts["prod"]["allowed_users"] == ["alice"]
    assert "allowed_users" not in cfg["desktop"]["targets"][2] or cfg["desktop"]["targets"][2]["allowed_users"] == []
    assert ts["lab"].get("access") == "all"                      # machine ouverte intacte
    assert U._set_desktop_membership("alice", set()) == ["prod"]
