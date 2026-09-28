# SPDX-License-Identifier: MIT
"""tests/rag_app/test_ocr_config.py — config du bloc ``ocr`` de rag_config.json.

Couvre : lecture du bloc ``ocr`` d'un rag_config.json isolé (CONFIG_PATH
patché), résolution ``host``+``port`` → ``endpoint_url``, rétro-compat
``endpoint_url`` explicite, défauts (prompts grounding, nouvelles clés
store_dir/collection/state_file), coercition int/bool (``auto_index``,
``enabled``), overrides env ``APP_OCR_*`` et flag ``ocr_feature_enabled``.
"""
from __future__ import annotations

import json

from rag_app.ocr import config as ocr_config


def _with_cfg(monkeypatch, tmp_path, ocr_section):
    """rag_config.json isolé : le bloc ``ocr`` fourni, rien du fichier réel."""
    path = tmp_path / "rag_config.json"
    path.write_text(json.dumps({"collection": "exigences", "ocr": ocr_section}),
                    encoding="utf-8")
    monkeypatch.setattr(ocr_config, "CONFIG_PATH", path)
    return path


def test_host_port_construisent_l_endpoint(monkeypatch, tmp_path):
    _with_cfg(monkeypatch, tmp_path, {"host": "10.168.122.1", "port": 8090})
    cfg = ocr_config.get_ocr_config()
    assert cfg["endpoint_url"] == "http://10.168.122.1:8090"
    assert cfg["prompt"].startswith("<|grounding|>")   # défaut famille DeepSeek
    assert cfg["zone_prompt"] == "Free OCR."


def test_retro_compat_endpoint_url_explicite(monkeypatch, tmp_path):
    _with_cfg(monkeypatch, tmp_path, {"endpoint_url": "https://gpu.lan/ocr/v1"})
    assert ocr_config.get_ocr_config()["endpoint_url"] == "https://gpu.lan/ocr/v1"


def test_host_prime_sur_endpoint_url(monkeypatch, tmp_path):
    _with_cfg(monkeypatch, tmp_path, {"host": "10.0.0.9", "port": 9000,
                                      "endpoint_url": "http://ancien:1"})
    assert ocr_config.get_ocr_config()["endpoint_url"] == "http://10.0.0.9:9000"


def test_non_configure(monkeypatch, tmp_path):
    _with_cfg(monkeypatch, tmp_path, {})
    cfg = ocr_config.get_ocr_config()
    assert cfg["endpoint_url"] == "" and cfg["default_model"] == ""


def test_fichier_absent_ou_illisible(monkeypatch, tmp_path):
    """Pas de rag_config.json (ou JSON cassé) → défauts purs, jamais de crash."""
    monkeypatch.setattr(ocr_config, "CONFIG_PATH", tmp_path / "absent.json")
    cfg = ocr_config.get_ocr_config()
    assert cfg["enabled"] is True and cfg["port"] == 8090
    bad = tmp_path / "casse.json"
    bad.write_text("{pas du json", encoding="utf-8")
    monkeypatch.setattr(ocr_config, "CONFIG_PATH", bad)
    assert ocr_config.get_ocr_config()["enabled"] is True


def test_defauts_nouvelles_cles(monkeypatch, tmp_path):
    """Clés propres au portage rag_app : store_dir, collection, auto_index,
    state_file — et disparition des clés per-user du chatbot."""
    _with_cfg(monkeypatch, tmp_path, {})
    cfg = ocr_config.get_ocr_config()
    assert cfg["store_dir"] == "OCR_STORE"
    assert cfg["collection"] == "ocr-documents"
    assert cfg["auto_index"] is False
    assert cfg["state_file"] == "rag_ocr_state.json"
    for gone in ("max_templates", "render_keep", "rag_collection",
                 "rag_auto_index"):
        assert gone not in cfg


def test_coercition_entiers(monkeypatch, tmp_path):
    _with_cfg(monkeypatch, tmp_path, {"host": "h", "port": "pas-un-port",
                                      "max_pages": "abc", "max_tokens": -5})
    cfg = ocr_config.get_ocr_config()
    assert cfg["port"] == 8090          # défaut sur valeur illisible
    assert cfg["max_pages"] == 300
    assert cfg["max_tokens"] == 1       # borné à ≥ 1


def test_env_override(monkeypatch, tmp_path):
    _with_cfg(monkeypatch, tmp_path, {"host": "h", "port": 8090})
    monkeypatch.setenv("APP_OCR_DEFAULT_MODEL", "deepseek-ocr")
    monkeypatch.setenv("APP_OCR_MAX_TOKENS", "123")
    cfg = ocr_config.get_ocr_config()
    assert cfg["default_model"] == "deepseek-ocr"
    assert cfg["max_tokens"] == 123


def test_bool_keys_coercion(monkeypatch, tmp_path):
    """Sans _BOOL_KEYS, un défaut booléen serait toujours truthy après la
    coercition str() — ``auto_index`` et ``enabled`` restent de vrais bools."""
    _with_cfg(monkeypatch, tmp_path, {"auto_index": "false"})
    assert ocr_config.get_ocr_config()["auto_index"] is False
    _with_cfg(monkeypatch, tmp_path, {"auto_index": True})
    assert ocr_config.get_ocr_config()["auto_index"] is True
    _with_cfg(monkeypatch, tmp_path, {})
    monkeypatch.setenv("APP_OCR_AUTO_INDEX", "1")
    assert ocr_config.get_ocr_config()["auto_index"] is True
    monkeypatch.setenv("APP_OCR_AUTO_INDEX", "0")
    assert ocr_config.get_ocr_config()["auto_index"] is False
    monkeypatch.delenv("APP_OCR_AUTO_INDEX")
    cfg = ocr_config.get_ocr_config()
    assert cfg["auto_index"] is False and cfg["enabled"] is True


def test_ocr_feature_enabled(monkeypatch, tmp_path):
    """Défaut ON (feature native au service) ; ``enabled: false`` coupe."""
    _with_cfg(monkeypatch, tmp_path, {})
    assert ocr_config.ocr_feature_enabled() is True
    _with_cfg(monkeypatch, tmp_path, {"enabled": False})
    assert ocr_config.ocr_feature_enabled() is False
    _with_cfg(monkeypatch, tmp_path, {"enabled": "off"})
    assert ocr_config.ocr_feature_enabled() is False


def test_apply_doc_model(monkeypatch, tmp_path):
    _with_cfg(monkeypatch, tmp_path, {"default_model": "defaut"})
    cfg = ocr_config.get_ocr_config()
    assert ocr_config.apply_doc_model(dict(cfg), {"model": "choisi"})["model"] \
        == "choisi"
    assert ocr_config.apply_doc_model(dict(cfg), {})["model"] == "defaut"
