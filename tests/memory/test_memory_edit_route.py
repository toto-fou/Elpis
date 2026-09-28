# SPDX-License-Identifier: MIT
"""tests/memory/test_memory_edit_route.py

PUT /api/memory/state/{user|memory} — réécrit les entrées d'un magasin depuis
Réglages → Mémoire (bouton « Éditer »). La curation reste le travail de
l'assistant ; cette route existe pour corriger ce qu'il a retenu de travers,
sans avoir à tout effacer.

Passe par ``MarkdownStore.rewrite`` : mêmes transaction (flock) et contrôle de
limite que l'outil ``memory``.
"""
from __future__ import annotations

import json

from fastapi import FastAPI
from fastapi.testclient import TestClient

import shared_infra.memory.routes as mem
from llm_core.memory import parse_entries
from llm_core.memory._migrate import migrate_legacy_memory


def _client(monkeypatch, tmp_path, username="alice"):
    monkeypatch.setattr(mem, "SANDBOX_DIR", tmp_path)
    monkeypatch.setattr(mem, "require_user_id", lambda r: 1)
    monkeypatch.setattr(mem, "get_username_by_id", lambda uid: username)
    app = FastAPI()
    app.include_router(mem.router)
    return TestClient(app)


def _entries_on_disk(base, name):
    p = base / name
    return parse_entries(p.read_text(encoding="utf-8")) if p.exists() else []


# ── Écriture nominale ───────────────────────────────────────────────────────

def test_put_ecrit_les_entrees_dans_l_ordre(monkeypatch, tmp_path):
    base = migrate_legacy_memory(tmp_path, "alice")
    c = _client(monkeypatch, tmp_path)
    r = c.put("/api/memory/state/memory",
              json={"entries": ["Première note", "Seconde note"]})
    assert r.status_code == 200
    assert r.json()["ok"] is True
    assert _entries_on_disk(base, "MEMORY.md") == ["Première note", "Seconde note"]


def test_put_rend_l_etat_a_jour(monkeypatch, tmp_path):
    """La page réaffiche depuis la réponse : elle doit porter le nouvel état."""
    migrate_legacy_memory(tmp_path, "alice")
    c = _client(monkeypatch, tmp_path)
    st = c.put("/api/memory/state/user", json={"entries": ["Prénom : Alice"]}).json()["state"]
    assert st["entries"] == ["Prénom : Alice"]
    assert st["chars"] == len("Prénom : Alice")
    assert st["entry_ids"] and len(st["entry_ids"]) == 1


def test_les_deux_magasins_sont_distincts(monkeypatch, tmp_path):
    base = migrate_legacy_memory(tmp_path, "alice")
    c = _client(monkeypatch, tmp_path)
    c.put("/api/memory/state/user", json={"entries": ["profil"]})
    c.put("/api/memory/state/memory", json={"entries": ["note"]})
    assert _entries_on_disk(base, "USER.md") == ["profil"]
    assert _entries_on_disk(base, "MEMORY.md") == ["note"]


def test_une_entree_supprimee_disparait(monkeypatch, tmp_path):
    base = migrate_legacy_memory(tmp_path, "alice")
    c = _client(monkeypatch, tmp_path)
    c.put("/api/memory/state/memory", json={"entries": ["a", "b", "c"]})
    c.put("/api/memory/state/memory", json={"entries": ["a", "c"]})
    assert _entries_on_disk(base, "MEMORY.md") == ["a", "c"]


def test_les_entrees_vides_sont_ignorees(monkeypatch, tmp_path):
    """Un champ laissé vide dans le formulaire ne doit pas créer d'entrée."""
    base = migrate_legacy_memory(tmp_path, "alice")
    c = _client(monkeypatch, tmp_path)
    r = c.put("/api/memory/state/memory", json={"entries": ["vrai", "   ", ""]})
    assert r.status_code == 200
    assert _entries_on_disk(base, "MEMORY.md") == ["vrai"]


# ── Le piège du séparateur ──────────────────────────────────────────────────

def test_un_trait_horizontal_ne_scinde_pas_l_entree(monkeypatch, tmp_path):
    """``rewrite`` découpe sur une ligne ``---`` OU ``§``. Joindre avec ``---``
    aurait coupé en deux toute entrée contenant un trait Markdown."""
    base = migrate_legacy_memory(tmp_path, "alice")
    c = _client(monkeypatch, tmp_path)
    entree = "Titre\n---\nsuite de la même entrée"
    r = c.put("/api/memory/state/memory", json={"entries": [entree]})
    assert r.status_code == 200
    assert len(_entries_on_disk(base, "MEMORY.md")) == 1


