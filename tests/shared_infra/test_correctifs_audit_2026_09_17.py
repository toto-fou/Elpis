# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_correctifs_audit_2026_09_17.py — les défauts relevés
pendant l'audit du 2026-09-16 et corrigés le lendemain.

A1  ``sandbox_grant_access`` (coroutine) était appelée SANS ``await`` depuis une
    fonction synchrone : jamais exécutée — un ``/work`` importé restait
    propriété de l'UID de l'app, inéditable depuis le container.
A2  idem pour ``count_tokens_exact`` dans l'aperçu admin du prompt système :
    le comptage exact ne pouvait pas aboutir, l'aperçu montrait TOUJOURS une
    estimation.
A5  la détection des capacités du serveur intégré recomposait ``http://IP:PORT``
    et ignorait ``llama.url`` / ``LLAMA_URL``.
A8  ``llm.allowed_provider_types`` n'était vérifié qu'à la CRÉATION : un
    connecteur perso d'un type retiré continuait de servir.
P3  ``tests/shared_infra/test_llm_connectors.py`` lancé SEUL cassait sur un
    import circulaire entre les routes connecteurs user et admin.
"""
from __future__ import annotations

import asyncio
import inspect

import pytest


# ── A1 ───────────────────────────────────────────────────────────────────────
def test_les_droits_de_work_sont_vraiment_remis_apres_import(monkeypatch):
    import shared_infra.sandbox.routes_files as rf

    vus = []

    async def _fake_grant(uid, rel):
        vus.append((uid, rel))

    monkeypatch.setattr("shared_infra.sandbox.exec_bridge.sandbox_grant_access",
                        _fake_grant)
    asyncio.run(rf.grant_work_access(7))
    assert vus == [(7, "")], "la coroutine de remise des droits n'a pas été exécutée"
    # La route asynchrone appelle bien le helper (et plus l'appel nu, en thread).
    src = inspect.getsource(rf.api_sandbox_import)
    assert "await grant_work_access(user_id)" in src
    assert "sandbox_grant_access(user_id" not in inspect.getsource(rf.import_work_archive)


def test_une_remise_de_droits_en_echec_ne_casse_pas_limport(monkeypatch):
    import shared_infra.sandbox.routes_files as rf

    async def _boom(uid, rel):
        raise OSError("acl refusée")

    monkeypatch.setattr("shared_infra.sandbox.exec_bridge.sandbox_grant_access", _boom)
    asyncio.run(rf.grant_work_access(7))        # ne lève pas


# ── A2 ───────────────────────────────────────────────────────────────────────
def test_lapercu_admin_du_prompt_compte_exact_quand_le_moteur_repond(monkeypatch):
    import shared_infra.routes.admin.system_prompts as sp

    async def _exact(text, *a, **k):
        return 4242

    monkeypatch.setattr("llm_core._llama_http.count_tokens_exact", _exact)
    n, exact = asyncio.run(sp._count_prompt_tokens("bonjour"))
    assert (n, exact) == (4242, True)


def test_lapercu_retombe_sur_lestimation_si_le_moteur_ne_repond_pas(monkeypatch):
    import shared_infra.routes.admin.system_prompts as sp

    async def _rien(text, *a, **k):
        return None

    monkeypatch.setattr("llm_core._llama_http.count_tokens_exact", _rien)
    n, exact = asyncio.run(sp._count_prompt_tokens("bonjour " * 50))
    assert exact is False and n > 0


# ── A5 ───────────────────────────────────────────────────────────────────────
def test_les_capacites_sondent_ladresse_configuree(monkeypatch):
    import httpx

    import shared_infra.config as cfg
    from llm_core import _capabilities as C

    vus = []

    class _Resp:
        status_code = 404

        def json(self):
            return {}

    class _Client:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url, **k):
            vus.append(url)
            return _Resp()

    monkeypatch.setattr(httpx, "AsyncClient", _Client)
    # État module (partagé par tout le processus de test) : on le remet.
    avant = dict(C._LLAMA_CAPABILITIES)
    monkeypatch.setattr(C, "_LLAMA_CAPABILITIES", dict(avant), raising=False)
    monkeypatch.setattr(cfg, "LLAMA_URL", "https://llm.interne:8443/v1/chat/completions")
    monkeypatch.setattr(cfg, "LLAMA_IP", "10.168.122.1")
    monkeypatch.setattr(cfg, "LLAMA_PORT", "8080")
    asyncio.run(C.detect_llama_capabilities(timeout_s=0.2))
    assert vus and vus[0].startswith("https://llm.interne:8443/"), vus
    assert not any("10.168.122.1" in u for u in vus)


# ── A8 ───────────────────────────────────────────────────────────────────────
@pytest.fixture()
def conn_base(tmp_path, monkeypatch):
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    legacy.init_db()
    from shared_infra.accounts.users import create_user
    from shared_infra.llm import connectors as lc
    uid = create_user("alice", "pw-alice-12")
    perso = lc.create_connector(scope="user", owner_user_id=uid, provider_type="openai",
                                wire="openai", base_url="https://api.openai.com/v1",
                                label="Perso", default_model="gpt-x")
    partage = lc.create_connector(scope="shared", provider_type="openai", wire="openai",
                                  base_url="https://api.openai.com/v1", label="Partagé",
                                  default_model="gpt-x")
    return {"uid": uid, "perso": perso, "partage": partage}


def test_un_fournisseur_retire_cesse_de_servir(conn_base, monkeypatch):
    from llm_core._target import EngineUnavailable, resolve_llm_target

    monkeypatch.setattr("shared_infra.llm.connectors.allowed_provider_types",
                        lambda: ["anthropic"])
    with pytest.raises(EngineUnavailable) as e:
        resolve_llm_target(conn_base["uid"], conn_base["perso"], None,
                           strict=True, touch=False)
    assert e.value.reason == "provider"
    # Un connecteur PARTAGÉ est posé par un administrateur : la liste, qui ne
    # vise que les créations d'utilisateurs, ne le coupe pas.
    t = resolve_llm_target(conn_base["uid"], conn_base["partage"], None,
                           strict=True, touch=False)
    assert t.connector_id == conn_base["partage"]


def test_le_fournisseur_autorise_passe_toujours(conn_base, monkeypatch):
    from llm_core._target import resolve_llm_target

    monkeypatch.setattr("shared_infra.llm.connectors.allowed_provider_types",
                        lambda: ["openai", "anthropic"])
    t = resolve_llm_target(conn_base["uid"], conn_base["perso"], None,
                           strict=True, touch=False)
    assert t.connector_id == conn_base["perso"] and t.model == "gpt-x"


def test_une_allowlist_illisible_ninterdit_rien(conn_base, monkeypatch):
    from llm_core._target import resolve_llm_target

    def _boom():
        raise OSError("config illisible")

    monkeypatch.setattr("shared_infra.llm.connectors.allowed_provider_types", _boom)
    assert resolve_llm_target(conn_base["uid"], conn_base["perso"], None,
                              strict=True, touch=False).connector_id == conn_base["perso"]


# ── Import circulaire ────────────────────────────────────────────────────────
def test_les_routes_connecteurs_simportent_dans_les_deux_sens():
    """Le module admin importe le MODULE user (pas ses noms) : importer l'un ou
    l'autre en premier doit marcher."""
    import subprocess
    import sys

    for premier, second in (("shared_infra.llm.routes_connectors",
                             "shared_infra.routes.admin.llm_connectors"),
                            ("shared_infra.routes.admin.llm_connectors",
                             "shared_infra.llm.routes_connectors")):
        r = subprocess.run([sys.executable, "-c",
                            f"import {premier}, {second}; print('ok')"],
                           capture_output=True, text=True, timeout=120)
        assert r.returncode == 0 and "ok" in r.stdout, r.stderr[-800:]
