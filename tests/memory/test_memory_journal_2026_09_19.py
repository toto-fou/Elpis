# SPDX-License-Identifier: MIT
"""tests/memory/test_memory_journal_2026_09_19.py

Écritures mémoire VISIBLES dans le fil du chat : l'outil ``memory`` ne renvoie
au modèle qu'un identifiant ``op`` ; le journal borné garde l'avant/après.
Couvre le journal, les routes de détail et d'annulation (compare-and-set),
l'origine des notes (Réglages → Mémoire), l'effacement complet, et
``session_search`` en extraits.
"""
from __future__ import annotations

import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import shared_infra.memory.routes as mem
from llm_core.memory import _journal, parse_entries
from llm_core.memory._migrate import migrate_legacy_memory


class FakeMCP:
    def __init__(self):
        self.tools = {}

    def tool(self, **kw):
        def deco(fn):
            self.tools[fn.__name__] = fn
            return fn
        return deco


class FakeCtx:
    def __init__(self, **meta):
        class _RC:
            pass
        rc = _RC()
        rc.meta = meta
        self.request_context = rc

    async def info(self, *a, **k):
        pass


@pytest.fixture
def env(tmp_path, monkeypatch):
    from llm_core.tools import memory_tools
    m = FakeMCP()
    memory_tools.register(m, tmp_path)
    monkeypatch.setattr(mem, "SANDBOX_DIR", tmp_path)
    monkeypatch.setattr(mem, "require_user_id", lambda r: 1)
    monkeypatch.setattr(mem, "get_username_by_id", lambda uid: "alice")
    monkeypatch.setattr(mem, "_chat_titles",
                        lambda req, ids: {i: f"Chat {i}" for i in ids if i == "c1"})
    app = FastAPI()
    app.include_router(mem.router)
    base = migrate_legacy_memory(tmp_path, "alice")
    return m.tools["memory"], TestClient(app), base


def _disk(base, name="MEMORY.md"):
    p = base / name
    return parse_entries(p.read_text(encoding="utf-8")) if p.exists() else []


CTX = FakeCtx(username="alice", chat_id="c1")


# ── Journal écrit par l'outil ───────────────────────────────────────────────

async def test_ajout_journalise_avec_chat_et_titre(env):
    memory, _, base = env
    r = await memory(CTX, action="add", store="memory", content="Le projet vise Python 3.12",
                     title="Je retiens la version de Python")
    assert r.ok and r.op
    rec = _journal.get(base, r.op)
    assert rec["before"] == [] and rec["after"] == ["Le projet vise Python 3.12"]
    assert rec["chat_id"] == "c1" and rec["source"] == "tool"
    assert rec["title"] == "Je retiens la version de Python"


async def test_doublon_exact_ni_ecrit_ni_journalise(env):
    memory, _, base = env
    r1 = await memory(CTX, action="add", store="memory", content="fait")
    r2 = await memory(CTX, action="add", store="memory", content="fait")
    assert r2.ok and r2.op == "" and r2.id == r1.id
    assert "Already stored" in r2.note
    assert len(_journal.records(base)) == 1


async def test_succes_court_sans_entrees(env):
    memory, _, _ = env
    r = await memory(CTX, action="add", store="user", content="Prénom : Alice")
    d = r.model_dump()
    assert set(d) == {"ok", "action", "store", "id", "op", "usage", "note"}
    assert "do not repeat" in d["note"]
    assert len(json.dumps(d, ensure_ascii=False)) < 260


# ── Détail + annulation ─────────────────────────────────────────────────────

async def test_detail_puis_annulation_d_un_ajout(env):
    memory, c, base = env
    await memory(CTX, action="add", store="memory", content="note A")
    r = await memory(CTX, action="add", store="memory", content="note B")
    d = c.get(f"/api/memory/ops/{r.op}").json()
    assert d["added"] == ["note B"] and d["removed"] == []
    assert d["can_undo"] is True and d["undone"] is False
    u = c.post(f"/api/memory/ops/{r.op}/undo")
    assert u.status_code == 200 and u.json()["op"]["undone"] is True
    assert _disk(base) == ["note A"]
    again = c.post(f"/api/memory/ops/{r.op}/undo")
    assert again.status_code == 409


async def test_annulation_d_un_remplacement_restaure_l_ancien_texte(env):
    memory, c, base = env
    r1 = await memory(CTX, action="add", store="user", content="Préfère le français")
    r2 = await memory(CTX, action="replace", store="user", target=f"[{r1.id}]",
                      content="Préfère l'anglais")
    d = c.get(f"/api/memory/ops/{r2.op}").json()
    assert d["removed"] == ["Préfère le français"] and d["added"] == ["Préfère l'anglais"]
    assert c.post(f"/api/memory/ops/{r2.op}/undo").status_code == 200
    assert _disk(base, "USER.md") == ["Préfère le français"]


