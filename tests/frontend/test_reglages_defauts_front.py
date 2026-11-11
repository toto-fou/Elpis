# SPDX-License-Identifier: MIT
"""tests/frontend/test_reglages_defauts_front.py — le front miroite les défauts des réglages du backend."""
import pathlib

# Racine du dépôt : deploy/configure.py change le dossier courant des tests qui l'appellent.
RACINE = pathlib.Path(__file__).resolve().parents[2]
CLES = ("voice_input_enabled", "voice_reply_enabled", "voice_reply_tools_enabled")


def test_le_front_miroite_le_defaut_et_suit_le_systeme():
    modale = (RACINE / "frontend/src/features/reglages/modale.ts").read_text(encoding="utf-8")
    apparence = (RACINE / "frontend/src/features/reglages/apparence.ts").read_text(encoding="utf-8")
    assert "d.dark_mode_auto ??= false" in modale
    # Le mode effectif lit la préférence de l'OS quand « Système » est choisi.
    assert "prefers-color-scheme: dark" in apparence
    assert "settings.value.dark_mode_auto ? prefereSombre.value : !!settings.value.dark_mode" in apparence


def test_le_front_miroite_les_memes_defauts():
    """Les défauts client doivent être identiques : c'est écrit noir sur blanc
    dans ``loadSettingsData`` (« defaults match the backend »)."""
    import pathlib
    js = (RACINE / "frontend/src/features/reglages/modale.ts").read_text(encoding="utf-8")
    for cle in CLES:
        assert f"d.{cle} ??= false" in js, (
            f"« {cle} » n'a pas son défaut miroir côté front"
        )
