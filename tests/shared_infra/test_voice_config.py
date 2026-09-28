# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_voice_config.py — défauts, bornes, lecture à chaud.

``get_voice_config()`` relit le disque à chaque appel. Ce n'est pas un détail
de confort : une constante figée à l'import n'est rafraîchie que dans le worker
qui a reçu le POST admin, et l'utilisateur voit son réglage s'appliquer une
requête sur trois (finding E6 de l'audit 2026-08-01).

Le POST admin n'ayant AUCUNE validation de schéma, les bornes appliquées ici
sont la seule protection contre une valeur saisie à la main.
"""
from __future__ import annotations

import json

import pytest


@pytest.fixture()
def cfg_file(tmp_path, monkeypatch):
    import shared_infra.config as cfg

    path = tmp_path / "config.json"
    path.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(cfg, "CONFIG_JSON_PATH", path)
    cfg.invalidate_config_cache()

    def ecrit(bloc):
        path.write_text(json.dumps({"voice": bloc}), encoding="utf-8")
        cfg.invalidate_config_cache()

    return ecrit


def test_config_absente_rend_les_defauts(cfg_file):
    from shared_infra.voice.config import VOICE_DEFAULTS, get_voice_config

    c = get_voice_config()
    assert c["enabled"] is False
    assert c["stt"]["endpoint_url"] == ""
    assert c["stt"]["language"] == VOICE_DEFAULTS["stt"]["language"]
    assert c["tts"]["voice"] == VOICE_DEFAULTS["tts"]["voice"]


def test_enabled_est_strict(cfg_file):
    """``"true"``, ``1`` ou ``"oui"`` laissent la fonction ÉTEINTE.

    Une fonctionnalité qui ouvre le micro ne s'allume pas sur une valeur
    approximative recopiée à la main dans config.json.
    """
    from shared_infra.voice.config import get_voice_config

    for valeur in ("true", 1, "oui", "on", [], {}):
        cfg_file({"enabled": valeur})
        assert get_voice_config()["enabled"] is False, f"allumé par {valeur!r}"
    cfg_file({"enabled": True})
    assert get_voice_config()["enabled"] is True


def test_none_ne_devient_pas_la_chaine_none(cfg_file):
    """``str(None)`` vaut « None » : une adresse non vide, donc une fonction
    qui se croit configurée et un bouton qui n'aboutit nulle part."""
    from shared_infra.voice.config import get_voice_config, voice_flags

    cfg_file({"enabled": True, "stt": {"endpoint_url": None}, "tts": {"voice": None}})
    c = get_voice_config()
    assert c["stt"]["endpoint_url"] == ""
    assert c["tts"]["voice"] == "fr_FR-siwis-medium"
    assert voice_flags(c) == (False, False)


def test_bornes_appliquees_a_la_lecture(cfg_file):
    from shared_infra.voice.config import get_voice_config

    cfg_file({
        "enabled": True,
        "stt": {"timeout_sec": 9999, "max_upload_mb": 0, "max_utterance_sec": 600,
                "max_concurrent": 99, "logprob_min": -42},
        "tts": {"speed": 12, "max_chars": 1, "timeout_sec": 0},
    })
    c = get_voice_config()
    assert c["stt"]["timeout_sec"] == 300
    assert c["stt"]["max_upload_mb"] == 1
    assert c["stt"]["max_utterance_sec"] == 120
    assert c["stt"]["max_concurrent"] == 8
    assert c["stt"]["logprob_min"] == -5.0
    assert c["tts"]["speed"] == 2.0
    assert c["tts"]["max_chars"] == 200
    assert c["tts"]["timeout_sec"] == 5


def test_valeur_illisible_retombe_sur_le_defaut(cfg_file):
    from shared_infra.voice.config import get_voice_config

    cfg_file({"stt": {"timeout_sec": "bientôt"}, "tts": {"speed": None}})
    c = get_voice_config()
    assert c["stt"]["timeout_sec"] == 30
    assert c["tts"]["speed"] == 1.0


def test_format_inconnu_retombe_sur_le_defaut(cfg_file):
    from shared_infra.voice.config import get_voice_config

    cfg_file({"stt": {"format": "kaldi"}, "tts": {"format": "festival"}})
    c = get_voice_config()
    assert c["stt"]["format"] == "whisper.cpp"
    assert c["tts"]["format"] == "elpis-tts"


def test_formats_reconnus_sont_normalises(cfg_file):
    from shared_infra.voice.config import get_voice_config

    cfg_file({"stt": {"format": "OpenAI"}, "tts": {"format": "OPENAI"}})
    c = get_voice_config()
    assert c["stt"]["format"] == "openai"
    assert c["tts"]["format"] == "openai"


def test_section_non_dict_ne_casse_rien(cfg_file):
    """Un ``"voice": "oui"`` tapé à la main ne doit pas faire tomber l'app."""
    import shared_infra.config as cfg
    from shared_infra.voice.config import get_voice_config

    path = cfg.CONFIG_JSON_PATH
    path.write_text(json.dumps({"voice": "oui"}), encoding="utf-8")
    cfg.invalidate_config_cache()
    assert get_voice_config()["enabled"] is False

    path.write_text(json.dumps({"voice": {"stt": [1, 2], "tts": None}}), encoding="utf-8")
    cfg.invalidate_config_cache()
    assert get_voice_config()["stt"]["endpoint_url"] == ""


def test_drapeaux_exigent_une_adresse(cfg_file):
    """Activé mais sans adresse = éteint. C'est le réglage mort qu'on traque
    depuis l'audit du 2026-07-29 : un bouton visible qui n'aboutit nulle part."""
    from shared_infra.voice.config import get_voice_config, voice_flags

    cfg_file({"enabled": True, "stt": {"endpoint_url": "http://h:8090"}, "tts": {}})
    assert voice_flags(get_voice_config()) == (True, False)

    cfg_file({"enabled": True, "stt": {}, "tts": {"endpoint_url": "http://h:8091"}})
    assert voice_flags(get_voice_config()) == (False, True)

    cfg_file({"enabled": False, "stt": {"endpoint_url": "http://h:8090"},
              "tts": {"endpoint_url": "http://h:8091"}})
    assert voice_flags(get_voice_config()) == (False, False)


def test_adresse_normalisee_sans_barre_finale(cfg_file):
    from shared_infra.voice.config import get_voice_config

    cfg_file({"stt": {"endpoint_url": "http://h:8090/  "}})
    assert get_voice_config()["stt"]["endpoint_url"] == "http://h:8090"


def test_ecriture_par_un_autre_worker_est_vue(cfg_file):
    """Le scénario multi-worker : un autre process écrit, celui-ci doit suivre
    sans avoir muté la moindre constante."""
    from shared_infra.voice.config import get_voice_config

    cfg_file({"enabled": True, "stt": {"endpoint_url": "http://un:8090"}})
    assert get_voice_config()["stt"]["endpoint_url"] == "http://un:8090"
    cfg_file({"enabled": True, "stt": {"endpoint_url": "http://deux:8090"}})
    assert get_voice_config()["stt"]["endpoint_url"] == "http://deux:8090"


# ── Audit 2026-09-23 ───────────────────────────────────────────────────────

def test_nouveaux_defauts(cfg_file):
    """STT une requête à la fois (whisper-server n'en traite qu'une) ;
    ``tts.model`` vide ; certificats vérifiés par défaut."""
    from shared_infra.voice.config import get_voice_config

    c = get_voice_config()
    assert c["stt"]["max_concurrent"] == 1
    assert c["stt"]["verify"] is True and c["tts"]["verify"] is True
    assert c["tts"]["model"] == ""


def test_verify_desactivable(cfg_file):
    from shared_infra.voice.config import get_voice_config

    for valeur in (False, "false", "0", "non"):
        cfg_file({"stt": {"verify": valeur}, "tts": {"verify": valeur}})
        c = get_voice_config()
        assert c["stt"]["verify"] is False and c["tts"]["verify"] is False, valeur
    for valeur in (True, "true", "", None, 1):
        cfg_file({"stt": {"verify": valeur}})
        assert get_voice_config()["stt"]["verify"] is True, valeur


def test_format_piper_http_accepte(cfg_file):
    from shared_infra.voice.config import get_voice_config

    cfg_file({"tts": {"format": "PIPER-HTTP", "model": "  tts-1 "}})
    c = get_voice_config()
    assert c["tts"]["format"] == "piper-http"
    assert c["tts"]["model"] == "tts-1"


def test_max_chars_jamais_au_dela_de_ce_que_le_moteur_accepte(cfg_file):
    """``tts_service`` plafonne à 4000 caractères (OpenAI à 4096) : au-delà,
    chaque phrase longue revenait en HTTP 413."""
    from shared_infra.voice.config import get_voice_config

    cfg_file({"tts": {"max_chars": 20000}})
    assert get_voice_config()["tts"]["max_chars"] == 4000


def test_lecture_sans_copie_profonde(cfg_file, monkeypatch):
    """Chemin chaud (chaque phrase) : lecture par ``config_view``, jamais la
    copie profonde de tout ``config.json``. Et le résultat reste mutable sans
    abîmer la vue partagée."""
    import shared_infra.config as cfg
    import shared_infra.voice.config as vcfg

    def interdit():
        raise AssertionError("read_config_json appelé dans le chemin chaud")

    monkeypatch.setattr(cfg, "read_config_json", interdit)
    cfg_file({"enabled": True, "stt": {"endpoint_url": "http://h:8090"}})
    c = vcfg.get_voice_config()
    c["stt"]["endpoint_url"] = "http://autre"
    assert vcfg.get_voice_config()["stt"]["endpoint_url"] == "http://h:8090"
    assert cfg.config_view()["voice"]["stt"]["endpoint_url"] == "http://h:8090"
