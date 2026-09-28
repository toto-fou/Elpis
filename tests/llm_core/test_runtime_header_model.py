# SPDX-License-Identifier: MIT
"""En-tête runtime du système : ligne « Backing model: … » (2026-08-16).

Le socle dit au modèle de répondre aux questions d'identité depuis cette ligne
(les modèles servis sont interchangeables — un nom appris à l'entraînement
serait halluciné) et prévoit son ABSENCE (« say you don't know »). Ces tests
verrouillent le contrat d'assemblage :

  - libellé fourni → la ligne apparaît, dans le MÊME « part » que la date
    (pas de séparateur ``---`` entre les deux — un seul en-tête runtime) ;
  - libellé vide/blanc/absent → AUCUNE ligne orpheline ;
  - le socle référence bien « Backing model: » (cohérence prompt ↔ injection).

Unit-level, fixture-free (même famille que test_audit_fixes.py).
"""
from __future__ import annotations

from pathlib import Path

from llm_core._system_prompts import assemble_system_messages

ROOT = Path(__file__).resolve().parents[2]


def _content(**kw) -> str:
    msgs = assemble_system_messages(custom_sys="SOCLE", last_user_text=None, **kw)
    assert len(msgs) == 1 and msgs[0]["role"] == "system"
    return msgs[0]["content"]


def test_model_label_injecte():
    out = _content(today="August 16, 2026", model_label="claude-opus-5")
    assert "Today's date: August 16, 2026." in out
    assert "Backing model: claude-opus-5." in out


def test_date_et_modele_dans_le_meme_part():
    """Un seul en-tête runtime : pas de séparateur ``---`` entre les deux
    lignes (sinon le modèle les lit comme deux blocs sans rapport)."""
    out = _content(today="August 16, 2026", model_label="qwen3-32b")
    assert ("Today's date: August 16, 2026.\n"
            "Backing model: qwen3-32b.") in out


def test_label_absent_ou_blanc_omis():
    for kw in ({}, {"model_label": None}, {"model_label": ""}, {"model_label": "  "}):
        out = _content(today="August 16, 2026", **kw)
        assert "Backing model" not in out
        assert "Today's date: August 16, 2026." in out


def test_label_seul_sans_date():
    out = _content(model_label="mistral-small")
    assert "Backing model: mistral-small." in out
    assert "Today's date" not in out


def test_label_trimme():
    out = _content(model_label="  gpt-oss-120b  ")
    assert "Backing model: gpt-oss-120b." in out


def test_socle_reference_backing_model():
    """Le socle renvoie à la ligne runtime pour l'identité : si l'un des deux
    côtés est renommé sans l'autre, l'instruction devient morte."""
    socle = (ROOT / "system_prompts" / "CHATBOT_SYSTEM.md").read_text(encoding="utf-8")
    assert "Backing model:" in socle
