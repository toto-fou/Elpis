# SPDX-License-Identifier: MIT
"""Configuration du moteur d'images (bornes à la lecture), droits par groupe,
préférences du compte et champs « image » des messages."""
from __future__ import annotations

import json

import pytest

from shared_infra.image import access, config, messages


@pytest.fixture()
def cfg_file(tmp_path, monkeypatch):
    import shared_infra.config as cfg_mod
    chemin = tmp_path / "config.json"
    monkeypatch.setattr(cfg_mod, "CONFIG_JSON_PATH", chemin)

    def ecrire(image):
        chemin.write_text(json.dumps({"image": image}), encoding="utf-8")
        cfg_mod.invalidate_config_cache()
    ecrire({})
    yield ecrire
    cfg_mod.invalidate_config_cache()


def test_defauts_eteint(cfg_file):
    c = config.get_image_config()
    assert c["enabled"] is False and c["provider"] == "sdcpp" and c["groups"] == []
    assert not config.image_ready(c)


def test_bornes_appliquees_a_la_lecture(cfg_file):
    cfg_file({"enabled": True, "url": "http://gpu:8084/", "max_n": 99, "max_side": 50,
              "default_side": 9000, "timeout_sec": "x", "provider": "autre",
              "edit_mode": "zz", "groups": [3, "4", "x", -1, 3], "tool_max_calls": 0,
              "ca_pem": "a" * (70 * 1024)})
    c = config.get_image_config()
    assert c["url"] == "http://gpu:8084"
    assert (c["max_n"], c["max_side"], c["default_side"]) == (8, 256, 256)
    assert c["timeout_sec"] == 180 and c["provider"] == "sdcpp" and c["edit_mode"] == "init"
    assert c["groups"] == [3, 4] and c["tool_max_calls"] == 1 and c["ca_pem"] == ""
    assert config.image_ready(c)


def test_enabled_strict(cfg_file):
    cfg_file({"enabled": "true", "url": "http://h"})
    assert config.get_image_config()["enabled"] is False


def test_tailles_fixes_et_dalle3(cfg_file):
    cfg_file({"provider": "openai", "size_policy": "fixed", "model": "dall-e-3", "max_n": 4})
    c = config.get_image_config()
    assert c["sizes"] == ["1024x1024", "1536x1024", "1024x1536"]
    assert config.effective_max_n(c) == 1
    st = config.public_status(c)
    assert st["max_n"] == 1 and st["size_policy"] == "fixed"
    assert st["features"] == {"seed": False, "negative": False, "steps": False,
                              "strength": False, "edit": True}
    assert "url" not in st and "api_key_enc" not in st


def test_format_et_taille():
    assert config.size_for_ratio("16:9", 1024) == (1024, 576)
    assert config.size_for_ratio("9:16", 1024) == (576, 1024)
    assert config.size_for_ratio("n'importe", 1000) == (1024, 1024)
    assert config.parse_size("1024x768") == (1024, 768)
    assert config.parse_size("10x10") is None


def test_ecriture_de_la_cle_sous_verrou(cfg_file, tmp_path):
    cfg_file({"enabled": True, "url": "http://h"})
    config.write_api_key("jeton-chiffre")
    disque = json.loads((tmp_path / "config.json").read_text(encoding="utf-8"))
    assert disque["image"] == {"enabled": True, "url": "http://h", "api_key_enc": "jeton-chiffre"}


@pytest.fixture()
def comptes(tmp_path, monkeypatch, cfg_file):
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    legacy.reset_pool()
    legacy.init_db()
    from shared_infra.accounts.groups import add_user_to_group, create_group
    from shared_infra.accounts.users import create_user
    admin = create_user("admin", "pw-admin-12", is_admin=1)
    alice = create_user("alice", "pw-alice-12")
    bob = create_user("bob", "pw-bob-1234")
    design = create_group("Design")
    add_user_to_group(alice, design)
    yield {"admin": admin, "alice": alice, "bob": bob, "design": design}
    legacy.reset_pool()


