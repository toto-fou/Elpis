# SPDX-License-Identifier: MIT
"""Cache de lecture de ``config.json`` — le fichier reste la source de vérité.

Le cache introduit dans ``shared_infra.config`` ne doit RIEN changer au
comportement observable : ce qui est écrit sur disque doit être relu, y
compris quand l'écriture vient d'un AUTRE process (cas multi-worker, qui est
la raison d'être de ``live_config_value`` / ``feature_enabled``).
"""
import copy
import json
import os

import pytest

from shared_infra import config as cfg


@pytest.fixture
def cfg_file(tmp_path, monkeypatch):
    """Redirige ``CONFIG_JSON_PATH`` vers un fichier jetable, cache vidé."""
    p = tmp_path / "config.json"
    p.write_text(json.dumps({"security": {"session": {"max_age_sec": 111}}}),
                 encoding="utf-8")
    monkeypatch.setattr(cfg, "CONFIG_JSON_PATH", p)
    cfg.invalidate_config_cache()
    yield p
    cfg.invalidate_config_cache()


def _write(path, data):
    """Écrit comme un AUTRE worker le ferait : .tmp puis replace().

    C'est le chemin de ``write_config_json``, et aussi celui de ``vi`` et de
    ``sed -i``. Il change l'inode — ce sur quoi le cache s'appuie, le mtime
    étant trop grossier (cf. test_mtime_seul_ne_suffirait_pas).
    """
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data), encoding="utf-8")
    tmp.replace(path)


def test_relit_apres_une_ecriture_externe(cfg_file):
    assert cfg.live_config_value("security.session.max_age_sec") == 111
    _write(cfg_file, {"security": {"session": {"max_age_sec": 222}}})
    assert cfg.live_config_value("security.session.max_age_sec") == 222


def test_relit_meme_si_la_taille_est_identique(cfg_file):
    """Deux contenus de MÊME taille : la clé ne peut pas se réduire à la taille."""
    _write(cfg_file, {"security": {"session": {"max_age_sec": 111}}})
    assert cfg.live_config_value("security.session.max_age_sec") == 111
    before = cfg_file.stat().st_size
    _write(cfg_file, {"security": {"session": {"max_age_sec": 999}}})
    assert cfg_file.stat().st_size == before, "le test ne prouve rien si la taille change"
    assert cfg.live_config_value("security.session.max_age_sec") == 999


def test_l_inode_fait_partie_de_la_cle(cfg_file):
    """Le mtime seul serait insuffisant : sa granularité est le tick noyau.

    Deux écritures rapprochées peuvent partager le même ``st_mtime_ns``. Or
    tous les écrivains réels (``write_config_json``, ``vi``, ``sed -i``)
    procèdent par rename, donc changent l'inode : c'est lui le signal fiable.
    On vérifie sa présence dans la clé plutôt que de parier sur la vitesse de
    la machine, ce qui rendrait le test instable.
    """
    cfg.config_view()
    st = cfg_file.stat()
    assert cfg._config_cache_key == (st.st_mtime_ns, st.st_size, st.st_ino)


class _StatFige:
    """Chemin réel dont le ``stat()`` est figé.

    Simule l'écrivain exotique qui modifierait le fichier EN PLACE, à taille et
    tick identiques — le seul cas qui échappe à la clé. Figer le stat rend le
    test déterministe là où compter sur la granularité réelle de l'horloge le
    rendrait instable.
    """

    def __init__(self, real):
        self._real, self._st = real, real.stat()

    def stat(self):
        return self._st

    def exists(self):
        return self._real.exists()

    def open(self, *a, **k):
        return self._real.open(*a, **k)

    def __fspath__(self):
        return str(self._real)


