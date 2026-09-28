# SPDX-License-Identifier: MIT
"""Le marqueur « restauration interrompue » doit être exposé ET acquittable.

Audit 2026-08-08. ``_restore_snapshot_stream`` pose ``.elpis_restore_incomplete``
dans ``/work`` entre le vidage et la fin d'extraction ; s'il survit, le worker a
été tué en plein vol (recyclage ``max_requests=2000``, ``graceful_timeout=330``)
et ``/work`` est AMPUTÉ. ``GET /api/sandbox/snapshots`` le remontait déjà dans
``last_restore_incomplete`` — mais AUCUN consommateur ne le lisait côté front :
le filet ne servait à rien.

Il manquait aussi un moyen d'éteindre l'alerte : le marqueur n'est retiré que
par une restauration menée à son terme, donc le bandeau serait resté affiché
indéfiniment pour qui a réparé son ``/work`` à la main.
"""
import json
import re
from pathlib import Path

import pytest
from fastapi import HTTPException

import shared_infra.sandbox.routes_snapshots as snap

FRONT = Path(__file__).resolve().parents[2] / "frontend"


class _Req:
    pass


@pytest.fixture
def work(tmp_path, monkeypatch):
    w = tmp_path / "work"
    w.mkdir()
    monkeypatch.setattr(snap, "require_user_id", lambda request: 7)
    monkeypatch.setattr(snap, "_sandbox_root_for", lambda uid: w)
    monkeypatch.setattr(snap, "_list_user_snapshots", lambda uid: [])
    return w


# ── Backend ──────────────────────────────────────────────────────────────

def test_liste_expose_le_marqueur(work):
    (work / snap._RESTORE_MARKER_NAME).write_text(
        json.dumps({"snap_id": "a" * 32, "ts": 1234567890}))
    body = json.loads(snap.api_sandbox_snapshots_list(_Req()).body)
    assert body["last_restore_incomplete"]["snap_id"] == "a" * 32
    assert body["last_restore_incomplete"]["ts"] == 1234567890


def test_liste_sans_marqueur(work):
    body = json.loads(snap.api_sandbox_snapshots_list(_Req()).body)
    assert body["last_restore_incomplete"] is None


def test_acquittement_retire_le_marqueur(work):
    mk = work / snap._RESTORE_MARKER_NAME
    mk.write_text("{}")
    assert snap.api_sandbox_clear_restore_marker(_Req()) == {"ok": True}
    assert not mk.exists()


def test_acquittement_idempotent(work):
    """Deux clics / deux onglets : le 2e ne doit pas lever."""
    assert snap.api_sandbox_clear_restore_marker(_Req()) == {"ok": True}


def test_marqueur_absent_du_json_ne_casse_pas(work):
    """Marqueur corrompu (worker tué pendant l'écriture) → dict vide, pas 500."""
    (work / snap._RESTORE_MARKER_NAME).write_text("{pas du json")
    body = json.loads(snap.api_sandbox_snapshots_list(_Req()).body)
    assert body["last_restore_incomplete"] == {}


def test_route_litterale_declaree_avant_la_route_parametree():
    """``/snapshots/restore-marker`` DOIT précéder ``/snapshots/{snap_id}`` :
    FastAPI résout dans l'ordre d'enregistrement, donc l'inverse ferait matcher
    ``snap_id="restore-marker"`` → rejeté par ``_SNAP_ID_RE`` → 400."""
    from shared_infra.routes._state import router

    ordre = [r.path for r in router.routes
             if getattr(r, "methods", None) and "DELETE" in r.methods
             and r.path.startswith("/api/sandbox/snapshots")]
    assert ordre.index("/api/sandbox/snapshots/restore-marker") \
        < ordre.index("/api/sandbox/snapshots/{snap_id}")


def test_id_de_snapshot_invalide_toujours_rejete(work):
    """Non-régression : la nouvelle route ne doit pas ouvrir un chemin de
    traversée sur la route par id."""
    with pytest.raises(HTTPException) as ei:
        snap.api_sandbox_snapshot_delete(_Req(), "../../etc/passwd")
    assert ei.value.status_code == 400


# ── Front : le signal doit avoir un consommateur ─────────────────────────

def test_le_front_consomme_le_marqueur():
    js = (FRONT / "js" / "editor" / "_sandbox_fs.js").read_text(encoding="utf-8")
    assert "last_restore_incomplete" in js, \
        "le backend expose le signal mais le front ne le lit toujours pas"
    assert "restore-marker" in js, "pas d'acquittement possible côté front"
    for nom in ("restoreIncomplete", "dismissRestoreIncomplete", "restoreIncompleteWhen"):
        assert re.search(rf"\b{nom}\b", js), f"{nom} absent du module"
        # …et réellement exporté vers l'éditeur (bloc `return {`).
        assert nom in js.split("// -- Public surface")[-1], f"{nom} non exporté"


def test_l_editeur_relaie_le_marqueur_au_template():
    js = (FRONT / "js" / "app-editor.js").read_text(encoding="utf-8")
    # Destructuré depuis le module FS, puis ré-exposé au template.
    assert js.count("restoreIncomplete") >= 2, \
        "restoreIncomplete doit être destructuré ET ré-exporté par app-editor"
    assert "dismissRestoreIncomplete" in js


def test_le_template_affiche_le_bandeau():
    html = (FRONT / "includes" / "main" / "editor.html").read_text(encoding="utf-8")
    assert 'v-if="restoreIncomplete"' in html, "aucun bandeau d'alerte dans le panneau"
    assert "dismissRestoreIncomplete()" in html, "alerte non acquittable depuis l'UI"