async def test_annulation_du_premier_ajout_vide_le_magasin(env):
    memory, c, base = env
    r = await memory(CTX, action="add", store="memory", content="seule note")
    assert c.post(f"/api/memory/ops/{r.op}/undo").status_code == 200
    assert _disk(base) == []


async def test_annulation_refusee_si_la_memoire_a_bouge(env):
    memory, c, base = env
    r1 = await memory(CTX, action="add", store="memory", content="note A")
    await memory(CTX, action="add", store="memory", content="note B")
    d = c.get(f"/api/memory/ops/{r1.op}").json()
    assert d["can_undo"] is False
    u = c.post(f"/api/memory/ops/{r1.op}/undo")
    assert u.status_code == 409 and "changé" in u.json()["detail"]
    assert _disk(base) == ["note A", "note B"]          # rien n'a été écrasé


def test_op_invalide_ou_inconnue(env):
    _, c, _ = env
    assert c.get("/api/memory/ops/../../etc").status_code == 404
    assert c.get("/api/memory/ops/zzzz").status_code == 404
    assert c.get("/api/memory/ops/abcd1234").status_code == 404
    assert c.post("/api/memory/ops/abcd1234/undo").status_code == 404


# ── Origine des notes (Réglages) ────────────────────────────────────────────

async def test_etat_porte_l_origine_de_chaque_note(env):
    memory, c, base = env
    (base / "MEMORY.md").write_text("note ancienne", encoding="utf-8")   # avant le journal
    await memory(CTX, action="add", store="memory", content="note du chat")
    c.put("/api/memory/state/user", json={"entries": ["écrite à la main"]})
    st = c.get("/api/memory/state").json()
    mo = st["memory_md"]["origins"]
    assert mo[0] is None
    assert mo[1]["chat_id"] == "c1" and mo[1]["chat_title"] == "Chat c1"
    assert mo[1]["source"] == "tool" and mo[1]["ts"]
    uo = st["user_md"]["origins"]
    assert uo[0]["source"] == "settings" and uo[0]["chat_id"] is None


async def test_origine_d_une_note_restauree_par_annulation(env):
    # Trouvé en test sur serveur réel : après « Annuler » d'un remplacement, la
    # note restaurée s'affichait « annulation » à la date de l'annulation.
    memory, c, _ = env
    r1 = await memory(CTX, action="add", store="memory", content="port 8080")
    r2 = await memory(CTX, action="replace", store="memory", target=f"[{r1.id}]",
                      content="port 8443")
    assert c.post(f"/api/memory/ops/{r2.op}/undo").status_code == 200
    o = c.get("/api/memory/state").json()["memory_md"]["origins"][0]
    assert o["source"] == "tool" and o["op"] == r1.op and o["chat_id"] == "c1"


def test_edition_reglages_journalisee_et_annulable(env):
    _, c, base = env
    c.put("/api/memory/state/memory", json={"entries": ["a", "b"]})
    c.put("/api/memory/state/memory", json={"entries": ["a"]})
    recs = _journal.records(base)
    assert [r["source"] for r in recs] == ["settings", "settings"]
    assert _journal.diff(recs[-1]) == {"added": [], "removed": ["b"]}
    assert c.post(f"/api/memory/ops/{recs[-1]['op']}/undo").status_code == 200
    assert _disk(base) == ["a", "b"]


async def test_effacement_complet_emporte_le_journal(env):
    memory, c, base = env
    await memory(CTX, action="add", store="memory", content="x")
    assert _journal.journal_path(base).exists()
    r = c.delete("/api/memory/state").json()
    assert _journal.JOURNAL_NAME in r["removed"]
    assert not _journal.journal_path(base).exists()


# ── Journal borné ───────────────────────────────────────────────────────────

def test_journal_borne(tmp_path):
    for i in range(_journal._TRIM_AT + 5):
        _journal.append(tmp_path, action="add", store="memory",
                        before=[], after=[f"n{i}"])
    recs = _journal.records(tmp_path)
    assert len(recs) <= _journal._TRIM_AT
    assert recs[-1]["after"] == [f"n{_journal._TRIM_AT + 4}"]


def test_journal_ignore_une_ecriture_sans_effet(tmp_path):
    assert _journal.append(tmp_path, action="add", store="memory",
                           before=["a"], after=["a"]) is None
    assert _journal.records(tmp_path) == []


# ── session_search en extraits ──────────────────────────────────────────────

@pytest.fixture
def search_db(tmp_path, monkeypatch):
    from shared_infra.db import _connection as _legacy
    monkeypatch.setattr(_legacy, "DB_PATH", str(tmp_path / "t.db"))
    from shared_infra.memory import store as ms
    with _legacy.db_conn() as conn:
        conn.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT)")
        conn.execute("INSERT INTO users VALUES (1, 'alice')")
        conn.execute("CREATE TABLE chats (id TEXT PRIMARY KEY, user_id INTEGER, title TEXT)")
        conn.execute("INSERT INTO chats VALUES ('c1', 1, 'Déploiement nginx')")
        conn.commit()
    ms.init_memory_db()
    long = ("intro " * 200) + "le port nginx est 8443 " + ("suite " * 200)
    ms.session_index_message(user_id=1, app="chat", session_id="c1", scope_key="",
                             role="assistant", content=long)
    ms.session_index_message(user_id=1, app="chat", session_id="c1", scope_key="",
                             role="tool", content="sortie brute nginx " * 50)
    return ms


