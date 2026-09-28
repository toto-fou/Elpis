# SPDX-License-Identifier: MIT
"""Profil réseau IMPOSÉ par l'admin (2026-08-05).

Deux clés cohabitent dans les settings user : ``network_profile_id`` (le
choix de l'utilisateur) et ``forced_network_profile_id`` (l'imposition
admin). L'imposition prime PARTOUT — sinon un utilisateur déjà positionné
sur un profil ouvert continuerait d'y tourner malgré la décision admin —
et ``POST /api/sandbox/me`` doit la faire respecter côté SERVEUR : le
grisage du sélecteur n'est que la partie visible.
"""
import types

import pytest
from fastapi import HTTPException

from shared_infra.sandbox.executors import resolve_network_profile_id


class _Req:
    def __init__(self, body=None, user_id=7):
        self._body = body or {}
        self.state = types.SimpleNamespace(user_id=user_id, username="admin")

    async def json(self):
        return self._body


_PROFILES = [
    {"id": "isolated", "name": "Isolé", "mode": "none", "ips": []},
    {"id": "web", "name": "Web", "mode": "allowlist_ip", "ips": ["10.0.0.0/8"]},
    {"id": "open", "name": "Ouvert", "mode": "bridge", "ips": []},
]


# ─── Résolveur ────────────────────────────────────────────────────────────

def test_forced_profile_wins_over_user_choice():
    assert resolve_network_profile_id(
        {"network_profile_id": "open", "forced_network_profile_id": "isolated"}
    ) == "isolated"


def test_user_choice_kept_without_force():
    assert resolve_network_profile_id({"network_profile_id": "web"}) == "web"


@pytest.mark.parametrize("settings", [
    None, {}, {"network_profile_id": ""}, {"forced_network_profile_id": "  "},
])
def test_defaults_to_isolated(settings):
    assert resolve_network_profile_id(settings) == "isolated"


# ─── POST /api/sandbox/me ────────────────────────────────────────────────

def _patch_sandbox_route(monkeypatch, settings):
    """Neutralise la DB, le docker et l'audit ; expose le dict de settings."""
    import shared_infra.sandbox.routes_lifecycle as us
    from shared_infra.sandbox.executors import SandboxAdminConfig

    store = dict(settings)
    monkeypatch.setattr(us, "require_user_id", lambda r: 7)
    monkeypatch.setattr(us, "get_user_settings", lambda uid: dict(store))
    monkeypatch.setattr(us, "get_username_by_id", lambda uid: "alice")
    monkeypatch.setattr(us, "audit_event", lambda **kw: None)
    monkeypatch.setattr(us, "load_admin_config",
                        lambda: SandboxAdminConfig.from_dict(
                            {"network_profiles": _PROFILES}))

    def _merge(uid, fn):
        fn(store)
    monkeypatch.setattr(us, "merge_user_settings", _merge)
    return us, store


async def test_post_refuses_other_profile_when_forced(monkeypatch):
    us, store = _patch_sandbox_route(
        monkeypatch,
        {"network_profile_id": "isolated", "forced_network_profile_id": "isolated"})
    with pytest.raises(HTTPException) as e:
        await us.sandbox_me_post(_Req({"mode": "docker", "network_profile_id": "open"}))
    assert e.value.status_code == 403
    # Rien n'a été écrit : la décision admin tient.
    assert store["network_profile_id"] == "isolated"


async def test_post_accepts_the_forced_profile_itself(monkeypatch):
    """Le POST périodique de l'UI (même profil) ne doit pas casser."""
    us, store = _patch_sandbox_route(
        monkeypatch,
        {"network_profile_id": "isolated", "forced_network_profile_id": "isolated"})
    monkeypatch.setattr(us, "ensure_image_loaded", _no_image)
    out = await us.sandbox_me_post(
        _Req({"mode": "docker", "network_profile_id": "isolated"}))
    assert out["ok"] is True
    assert out["network_profile_id"] == "isolated"


async def test_post_free_choice_when_not_forced(monkeypatch):
    us, store = _patch_sandbox_route(monkeypatch, {"network_profile_id": "isolated"})
    monkeypatch.setattr(us, "ensure_image_loaded", _no_image)
    out = await us.sandbox_me_post(
        _Req({"mode": "docker", "network_profile_id": "web"}))
    assert out["network_profile_id"] == "web"
    assert store["network_profile_id"] == "web"


async def test_post_ignores_force_on_a_deleted_profile(monkeypatch):
    """L'admin a supprimé le profil imposé : l'imposition tombe avec lui,
    sinon l'utilisateur reste coincé sur un identifiant inexistant."""
    us, store = _patch_sandbox_route(
        monkeypatch,
        {"network_profile_id": "web", "forced_network_profile_id": "disparu"})
    monkeypatch.setattr(us, "ensure_image_loaded", _no_image)
    out = await us.sandbox_me_post(
        _Req({"mode": "docker", "network_profile_id": "web"}))
    assert out["network_profile_id"] == "web"


async def _no_image(image, blocking=False):
    """``ensure_image_loaded`` stub : image absente → pas de bootstrap docker."""
    from shared_infra.sandbox.executors import ImageLoadStatus

    class _S:
        status = ImageLoadStatus.NOT_FOUND

        def to_dict(self):
            return {"status": "not_found"}
    return _S()


