# SPDX-License-Identifier: MIT
"""Routes de la génération d'images : état proposé au compte, fichiers et
galerie (propriétaire seul, 404 sans oracle), console (administrateur seul,
clé jamais renvoyée, clé enregistrée seulement vers l'adresse enregistrée),
réglages du compte et zone possédée de ``config.json``."""
from __future__ import annotations

import io
import json
from dataclasses import dataclass
from typing import Optional

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@dataclass
class Resultat:
    data: bytes
    mime: str
    width: int
    height: int
    seed: Optional[int] = None
    revised_prompt: str = ""


def png() -> bytes:
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (64, 48), (10, 120, 200)).save(buf, "PNG")
    return buf.getvalue()


@pytest.fixture()
def env(tmp_path, monkeypatch):
    import shared_infra.config as cfg_mod
    import shared_infra.db._connection as legacy
    import shared_infra.routes._helpers as helpers
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "user_db" / "app.db"))
    legacy.reset_pool()
    legacy.init_db()
    chemin = tmp_path / "config.json"
    monkeypatch.setattr(cfg_mod, "CONFIG_JSON_PATH", chemin)

    def config(image):
        chemin.write_text(json.dumps({"image": image}), encoding="utf-8")
        cfg_mod.invalidate_config_cache()
    config({"enabled": True, "url": "http://gpu:8084", "max_n": 4})

    from shared_infra.accounts.groups import add_user_to_group, create_group
    from shared_infra.accounts.users import create_user
    ids = {"admin": create_user("admin", "pw-admin-12", is_admin=1),
           "alice": create_user("alice", "pw-alice-12"),
           "bob": create_user("bob", "pw-bob-1234"),
           "modo": create_user("modo", "pw-modo-123", is_admin=2)}
    ids["design"] = create_group("Design")
    add_user_to_group(ids["alice"], ids["design"])

    courant = {"uid": ids["alice"]}

    def qui(request):
        return courant["uid"]
    import shared_infra.accounts.routes_settings as rs
    import shared_infra.image.routes as routes_mod
    monkeypatch.setattr(routes_mod, "require_user_id", qui)
    monkeypatch.setattr(rs, "require_user_id", qui)
    monkeypatch.setattr(helpers, "require_user_id", qui)

    import shared_infra.routes  # noqa: F401 — enregistre les routes
    from shared_infra.routes._state import router
    from shared_infra.routes.admin._state import admin_router
    app = FastAPI()
    app.include_router(router)
    app.include_router(admin_router)
    c = TestClient(app, raise_server_exceptions=False)
    yield {"c": c, "ids": ids, "as": lambda nom: courant.update(uid=ids[nom]),
           "config": config, "chemin": chemin}
    legacy.reset_pool()
    cfg_mod.invalidate_config_cache()


def _image(uid, prompt="Un phare sous l'orage", chat_id=None):
    from shared_infra.image import store
    return store.save_images(uid, chat_id, prompt, model="Qwen-Image", params={},
                             results=[Resultat(png(), "image/png", 64, 48, seed=4812)],
                             keep=50)[0]


# ── État ──────────────────────────────────────────────────────────────────

def test_etat_propose_sans_adresse_ni_cle(env):
    j = env["c"].get("/api/image/status").json()
    assert j["ready"] and j["available"] and j["tool_enabled"]
    assert j["prefs"] == {"ratio": "1:1", "side": 1024, "n": 1, "enhance": False}
    assert j["stored"] == 0 and j["max_n"] == 4 and j["features"]["seed"]
    assert "url" not in j and "api_key_enc" not in j and "gpu" not in json.dumps(j)


def test_etat_hors_groupe_et_moteur_eteint(env):
    env["config"]({"enabled": True, "url": "http://gpu", "groups": [env["ids"]["design"]]})
    env["as"]("bob")
    assert env["c"].get("/api/image/status").json() == {"ready": False, "available": False}
    env["as"]("alice")
    assert env["c"].get("/api/image/status").json()["ready"]
    env["config"]({"enabled": False, "url": "http://gpu"})
    assert env["c"].get("/api/image/status").json()["ready"] is False


# ── Fichiers et galerie ───────────────────────────────────────────────────

def test_fichier_proprietaire_seul(env):
    ref = _image(env["ids"]["alice"])
    r = env["c"].get(ref["url"])
    assert r.status_code == 200 and r.content.startswith(b"\x89PNG")
    assert r.headers["cache-control"].startswith("private")
    assert r.headers["x-content-type-options"] == "nosniff"
    assert 'filename="Un-phare-sous-l-orage-4812.png"' in r.headers["content-disposition"]
    t = env["c"].get(ref["thumb_url"])
    assert t.status_code == 200 and t.headers["content-type"] == "image/webp"
    env["as"]("bob")
    assert env["c"].get(ref["url"]).status_code == 404
    assert env["c"].delete(ref["url"]).status_code == 404
    assert env["c"].get("/api/images/" + "0" * 32).status_code == 404


