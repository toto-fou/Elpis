# SPDX-License-Identifier: MIT
"""Magasin des images générées (``shared_infra/image/store.py``) et son
nettoyage : rétention par compte, confinement, vignettes, galerie, mesures de
durée, suppression d'une conversation ou d'un compte, entretien."""
from __future__ import annotations

import io
import json
import os
import time
from dataclasses import dataclass
from typing import Optional

import pytest

from shared_infra.image import store


@dataclass
class Resultat:
    data: bytes
    mime: str
    width: int
    height: int
    seed: Optional[int] = None
    revised_prompt: str = ""


def png(w: int = 64, h: int = 48, couleur=(200, 30, 30)) -> bytes:
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (w, h), couleur).save(buf, "PNG")
    return buf.getvalue()


@pytest.fixture()
def base(tmp_path, monkeypatch):
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "user_db" / "app.db"))
    legacy.reset_pool()
    legacy.init_db()
    from shared_infra.accounts.users import create_user
    assert create_user("alice", "pw-alice-12") == 1
    assert create_user("bob", "pw-bob-1234") == 2
    yield tmp_path
    legacy.reset_pool()


def _enregistrer(uid=1, chat_id=None, n=1, keep=50, prompt="un phare", seed=7,
                 model="Qwen-Image", duration_s=12.0, steps=0):
    res = [Resultat(png(), "image/png", 64, 48, seed=seed + i) for i in range(n)]
    return store.save_images(uid, chat_id, prompt, model=model, params={"size": "64x48"},
                             results=res, keep=keep, steps=steps, duration_s=duration_s)


def _chat(uid, chat_id):
    from shared_infra.chat.store import upsert_chat
    upsert_chat(uid, chat_id, "t", [{"role": "user", "content": "x"}], time.time())


def test_references_fichiers_et_vignette(base):
    refs = _enregistrer(n=2)
    assert len(refs) == 2
    r = refs[0]
    assert r["url"] == f"/api/images/{r['id']}" and r["thumb_url"].endswith("?thumb=1")
    assert (r["width"], r["height"], r["mime"], r["seed"]) == (64, 48, "image/png", 7)
    row = store.get_image(1, r["id"])
    assert row and os.path.isfile(row["path"]) and row["thumb_path"].endswith(".thumb.webp")
    assert row["rel_path"] == f"1/{r['id']}.png", "chemin RELATIF en base"
    assert store.read_bytes(1, r["id"]).startswith(b"\x89PNG")


def test_image_d_un_autre_compte_inexistante(base):
    iid = _enregistrer()[0]["id"]
    assert store.get_image(2, iid) is None
    assert store.delete_image(2, iid) is False
    assert store.get_image(1, iid) is not None
    assert store.get_image(1, "../../etc") is None


def test_chemin_hors_magasin_refuse(base):
    from shared_infra.db._connection import db_conn
    iid = _enregistrer()[0]["id"]
    with db_conn() as conn:
        conn.execute("UPDATE generated_images SET rel_path=? WHERE id=?", ("../../app.db", iid))
        conn.commit()
    assert store.get_image(1, iid) is None


def test_retention_glissante_par_compte(base):
    vieilles = [_enregistrer(keep=2)[0] for _ in range(2)]
    autre = _enregistrer(uid=2, keep=2)[0]
    neuve = _enregistrer(keep=2)[0]
    assert store.get_image(1, vieilles[0]["id"]) is None, "la plus ancienne part"
    assert not (store.root() / "1" / f"{vieilles[0]['id']}.png").exists()
    assert not (store.root() / "1" / f"{vieilles[0]['id']}.thumb.webp").exists()
    assert store.get_image(1, vieilles[1]["id"]) and store.get_image(1, neuve["id"])
    assert store.get_image(2, autre["id"]), "rétention par compte"


def test_suppression_unitaire_efface_fichiers(base):
    iid = _enregistrer()[0]["id"]
    assert store.delete_image(1, iid) is True
    assert not list((store.root() / "1").glob(f"{iid}*"))