# ─── POST /api/admin/users/{id}/network-profile ──────────────────────────

def _patch_admin_users(monkeypatch, settings):
    import shared_infra.routes.admin.users as au
    from shared_infra.sandbox.executors import SandboxAdminConfig
    import shared_infra.sandbox.executors as ex

    store = dict(settings)
    monkeypatch.setattr(au, "_require_admin", lambda r: None)
    monkeypatch.setattr(au, "audit_event", lambda **kw: None)
    monkeypatch.setattr(au, "get_username_by_id", lambda uid: "alice")
    monkeypatch.setattr(au, "get_user_settings", lambda uid: dict(store))
    monkeypatch.setattr(au, "merge_user_settings", lambda uid, fn: fn(store))
    monkeypatch.setattr(ex, "load_admin_config",
                        lambda: SandboxAdminConfig.from_dict(
                            {"network_profiles": _PROFILES}))
    # Pas de docker sous pytest : la destruction du container est best-effort
    # et son échec ne doit pas faire échouer l'imposition.
    monkeypatch.setattr(ex, "get_user_sandbox",
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("no docker")))
    return au, store


async def test_admin_forces_profile(monkeypatch):
    au, store = _patch_admin_users(monkeypatch, {"network_profile_id": "open"})
    out = await au.api_admin_set_network_profile(7, _Req({"profile_id": "isolated"}))
    assert out["ok"] is True
    assert store["forced_network_profile_id"] == "isolated"
    # Le choix courant est aligné : à la levée de l'imposition l'utilisateur
    # repart du profil subi, pas d'un ancien choix réactivé en douce.
    assert store["network_profile_id"] == "isolated"
    assert out["network_profile_id"] == "isolated"


async def test_admin_releases_profile(monkeypatch):
    au, store = _patch_admin_users(
        monkeypatch,
        {"network_profile_id": "isolated", "forced_network_profile_id": "isolated"})
    out = await au.api_admin_set_network_profile(7, _Req({"profile_id": None}))
    assert out["forced_network_profile_id"] == ""
    assert "forced_network_profile_id" not in store
    assert store["network_profile_id"] == "isolated"


async def test_admin_rejects_unknown_profile(monkeypatch):
    au, store = _patch_admin_users(monkeypatch, {"network_profile_id": "web"})
    with pytest.raises(HTTPException) as e:
        await au.api_admin_set_network_profile(7, _Req({"profile_id": "nope"}))
    assert e.value.status_code == 400
    assert "forced_network_profile_id" not in store


# ─── GET /api/sandbox/me : un worker « non vérifié » lance le chargement ────
# (2026-09-20) L'état de chargement d'image est PAR WORKER ; seul le POST le
# déclenchait. Le worker qui n'avait pas reçu le POST répondait « non vérifié »
# pour toujours et ne créait jamais le conteneur.

@pytest.mark.asyncio
async def test_get_me_declenche_le_chargement_d_image_sur_un_worker_vierge(monkeypatch):
    from fastapi import Request
    from shared_infra.sandbox.executors._image_loader import ImageLoadState, ImageLoadStatus
    us, _ = _patch_sandbox_route(monkeypatch, {"network_profile_id": "bridge"})
    appels = []

    class _Sb:
        container_name = "elpis-sb-alice"
        async def daemon_reachable(self): return True, "ok"
        async def status(self):
            raise AssertionError("pas de statut tant que l'image charge")
    monkeypatch.setattr(us, "_user_sandbox_for", lambda uid, u: _Sb())
    monkeypatch.setattr(us, "get_image_load_state", lambda: ImageLoadState(status=ImageLoadStatus.NOT_CHECKED))

    async def _ensure(image, blocking=False):
        appels.append((image, blocking))
        return ImageLoadState(status=ImageLoadStatus.LOADING, image=image)
    monkeypatch.setattr(us, "ensure_image_loaded", _ensure)
    out = await us.sandbox_me_get(Request({"type": "http", "headers": [], "method": "GET", "path": "/"}))
    assert appels and appels[0][1] is False, "chargement lancé, non bloquant"
    assert out["container"]["pending"] == "image_loading"


@pytest.mark.asyncio
async def test_get_me_ne_relance_rien_quand_l_image_est_connue(monkeypatch):
    from fastapi import Request
    from shared_infra.sandbox.executors._image_loader import ImageLoadState, ImageLoadStatus
    us, _ = _patch_sandbox_route(monkeypatch, {"network_profile_id": "bridge"})

    class _Sb:
        container_name = "elpis-sb-alice"
        async def daemon_reachable(self): return True, "ok"
    monkeypatch.setattr(us, "_user_sandbox_for", lambda uid, u: _Sb())
    monkeypatch.setattr(us, "get_image_load_state", lambda: ImageLoadState(status=ImageLoadStatus.LOADING, image="i"))

    async def _ensure(image, blocking=False):
        raise AssertionError("ne doit pas être appelé")
    monkeypatch.setattr(us, "ensure_image_loaded", _ensure)
    out = await us.sandbox_me_get(Request({"type": "http", "headers": [], "method": "GET", "path": "/"}))
    assert out["container"]["pending"] == "image_loading"
