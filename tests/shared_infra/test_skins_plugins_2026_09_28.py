# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_skins_plugins_2026_09_28.py — skins intégrés et plugins.

Couvre ``shared_infra/appearance/skins.py`` (registre, état d'instance,
validation, import/export, formulaire) et ses routes (``/api/skins*``,
``/api/admin/skins*``, réglage utilisateur ``skin``). Chaque test travaille sur
un ``config.json`` et un dossier de skins temporaires.
"""
from __future__ import annotations

import base64
import io
import json
import zipfile
from contextvars import ContextVar

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

from shared_infra import config as cfg
from shared_infra.appearance import skins as S

PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk"
    "YPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")


@pytest.fixture(autouse=True)
def env(tmp_path, monkeypatch):
    conf = tmp_path / "config.json"
    conf.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(cfg, "CONFIG_JSON_PATH", conf)
    monkeypatch.setattr(cfg, "SKINS_DIR", tmp_path / "user_skins")
    cfg.invalidate_config_cache()
    S._PLUGIN_CACHE.clear()
    yield tmp_path
    cfg.invalidate_config_cache()
    S._PLUGIN_CACHE.clear()


def _manifest(**kw):
    m = {"id": "brume", "label": "Brume", "description": "Gris doux",
         "swatch": ["#111111", "#eeeeee", "#3366ff"],
         "tokens": {"light": {"--accent": "#3366ff", "--radius": "0.9rem"},
                    "dark": {"--accent": "#99bbff"}}}
    m.update(kw)
    return m


def _zip(files: dict, root: str = "brume/") -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, data in files.items():
            if isinstance(data, (dict, list)):
                data = json.dumps(data)
            z.writestr(root + name, data)
    return buf.getvalue()


def _cfg_disk() -> dict:
    return json.loads(cfg.CONFIG_JSON_PATH.read_text(encoding="utf-8"))


# ── Registre et état ───────────────────────────────────────────────────────

def test_kiki_desactive_par_defaut_et_ardoise_toujours_la():
    ids = [s["id"] for s in S.list_skins()]
    assert "kiki" not in ids
    assert "" in ids and "elpis" in ids
    assert S.default_skin() == "elpis"
    tout = {s["id"]: s for s in S.list_skins(include_disabled=True)}
    assert tout["kiki"]["enabled"] is False
    assert tout["kiki"]["brand"] == {"name": "Kiki"} and tout["kiki"]["mascot"] == "kiki"
    assert tout[""]["locked"] and tout["elpis"]["locked"] and tout["elpis"]["is_default"]


def test_resolve_user_skin():
    assert S.resolve_user_skin("kiki") == "elpis"
    assert S.resolve_user_skin("inconnu") == "elpis"
    assert S.resolve_user_skin("") == ""
    assert S.resolve_user_skin(None) == "elpis"
    assert S.resolve_user_skin("parchemin") == "parchemin"
    S.set_state(enabled={"kiki": True})
    assert S.resolve_user_skin("kiki") == "kiki"
    S.set_state(enabled={"parchemin": False})
    assert S.resolve_user_skin("parchemin") == "elpis"


def test_defaut_active_et_non_desactivable():
    S.set_state(default="kiki")
    assert S.default_skin() == "kiki" and S.is_enabled("kiki")
    assert _cfg_disk()["skins"] == {"enabled": {"kiki": True}, "default": "kiki"}
    with pytest.raises(S.SkinError):
        S.set_state(enabled={"kiki": False})
    with pytest.raises(S.SkinError):
        S.set_state(default="nexiste-pas")
    S.set_state(enabled={"": False})      # Ardoise : ignoré, toujours actif
    assert S.is_enabled("")
    # Défaut disparu (skin supprimé à la main) → repli « elpis »
    cfg.CONFIG_JSON_PATH.write_text(json.dumps({"skins": {"default": "fantome"}}), encoding="utf-8")
    cfg.invalidate_config_cache()
    assert S.default_skin() == "elpis"


# ── Validation ─────────────────────────────────────────────────────────────

@pytest.mark.parametrize("bad", ["A", "x", "1abc", "elpis", "kiki", "self", "a/b", "a" * 40])
def test_identifiant_refuse(bad):
    with pytest.raises(S.SkinError):
        S.validate_manifest(_manifest(id=bad))


@pytest.mark.parametrize("valeur", [
    "red; background: url(x)", "url(https://evil/x.png)", "@import", "expression(alert(1))",
    "a{b}", "<x>", "a\\75rl(", "/* x", "image-set('x.png' 1x)", "x" * 201,
])
def test_valeur_de_jeton_refusee(valeur):
    with pytest.raises(S.SkinError):
        S.validate_manifest(_manifest(tokens={"light": {"--accent": valeur}}))


def test_nom_de_jeton_refuse():
    with pytest.raises(S.SkinError):
        S.validate_manifest(_manifest(tokens={"light": {"accent": "#fff"}}))
    with pytest.raises(S.SkinError):
        S.validate_manifest(_manifest(tokens={"light": {"--Accent": "#fff"}}))


@pytest.mark.parametrize("css", [
    "@import url(assets/a.png);",
    "body{background:url(http://evil/x.png)}",
    "body{background:url(//evil/x.png)}",
    "body{background:url('javascript:alert(1)')}",
    "body{background:url(file:///etc/passwd)}",
    "body{background:url(assets/../../config.json)}",
    "body{width:expression(alert(1))}",
    "body{-moz-binding:x}",
    "body{behavior: x}",
    "</style><script>alert(1)</script>",
    "body{background:u\\72l(http://evil)}",
    "body{background:image-set('https://evil/x.png' 1x)}",
    "@font-face{font-family:x}",
    "body{background:url(assets/absente.png)}",
    "body{background:url(data:image/svg+xml;base64,AAAA)}",
])
def test_feuille_refusee(css):
    with pytest.raises(S.SkinError):
        S.validate_css(css, {"a.png"})


def test_feuille_acceptee():
    css = (".elpis-skin-self .hover\\:bg-x:hover{color:red}\n"
           "@media (max-width:600px){body{background:url(assets/a.png)}}\n"
           "body{background-image:url(\"data:image/png;base64,iVBORw0KGgo=\")}")
    assert S.validate_css(css, {"a.png"}) == css


# ── Import zip ─────────────────────────────────────────────────────────────

def test_import_arrive_desactive_et_rendu_css():
    data = _zip({"skin.json": _manifest(), "skin.css": ".elpis-skin-self .x{background:url(assets/a.png)}",
                 "assets/a.png": PNG, "LICENSE": "MIT"})
    sk = S.import_zip(data)
    assert sk["id"] == "brume" and sk["enabled"] is False and sk["source"] == "plugin"
    assert "brume" not in [s["id"] for s in S.list_skins()]
    assert _cfg_disk()["skins"]["enabled"]["brume"] is False
    css = S.render_css("brume")
    assert "body.elpis-skin-brume {" in css and "--accent: #3366ff;" in css
    assert "body.elpis-skin-brume.elpis-app-dark {" in css and "--accent: #99bbff;" in css
    assert "--radius-sm: calc(var(--radius) - 4px);" in css
    assert 'url("/api/skins/brume/assets/a.png")' in css
    assert ".elpis-skin-brume .x" in css and ".elpis-skin-self" not in css
    assert S.asset_path("brume", "a.png").read_bytes() == PNG
    assert S.asset_path("brume", "../skin.json") is None


def test_import_a_la_racine_du_zip():
    sk = S.import_zip(_zip({"skin.json": _manifest()}, root=""))
    assert sk["id"] == "brume"


def test_import_existant_sans_puis_avec_ecrasement():
    S.import_zip(_zip({"skin.json": _manifest()}))
    S.set_state(enabled={"brume": True})
    with pytest.raises(S.SkinExistsError):
        S.import_zip(_zip({"skin.json": _manifest(label="Brume 2")}))
    sk = S.import_zip(_zip({"skin.json": _manifest(label="Brume 2")}), overwrite=True)
    assert sk["label"] == "Brume 2" and sk["enabled"] is True   # l'état est conservé


def _zip_brut(entries) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for info, data in entries:
            z.writestr(info, data)
    return buf.getvalue()


@pytest.mark.parametrize("cas", ["zip-slip", "absolu", "svg", "magic", "url-externe", "import",
                                 "css-trop-gros", "trop-de-fichiers", "lien", "inconnu", "pas-de-json",
                                 "pas-un-zip"])
def test_import_malveillant_refuse(cas, env):
    man = json.dumps(_manifest())
    if cas == "zip-slip":
        data = _zip_brut([("brume/skin.json", man), ("brume/../../evil.txt", "x")])
    elif cas == "absolu":
        data = _zip_brut([("brume/skin.json", man), ("/etc/evil", "x")])
    elif cas == "svg":
        data = _zip({"skin.json": _manifest(), "assets/a.svg": "<svg onload=alert(1)/>"})
    elif cas == "magic":
        data = _zip({"skin.json": _manifest(), "assets/a.png": b"<svg/>"})
    elif cas == "url-externe":
        data = _zip({"skin.json": _manifest(), "skin.css": "body{background:url(https://evil/x)}"})
    elif cas == "import":
        data = _zip({"skin.json": _manifest(), "skin.css": "@import 'x.css';"})
    elif cas == "css-trop-gros":
        data = _zip({"skin.json": _manifest(), "skin.css": "a{}" * (S.MAX_CSS_BYTES // 3 + 10)})
    elif cas == "trop-de-fichiers":
        files = {"skin.json": _manifest()}
        files.update({f"assets/i{n}.png": PNG for n in range(S.MAX_ASSETS + 10)})
        data = _zip(files)
    elif cas == "lien":
        info = zipfile.ZipInfo("brume/assets/a.png")
        info.external_attr = (0o120777 << 16)
        data = _zip_brut([("brume/skin.json", man), (info, "/etc/passwd")])
    elif cas == "inconnu":
        data = _zip({"skin.json": _manifest(), "script.js": "alert(1)"})
    elif cas == "pas-de-json":
        data = _zip({"skin.css": "a{}"})
    else:
        data = b"PK pas un zip"
    with pytest.raises(S.SkinError):
        S.import_zip(data)
    assert not (env / "evil.txt").exists()
    assert S.plugin_skins() == []


# ── Export / formulaire / suppression ──────────────────────────────────────

def test_export_import_aller_retour():
    S.import_zip(_zip({"skin.json": _manifest(), "skin.css": ".x{background:url(assets/a.png)}",
                       "assets/a.png": PNG}))
    name, data = S.export_zip("brume")
    assert name == "skin-brume.zip"
    S.delete("brume")
    assert S.plugin_skins() == []
    sk = S.import_zip(data)
    assert sk["id"] == "brume"
    assert S.skin_detail("brume")["tokens"] == S.validate_manifest(_manifest())["tokens"]
    assert S.skin_detail("brume")["assets"] == ["a.png"]


@pytest.mark.parametrize("builtin", ["elpis", "llamacpp", "emeraude", "parchemin", "pingouins", "kiki"])
def test_export_d_un_integre_sert_de_modele(builtin):
    name, data = S.export_zip(builtin)
    assert name == f"skin-{builtin}-perso.zip"
    sk = S.import_zip(data)
    assert sk["id"] == builtin + "-perso" and sk["enabled"] is False
    css = S.render_css(builtin + "-perso")
    assert f"body.elpis-skin-{builtin}-perso" in css
    assert f".elpis-skin-{builtin} " not in css.replace(f".elpis-skin-{builtin}-perso", "")


def test_formulaire_creation_modification_suppression():
    payload = {"id": "brume", "label": "Brume", "description": "", "darkBase": False,
               "swatch": ["#111", "#eee", "#36f"], "tokens": {"light": {"--accent": "#36f"}, "dark": {}},
               "css": "", "brand": {"name": "Brumeux"}}
    sk = S.save_from_editor(payload)
    assert sk["enabled"] is False and sk["brand"] == {"name": "Brumeux"}
    with pytest.raises(S.SkinExistsError):
        S.save_from_editor(payload)
    sk = S.save_from_editor({**payload, "label": "Brume bis", "css": ".elpis-skin-self{color:red}", "update": True})
    assert sk["label"] == "Brume bis"
    assert ".elpis-skin-brume{color:red}" in S.render_css("brume")
    with pytest.raises(S.SkinError):
        S.save_from_editor({**payload, "css": "@import 'x';", "update": True})
    S.set_state(default="brume")
    with pytest.raises(S.SkinError):
        S.delete("brume")                  # skin par défaut
    S.set_state(default="elpis")
    S.delete("brume")
    assert "brume" not in _cfg_disk()["skins"]["enabled"]
    with pytest.raises(S.SkinError):
        S.delete("elpis")                  # intégré


def test_skin_du_dossier_modifie_a_la_main_est_ignore(env):
    d = env / "user_skins" / "brume"
    d.mkdir(parents=True)
    (d / "skin.json").write_text(json.dumps(_manifest(id="autre")), encoding="utf-8")
    assert S.plugin_skins() == []          # id ≠ dossier
    (d / "skin.json").write_text(json.dumps(_manifest()), encoding="utf-8")
    (d / "skin.css").write_text("@import 'x';", encoding="utf-8")
    assert [s["id"] for s in S.plugin_skins()] == ["brume"]
    assert "@import" not in S.render_css("brume")   # feuille revalidée au rendu


# ── Mascottes ──────────────────────────────────────────────────────────────

def test_registre_des_mascottes_coherent_avec_les_assets():
    root = S._ROOT / "frontend" / "assets" / "mascotte"
    ids = S.mascot_ids()
    assert ids == ("boite_or", "flamme", "flamme_bleue", "fantome", "elpis")
    socle = json.loads((root / "socle-mascottes.json").read_text(encoding="utf-8"))["mascottes"]
    css = (root / "socle-mascottes.css").read_text(encoding="utf-8")
    for m in ids:
        assert (root / m).is_dir(), m
        assert m in socle, m
        assert f'data-perso="{m}"' in css, m
    assert all(m["label"] for m in S.mascots_catalogue())


def test_mascottes_repli_si_registre_illisible(monkeypatch, tmp_path):
    monkeypatch.setattr(S, "MASCOTS_JSON", tmp_path / "absent.json")
    assert S.mascot_ids() == ("boite_or", "flamme", "flamme_bleue", "fantome", "elpis")


# ── Routes ─────────────────────────────────────────────────────────────────

_UID: "ContextVar[str | None]" = ContextVar("_UID", default=None)


@pytest.fixture()
def client(monkeypatch):
    import shared_infra.appearance.routes as R
    import shared_infra.routes.admin.skins as A
    import shared_infra.routes.admin  # noqa: F401 — enregistre admin_router
    from shared_infra.routes._state import router
    from shared_infra.routes.admin._state import admin_router

    def _uid(request):
        u = _UID.get()
        if not u:
            raise HTTPException(401, "Authentification requise")
        return u

    def _admin(request):
        if _uid(request) != "admin":
            raise HTTPException(403, "Admin required")
        return "admin"

    monkeypatch.setattr(R, "require_user_id", _uid)
    monkeypatch.setattr(R, "_is_admin", lambda uid: uid == "admin")
    monkeypatch.setattr(A, "_require_admin", _admin)
    app = FastAPI()

    @app.middleware("http")
    async def _auth(request: Request, call_next):
        tok = _UID.set(request.headers.get("x-test-user") or None)
        try:
            return await call_next(request)
        finally:
            _UID.reset(tok)

    app.include_router(router)
    app.include_router(admin_router)
    return TestClient(app)


U = {"x-test-user": "alice"}
ADM = {"x-test-user": "admin"}


def test_get_api_skins_filtre_les_desactives(client):
    assert client.get("/api/skins").status_code == 401
    d = client.get("/api/skins", headers=U).json()
    assert "kiki" not in [s["id"] for s in d["skins"]] and d["default"] == "elpis"
    assert [m["id"] for m in d["mascottes"]][0] == "boite_or"
    S.set_state(enabled={"kiki": True})
    d = client.get("/api/skins", headers=U).json()
    assert "kiki" in [s["id"] for s in d["skins"]]


def test_admin_requis(client):
    assert client.get("/api/admin/skins", headers=U).status_code == 403
    assert client.put("/api/admin/skins", headers=U, json={"default": "kiki"}).status_code == 403
    assert client.post("/api/admin/skins", headers=U, json={}).status_code == 403
    assert client.delete("/api/admin/skins/brume", headers=U).status_code == 403
    assert client.get("/api/admin/skins/elpis/export", headers=U).status_code == 403
    r = client.post("/api/admin/skins/import", headers=U, files={"file": ("s.zip", b"x", "application/zip")})
    assert r.status_code == 403
    assert client.get("/api/admin/skins", headers=ADM).status_code == 200


def test_admin_import_etat_export(client):
    data = _zip({"skin.json": _manifest(), "assets/a.png": PNG})
    r = client.post("/api/admin/skins/import", headers=ADM, files={"file": ("s.zip", data, "application/zip")})
    assert r.status_code == 200 and r.json()["skin"]["enabled"] is False
    r = client.post("/api/admin/skins/import", headers=ADM, files={"file": ("s.zip", data, "application/zip")})
    assert r.status_code == 409
    r = client.post("/api/admin/skins/import", headers=ADM,
                    files={"file": ("s.zip", _zip({"skin.json": _manifest(), "assets/a.svg": "<svg/>"}), "application/zip")})
    assert r.status_code == 400 and "SVG" in r.json()["detail"]
    # Feuille d'un skin désactivé : admin seulement
    assert client.get("/api/skins/brume/skin.css", headers=U).status_code == 404
    assert client.get("/api/skins/brume/skin.css", headers=ADM).status_code == 200
    r = client.put("/api/admin/skins", headers=ADM, json={"enabled": {"brume": True}})
    assert r.status_code == 200
    r = client.get("/api/skins/brume/skin.css", headers=U)
    assert r.status_code == 200 and r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["content-type"].startswith("text/css")
    assert client.get("/api/skins/brume/skin.css", headers={**U, "If-None-Match": r.headers["etag"]}).status_code == 304
    r = client.get("/api/skins/brume/assets/a.png", headers=U)
    assert r.status_code == 200 and r.content == PNG and r.headers["content-type"] == "image/png"
    for chemin in ("/api/skins/brume/assets/..%2Fskin.json", "/api/skins/brume/assets/skin.json",
                   "/api/skins/brume/assets/a.svg", "/api/skins/..%2F..%2Fx/assets/a.png"):
        assert client.get(chemin, headers=U).status_code == 404, chemin
    r = client.get("/api/admin/skins/brume/export", headers=ADM)
    assert r.status_code == 200 and r.headers["content-type"] == "application/zip"
    r = client.put("/api/admin/skins", headers=ADM, json={"default": "brume"})
    assert r.json()["default"] == "brume"
    assert client.put("/api/admin/skins", headers=ADM, json={"enabled": {"brume": False}}).status_code == 400
    assert client.delete("/api/admin/skins/brume", headers=ADM).status_code == 400
    client.put("/api/admin/skins", headers=ADM, json={"default": "elpis"})
    assert client.delete("/api/admin/skins/brume", headers=ADM).status_code == 200
    assert client.delete("/api/admin/skins/elpis", headers=ADM).status_code == 400


# ── Réglage utilisateur ``skin`` ───────────────────────────────────────────

@pytest.fixture()
def settings_client(monkeypatch):
    import shared_infra.accounts.routes_settings as RS
    store: dict = {}

    def _uid(request):
        u = _UID.get()
        if not u:
            raise HTTPException(401, "Authentification requise")
        return u

    def _merge(uid, mutate):
        s = dict(store.get(uid) or {})
        mutate(s)
        store[uid] = s
        return dict(s)

    monkeypatch.setattr(RS, "require_user_id", _uid)
    monkeypatch.setattr(RS, "get_user_settings", lambda uid: dict(store.get(uid) or {}))
    monkeypatch.setattr(RS, "update_user_settings", lambda uid, s: store.__setitem__(uid, dict(s)))
    monkeypatch.setattr(RS, "merge_user_settings", _merge)
    monkeypatch.setattr(RS, "get_username_by_id", lambda uid: str(uid))
    monkeypatch.setattr(RS, "read_config_json", lambda: {})
    from shared_infra.routes._state import router
    app = FastAPI()

    @app.middleware("http")
    async def _auth(request: Request, call_next):
        tok = _UID.set(request.headers.get("x-test-user") or None)
        try:
            return await call_next(request)
        finally:
            _UID.reset(tok)

    app.include_router(router)
    return TestClient(app), store


def test_put_settings_skin_desactive_retombe_sur_le_defaut(settings_client):
    c, store = settings_client
    assert c.put("/api/settings", headers=U, json={"skin": "kiki"}).status_code == 200
    assert store["alice"]["skin"] == "elpis"
    c.put("/api/settings", headers=U, json={"skin": "parchemin"})
    assert store["alice"]["skin"] == "parchemin"
    c.put("/api/settings", headers=U, json={"skin": ""})
    assert store["alice"]["skin"] == ""


def test_get_settings_skin_desactive_depuis(settings_client):
    c, store = settings_client
    d = c.get("/api/settings", headers=U).json()
    assert d["skin"] == "elpis"                          # défaut d'instance
    assert [m["id"] for m in d["mascottes_catalogue"]][:2] == ["boite_or", "flamme"]
    S.set_state(default="parchemin")
    assert c.get("/api/settings", headers=U).json()["skin"] == "parchemin"
    store["alice"] = {"skin": "llamacpp"}
    assert c.get("/api/settings", headers=U).json()["skin"] == "llamacpp"
    S.set_state(enabled={"llamacpp": False})
    assert c.get("/api/settings", headers=U).json()["skin"] == "parchemin"
