# SPDX-License-Identifier: MIT
"""
Jeton ``pcr_`` de la page Code : il ne survit pas au compte (2026-09-20).

Avant : ``delete_user_full`` ne purgeait pas ``code_remote_tokens`` et
``_resolve_token`` ne vérifiait pas que le compte existe encore. Les ids SQLite
étant réattribuables, un vieux jeton pouvait authentifier sur les données d'un
compte créé APRÈS.
"""
from __future__ import annotations

import pytest


@pytest.fixture()
def base(tmp_path, monkeypatch):
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    legacy.init_db()
    import shared_infra.opencode.routes_code as code

    # Même base que les comptes (c'est le cas en production) : la page Code
    # passe par le pool commun, déjà redirigé ci-dessus.
    from shared_infra.accounts.users import create_user
    return {"code": code, "alice": create_user("alice", "pw-alice-1"),
            "bob": create_user("bob", "pw-bob-1")}


def test_le_jeton_resout_un_compte_vivant(base):
    code = base["code"]
    tok = code._get_or_mint_token(base["alice"])
    assert tok.startswith("pcr_") and code._resolve_token(tok) == base["alice"]


def test_delete_user_full_purge_le_jeton(base):
    code = base["code"]
    tok = code._get_or_mint_token(base["bob"])
    from shared_infra.accounts.users import delete_user_full
    assert delete_user_full(base["bob"])
    assert code._resolve_token(tok) is None
    with code._db() as c:
        assert c.execute("SELECT COUNT(*) FROM code_remote_tokens WHERE user_id=?",
                         (base["bob"],)).fetchone()[0] == 0


def test_un_jeton_orphelin_ne_resout_plus(base):
    # Ligne de jeton laissée par un ancien chemin de suppression (sans purge) :
    # le compte n'existe plus → refus, quel que soit l'id.
    code = base["code"]
    tok = code._get_or_mint_token(base["bob"])
    with code._db() as c:      # même fichier que les comptes
        c.execute("DELETE FROM users WHERE id=?", (base["bob"],))
        c.commit()
    assert code._resolve_token(tok) is None
    assert code._resolve_token("pcr_inconnu") is None
    assert code._resolve_token("") is None