def test_peremption_bornee_pour_une_ecriture_sur_place(cfg_file, monkeypatch):
    """Le plafond borne le retard à 1 s au lieu de le laisser infini."""
    monkeypatch.setattr(cfg, "CONFIG_JSON_PATH", _StatFige(cfg_file))
    cfg.invalidate_config_cache()
    assert cfg.live_config_value("security.session.max_age_sec") == 111

    cfg_file.write_text(json.dumps({"security": {"session": {"max_age_sec": 999}}}),
                        encoding="utf-8")
    assert cfg.live_config_value("security.session.max_age_sec") == 111, \
        "clé inchangée et plafond non atteint : servir le cache est attendu"

    base = cfg._config_cache_at
    monkeypatch.setattr(cfg.time, "monotonic",
                        lambda: base + cfg._CONFIG_MAX_STALE_S + 0.01)
    assert cfg.live_config_value("security.session.max_age_sec") == 999


def test_write_config_json_est_relu_immediatement(cfg_file):
    """Lire-modifier-écrire-relire dans le MÊME process, sans dépendre du mtime."""
    d = cfg.read_config_json()
    d.setdefault("features", {})["truc"] = False
    cfg.write_config_json(d)
    assert cfg.feature_enabled("truc") is False
    assert cfg.read_config_json()["features"]["truc"] is False


def test_fichier_absent_rend_un_dict_vide(tmp_path, monkeypatch):
    monkeypatch.setattr(cfg, "CONFIG_JSON_PATH", tmp_path / "absent.json")
    cfg.invalidate_config_cache()
    assert cfg.read_config_json() == {}
    assert cfg.config_view() == {}
    assert cfg.live_config_value("a.b", "repli") == "repli"


def test_json_invalide_rend_un_dict_vide(cfg_file):
    cfg_file.write_text("{ pas du json", encoding="utf-8")
    assert cfg.read_config_json() == {}
    assert cfg.live_config_value("security.session.max_age_sec", 7) == 7


def test_fichier_supprime_apres_avoir_ete_lu(cfg_file):
    """Le cache ne doit pas continuer à servir une version fantôme."""
    assert cfg.live_config_value("security.session.max_age_sec") == 111
    os.unlink(cfg_file)
    assert cfg.config_view() == {}


# ── Isolation : le cache est partagé, personne ne doit pouvoir le corrompre ──

def test_read_config_json_rend_un_objet_mutable_et_isole(cfg_file):
    """Contrat historique : l'appelant peut muter librement ce qu'il reçoit.

    C'est le motif de tous les endpoints admin (``cfg.setdefault(...)`` puis
    ``write_config_json(cfg)``). Muter le retour ne doit pas contaminer le
    cache partagé.
    """
    a = cfg.read_config_json()
    a["security"]["session"]["max_age_sec"] = 42
    a["injecte"] = True

    b = cfg.read_config_json()
    assert b["security"]["session"]["max_age_sec"] == 111
    assert "injecte" not in b
    assert cfg.live_config_value("security.session.max_age_sec") == 111


def test_live_config_value_isole_les_conteneurs(cfg_file):
    """Un chemin qui désigne un dict ne doit pas exposer le cache lui-même."""
    sess = cfg.live_config_value("security.session")
    assert sess == {"max_age_sec": 111}
    sess["max_age_sec"] = 0
    assert cfg.live_config_value("security.session.max_age_sec") == 111


def test_config_view_ne_recopie_pas(cfg_file):
    """L'intérêt de config_view est justement d'éviter la copie : même objet."""
    assert cfg.config_view() is cfg.config_view()


# ── Le gain, mesuré : plus de reparse quand le fichier n'a pas bougé ────────

def test_aucune_relecture_disque_quand_le_fichier_est_stable(cfg_file, monkeypatch):
    cfg.config_view()  # amorce
    calls = []
    real = cfg._read_json_file
    monkeypatch.setattr(cfg, "_read_json_file",
                        lambda p: (calls.append(p), real(p))[1])
    # Horloge figée : on teste l'effet de la CLÉ, pas celui du plafond.
    monkeypatch.setattr(cfg.time, "monotonic", lambda: cfg._config_cache_at)
    for _ in range(50):
        cfg.config_view()
    assert calls == [], "le fichier n'a pas changé : aucun parse ne devait avoir lieu"

    _write(cfg_file, {"security": {"session": {"max_age_sec": 333}}})
    assert cfg.live_config_value("security.session.max_age_sec") == 333
    assert len(calls) == 1, "exactement un reparse après la modification"