def test_conversations_supprimees_par_tous_les_chemins(base):
    from shared_infra.chat import store as chats
    for cid in ("c1", "c2", "c3", "c4"):
        _chat(1, cid)
    ids = {cid: _enregistrer(chat_id=cid)[0]["id"] for cid in ("c1", "c2", "c3", "c4")}
    assert chats.delete_chat(1, "c1")
    assert store.get_image(1, ids["c1"]) is None
    chats.delete_chats_by_ids(1, ["c2"])
    assert store.get_image(1, ids["c2"]) is None
    chats.delete_all_chats(1)
    assert store.get_image(1, ids["c3"]) is None and store.get_image(1, ids["c4"]) is None


def test_plafond_de_conversations_efface_leurs_images(base, monkeypatch):
    from shared_infra.chat import store as chats
    monkeypatch.setattr(chats, "max_recent_chats", lambda: 1)
    _chat(1, "vieux")
    time.sleep(0.01)
    _chat(1, "neuf")
    vieille = _enregistrer(chat_id="vieux")[0]["id"]
    chats.enforce_recent_chats_cap(1)
    assert store.get_image(1, vieille) is None


def test_chat_neuf_pas_encore_ecrit_garde_ses_images(base):
    """La question d'un chat neuf peut être écrite après l'image : le
    ramassage n'agit qu'au-delà du délai de grâce."""
    iid = _enregistrer(chat_id="pas-encore-en-base")[0]["id"]
    _enregistrer()
    assert store.get_image(1, iid), "image fraîche gardée"
    assert store.sweep_orphans(now=time.time() + store.ORPHAN_GRACE_S + 5) >= 1
    assert store.get_image(1, iid) is None


def test_suppression_du_compte(base):
    from shared_infra.accounts.users import delete_user_full
    from shared_infra.db._connection import db_conn
    _enregistrer(uid=2)
    assert (store.root() / "2").is_dir()
    assert delete_user_full(2)
    with db_conn() as conn:
        assert conn.execute("SELECT COUNT(*) FROM generated_images WHERE user_id=2").fetchone()[0] == 0
    assert not (store.root() / "2").exists()


def test_entretien_fichiers_sans_ligne_et_comptes_disparus(base):
    _enregistrer()
    perdu = store.root() / "1" / ("f" * 32 + ".png")
    perdu.write_bytes(b"x")
    vieux = time.time() - 7200
    os.utime(perdu, (vieux, vieux))
    fantome = store.root() / "99"
    fantome.mkdir()
    (fantome / "a.png").write_bytes(b"x")
    assert store.sweep_orphans() >= 2
    assert not perdu.exists() and not fantome.exists()
    assert len(list((store.root() / "1").glob("*.png"))) == 1, "les vraies images restent"


def test_galerie_paginee_et_filtree(base):
    _chat(1, "c1")
    for i in range(5):
        _enregistrer(chat_id="c1" if i % 2 else None, prompt=f"p{i}")
    items, suite, total = store.list_images(1, limit=2)
    assert total == 5 and len(items) == 2 and suite is not None
    assert [i["prompt"] for i in items] == ["p4", "p3"]
    items2, suite2, _ = store.list_images(1, limit=10, before=suite)
    assert [i["prompt"] for i in items2] == ["p2", "p1", "p0"] and suite2 is None
    du_chat, _, _ = store.list_images(1, chat_id="c1")
    assert {i["prompt"] for i in du_chat} == {"p1", "p3"}
    assert store.list_images(2)[2] == 0
    assert store.count_for_user(1) == 5


def test_mesures_de_duree_une_par_lot(base):
    _enregistrer(n=3, duration_s=30.0)
    _enregistrer(n=1, duration_s=10.0, model="autre")
    _enregistrer(n=1, duration_s=8.0, steps=20)
    t = store.recent_timings("Qwen-Image", 0)
    assert t == [(30.0, round(3 * 64 * 48 / 1e6, 4))]