def test_hors_groupe_garde_ses_images(env):
    ref = _image(env["ids"]["bob"])
    env["config"]({"enabled": True, "url": "http://gpu", "groups": [env["ids"]["design"]]})
    env["as"]("bob")
    assert env["c"].get(ref["url"]).status_code == 200


def test_suppression_puis_404(env):
    ref = _image(env["ids"]["alice"])
    assert env["c"].delete(ref["url"]).json() == {"ok": True}
    assert env["c"].get(ref["url"]).status_code == 404


def test_galerie(env):
    for i in range(3):
        _image(env["ids"]["alice"], prompt=f"p{i}")
    _image(env["ids"]["bob"])
    j = env["c"].get("/api/images?limit=2").json()
    assert j["total"] == 3 and j["keep"] == 50 and len(j["items"]) == 2
    assert j["next_before"] is not None
    suite = env["c"].get(f"/api/images?limit=2&before={j['next_before']}").json()
    assert [i["prompt"] for i in suite["items"]] == ["p0"] and suite["next_before"] is None
    assert env["c"].get("/api/images?chat_id=" + "x" * 200).status_code == 400
    assert env["c"].get("/api/images?before=nan").status_code == 400
    assert env["c"].get("/api/images?before=inf").status_code == 400


# ── Console ───────────────────────────────────────────────────────────────

def test_console_administrateur_seul(env):
    for nom in ("alice", "modo"):
        env["as"](nom)
        assert env["c"].post("/api/admin/image/test", json={}).status_code == 403
        assert env["c"].put("/api/admin/image/key", json={"api_key": "x"}).status_code == 403
        assert env["c"].get("/api/admin/image/key").status_code == 403


def test_cle_chiffree_jamais_renvoyee(env, monkeypatch, tmp_path):
    import shared_infra.security.encryption as enc
    monkeypatch.setattr(enc, "encrypt", lambda s: "chiffre:" + s)
    monkeypatch.setattr(enc, "decrypt", lambda s: s.split(":", 1)[1])
    env["as"]("admin")
    r = env["c"].put("/api/admin/image/key", json={"api_key": "sk-secret"})
    assert r.json() == {"ok": True, "has_key": True, "stale": False}
    disque = json.loads(env["chemin"].read_text(encoding="utf-8"))
    scelle = json.loads(disque["image"]["api_key_enc"].split(":", 1)[1])
    assert scelle == {"k": "sk-secret", "o": "http://gpu:8084"}
    assert env["c"].get("/api/admin/image/key").json() == {"has_key": True, "stale": False}
    assert "sk-secret" not in env["c"].get("/api/image/status").text
    assert env["c"].put("/api/admin/image/key", json={"api_key": ""}).json()["has_key"] is False


def test_cle_liee_a_l_origine_du_moteur(env, monkeypatch):
    """Changer l'adresse vers une autre machine rend la clé inutilisable ; un
    jeton qui n'est pas une clé scellée ne vaut rien."""
    import shared_infra.security.encryption as enc
    from shared_infra.image.config import api_key, engine_origin, get_image_config
    monkeypatch.setattr(enc, "encrypt", lambda s: "chiffre:" + s)
    monkeypatch.setattr(enc, "decrypt", lambda s: s.split(":", 1)[1])
    assert engine_origin("HTTP://GPU/v1") == "http://gpu:80"
    assert engine_origin("https://gpu:443/") == "https://gpu:443"
    assert engine_origin("ftp://gpu") == "" and engine_origin("gpu:8080") == ""
    env["as"]("admin")
    env["c"].put("/api/admin/image/key", json={"api_key": "sk-secret"})
    enc_ = json.loads(env["chemin"].read_text(encoding="utf-8"))["image"]["api_key_enc"]
    env["config"]({"enabled": True, "url": "http://gpu:8084/v1", "api_key_enc": enc_})
    assert api_key(get_image_config()) == "sk-secret", "même origine, autre chemin"
    env["config"]({"enabled": True, "url": "http://autre:8084", "api_key_enc": enc_})
    assert api_key(get_image_config()) == ""
    assert env["c"].get("/api/admin/image/key").json() == {"has_key": False, "stale": True}
    env["config"]({"enabled": True, "url": "http://gpu:8084", "api_key_enc": "chiffre:sk-brut"})
    assert api_key(get_image_config()) == ""
    # Clé saisie avec l'adresse du formulaire, avant d'enregistrer l'adresse.
    r = env["c"].put("/api/admin/image/key", json={"api_key": "sk-2", "url": "http://neuf:1"})
    assert r.json() == {"ok": True, "has_key": False, "stale": True}
    env["config"]({"enabled": True, "url": "",
                   "api_key_enc": ""})
    assert env["c"].put("/api/admin/image/key", json={"api_key": "sk"}).status_code == 400


