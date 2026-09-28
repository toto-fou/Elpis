# SPDX-License-Identifier: MIT
"""Vendor versionné par empreinte de contenu, et servi en ``immutable``.

Les bundles tiers ne changent qu'au redéploiement. Les taguer au BUILD_ID —
qui change à chaque redémarrage de gunicorn — les ferait re-télécharger pour
rien. Une empreinte (mtime, taille) ne bouge que si le fichier bouge, ce qui
rend ``Cache-Control: immutable`` correct par construction.

Les assets APPLICATIFS gardent délibérément le BUILD_ID et le ``no-cache`` :
le choix assumé est qu'un redéploiement soit visible immédiatement, et qu'une
édition de JS en dev ne reste pas collée.
"""
import json
import os
import re

import pytest

from shared_infra.routes import system as S


# ── Empreinte ───────────────────────────────────────────────────────────────

def test_l_empreinte_est_stable_a_fichier_inchange():
    a = S.vendor_fingerprint("static/vendor/marked.min.js")
    S._VENDOR_FP_CACHE.clear()
    b = S.vendor_fingerprint("static/vendor/marked.min.js")
    assert a == b and len(a) == 10


def test_l_empreinte_change_avec_le_fichier(tmp_path, monkeypatch):
    f = tmp_path / "frontend" / "vendor"
    f.mkdir(parents=True)
    lib = f / "lib.js"
    lib.write_text("a", encoding="utf-8")
    monkeypatch.chdir(tmp_path)

    S._VENDOR_FP_CACHE.clear()
    before = S.vendor_fingerprint("static/vendor/lib.js")
    lib.write_text("contenu bien plus long qu'avant", encoding="utf-8")
    S._VENDOR_FP_CACHE.clear()
    assert S.vendor_fingerprint("static/vendor/lib.js") != before


def test_fichier_absent_retombe_sur_le_build_id():
    """Mieux vaut un cache-bust inutile qu'une URL sans version.

    Une URL vendor sans ``?v=`` serait servie en ``no-cache`` (la garde côté
    serveur porte sur la présence du paramètre), donc pas de risque de version
    figée — mais on préfère quand même toujours poser une version.
    """
    from shared_infra.config import BUILD_ID
    S._VENDOR_FP_CACHE.clear()
    assert S.vendor_fingerprint("static/vendor/nexistepas.js") == BUILD_ID


# ── Réécriture du HTML ──────────────────────────────────────────────────────

def _render(html):
    S._VENDOR_FP_CACHE.clear()
    return S._apply_includes_and_cachebust(html)


def test_les_urls_vendor_recoivent_une_empreinte():
    out = _render('<head><script src="static/vendor/marked.min.js"></script></head>')
    m = re.search(r'static/vendor/marked\.min\.js\?v=([0-9a-f]{10})"', out)
    assert m, out


def test_les_feuilles_de_style_vendor_aussi():
    out = _render('<head><link rel="stylesheet" href="static/vendor/github-dark.min.css"></head>')
    assert re.search(r'static/vendor/github-dark\.min\.css\?v=[0-9a-f]{10}"', out)


def test_les_assets_applicatifs_gardent_le_build_id():
    """Le choix de l'auteur — redéploiement visible tout de suite — est préservé."""
    from shared_infra.config import BUILD_ID
    out = _render('<head><script src="static/js/app.js?v=vieux"></script></head>')
    assert f'static/js/app.js?v={BUILD_ID}' in out


def test_une_url_vendor_deja_versionnee_n_est_pas_doublee():
    out = _render('<head><script src="static/vendor/marked.min.js?v=deja"></script></head>')
    assert out.count("?v=") == 1, out


# ── Carte des bundles différés ──────────────────────────────────────────────

def test_la_carte_des_bundles_differes_est_publiee():
    out = _render("<head></head>")
    m = re.search(r'window\.__VENDOR_V__=(\{.*?\});', out)
    assert m, out
    data = json.loads(m.group(1))
    assert "vendor/mermaid.min.js" in data
    assert "vendor/monaco/vs/loader.js" in data
    assert all(v for v in data.values())


def test_la_liste_des_differes_couvre_exactement_les_groupes_du_chargeur():
    """Un bundle ajouté dans utils.js sans l'être ici partirait sans version.

    Il serait alors servi en ``no-cache`` : correct, mais on perdrait
    silencieusement le bénéfice. Le test relie les deux listes.
    """
    js = open("frontend/js/utils.js", encoding="utf-8").read()
    debut = js.index("const GROUPS = {")
    fin = js.index("const _pending", debut)
    dans_js = set(re.findall(r"'(static/vendor/[^']+)'", js[debut:fin]))
    dans_py = {"static/" + p for p in S._LAZY_VENDOR}
    assert dans_js == dans_py, (
        f"seulement dans utils.js : {dans_js - dans_py}\n"
        f"seulement dans system.py : {dans_py - dans_js}"
    )


def test_tous_les_bundles_differes_existent_sur_disque():
    manquants = [p for p in S._LAZY_VENDOR
                 if not os.path.exists(os.path.join("frontend", p))]
    assert manquants == []


# ── Politique de cache servie ───────────────────────────────────────────────

@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("APP_SESSION_SECRET", "x" * 48)
    from starlette.testclient import TestClient
    from server.app import create_app
    with TestClient(create_app()) as c:
        yield c


def test_vendor_versionne_est_immuable(client):
    fp = S.vendor_fingerprint("static/vendor/marked.min.js")
    r = client.get(f"/static/vendor/marked.min.js?v={fp}")
    assert r.status_code == 200
    assert "immutable" in r.headers["cache-control"]
    assert "max-age=31536000" in r.headers["cache-control"]


def test_vendor_sans_version_reste_prudent(client):
    """Le chargeur AMD de monaco demande ses morceaux sans ``?v=``."""
    r = client.get("/static/vendor/marked.min.js")
    assert r.status_code == 200
    assert r.headers["cache-control"] == "no-cache, must-revalidate"


def test_un_asset_applicatif_n_est_jamais_immuable(client):
    """Même versionné : son ?v= est le BUILD_ID, pas une empreinte de contenu."""
    r = client.get("/static/js/utils.js?v=peu-importe")
    assert r.status_code == 200
    assert "immutable" not in r.headers["cache-control"]
    assert r.headers["cache-control"] == "no-cache, must-revalidate"


def test_une_image_garde_son_cache_par_defaut(client):
    r = client.get("/static/favicon.ico")
    if r.status_code == 200:
        assert "no-cache, must-revalidate" not in r.headers.get("cache-control", "")
