# SPDX-License-Identifier: MIT
"""Assemblage des pages HTML mis en cache sur l'état du disque.

Assembler ``index.html`` coûtait 27 ms par chargement — @include d'une
quarantaine de fichiers, puis deux passes d'expression régulière sur 1,26 Mo —
pour un résultat identique tant que rien ne bouge.

Le contrat à préserver est celui du développement : éditer un include doit se
voir au rechargement suivant, sans redémarrer le serveur.
"""
import os
import time

import pytest

from shared_infra.routes import system as S


@pytest.fixture
def pages(tmp_path, monkeypatch):
    """Arborescence ``frontend/`` jetable, avec un include."""
    front = tmp_path / "frontend"
    (front / "includes").mkdir(parents=True)
    (front / "index.html").write_text(
        '<html><head><script src="static/js/a.js?v=old"></script></head>'
        '<body><!-- @include includes/bloc.html --></body></html>',
        encoding="utf-8")
    (front / "includes" / "bloc.html").write_text("<p>ORIGINAL</p>", encoding="utf-8")
    monkeypatch.chdir(tmp_path)
    S._page_cache.clear()
    S._VENDOR_FP_CACHE.clear()
    yield front
    S._page_cache.clear()


def test_l_include_est_assemble(pages):
    assert "<p>ORIGINAL</p>" in S.render_page("index.html")


def test_le_cache_evite_de_reassembler(pages, monkeypatch):
    S.render_page("index.html")
    appels = []
    vrai = S._apply_includes_and_cachebust
    monkeypatch.setattr(S, "_apply_includes_and_cachebust",
                        lambda *a, **k: (appels.append(1), vrai(*a, **k))[1])
    for _ in range(20):
        S.render_page("index.html")
    assert appels == [], "rien n'a changé sur le disque : aucun réassemblage"


def test_editer_un_include_est_vu_au_rechargement(pages):
    """Le contrat de développement : pas besoin de redémarrer."""
    assert "ORIGINAL" in S.render_page("index.html")
    time.sleep(0.01)
    (pages / "includes" / "bloc.html").write_text("<p>MODIFIÉ</p>", encoding="utf-8")
    out = S.render_page("index.html")
    assert "MODIFIÉ" in out and "ORIGINAL" not in out


def test_editer_la_page_racine_est_vu_aussi(pages):
    S.render_page("index.html")
    time.sleep(0.01)
    (pages / "index.html").write_text("<html><body>TOUT NEUF</body></html>",
                                      encoding="utf-8")
    assert "TOUT NEUF" in S.render_page("index.html")


def test_un_include_qui_APPARAIT_invalide_le_cache(pages):
    """Un include manquant est noté quand même, sinon la page resterait amputée.

    Sans cela, une page rendue une fois avec un include absent garderait son
    commentaire d'erreur même après création du fichier — jusqu'au prochain
    redémarrage.
    """
    (pages / "index.html").write_text(
        "<html><body><!-- @include includes/tard.html --></body></html>",
        encoding="utf-8")
    S._page_cache.clear()
    assert "include not found" in S.render_page("index.html")

    time.sleep(0.01)
    (pages / "includes" / "tard.html").write_text("<p>ME VOICI</p>", encoding="utf-8")
    assert "ME VOICI" in S.render_page("index.html")


def test_un_include_supprime_invalide_le_cache(pages):
    assert "ORIGINAL" in S.render_page("index.html")
    time.sleep(0.01)
    os.unlink(pages / "includes" / "bloc.html")
    assert "include not found" in S.render_page("index.html")


def test_deux_pages_ont_des_caches_distincts(pages):
    (pages / "admin.html").write_text("<html><body>ADMIN</body></html>", encoding="utf-8")
    assert "ORIGINAL" in S.render_page("index.html")
    assert "ADMIN" in S.render_page("admin.html")
    assert "ORIGINAL" in S.render_page("index.html")


def test_le_cache_busting_est_toujours_applique(pages):
    from shared_infra.config import BUILD_ID
    assert f"?v={BUILD_ID}" in S.render_page("index.html")


def test_le_gain_est_reel(pages, monkeypatch):
    """Un assemblage complet doit être franchement plus coûteux qu'un accès au cache."""
    S.render_page("index.html")
    t = time.perf_counter()
    for _ in range(200):
        S.render_page("index.html")
    avec_cache = (time.perf_counter() - t) / 200

    t = time.perf_counter()
    for _ in range(200):
        S._page_cache.clear()
        S.render_page("index.html")
    sans_cache = (time.perf_counter() - t) / 200

    assert avec_cache < sans_cache, \
        f"cache {avec_cache*1e6:.0f} µs vs assemblage {sans_cache*1e6:.0f} µs"