def test_un_delimiteur_nu_saisi_a_la_main_ne_scinde_pas(monkeypatch, tmp_path):
    """Même garde pour le ``§`` du format de stockage, tapé par l'utilisateur."""
    base = migrate_legacy_memory(tmp_path, "alice")
    c = _client(monkeypatch, tmp_path)
    r = c.put("/api/memory/state/memory", json={"entries": ["avant\n§\naprès"]})
    assert r.status_code == 200
    assert len(_entries_on_disk(base, "MEMORY.md")) == 1


# ── Vidage explicite ────────────────────────────────────────────────────────

def test_liste_vide_supprime_le_fichier(monkeypatch, tmp_path):
    """``rewrite`` refuse un contenu vide (anti-wipe accidentel de l'outil) ;
    ici l'intention est explicite, donc le fichier part."""
    base = migrate_legacy_memory(tmp_path, "alice")
    c = _client(monkeypatch, tmp_path)
    c.put("/api/memory/state/memory", json={"entries": ["à jeter"]})
    r = c.put("/api/memory/state/memory", json={"entries": []})
    assert r.status_code == 200
    assert not (base / "MEMORY.md").exists()
    assert r.json()["state"]["entries"] == []


def test_vider_un_magasin_laisse_l_autre_intact(monkeypatch, tmp_path):
    base = migrate_legacy_memory(tmp_path, "alice")
    c = _client(monkeypatch, tmp_path)
    c.put("/api/memory/state/user", json={"entries": ["profil"]})
    c.put("/api/memory/state/memory", json={"entries": ["note"]})
    c.put("/api/memory/state/memory", json={"entries": []})
    assert _entries_on_disk(base, "USER.md") == ["profil"]
    assert not (base / "MEMORY.md").exists()


# ── Refus ───────────────────────────────────────────────────────────────────

def test_depassement_de_limite_refuse_et_ne_touche_a_rien(monkeypatch, tmp_path):
    base = migrate_legacy_memory(tmp_path, "alice")
    c = _client(monkeypatch, tmp_path)
    c.put("/api/memory/state/user", json={"entries": ["contenu d'origine"]})
    r = c.put("/api/memory/state/user", json={"entries": ["x" * 50_000]})
    assert r.status_code == 400
    assert "limit" in r.json()["detail"].lower()
    assert _entries_on_disk(base, "USER.md") == ["contenu d'origine"], \
        "un refus ne doit RIEN modifier"


def test_magasin_inconnu(monkeypatch, tmp_path):
    migrate_legacy_memory(tmp_path, "alice")
    c = _client(monkeypatch, tmp_path)
    assert c.put("/api/memory/state/scopes", json={"entries": ["x"]}).status_code == 404


def test_corps_invalide(monkeypatch, tmp_path):
    migrate_legacy_memory(tmp_path, "alice")
    c = _client(monkeypatch, tmp_path)
    assert c.put("/api/memory/state/memory", json={}).status_code == 400
    assert c.put("/api/memory/state/memory", json={"entries": "x"}).status_code == 400
    assert c.put("/api/memory/state/memory",
                 json={"entries": ["x"] * 900}).status_code == 400


# ── Isolation + audit ───────────────────────────────────────────────────────

def test_l_edition_est_scopee_a_l_utilisateur(monkeypatch, tmp_path):
    base_bob = migrate_legacy_memory(tmp_path, "bob")
    (base_bob / "MEMORY.md").write_text("bob-notes", encoding="utf-8")
    c = _client(monkeypatch, tmp_path, username="alice")
    c.put("/api/memory/state/memory", json={"entries": ["alice-notes"]})
    assert (base_bob / "MEMORY.md").read_text(encoding="utf-8") == "bob-notes"


def test_l_edition_est_journalisee(monkeypatch, tmp_path):
    """Sans ligne d'audit, le journal laisserait croire que TOUT le contenu du
    store vient de l'assistant."""
    base = migrate_legacy_memory(tmp_path, "alice")
    c = _client(monkeypatch, tmp_path)
    c.put("/api/memory/state/memory", json={"entries": ["note"]})
    lignes = [json.loads(l) for l in
              (base / ".audit.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
    assert lignes and lignes[-1]["source"] == "settings"
    assert lignes[-1]["action"] == "rewrite" and lignes[-1]["ok"] is True

    audit = c.get("/api/memory/audit").json()
    assert audit["summary"]["rewrite"] == 1 and audit["summary"]["ok"] == 1
