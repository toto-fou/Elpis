# SPDX-License-Identifier: MIT
"""Compteur d'usage disque de la sandbox — cache, single-flight, bump.

Audit perf 2026-08-08. ``_sandbox_size_bytes`` lance un ``du -sb`` qui parcourt
tout l'arbre. Il était appelé :
  * à chaque ``GET /api/sandbox/quota``, lui-même déclenché par CHAQUE chunk de
    sortie du terminal (le PTY fait l'écho de chaque frappe) ;
  * à chaque ``POST /api/sandbox/save``, donc à chaque autosave ;
  * au 1er chunk de chaque upload.

Ces tests verrouillent les trois garde-fous : le cache (TTL), le single-flight
(N appels concurrents = 1 seul ``du``), et la mise à jour incrémentale — plus le
garde-fou d'enforcement (recalcul EXACT près de la limite, pour qu'aucune
économie de calcul ne laisse passer un dépassement de quota).
"""
import threading
import time

import pytest

from shared_infra.routes import _helpers as H


@pytest.fixture(autouse=True)
def _clean():
    H.reset_sandbox_usage_cache()
    yield
    H.reset_sandbox_usage_cache()


class _Counter:
    """Remplace ``_sandbox_size_bytes`` et compte les appels réels."""

    def __init__(self, value=1000, delay=0.0):
        self.value = value
        self.delay = delay
        self.calls = 0
        self._lk = threading.Lock()

    def __call__(self, root):
        with self._lk:
            self.calls += 1
        if self.delay:
            time.sleep(self.delay)
        return self.value


def _patch(monkeypatch, counter):
    monkeypatch.setattr(H, "_sandbox_size_bytes", counter)


# ── Cache ────────────────────────────────────────────────────────────────

def test_deuxieme_lecture_ne_relance_pas_du(monkeypatch, tmp_path):
    c = _Counter(4242)
    _patch(monkeypatch, c)
    assert H.sandbox_usage_bytes(1, tmp_path) == 4242
    assert H.sandbox_usage_bytes(1, tmp_path) == 4242
    assert H.sandbox_usage_bytes(1, tmp_path) == 4242
    assert c.calls == 1, "le cache ne sert pas — un ``du`` par lecture"


def test_ttl_expire_relance_le_calcul(monkeypatch, tmp_path):
    c = _Counter(10)
    _patch(monkeypatch, c)
    H.sandbox_usage_bytes(1, tmp_path)
    c.value = 99
    # max_age_s=0 → toute entrée est périmée.
    assert H.sandbox_usage_bytes(1, tmp_path, max_age_s=0) == 99
    assert c.calls == 2


def test_cache_isole_par_utilisateur(monkeypatch, tmp_path):
    c = _Counter(7)
    _patch(monkeypatch, c)
    H.sandbox_usage_bytes(1, tmp_path)
    c.value = 500
    assert H.sandbox_usage_bytes(2, tmp_path) == 500      # user 2 = entrée neuve
    assert H.sandbox_usage_bytes(1, tmp_path) == 7        # user 1 garde la sienne
    assert c.calls == 2


# ── Single-flight ────────────────────────────────────────────────────────

