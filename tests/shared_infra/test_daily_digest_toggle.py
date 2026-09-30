# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_daily_digest_toggle.py — digest quotidien désactivable.

La passe de maintenance ne génère le rapport+notification quotidiens que si
``maintenance.daily_digest_enabled`` (config.json) est vrai — relu À CHAUD. Une
route admin permet de basculer ce flag.
"""
from __future__ import annotations

import pytest


def test_maybe_run_digest_respects_flag(monkeypatch):
    import shared_infra.config as config
    import shared_infra.observability.metrics.daily_report as dr
    import shared_infra.ops.maintenance as mnt
    calls = []
    monkeypatch.setattr(dr, "generate_and_store_daily_digest", lambda *a, **k: calls.append(1))

    monkeypatch.setattr(config, "read_config_json", lambda: {"maintenance": {"daily_digest_enabled": False}})
    mnt._maybe_run_daily_digest()
    assert calls == []                                  # désactivé → aucun digest

    monkeypatch.setattr(config, "read_config_json", lambda: {"maintenance": {"daily_digest_enabled": True}})
    mnt._maybe_run_daily_digest()
    assert calls == [1]                                 # activé → digest

    monkeypatch.setattr(config, "read_config_json", lambda: {})
    mnt._maybe_run_daily_digest()
    assert calls == [1, 1]                              # absent → défaut rétro-compat (True)


def test_auto_toggle_route(tmp_path, monkeypatch):
    import shared_infra.config as config
    cfgpath = tmp_path / "config.json"
    cfgpath.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(config, "CONFIG_JSON_PATH", cfgpath)
    import shared_infra.routes.admin.metrics as metrics
    monkeypatch.setattr(metrics, "require_user_id", lambda r: 1)
    monkeypatch.setattr(metrics, "get_user_by_id", lambda uid: {"id": uid, "is_admin": 1})
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from shared_infra.routes.admin._state import admin_router
    app = FastAPI(); app.include_router(admin_router)
    c = TestClient(app)

    # Défaut (clé absente) → True.
    assert c.get("/api/admin/report/daily/auto").json()["enabled"] is True
    # Désactivation persistée.
    assert c.post("/api/admin/report/daily/auto", json={"enabled": False}).json()["enabled"] is False
    assert c.get("/api/admin/report/daily/auto").json()["enabled"] is False
    import json
    assert json.loads(cfgpath.read_text())["maintenance"]["daily_digest_enabled"] is False
