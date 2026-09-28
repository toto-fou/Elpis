# SPDX-License-Identifier: MIT
"""tests/db/test_chat_plan_mode.py — mode lecture seule PAR CHAT (meta_json).

Couvre ``shared_infra/chat/store.py`` pour la commande « /plan » :
- ``set_chat_plan_mode`` : roundtrip, False si chat inconnu, PAS de bump
  ``updated_at`` (basculer un mode n'est pas un tour), merge non destructif
  vis-à-vis de ``tools`` / ``todos`` ;
- ``get_chat`` : expose ``plan_mode`` ; absent ⇒ False ;
- ``get_chat_plan_mode`` : lecture LÉGÈRE (sans ``messages_json``), False sur
  chat inconnu ou meta illisible.

La fixture reproduit la table post-0008, comme test_chat_tools_meta.py.
"""
from __future__ import annotations

import json

import pytest


@pytest.fixture()
def C(tmp_path, monkeypatch):
    """Table ``chats`` post-0008 (avec ``meta_json``), DB temporaire."""
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    from shared_infra.db._connection import db_conn
    with db_conn() as conn:
        conn.execute(
            "CREATE TABLE chats (id TEXT PRIMARY KEY, user_id INTEGER, title TEXT, "
            "messages_json TEXT, updated_at REAL, archived INTEGER DEFAULT 0, "
            "meta_json TEXT NOT NULL DEFAULT '{}')"
        )
        conn.commit()
    import shared_infra.chat.store as chats
    return chats


def _seed(C, chat_id="c1"):
    C.upsert_chat(1, chat_id, "T", [{"role": "user", "content": "x"}], 10.0)


def test_roundtrip_set_puis_get(C):
    _seed(C)
    assert C.set_chat_plan_mode(1, "c1", True) is True
    assert C.get_chat(1, "c1")["plan_mode"] is True
    assert C.set_chat_plan_mode(1, "c1", False) is True
    assert C.get_chat(1, "c1")["plan_mode"] is False


def test_absent_vaut_false(C):
    """Un chat qui n'a jamais vu la commande n'est PAS en lecture seule.

    Contrairement à ``tools``, il n'y a pas d'état « jamais posé » à
    distinguer : le mode est un booléen, son absence vaut coupé.
    """
    _seed(C)
    assert C.get_chat(1, "c1")["plan_mode"] is False


def test_chat_inconnu_false(C):
    assert C.set_chat_plan_mode(1, "nexiste-pas", True) is False
    assert C.get_chat_plan_mode(1, "nexiste-pas") is False


def test_pas_de_bump_updated_at(C):
    """Basculer le mode ne doit ni remonter le chat dans la sidebar ni
    invalider la garde optimiste de la persistance de fin de tour."""
    _seed(C)
    avant = C.get_chat(1, "c1")["updated_at"]
    C.set_chat_plan_mode(1, "c1", True)
    assert C.get_chat(1, "c1")["updated_at"] == avant


def test_merge_ne_detruit_pas_les_autres_cles(C):
    """Même canal que set_chat_tools : le merge se fait SOUS la transaction,
    deux réglages par-chat ne doivent pas s'écraser l'un l'autre."""
    _seed(C)
    C.set_chat_tools(1, "c1", ["fs", "shell"])
    C.set_chat_plan_mode(1, "c1", True)
    chat = C.get_chat(1, "c1")
    assert chat["tools"] == ["fs", "shell"]
    assert chat["plan_mode"] is True
    # et dans l'autre sens
    C.set_chat_tools(1, "c1", ["git"])
    chat = C.get_chat(1, "c1")
    assert chat["tools"] == ["git"]
    assert chat["plan_mode"] is True


def test_lecture_legere_sans_messages_json(C):
    """``get_chat_plan_mode`` existe pour être appelée à chaque tour : elle
    ne doit pas désérialiser l'historique. On le prouve en rendant
    ``messages_json`` illisible — la lecture doit quand même répondre."""
    _seed(C)
    C.set_chat_plan_mode(1, "c1", True)
    from shared_infra.db._connection import db_conn
    with db_conn() as conn:
        conn.execute("UPDATE chats SET messages_json='{{{ pas du JSON' WHERE id='c1'")
        conn.commit()
    assert C.get_chat_plan_mode(1, "c1") is True


def test_chat_id_vide(C):
    """Chat neuf : la route lit le mode avant d'avoir un id."""
    assert C.get_chat_plan_mode(1, "") is False


def test_meta_json_corrompu_tolere(C):
    _seed(C)
    from shared_infra.db._connection import db_conn
    with db_conn() as conn:
        conn.execute("UPDATE chats SET meta_json='pas du json' WHERE id='c1'")
        conn.commit()
    assert C.get_chat_plan_mode(1, "c1") is False
    assert C.get_chat(1, "c1")["plan_mode"] is False


def test_isolation_par_utilisateur(C):
    _seed(C)
    C.set_chat_plan_mode(1, "c1", True)
    assert C.set_chat_plan_mode(2, "c1", True) is False   # pas son chat
    assert C.get_chat_plan_mode(2, "c1") is False


def test_valeur_stockee_est_un_bool(C):
    """meta_json doit porter un vrai booléen : la route renvoie 422 sur autre
    chose, mais la couche DB coerce quand même (défense en profondeur)."""
    _seed(C)
    C.set_chat_plan_mode(1, "c1", "oui")        # type: ignore[arg-type]
    from shared_infra.db._connection import db_conn
    with db_conn() as conn:
        row = conn.execute("SELECT meta_json FROM chats WHERE id='c1'").fetchone()
    assert json.loads(row["meta_json"])["plan_mode"] is True
