# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_config_coercion.py — coercions de config.

Régression 2026-07-18 : ``_as_str`` renvoyait une chaîne d'env VIDE telle
quelle → une variable positionnée mais vide (``LLAMA_IP=""``) écrasait
silencieusement la valeur json/défaut. Une chaîne vide/blanche = « non
définie » → défaut.
"""
from __future__ import annotations

from shared_infra.config import _as_str


def test_as_str_none_returns_default():
    assert _as_str(None, "def") == "def"


def test_as_str_empty_or_whitespace_returns_default():
    # C'est le footgun corrigé : env positionnée mais vide ⇒ défaut.
    assert _as_str("", "def") == "def"
    assert _as_str("   ", "def") == "def"
    assert _as_str("\t\n", "def") == "def"


def test_as_str_nonempty_kept_verbatim():
    assert _as_str("10.168.1.5", "def") == "10.168.1.5"
    assert _as_str("  x  ", "def") == "  x  "   # non-blanc → gardé tel quel


def test_as_str_empty_default_stays_empty():
    # Un défaut lui-même vide reste vide (comportement inchangé).
    assert _as_str("", "") == ""
    assert _as_str(None, "") == ""


def test_as_str_non_string_coerced():
    assert _as_str(8080, "def") == "8080"
