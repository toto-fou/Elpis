# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_session_secret_resolution.py — résolution du secret
de signature des sessions.

Bug corrigé (2026-07-30) : l'ordre était env → config.json → fichier dédié.
Comme la valeur d'exemple ``mysecretsessiontomodify`` est COMMITÉE dans
``shared_infra/config.json``, la branche « fichier dédié » — pourtant
documentée comme le fallback des lancements directs (uvicorn seul, tests) —
était INATTEIGNABLE : tout démarrage hors ``start_*.sh`` (dont le « Lancement
minimal » de docs/configuration.md) signait les cookies avec une valeur publique
du dépôt. Vérifié sur la machine : ``SESSION_SECRET`` valait le placeholder de
23 caractères alors qu'un secret fort de 70 caractères existait dans
``user_db/.session_secret``.

``config.py`` résout le secret À L'IMPORT : on rejoue donc la logique dans un
sous-processus, avec un environnement et un ``APP_CONFIG_PATH`` maîtrisés.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import textwrap

import pytest

from shared_infra.config import _WEAK_SESSION_SECRETS

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

_PROBE = textwrap.dedent("""
    from shared_infra.config import SESSION_SECRET
    print(SESSION_SECRET)
""")


def _resolve(tmp_path, *, json_secret, env_secret=None, file_secret=None):
    """Importe config.py dans un process neuf et rend le SESSION_SECRET résolu."""
    cfg = {"app": {"session_secret": json_secret, "db_path": str(tmp_path / "user_db" / "app.db")}}
    cfg_path = tmp_path / "config.json"
    cfg_path.write_text(json.dumps(cfg), encoding="utf-8")
    (tmp_path / "user_db").mkdir(exist_ok=True)
    if file_secret is not None:
        f = tmp_path / "user_db" / ".session_secret"
        f.write_text(file_secret, encoding="utf-8")
        f.chmod(0o600)

    env = dict(os.environ, APP_CONFIG_PATH=str(cfg_path), PYTHONPATH=REPO)
    env.pop("APP_SESSION_SECRET", None)
    if env_secret is not None:
        env["APP_SESSION_SECRET"] = env_secret
    out = subprocess.run([sys.executable, "-c", _PROBE], capture_output=True,
                         text=True, env=env, cwd=REPO, timeout=120)
    assert out.returncode == 0, out.stderr[-2000:]
    return out.stdout.strip().splitlines()[-1]


FORT = "ELPIS_" + "a" * 64


def test_placeholder_committe_ne_prime_plus_sur_le_fichier(tmp_path):
    """LE fix : un placeholder publié est traité comme absent → le secret fort
    persistant l'emporte."""
    got = _resolve(tmp_path, json_secret="mysecretsessiontomodify", file_secret=FORT)
    assert got == FORT


@pytest.mark.parametrize("weak", sorted(_WEAK_SESSION_SECRETS))
def test_tous_les_placeholders_connus_sont_ignores(tmp_path, weak):
    got = _resolve(tmp_path, json_secret=weak, file_secret=FORT)
    assert got == FORT, f"placeholder {weak!r} encore utilisé comme secret"


def test_sans_fichier_le_placeholder_declenche_une_generation_forte(tmp_path):
    """Aucun fichier : on ne doit toujours PAS retomber sur le placeholder —
    la branche 3 en génère un fort et le persiste."""
    got = _resolve(tmp_path, json_secret="changeme")
    assert got not in _WEAK_SESSION_SECRETS
    assert len(got) >= 40
    assert (tmp_path / "user_db" / ".session_secret").read_text().strip() == got


def test_secret_operateur_reste_honore(tmp_path):
    """Un secret PROPRE à l'opérateur, même court, doit continuer de marcher :
    le sauter déconnecterait tout le monde par surprise (on n'écarte QUE les
    placeholders publiés)."""
    got = _resolve(tmp_path, json_secret="court-mais-a-moi", file_secret=FORT)
    assert got == "court-mais-a-moi"


def test_env_prime_sur_tout(tmp_path):
    got = _resolve(tmp_path, json_secret="mysecretsessiontomodify",
                   env_secret="ELPIS_" + "b" * 64, file_secret=FORT)
    assert got == "ELPIS_" + "b" * 64


def test_mode_du_fichier_reaffirme_a_la_lecture(tmp_path):
    """Le fichier est créé en 0600, mais rien ne le vérifiait ensuite : un mode
    élargi (restauration de sauvegarde, copie) laissait la clé de signature
    lisible par tout compte local."""
    (tmp_path / "user_db").mkdir(exist_ok=True)
    f = tmp_path / "user_db" / ".session_secret"
    f.write_text(FORT, encoding="utf-8")
    f.chmod(0o664)                                  # élargi

    got = _resolve(tmp_path, json_secret="mysecretsessiontomodify")

    assert got == FORT
    assert (f.stat().st_mode & 0o777) == 0o600, "mode non ré-affirmé"
