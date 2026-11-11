# SPDX-License-Identifier: MIT
"""Le marqueur « restauration interrompue » doit être exposé ET acquittable.

Audit 2026-08-08. ``_restore_snapshot_stream`` pose ``.elpis_restore_incomplete``
(dans le dossier des snapshots du compte depuis L4.5) pendant la restauration ;
s'il survit, le worker a été tué en plein vol (recyclage ``max_requests=2000``,
``graceful_timeout=330``) et ``/work`` peut être AMPUTÉ. ``GET /api/sandbox/snapshots`` le remontait déjà dans
``last_restore_incomplete`` — mais AUCUN consommateur ne le lisait côté front :
le filet ne servait à rien.

Il manquait aussi un moyen d'éteindre l'alerte : le marqueur n'est retiré que
par une restauration menée à son terme, donc le bandeau serait resté affiché
indéfiniment pour qui a réparé son ``/work`` à la main.
"""
import re
from pathlib import Path

FRONT = Path(__file__).resolve().parents[2] / "frontend"


# ── Front : le signal doit avoir un consommateur ─────────────────────────

def test_le_front_consomme_le_marqueur():
    js = (FRONT / "src" / "features" / "editor" / "fichiers.ts").read_text(encoding="utf-8")
    assert "last_restore_incomplete" in js, \
        "le backend expose le signal mais le front ne le lit toujours pas"
    assert "restore-marker" in js, "pas d'acquittement possible côté front"
    for nom in ("restoreIncomplete", "dismissRestoreIncomplete", "restoreIncompleteWhen"):
        assert re.search(rf"\b{nom}\b", js), f"{nom} absent du module"
        # …et réellement exporté vers l'éditeur (bloc `return {`).
        assert nom in js.split("// -- Public surface")[-1], f"{nom} non exporté"


def test_l_editeur_relaie_le_marqueur_au_template():
    js = (FRONT / "src" / "features" / "editor" / "editeur.ts").read_text(encoding="utf-8")
    # Lu depuis le module FS, puis ré-exposé au template.
    assert js.count("restoreIncomplete") >= 2, \
        "restoreIncomplete doit être lu ET ré-exporté par l'éditeur (editeur.ts)"
    assert "dismissRestoreIncomplete" in js


def test_le_template_affiche_le_bandeau():
    html = (FRONT / "src" / "components" / "editor" / "MenuEditeur.vue").read_text(encoding="utf-8")
    assert 'v-if="ed.restoreIncomplete"' in html, "aucun bandeau d'alerte dans le panneau"
    assert "ed.dismissRestoreIncomplete()" in html, "alerte non acquittable depuis l'UI"