def test_migration_idempotente(base):
    import importlib

    from shared_infra.db._connection import db_conn
    mod = importlib.import_module("shared_infra.db._migrations.0024_generated_images")
    with db_conn() as conn:
        mod.migrate(conn)
        mod.migrate(conn)
        conn.commit()
        assert conn.execute("SELECT COUNT(*) FROM generated_images").fetchone()[0] == 0


def test_params_json_porte_graine_et_description(base):
    from shared_infra.db._connection import db_conn
    res = [Resultat(png(), "image/png", 64, 48, seed=None, revised_prompt="a lighthouse")]
    ref = store.save_images(1, None, "phare", model="m", params={"size": "64x48"},
                            results=res, keep=5)[0]
    assert "seed" not in ref
    with db_conn() as conn:
        p = json.loads(conn.execute("SELECT params_json FROM generated_images").fetchone()[0])
    assert p == {"size": "64x48", "revised_prompt": "a lighthouse"}


# ── Correctifs de la relecture finale ─────────────────────────────────────

def _vieillir(iid, secondes):
    from shared_infra.db._connection import db_conn
    with db_conn() as conn:
        conn.execute("UPDATE generated_images SET created_at=created_at-? WHERE id=?",
                     (float(secondes), iid))
        conn.commit()


def test_retention_jamais_plus_petite_que_le_lot(base):
    """Une rétention de 2 n'efface pas un lot de 4 qu'on vient de produire."""
    ancienne = _enregistrer(keep=2)[0]["id"]
    lot = _enregistrer(n=4, keep=2)
    assert all(store.get_image(1, r["id"]) for r in lot)
    assert store.get_image(1, ancienne) is None


def test_grace_du_ramasse_miettes_plus_longue_qu_un_tour(base):
    assert store.ORPHAN_GRACE_S >= 2 * 3600
    iid = _enregistrer(chat_id="ecrit-plus-tard")[0]["id"]
    assert store.sweep_orphans(now=time.time() + 3600) == 0
    assert store.get_image(1, iid)


def test_entretien_sessions_ephemeres_apres_un_jour(base):
    vieille = _enregistrer(chat_id=None)[0]["id"]
    recente = _enregistrer(chat_id=None)[0]["id"]
    _vieillir(vieille, store.EPHEMERAL_TTL_S + 60)
    store.sweep_orphans()
    assert store.get_image(1, vieille) is None and store.get_image(1, recente)


def test_entretien_lignes_sans_fichier(base):
    perdue, gardee = (_enregistrer()[0]["id"] for _ in range(2))
    (store.root() / "1" / f"{perdue}.png").unlink()
    _vieillir(perdue, 2 * 86400)
    store.sweep_orphans()
    assert store.count_for_user(1) == 1 and store.get_image(1, gardee)


def test_entretien_retention_de_tous_les_comptes(base):
    """Une baisse de ``keep_per_user`` vaut aussi pour un compte inactif."""
    ids = [_enregistrer(uid=2, keep=50)[0]["id"] for _ in range(4)]
    store.sweep_orphans(keep=2)
    assert store.count_for_user(2) == 2
    assert store.get_image(2, ids[-1]) and store.get_image(2, ids[0]) is None
    assert not (store.root() / "2" / f"{ids[0]}.png").exists()


def test_nom_de_modele_borne(base):
    from shared_infra.db._connection import db_conn
    iid = _enregistrer(model="m" * 400)[0]["id"]
    with db_conn() as conn:
        assert len(conn.execute("SELECT model FROM generated_images WHERE id=?",
                                (iid,)).fetchone()[0]) == 191


def test_suppression_par_tranches_dedoublonnees(base):
    from shared_infra.db._connection import db_conn
    ids = [_enregistrer()[0]["id"] for _ in range(3)]
    with db_conn() as conn:
        store._delete_ids(conn, [ids[0], ids[0], ids[1], ""])
        conn.commit()
    assert store.count_for_user(1) == 1 and store.get_image(1, ids[2])


def test_vignette_formats_acceptes_seulement(base):
    assert store._thumbnail(b"%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 8 8\n") is None
    assert store._thumbnail(png())
