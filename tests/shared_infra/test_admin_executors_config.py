# SPDX-License-Identifier: MIT
"""Config admin sandbox (/api/admin/executors) — paramètres avancés.

Depuis 2026-07-19 le POST valide et PERSISTE exec_user / runtime /
extra_run_args (déjà consommés par SandboxAdminConfig).
Régression couverte : avant, le sanitizer reconstruisait le bloc
``executors`` sans ces clés → chaque sauvegarde admin les effaçait
silencieusement du config.json.
"""
import types

import pytest
from fastapi import HTTPException

from shared_infra.sandbox.executors import DEFAULT_IMAGE, configured_image


class _Req:
    """Request minimal : state + body JSON async."""
    def __init__(self, body):
        self._body = body
        self.state = types.SimpleNamespace(user_id=1, username="admin")

    async def json(self):
        return self._body


def _patch(monkeypatch, store):
    import shared_infra.routes.admin.executors as ex
    monkeypatch.setattr(ex, "_require_admin", lambda r: None)
    monkeypatch.setattr(ex, "audit_event", lambda **kw: None)
    monkeypatch.setattr(ex, "reset_user_sandbox_cache", lambda: None)
    monkeypatch.setattr(ex, "read_config_json", lambda: dict(store))
    monkeypatch.setattr(ex, "write_config_json", lambda cfg: store.update(cfg))
    return ex


_BASE_BODY = {
    "limits": {"memory_mb": 4096, "cpu_quota_pct": 200, "pids_max": 1024, "timeout_s": 300},
    "force_user_docker": True,
    "idle_kill_hours": 12,
    "network_profiles": [{"id": "isolated", "name": "Isolé", "mode": "none", "ips": []}],
}


async def test_post_persists_advanced_fields(monkeypatch):
    store = {}
    ex = _patch(monkeypatch, store)
    body = dict(_BASE_BODY, exec_user="0:0", runtime="runsc",
                extra_run_args=["--cap-add=NET_ADMIN", "--shm-size=2g"])
    out = await ex.admin_executors_post(_Req({"executors": body}))
    assert out["ok"] is True
    blk = store["executors"]
    assert blk["exec_user"] == "0:0"
    assert blk["runtime"] == "runsc"
    assert blk["extra_run_args"] == ["--cap-add=NET_ADMIN", "--shm-size=2g"]
    # Et le GET les ré-expose.
    got = ex.admin_executors_get(_Req({}))
    assert got["config"]["exec_user"] == "0:0"
    assert got["config"]["runtime"] == "runsc"


async def test_post_preserves_advanced_fields_when_absent(monkeypatch):
    """Client legacy (sans les clés avancées) → les valeurs en place SURVIVENT."""
    store = {"executors": {"exec_user": "0:0", "runtime": "runsc",
                           "extra_run_args": ["--dns=1.1.1.1"]}}
    ex = _patch(monkeypatch, store)
    await ex.admin_executors_post(_Req({"executors": dict(_BASE_BODY)}))
    blk = store["executors"]
    assert blk["exec_user"] == "0:0"
    assert blk["runtime"] == "runsc"
    assert blk["extra_run_args"] == ["--dns=1.1.1.1"]
    # Les champs standards du POST sont bien pris en compte.
    assert blk["limits"]["memory_mb"] == 4096
    assert blk["force_user_docker"] is True


@pytest.mark.parametrize("field,value,msg", [
    ("exec_user", "abc", "exec_user"),
    ("exec_user", "10001", "exec_user"),
    ("runtime", "bad runtime!", "runtime"),
    ("extra_run_args", "pas-une-liste", "extra_run_args"),
    ("extra_run_args", ["ok", "in\njecte"], "extra_run_args"),
])
async def test_post_validates_advanced_fields(monkeypatch, field, value, msg):
    store = {}
    ex = _patch(monkeypatch, store)
    body = dict(_BASE_BODY)
    body[field] = value
    with pytest.raises(HTTPException) as ei:
        await ex.admin_executors_post(_Req({"executors": body}))
    assert ei.value.status_code == 400
    assert msg in str(ei.value.detail)
    assert "executors" not in store          # rien écrit en cas d'erreur