def test_extraits_courts_tous_roles(search_db):
    rows = search_db.session_search_snippets(1, "nginx")
    # Les sorties d'outils restent cherchées : c'est ce que vise le marqueur
    # d'élagage « [Old tool output cleared — use session_search … ] ».
    assert {r["role"] for r in rows} == {"assistant", "tool"}
    a = next(r for r in rows if r["role"] == "assistant")
    assert a["title"] == "Déploiement nginx" and a["ref"] > 0
    assert "«nginx»" in a["snippet"] and len(a["snippet"]) < 400
    assert all(len(r["snippet"]) < 400 for r in rows)


def test_lecture_d_un_passage_entier_par_ref(search_db):
    rows = search_db.session_search_snippets(1, "nginx")
    t = next(r for r in rows if r["role"] == "tool")
    full = search_db.session_message_by_ref(1, t["ref"])
    assert full["content"] == ("sortie brute nginx " * 50).strip() and full["truncated"] is False
    assert full["title"] == "Déploiement nginx"
    # Scopé au compte, et tolérant aux références farfelues.
    assert search_db.session_message_by_ref(2, t["ref"]) is None
    assert search_db.session_message_by_ref(1, "abc") is None
    assert search_db.session_message_by_ref(1, -3) is None


def test_passage_entier_plafonne(search_db):
    a = next(r for r in search_db.session_search_snippets(1, "8443") if r["role"] == "assistant")
    # message de ~2 400 c : sous le plafond ; on force un plafond bas.
    import shared_infra.memory.store as ms
    old = ms.MESSAGE_MAX_CHARS
    ms.MESSAGE_MAX_CHARS = 100
    try:
        full = search_db.session_message_by_ref(1, a["ref"])
    finally:
        ms.MESSAGE_MAX_CHARS = old
    assert len(full["content"]) == 100 and full["truncated"] is True


async def test_outil_session_search_recherche_puis_ouvre(search_db, tmp_path):
    from llm_core.tools import memory_tools
    m = FakeMCP()
    memory_tools.register(m, tmp_path)
    tool = m.tools["session_search"]
    r = await tool(CTX, query="nginx", limit=5)
    assert r.ok and r.count == 2 and all(x.ref > 0 for x in r.matches)
    ref = next(x.ref for x in r.matches if x.role == "tool")
    full = await tool(CTX, query="", limit=5, ref=ref)
    assert full.ok and full.count == 1
    assert full.matches[0].excerpt.startswith("sortie brute nginx")
    assert len(full.matches[0].excerpt) > 600
    bad = await tool(CTX, query="", limit=5, ref=999999)
    assert not bad.ok and bad.error == "unknown_ref"


# ── Fins de ligne Windows (relecture 2026-09-19) ────────────────────────────

async def test_contenu_crlf_id_exact_et_annulable(env):
    # ``read_text`` ramène \r\n à \n : l'id annoncé ne correspondait pas au
    # disque (replace suivant en no_match) et l'écriture n'était plus annulable.
    memory, c, base = env
    r = await memory(CTX, action="add", store="memory", content="ligne un\r\nligne deux")
    assert _disk(base) == ["ligne un\nligne deux"]
    from llm_core.memory import compute_entry_id
    assert r.id == compute_entry_id("ligne un\nligne deux")
    r2 = await memory(CTX, action="replace", store="memory", target=f"[{r.id}]", content="remplacée")
    assert r2.ok
    assert c.get(f"/api/memory/ops/{r2.op}").json()["can_undo"] is True
    assert c.post(f"/api/memory/ops/{r2.op}/undo").status_code == 200
    assert _disk(base) == ["ligne un\nligne deux"]


def test_extraits_repli_sans_fts(search_db, monkeypatch):
    # Repli LIKE : extrait manuel autour de la première occurrence.
    out = search_db._manual_excerpt(("a " * 300) + "cible trouvée " + ("b " * 300), ["cible"])
    assert "cible trouvée" in out and out.startswith("… ") and out.endswith(" …")
    assert len(out) < 260


def test_suppression_lit_l_etat_avant_sous_le_verrou(tmp_path):
    """(2026-09-21, B5) Le contenu journalisé est celui lu SOUS le verrou de
    suppression, pas une lecture antérieure qui pouvait manquer une écriture."""
    from shared_infra.memory.routes import _unlink_store_file_capture
    p = tmp_path / "MEMORY.md"
    p.write_text("une note\n§\nune autre", encoding="utf-8")
    removed, err, text = _unlink_store_file_capture(p)
    assert removed is True and err is None
    assert text == "une note\n§\nune autre" and not p.exists()
    assert _unlink_store_file_capture(p) == (False, None, None)
