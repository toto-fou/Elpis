# SPDX-License-Identifier: MIT
# conftest.example.py — fixtures pytest types, prêtes à adapter.
# Un conftest.py se place dans tests/ : ses fixtures sont disponibles dans
# tous les tests du dossier SANS import.
from __future__ import annotations

import json
from pathlib import Path

import pytest


# ── Fixture simple avec teardown ─────────────────────────────────────────────
# yield = le test s'exécute ici ; ce qui suit s'exécute TOUJOURS (même si le
# test échoue) — c'est là que vivent les nettoyages.
@pytest.fixture()
def registre(tmp_path: Path):
    chemin = tmp_path / "registre.json"
    chemin.write_text("{}", encoding="utf-8")
    yield chemin
    # teardown : rien à faire ici, tmp_path est jeté par pytest — l'exemple
    # montre l'emplacement (fermer une connexion, tuer un process…).


# ── Fixture "factory" ────────────────────────────────────────────────────────
# Quand un test a besoin de PLUSIEURS objets paramétrés, la fixture renvoie
# une fonction de construction plutôt qu'un objet unique.
@pytest.fixture()
def fabrique_client(tmp_path: Path):
    compteur = {"n": 0}

    def _faire(nom: str = "", solde: int = 0) -> dict:
        compteur["n"] += 1
        client = {"id": compteur["n"], "nom": nom or f"client{compteur['n']}",
                  "solde": solde}
        (tmp_path / f"client{client['id']}.json").write_text(
            json.dumps(client), encoding="utf-8")
        return client

    return _faire


# ── Environnement contrôlé (monkeypatch) ─────────────────────────────────────
# Isoler le test de l'environnement réel : variables, cwd, attributs.
# monkeypatch remet TOUT en place à la fin du test.
@pytest.fixture()
def env_hermetique(monkeypatch, tmp_path: Path):
    monkeypatch.setenv("APP_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("APP_PROXY", raising=False)
    monkeypatch.chdir(tmp_path)
    return tmp_path


# ── Fixture autouse : garde-fou appliqué à TOUS les tests du dossier ─────────
# Ici : interdire les appels réseau accidentels (le test qui en fait un
# échoue immédiatement au lieu de dépendre du réseau de la CI).
@pytest.fixture(autouse=True)
def _pas_de_reseau(monkeypatch):
    import socket

    def _refus(*_a, **_k):
        raise RuntimeError("appel réseau interdit dans les tests unitaires")

    monkeypatch.setattr(socket, "create_connection", _refus)


# ── Marker maison déclaré proprement ────────────────────────────────────────
# Usage : @pytest.mark.lent — et `pytest -m "not lent"` pour les exclure.
def pytest_configure(config):
    config.addinivalue_line("markers", "lent: test long (exclu par -m 'not lent')")
