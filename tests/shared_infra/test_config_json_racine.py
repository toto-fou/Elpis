# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_config_json_racine.py — où vit ``config.json``.

Déplacé de ``shared_infra/`` vers la RACINE du dépôt le 2026-09-04 : c'est un
fichier d'exploitation (secret de session, TLS, clé Qdrant, écran d'accueil),
pas un morceau de ``shared_infra``.

CE QUI REND CE DÉPLACEMENT DANGEREUX, et pourquoi ces tests existent : un
``config.json`` introuvable est lu comme ``{}`` **sans la moindre erreur**
(``_read_json_file``). Une installation qui n'aurait pas déplacé son fichier
redémarrerait donc avec un secret de session neuf — toutes les sessions
invalidées —, sans HTTPS et sans clé Qdrant, et rien ne le dirait. Le repli sur
l'ancien emplacement est la seule chose qui l'empêche ; il est vérifié ici.
"""
from __future__ import annotations

import importlib

import pytest


@pytest.fixture()
def resolve(monkeypatch, tmp_path):
    """(fonction de résolution, racine simulée, ancien dossier simulé)."""
    import shared_infra.config as cfg

    racine = tmp_path / "depot"
    backend = racine / "shared_infra"
    backend.mkdir(parents=True)
    monkeypatch.setattr(cfg, "PROJECT_ROOT", racine)
    monkeypatch.setattr(cfg, "BACKEND_DIR", backend)
    monkeypatch.delenv("APP_CONFIG_PATH", raising=False)
    return cfg._resolve_config_json_path, racine, backend


def test_la_racine_est_le_defaut(resolve):
    f, racine, _backend = resolve
    (racine / "config.json").write_text("{}", encoding="utf-8")
    assert f() == (racine / "config.json").resolve()


def test_repli_sur_l_ancien_emplacement_et_il_le_dit(resolve, capsys):
    """Une installation non migrée doit continuer de démarrer — en le signalant."""
    f, _racine, backend = resolve
    (backend / "config.json").write_text('{"security": {}}', encoding="utf-8")
    assert f() == (backend / "config.json").resolve()
    sortie = capsys.readouterr().out
    assert "ANCIEN emplacement" in sortie
    assert "racine" in sortie.lower()


def test_la_racine_prime_sur_l_ancien(resolve, capsys):
    """Les deux présents : la racine gagne, et on ne crie pas au repli."""
    f, racine, backend = resolve
    (racine / "config.json").write_text("{}", encoding="utf-8")
    (backend / "config.json").write_text("{}", encoding="utf-8")
    assert f() == (racine / "config.json").resolve()
    assert "ANCIEN emplacement" not in capsys.readouterr().out


def test_app_config_path_prime_sur_tout(resolve, monkeypatch, tmp_path):
    f, racine, backend = resolve
    (racine / "config.json").write_text("{}", encoding="utf-8")
    (backend / "config.json").write_text("{}", encoding="utf-8")
    ailleurs = tmp_path / "ailleurs.json"
    ailleurs.write_text("{}", encoding="utf-8")
    monkeypatch.setenv("APP_CONFIG_PATH", str(ailleurs))
    assert f() == ailleurs.resolve()


def test_absent_des_deux_cotes_la_racine_fait_foi(resolve):
    """Clone frais : aucun fichier. On pointe la racine — c'est là qu'il faut
    le créer, et ``_read_json_file`` rendra ``{}`` (défauts du code)."""
    f, racine, _backend = resolve
    assert f() == (racine / "config.json").resolve()


# ── L'emplacement réel du dépôt ─────────────────────────────────────────────

def test_le_fichier_de_ce_depot_est_bien_a_la_racine():
    from shared_infra.config import CONFIG_JSON_PATH, PROJECT_ROOT
    assert CONFIG_JSON_PATH == (PROJECT_ROOT / "config.json").resolve()


def test_config_json_et_ses_backups_restent_hors_du_depot():
    """Il porte le secret de session et la clé Qdrant : jamais versionné.
    Le déplacement a changé leur chemin — donc les règles qui les ignorent."""
    import subprocess
    from shared_infra.config import PROJECT_ROOT

    for nom in ("config.json", "config.json.bak", "config.json.bak-2026-08-21"):
        r = subprocess.run(["git", "check-ignore", "-q", nom],
                           cwd=PROJECT_ROOT, capture_output=True)
        assert r.returncode == 0, f"{nom} n'est PAS ignoré par git"


def test_le_lanceur_lit_le_meme_fichier_que_l_app():
    """``./elpis start`` calcule le bind du RAG depuis ce fichier : un
    défaut divergent ferait lire deux configs différentes dans le même
    déploiement (le RAG en 0.0.0.0 pendant que l'app est en loopback)."""
    from shared_infra.config import PROJECT_ROOT
    src = (PROJECT_ROOT / "elpis").read_text(encoding="utf-8")
    assert 'os.environ.get("APP_CONFIG_PATH") or "config.json"' in src
    assert "shared_infra/config.json" not in src