async def test_get_defaults_without_config(monkeypatch):
    ex = _patch(monkeypatch, {})
    got = ex.admin_executors_get(_Req({}))
    cfg = got["config"]
    assert cfg["exec_user"] == "10001:10001"
    assert cfg["runtime"] == ""
    assert cfg["extra_run_args"] == []


# ── Profils réseau : réglage fin (domains / ports / dns) ─────────────────────

def _allowlist_profile(**over):
    p = {"id": "web", "name": "Web", "mode": "allowlist_ip",
         "ips": ["10.0.0.5"], "domains": [], "ports": [], "dns": []}
    p.update(over)
    return p


async def test_post_persists_network_fine_grain(monkeypatch):
    store = {}
    ex = _patch(monkeypatch, store)
    monkeypatch.setattr(ex, "_find_stale_network_containers",
                        _fake_stale([{"user_id": 3, "username": "carol",
                                      "container": "elpis-sb-carol", "profile_id": "web"}]))
    body = dict(_BASE_BODY, network_profiles=[
        _BASE_BODY["network_profiles"][0],
        _allowlist_profile(domains=["GitHub.com."], ports=["443", 80], dns=["10.168.1.1"]),
    ])
    out = await ex.admin_executors_post(_Req({"executors": body}))
    assert out["ok"] is True
    prof = next(p for p in store["executors"]["network_profiles"] if p["id"] == "web")
    assert prof["domains"] == ["github.com"]        # normalisé (minuscule, sans point final)
    assert prof["ports"] == [443, 80]               # int() même depuis des strings
    assert prof["dns"] == ["10.168.1.1"]
    # La réponse expose la dérive pour l'UI « Recréer maintenant ».
    assert out["stale_containers"][0]["container"] == "elpis-sb-carol"
    assert out["warnings"] == []


def _fake_stale(result):
    async def _f(profiles):
        return result
    return _f


async def test_post_network_warnings_non_blocking(monkeypatch):
    """CIDR dangereux (0.0.0.0/0, plage métadonnées) : warning renvoyé, PAS de 400."""
    store = {}
    ex = _patch(monkeypatch, store)
    monkeypatch.setattr(ex, "_find_stale_network_containers", _fake_stale([]))
    body = dict(_BASE_BODY, network_profiles=[
        _BASE_BODY["network_profiles"][0],
        _allowlist_profile(ips=["0.0.0.0/0", "169.254.0.0/16"]),
    ])
    out = await ex.admin_executors_post(_Req({"executors": body}))
    assert out["ok"] is True
    assert len(out["warnings"]) == 2
    assert any("TOUT internet" in w for w in out["warnings"])
    assert any("169.254" in w for w in out["warnings"])


@pytest.mark.parametrize("over,msg", [
    ({"ips": [], "domains": []},              "sans IP ni domaine"),
    ({"domains": ["pas un domaine!"]},        "domaine invalide"),
    ({"ports": ["https"]},                    "port invalide"),
    ({"ports": [70000]},                      "port hors plage"),
    ({"dns": ["resolver.example"]},           "résolveur DNS invalide"),
])
async def test_post_network_fine_grain_validation(monkeypatch, over, msg):
    store = {}
    ex = _patch(monkeypatch, store)
    body = dict(_BASE_BODY, network_profiles=[
        _BASE_BODY["network_profiles"][0], _allowlist_profile(**over)])
    with pytest.raises(HTTPException) as ei:
        await ex.admin_executors_post(_Req({"executors": body}))
    assert ei.value.status_code == 400
    assert msg in str(ei.value.detail)
    assert "executors" not in store


async def test_post_reanchors_isolated_profile_to_none(monkeypatch):
    """``isolated`` est le repli fail-closed du résolveur de profil : lui
    donner un mode ouvert transformerait chaque repli en accès réseau. Le
    serveur le ré-ancre sur "none" et le DIT (avertissement non bloquant)."""
    store = {}
    ex = _patch(monkeypatch, store)
    monkeypatch.setattr(ex, "_find_stale_network_containers", _fake_stale([]))
    body = dict(_BASE_BODY, network_profiles=[
        {"id": "isolated", "name": "Isolé", "mode": "bridge", "ips": []},
    ])
    out = await ex.admin_executors_post(_Req({"executors": body}))
    assert out["ok"] is True
    saved = store["executors"]["network_profiles"][0]
    assert saved["id"] == "isolated" and saved["mode"] == "none"
    assert any("repli de sécurité" in w for w in out["warnings"])


