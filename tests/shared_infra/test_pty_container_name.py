# SPDX-License-Identifier: MIT
"""Le terminal doit viser le MÊME conteneur que le reste de l'app.

Audit 2026-08-08. ``_spawn_terminal`` construisait ``f"elpis-sb-{username}"``
sur le username BRUT, alors que ``UserSandbox.container_name`` — comme le
dossier monté sur ``/work`` — passe par ``safe_sandbox_name`` (source unique,
charset ``[A-Za-z0-9_-]``, sémantique « delete »).

Divergence pour tout compte non canonique : le conteneur réel de
« Jean.Dupont » est ``elpis-sb-JeanDupont``, le terminal cherchait
``elpis-sb-Jean.Dupont`` → ``docker inspect`` KO → ``container_not_ready``
DÉFINITIF, alors que l'éditeur et les outils MCP fonctionnent (eux passent
déjà par la source unique).

``validate_username`` refuse désormais les nouveaux noms non canoniques mais
TOLÈRE explicitement les comptes existants — le piège restait donc armé pour
toute base migrée.
"""
import subprocess
import sys

import pytest

# ⚠ Import via ``sys.modules`` et NON ``import shared_infra.terminal.pty as x`` :
# la boucle d'auto-export de ``routes/__init__.py`` recopie tous les symboles
# des submodules dans le namespace du package, et ``_pty.py`` fait
# ``import pty as _pty`` — donc l'attribut ``shared_infra.terminal.pty`` pointe
# sur le module STDLIB ``pty``, pas sur le submodule. Même piège que celui
# documenté en tête de ``sandbox_snapshots.py``.
import shared_infra.terminal.pty  # noqa: F401  (peuple sys.modules)
ptymod = sys.modules["shared_infra.terminal.pty"]

from shared_infra.config import safe_sandbox_name  # noqa: E402


@pytest.fixture
def spawn(tmp_path, monkeypatch):
    """Lance ``_spawn_terminal`` en capturant le nom de conteneur inspecté.

    On répond « pas running » : la fonction lève ``container_not_ready`` avant
    tout ``fork()`` — on teste la résolution du nom, pas le PTY.
    """
    vus = []

    def _fake_run(cmd, **kw):
        vus.append(cmd)
        return subprocess.CompletedProcess(cmd, 0, stdout="false", stderr="")

    monkeypatch.setattr(ptymod, "_get_work_path", lambda uid: tmp_path)
    monkeypatch.setattr(ptymod.subprocess, "run", _fake_run)

    def _go(username):
        monkeypatch.setattr(ptymod, "get_username_by_id", lambda uid: username)
        with pytest.raises(RuntimeError, match="container_not_ready"):
            ptymod._spawn_terminal(7)
        return vus[-1][-1]        # dernier argv de `docker inspect …` = le nom

    return _go


@pytest.mark.parametrize("username", [
    "Jean.Dupont",      # point supprimé
    "jean dupont",      # espace supprimé
    "José",             # accent supprimé (regex ASCII, pas isalnum() unicode)
    "a+b@c",            # ponctuation supprimée
    "hugo",             # déjà canonique → inchangé
])
def test_nom_de_conteneur_canonise(spawn, username):
    assert spawn(username) == f"elpis-sb-{safe_sandbox_name(username)}"


def test_nom_identique_a_celui_de_user_sandbox(spawn, tmp_path):
    """Contrat croisé : terminal et exécuteur doivent produire la MÊME chaîne."""
    from shared_infra.sandbox.executors._user_sandbox import UserSandbox

    username = "Jean.Dupont"
    attendu = UserSandbox(7, username, tmp_path).container_name
    assert spawn(username) == attendu
    assert attendu == "elpis-sb-JeanDupont"


def test_repli_aligne_sur_le_dossier_sandbox(spawn):
    """Utilisateur introuvable (compte supprimé en cours de session) : le repli
    doit être celui de ``_get_sandbox_path`` (``user_<id>``), sinon terminal et
    dossier /work divergent."""
    assert spawn(None) == "elpis-sb-user_7"
