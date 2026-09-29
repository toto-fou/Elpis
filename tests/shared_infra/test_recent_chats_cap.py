# SPDX-License-Identifier: MIT
"""Plafond des conversations actives : un réglage VIVANT, et destructif.

``app.max_recent_chats`` n'était lu qu'à l'import de ``config.py``. Le champ
d'administration « Conversations récentes » n'avait donc d'effet qu'après un
redémarrage COMPLET — et, en multi-worker, seulement dans le worker qui avait
reçu le POST. Le déploiement livrait par ailleurs ``20`` là où tous les défauts
du code annoncent ``100`` : la barre latérale plafonnait à vingt conversations
et ``enforce_recent_chats_cap`` SUPPRIMAIT le reste.

Ces tests verrouillent les trois propriétés qui comptent : la valeur suit le
fichier sans redémarrage, la variable d'environnement garde la priorité, et un
plafond nul ne peut pas vider la base.
"""
import itertools
import json

import pytest

from shared_infra import config as cfg
from shared_infra.accounts.users import create_user
from shared_infra.chat.store import (
    enforce_recent_chats_cap,
    list_chats,
    search_chats,
    upsert_chat,
)
from shared_infra.db._connection import db_conn

_SEQ = itertools.count(1)


@pytest.fixture
def set_cap(tmp_path, monkeypatch):
    """Rend un ``set_cap(valeur)`` qui écrit le plafond comme un autre worker.

    Écriture ``.tmp`` puis ``replace()`` — le chemin de ``write_config_json``,
    celui sur lequel le cache de ``config_view`` s'appuie (l'inode change).
    """
    p = tmp_path / "config.json"
    monkeypatch.setattr(cfg, "CONFIG_JSON_PATH", p)
    monkeypatch.delenv("APP_MAX_RECENT_CHATS", raising=False)

    def _set(value):
        app = {} if value is None else {"max_recent_chats": value}
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps({"app": app}), encoding="utf-8")
        tmp.replace(p)
        cfg.invalidate_config_cache()

    _set(100)
    yield _set
    cfg.invalidate_config_cache()


@pytest.fixture
def uid():
    """Un propriétaire neuf par test : la base de la suite est de portée session.

    Un utilisateur RÉEL, pas un entier arbitraire — ``chats.user_id`` porte une
    clé étrangère.
    """
    return create_user(f"cap_user_{next(_SEQ)}", "motdepasse-de-test")


def _seed(uid, n, title="Conversation"):
    """``n`` chats actifs, du plus ancien au plus récent."""
    for i in range(n):
        upsert_chat(uid, f"c{uid}-{i:03d}", f"{title} {i:03d}", [], 1_700_000_000.0 + i)


def _remaining(uid):
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT id FROM chats WHERE user_id=? AND archived=0 "
                    "ORDER BY updated_at DESC", (uid,))
        return [r["id"] for r in cur.fetchall()]


# ── Le réglage suit le fichier, sans redémarrage ────────────────────────────

def test_la_liste_suit_le_fichier_sans_redemarrage(set_cap, uid):
    _seed(uid, 30)
    assert len(list_chats(uid, archived=0)) == 30

    set_cap(20)
    assert len(list_chats(uid, archived=0)) == 20, \
        "le plafond du fichier doit s'appliquer immédiatement"

    set_cap(80)
    assert len(list_chats(uid, archived=0)) == 30, \
        "et le relèvement aussi — sans redémarrage ni rien supprimer"


def test_quatre_vingts_conversations_sont_listables(set_cap, uid):
    """L'exigence tenue par le réglage livré : bien plus que les 20 d'avant."""
    set_cap(80)
    _seed(uid, 85)
    assert len(list_chats(uid, archived=0)) == 80


def test_valeur_absente_ou_illisible_retombe_sur_le_defaut(set_cap):
    set_cap(None)
    assert cfg.max_recent_chats() == cfg.MAX_RECENT_CHATS
    set_cap("beaucoup")
    assert cfg.max_recent_chats() == cfg.MAX_RECENT_CHATS


def test_l_environnement_prime_sur_le_fichier(set_cap, monkeypatch):
    """``APP_MAX_RECENT_CHATS`` est un choix de DÉPLOIEMENT : l'admin ne l'écrase pas.

    La constante porte déjà la résolution de la variable (faite à l'import),
    d'où le double patch : c'est l'état exact d'un process lancé avec elle.
    """
    monkeypatch.setenv("APP_MAX_RECENT_CHATS", "7")
    monkeypatch.setattr(cfg, "MAX_RECENT_CHATS", 7)
    set_cap(500)
    assert cfg.max_recent_chats() == 7


# ── Le plafond n'est pas qu'un affichage : il SUPPRIME ──────────────────────

def test_enforce_supprime_au_dela_du_plafond_courant(set_cap, uid):
    _seed(uid, 10)
    set_cap(3)
    enforce_recent_chats_cap(uid)
    assert _remaining(uid) == [f"c{uid}-009", f"c{uid}-008", f"c{uid}-007"], \
        "les plus RÉCENTES survivent, les anciennes sont détruites"


def test_enforce_ne_touche_a_rien_sous_le_plafond(set_cap, uid):
    _seed(uid, 10)
    set_cap(80)
    enforce_recent_chats_cap(uid)
    assert len(_remaining(uid)) == 10


def test_un_plafond_nul_ne_vide_pas_la_base(set_cap, uid):
    """``0`` — saisissable dans un config.json écrit à la main — signifiait
    « tout supprimer » : ``out[:0]`` et ``ids[0:]``. Plancher à 1."""
    _seed(uid, 5)
    set_cap(0)
    assert cfg.max_recent_chats() == 1
    enforce_recent_chats_cap(uid)
    assert _remaining(uid) == [f"c{uid}-004"]


# ── Cohérence liste / recherche ─────────────────────────────────────────────

def test_la_recherche_couvre_au_moins_ce_que_la_liste_montre(set_cap, uid):
    """Jadis ``LIMIT 50`` en dur : au-delà, un chat VISIBLE dans la barre
    latérale restait introuvable à la recherche."""
    set_cap(80)
    _seed(uid, 60, title="Zorglub")
    assert len(search_chats(uid, "Zorglub", archived=0)) == 60
    assert len(search_chats(uid, "Zorglub", archived=0, deep=True)) == 60
