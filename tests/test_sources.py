# SPDX-License-Identifier: MIT
"""tests/test_sources.py — le helper ``tests/_sources.py`` retire bien les
commentaires et les docstrings, et seulement eux.

Les tests structurels de la boucle et du flux de chat reposent sur ce helper :
s'il laissait passer un commentaire, un test pourrait de nouveau dépendre d'un
texte explicatif ; s'il mangeait une chaîne ordinaire, une assertion de
présence échouerait à tort, une d'absence passerait à vide.
"""
from __future__ import annotations

import pytest

from tests import _sources as S

EXEMPLE = '''"""Docstring de module — accentuée."""
import os  # commentaire de fin de ligne

# commentaire seul sur sa ligne
X = "# pas un commentaire"
Y = """chaîne multiligne
gardée"""


class C:
    """Docstring de classe."""

    def m(self):
        """Docstring de méthode,
        sur deux lignes — é."""
        def interne():
            "docstring simple"
            return 'chaîne simple'
        return interne()
'''


def test_commentaires_et_docstrings_retires():
    code = S.code_seul(EXEMPLE)
    for texte in ("Docstring de module", "commentaire de fin", "commentaire seul",
                  "Docstring de classe", "Docstring de méthode", "docstring simple"):
        assert texte not in code, texte


def test_chaines_ordinaires_gardees():
    code = S.code_seul(EXEMPLE)
    assert 'X = "# pas un commentaire"' in code
    assert 'Y = """chaîne multiligne\ngardée"""' in code
    assert "return 'chaîne simple'" in code
    assert "import os" in code


def test_lignes_conservees():
    """Les numéros de ligne restent alignés sur le fichier d'origine (une
    docstring multiligne accentuée ne décale rien)."""
    code = S.code_seul(EXEMPLE)
    assert code.count("\n") == EXEMPLE.count("\n")
    assert code.splitlines()[EXEMPLE.splitlines().index("class C:")] == "class C:"


def test_les_fichiers_reels_gardent_leurs_lignes():
    for f in S.fichiers_boucle() + S.fichiers_flux_chat():
        texte = f.read_text(encoding="utf-8")
        assert S.code_seul(texte).count("\n") == texte.count("\n"), f


def test_les_sujets_ne_sont_pas_vides():
    assert S.fichiers_boucle()[0].name == "_chat_with_tools.py"
    assert S.fichiers_flux_chat()[0].name == "chats.py"
    assert "async def _run_chat_multi_mcp_impl(" in S.source_boucle()
    assert "async def api_chat_saved_stream3(" in S.source_flux_chat()


@pytest.fixture()
def sujet_factice(tmp_path, monkeypatch):
    a = tmp_path / "a.py"
    a.write_text(EXEMPLE + "\n\ndef f():\n    # note\n    os.path.join('x')\n    g()\n",
                 encoding="utf-8")
    b = tmp_path / "b.py"
    b.write_text("def g():\n    return f()\n\n\ndef interne():\n    pass\n", encoding="utf-8")
    monkeypatch.setitem(S._SUJETS, "factice", lambda: [a, b])
    monkeypatch.setattr(S, "RACINE", tmp_path)
    return "factice"


def test_source_fonction_trouve_une_fonction_imbriquee(sujet_factice):
    src = S.source_fonction("m", sujet_factice)
    assert "def interne():" in src and "Docstring de méthode" not in src


def test_source_fonction_refuse_un_nom_ambigu_ou_absent(sujet_factice):
    with pytest.raises(AssertionError, match="interne"):
        S.source_fonction("interne", sujet_factice)
    with pytest.raises(AssertionError, match="absente"):
        S.source_fonction("inexistante", sujet_factice)


def test_compter_appels_nom_et_attribut(sujet_factice):
    assert S.compter_appels("join", sujet_factice) == 1     # os.path.join(…)
    assert S.compter_appels("g", sujet_factice) == 1
    assert S.compter_appels("f", sujet_factice) == 1