# ── Image de déploiement : config.json fait foi ──────────────────────────
# 2026-08-26 — Régression : le POST réinscrivait ``DEFAULT_IMAGE`` en dur.
# Une instance pointée sur une image alternative repassait donc
# SILENCIEUSEMENT sur l'image standard dès qu'un admin enregistrait mémoire,
# réseau ou profils depuis l'onglet Sandbox — et le symptôme n'apparaissait
# qu'au conteneur suivant, très loin de la cause. Le bug était invisible tant
# que config.json portait la valeur par défaut : c'est le premier déploiement
# d'une image maison qui l'aurait révélé.

async def test_post_preserve_image_de_config_json(monkeypatch):
    """Enregistrer depuis l'onglet Sandbox ne doit PAS écraser l'image."""
    store = {"executors": {"image": "elpis/sandbox-maison:2.0.0"}}
    ex = _patch(monkeypatch, store)

    out = await ex.admin_executors_post(_Req({"executors": dict(_BASE_BODY)}))

    assert out["config"]["image"] == "elpis/sandbox-maison:2.0.0"
    assert store["executors"]["image"] == "elpis/sandbox-maison:2.0.0"
    # Le POST doit rester efficace par ailleurs.
    assert store["executors"]["limits"]["memory_mb"] == 4096


async def test_post_n_inscrit_jamais_l_image_livree(monkeypatch):
    """L'image livrée suit la version de l'app : l'inscrire dans config.json
    (sans image déclarée, ou d'une version antérieure) y figerait l'instance
    à la mise à jour suivante (2026-09-29)."""
    for avant in ({}, {"executors": {"image": "elpis/sandbox:1.6.0"}},
                  {"executors": {"image": DEFAULT_IMAGE}}):
        store = dict(avant)
        ex = _patch(monkeypatch, store)
        await ex.admin_executors_post(_Req({"executors": dict(_BASE_BODY)}))
        assert "image" not in store["executors"], avant
        assert ex.admin_executors_get(_Req({}))["image"] == DEFAULT_IMAGE


async def test_post_enchaine_sans_deriver(monkeypatch):
    """Deux enregistrements de suite conservent l'image (pas de dérive)."""
    store = {"executors": {"image": "elpis/sandbox-maison:2.0.0"}}
    ex = _patch(monkeypatch, store)

    await ex.admin_executors_post(_Req({"executors": dict(_BASE_BODY)}))
    await ex.admin_executors_post(_Req({"executors": dict(_BASE_BODY)}))

    assert store["executors"]["image"] == "elpis/sandbox-maison:2.0.0"


def test_get_expose_l_image_reelle(monkeypatch):
    """Le GET doit montrer l'image EFFECTIVE, pas le défaut de l'app.

    Sinon l'admin lit ``elpis/sandbox:1.5.0`` dans l'onglet Sandbox pendant
    que les conteneurs tournent sur une autre image.
    """
    ex = _patch(monkeypatch, {"executors": {"image": "elpis/sandbox-maison:2.0.0"}})
    assert ex.admin_executors_get(_Req({}))["image"] == "elpis/sandbox-maison:2.0.0"

    ex = _patch(monkeypatch, {})
    assert ex.admin_executors_get(_Req({}))["image"] == DEFAULT_IMAGE


def test_image_configuree():
    """Vide, blanche ou ``elpis/sandbox`` d'une autre version : l'image
    livrée ; une image tierce (registre à port compris) : elle-même."""
    for val in ("", "   ", None, "elpis/sandbox:1.6.0", "elpis/sandbox", DEFAULT_IMAGE):
        assert configured_image(val) == DEFAULT_IMAGE, val
    for val in ("elpis/sandbox-maison:2.0.0", "registre:5000/elpis/sandbox:1.6.0",
                "registre:5000/equipe/image"):
        assert configured_image(f" {val} ") == val