def test_appels_concurrents_ne_lancent_quun_seul_du(monkeypatch, tmp_path):
    """C'est LE point qui compte en multi-utilisateur : sans single-flight,
    N onglets/requêtes simultanés = N ``du`` concurrents sur le même arbre."""
    c = _Counter(1234, delay=0.08)
    _patch(monkeypatch, c)
    results = []
    threads = [threading.Thread(target=lambda: results.append(
        H.sandbox_usage_bytes(1, tmp_path))) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert results == [1234] * 8
    assert c.calls == 1, f"{c.calls} ``du`` lancés au lieu d'un seul"


# ── Mise à jour incrémentale ─────────────────────────────────────────────

def test_bump_ajuste_sans_relancer_du(monkeypatch, tmp_path):
    c = _Counter(1000)
    _patch(monkeypatch, c)
    H.sandbox_usage_bytes(1, tmp_path)
    H.bump_sandbox_usage(1, 250)                     # une sauvegarde de +250 o
    assert H.sandbox_usage_bytes(1, tmp_path) == 1250
    assert c.calls == 1, "l'autosave a re-déclenché un ``du``"


def test_bump_ne_descend_jamais_sous_zero(monkeypatch, tmp_path):
    _patch(monkeypatch, _Counter(100))
    H.sandbox_usage_bytes(1, tmp_path)
    H.bump_sandbox_usage(1, -5000)
    assert H.sandbox_usage_bytes(1, tmp_path) == 0


def test_bump_sans_entree_en_cache_est_un_noop(monkeypatch, tmp_path):
    c = _Counter(80)
    _patch(monkeypatch, c)
    H.bump_sandbox_usage(1, 999)                     # rien en cache
    assert H.sandbox_usage_bytes(1, tmp_path) == 80  # valeur fraîche, pas 999+
    assert c.calls == 1


def test_bump_ne_reporte_pas_l_expiration(monkeypatch, tmp_path):
    """Sinon une suite d'autosaves repousserait le TTL indéfiniment et la
    dérive (écritures hors app : terminal, outils du modèle) ne serait jamais
    rattrapée."""
    c = _Counter(100)
    _patch(monkeypatch, c)
    H.sandbox_usage_bytes(1, tmp_path)
    key = H._usage_key(1, tmp_path)
    ts_avant = H._usage_cache[key][0]
    H.bump_sandbox_usage(1, 10)
    assert H._usage_cache[key][0] == ts_avant


def test_invalidate_force_le_recalcul(monkeypatch, tmp_path):
    c = _Counter(10)
    _patch(monkeypatch, c)
    H.sandbox_usage_bytes(1, tmp_path)
    H.invalidate_sandbox_usage(1)                    # suppression / vidage
    c.value = 3
    assert H.sandbox_usage_bytes(1, tmp_path) == 3
    assert c.calls == 2


# ── Enforcement : pas d'économie de calcul près de la limite ─────────────

def test_pres_de_la_limite_le_cache_est_ignore(monkeypatch, tmp_path):
    """Au-delà de 90 % du quota, on recalcule en EXACT : une valeur en cache
    optimiste ne doit jamais laisser passer un dépassement."""
    quota = 1000
    c = _Counter(950)                                # 95 % du quota
    _patch(monkeypatch, c)
    H.sandbox_usage_bytes(1, tmp_path, quota_bytes=quota)
    H.sandbox_usage_bytes(1, tmp_path, quota_bytes=quota)
    assert c.calls == 2, "le cache a servi alors qu'on est à 95 % du quota"


def test_loin_de_la_limite_le_cache_sert(monkeypatch, tmp_path):
    quota = 1000
    c = _Counter(100)                                # 10 % du quota
    _patch(monkeypatch, c)
    H.sandbox_usage_bytes(1, tmp_path, quota_bytes=quota)
    H.sandbox_usage_bytes(1, tmp_path, quota_bytes=quota)
    assert c.calls == 1


def test_lecture_seule_ne_declenche_pas_le_recalcul_exact(monkeypatch, tmp_path):
    """La jauge (``GET /quota``) n'a pas d'enjeu d'enforcement : même à 95 %
    elle doit rester servie par le cache, sinon on retombe sur un ``du`` par
    lecture pour les utilisateurs proches de leur quota."""
    c = _Counter(950)
    _patch(monkeypatch, c)
    H.sandbox_usage_bytes(1, tmp_path)               # pas de quota_bytes
    H.sandbox_usage_bytes(1, tmp_path)
    assert c.calls == 1


def test_deux_racines_du_meme_user_ne_se_melangent_pas(monkeypatch, tmp_path):
    """``P/work`` (quota utilisateur) et ``P`` (vue admin) sont deux mesures
    DIFFÉRENTES. Avec une clé au seul user_id, la seconde écrasait la première
    et la jauge — comme l'enforcement — lisait une valeur qui n'est pas la
    sienne."""
    work = tmp_path / "work"
    work.mkdir()
    tailles = {str(work): 100, str(tmp_path): 900}
    calls = []

    def _fake(root):
        calls.append(str(root))
        return tailles[str(root)]

    monkeypatch.setattr(H, "_sandbox_size_bytes", _fake)
    assert H.sandbox_usage_bytes(1, work) == 100
    assert H.sandbox_usage_bytes(1, tmp_path) == 900
    assert H.sandbox_usage_bytes(1, work) == 100      # pas écrasé par P
    assert len(calls) == 2


def test_bump_et_invalidate_couvrent_toutes_les_racines(monkeypatch, tmp_path):
    work = tmp_path / "work"
    work.mkdir()
    c = _Counter(50)
    _patch(monkeypatch, c)
    H.sandbox_usage_bytes(1, work)
    H.sandbox_usage_bytes(1, tmp_path)
    H.bump_sandbox_usage(1, 25)
    assert H.sandbox_usage_bytes(1, work) == 75
    assert H.sandbox_usage_bytes(1, tmp_path) == 75
    H.invalidate_sandbox_usage(1)
    assert not [k for k in H._usage_cache if k[0] == 1]