def test_groupes_autorises(comptes, cfg_file):
    cfg_file({"enabled": True, "url": "http://h", "groups": []})
    assert all(access.user_allowed(u) for u in (comptes["alice"], comptes["bob"]))
    cfg_file({"enabled": True, "url": "http://h", "groups": [comptes["design"]]})
    assert access.user_allowed(comptes["alice"])
    assert not access.user_allowed(comptes["bob"])
    assert access.user_allowed(comptes["admin"]), "l'administrateur passe toujours"
    assert access.ready_for(comptes["alice"]) and not access.ready_for(comptes["bob"])


def test_groupe_supprime_ne_rouvre_pas(comptes, cfg_file):
    from shared_infra.accounts.groups import delete_group
    cfg_file({"enabled": True, "url": "http://h", "groups": [comptes["design"]]})
    delete_group(comptes["design"])
    assert not access.user_allowed(comptes["alice"])
    assert not access.user_allowed(comptes["bob"])


def test_groupes_illisibles_refus(comptes, cfg_file, monkeypatch):
    import shared_infra.accounts.groups as groups

    def panne(_uid):
        raise RuntimeError("base verrouillée")
    monkeypatch.setattr(groups, "get_user_groups", panne)
    cfg_file({"enabled": True, "url": "http://h", "groups": [comptes["design"]]})
    assert not access.user_allowed(comptes["alice"])


def test_cases_du_compte():
    assert access.enabled_in({}) and access.tool_enabled_in({})
    assert not access.enabled_in(None), "réglages illisibles : non"
    assert not access.tool_enabled_in({"image_enabled": False})
    assert not access.tool_enabled_in({"image_tool_enabled": False})


def test_preferences_ramenees_aux_limites(cfg_file):
    cfg_file({"enabled": True, "url": "http://h", "max_side": 1024, "max_n": 2})
    p = access.clean_prefs({"ratio": "16:9", "side": 2048, "n": 9, "enhance": True})
    assert p == {"ratio": "16:9", "side": 1024, "n": 2, "enhance": True}
    assert access.clean_prefs({"ratio": "5:1", "side": "x"}) == {
        "ratio": "1:1", "side": 1024, "n": 1, "enhance": False}
    assert access.clean_prefs({"side": 900})["side"] == 1024
    assert access.clean_prefs({"side": 700})["side"] == 768


def test_champs_de_message_assainis():
    iid = "a" * 32
    src = {"role": "assistant", "content": "x",
           "generated_images": [{"id": iid, "url": "http://ailleurs/x.png", "width": 64,
                                 "height": "48", "seed": 3, "mime": "text/html"},
                                {"id": "../etc", "url": "/x"}],
           "tool_images": "pas une liste", "revised_prompt": "  p  ",
           "image_meta": {"model": "Qwen", "duration_s": 12.345, "autre": 1},
           "image_error": {"code": "inconnu", "message": "m" * 999}}
    dst: dict = {}
    messages.copy_fields(src, dst)
    assert dst["generated_images"] == [{"id": iid, "url": f"/api/images/{iid}",
                                        "thumb_url": f"/api/images/{iid}?thumb=1",
                                        "width": 64, "seed": 3}]
    assert "tool_images" not in dst and dst["revised_prompt"] == "p"
    assert dst["image_meta"] == {"model": "Qwen", "duration_s": 12.3}
    assert dst["image_error"]["code"] == "engine" and len(dst["image_error"]["message"]) == 400
    u: dict = {}
    messages.copy_fields({"role": "user", "image_request": {
        "size": "1024x576", "n": 2, "seed": True, "ratio": "16:9", "side": 1024,
        "ref_image_id": "zz", "strength": 3, "enhance": True}}, u)
    assert u["image_request"] == {"size": "1024x576", "n": 2, "side": 1024,
                                  "ratio": "16:9", "enhance": True}
    assert messages.is_image_request({"role": "user", "image_request": {}})
    assert messages.caption("un  phare", 2) == "[2 images générées : « un phare »]"