def test_cle_enregistree_seulement_vers_l_adresse_enregistree(env, monkeypatch):
    import shared_infra.security.encryption as enc
    from llm_core.imagegen import http as transport_mod
    monkeypatch.setattr(enc, "encrypt", lambda s: "chiffre:" + s)
    monkeypatch.setattr(enc, "decrypt", lambda s: s.split(":", 1)[1])
    vues = []

    def h(req):
        vues.append(req)
        return httpx.Response(200, json={"data": [{"id": "m1"}]})
    monkeypatch.setattr(transport_mod, "_TRANSPORT", httpx.MockTransport(h))
    from shared_infra.image.config import seal_api_key
    enc_ = "chiffre:" + seal_api_key("sk-secret", "http://gpu:8084")
    env["config"]({"enabled": True, "provider": "openai", "url": "http://gpu:8084",
                   "api_key_enc": enc_, "model": "m1"})
    env["as"]("admin")
    j = env["c"].post("/api/admin/image/test", json={"url": "http://gpu:8084/"}).json()
    assert j["ok"] and vues[-1].headers["authorization"] == "Bearer sk-secret"
    # Adresse ENREGISTRÉE changée (champ par champ) : la clé ne la suit pas.
    env["config"]({"enabled": True, "provider": "openai", "url": "http://ailleurs:9000",
                   "api_key_enc": enc_, "model": "m1"})
    env["c"].post("/api/admin/image/test", json={})
    assert vues[-1].url.host == "ailleurs" and "authorization" not in vues[-1].headers
    env["c"].post("/api/admin/image/models", json={"url": "http://ailleurs:9000"})
    assert vues[-1].url.host == "ailleurs" and "authorization" not in vues[-1].headers
    env["c"].post("/api/admin/image/models",
                  json={"url": "http://ailleurs:9000", "api_key": "sk-saisie"})
    assert vues[-1].headers["authorization"] == "Bearer sk-saisie"


def test_test_de_la_console(env, monkeypatch):
    from llm_core.imagegen import http as transport_mod

    def h(req):
        return httpx.Response(200, json={"model": {"name": "qwen"}, "current_mode": "img_gen",
                                         "limits": {"max_width": 2048}})
    monkeypatch.setattr(transport_mod, "_TRANSPORT", httpx.MockTransport(h))
    env["as"]("admin")
    j = env["c"].post("/api/admin/image/test", json={}).json()
    assert j["ok"] and j["model"] == "qwen" and j["limits"] == {"max_width": 2048}
    assert j["warnings"] == []
    assert env["c"].post("/api/admin/image/test", json={"url": ""}).json() == {
        "ok": False, "provider": "sdcpp", "has_key": False, "stale": False, "enabled": True,
        "ready": True, "error": "Aucune adresse renseignée."}

    def panne(req):
        raise httpx.ConnectError("refusé", request=req)
    monkeypatch.setattr(transport_mod, "_TRANSPORT", httpx.MockTransport(panne))
    j = env["c"].post("/api/admin/image/test", json={"url": "http://autre"}).json()
    assert j["ok"] is False and "injoignable" in j["error"] and "refusé" not in j["error"]


def test_zone_possedee_de_config(env):
    from shared_infra.routes.admin import config as adm
    assert ("image", "api_key_enc") in adm._OWNED_PATHS
    assert adm._touches_owned(("image",))
    assert not adm._touches_owned(("image", "url"))
    from shared_infra.routes.config import _SECRET_PATHS
    assert "image.api_key_enc" in _SECRET_PATHS


# ── Réglages du compte ────────────────────────────────────────────────────

def test_reglages_du_compte(env):
    c = env["c"]
    s = c.get("/api/settings").json()
    assert s["image_enabled"] is True and s["image_tool_enabled"] is True
    assert s["image_ready"] is True and s["image_available"] is True
    assert s["image_prefs"] == {"ratio": "1:1", "side": 1024, "n": 1, "enhance": False}
    r = c.put("/api/settings", json={"image_enabled": 0, "image_ready": False,
                                     "image_prefs": {"ratio": "16:9", "side": 4096, "n": 9}})
    assert r.status_code == 200, r.text
    s = c.get("/api/settings").json()
    assert s["image_enabled"] is False and s["image_available"] is False
    assert s["image_ready"] is True, "calculé, jamais écrit"
    assert s["image_prefs"] == {"ratio": "16:9", "side": 2048, "n": 4, "enhance": False}
    st = c.get("/api/image/status").json()
    assert st["available"] is False and st["prefs"]["ratio"] == "16:9"


def test_nom_de_telechargement_comme_l_interface():
    """Même règle que ``imageFileName`` (chat/_image.js)."""
    from shared_infra.image.routes import download_name
    assert download_name("Café à l'aube !", 7, "image/jpeg") == "Café-à-l-aube-7.jpg"
    assert download_name("", None, "image/webp", "abcdef0123456789") == "image-abcdef01.webp"
    assert download_name("x" * 60, 1, "image/png") == "x" * 40 + "-1.png"
