# SPDX-License-Identifier: MIT
"""Vue admin : périmètre du quota + coût. Et bornage de l'arbre de fichiers.

Audit 2026-08-08.

1. PÉRIMÈTRE — ``/api/admin/users-with-groups`` mesurait ``_get_sandbox_path``
   (= ``P``), qui contient EN PLUS ``skills/``, ``memory/`` et ``.ocr/``, alors
   que le quota affiché juste à côté est appliqué sur ``P/work``. L'admin
   comparait donc un chiffre à un plafond d'un autre périmètre et pouvait voir
   « au-dessus du quota » un utilisateur qui ne l'était pas.

2. COÛT — un ``du -sb`` synchrone PAR UTILISATEUR dans la boucle : route en
   O(N × taille sandbox). 127 ms mesurés pour 18 sandboxes quasi vides,
   ~15 s extrapolées pour 50 utilisateurs avec un ``node_modules``.

3. ARBRE — ``_build_file_tree`` sérialisait l'arbre ENTIER à chaque ouverture
   de l'éditeur et après chaque opération de fichier. Une sandbox avec
   ``node_modules`` produisait un JSON de plusieurs Mo qui figeait
   l'explorateur côté navigateur.
"""
import inspect

import shared_infra.routes.admin.users as AU
from shared_infra.routes import _helpers as H

# ── Vue admin ────────────────────────────────────────────────────────────

def test_admin_mesure_la_meme_racine_que_l_enforcement():
    src = inspect.getsource(AU.api_users_with_groups)
    code = "\n".join(l for l in src.splitlines() if not l.lstrip().startswith("#"))
    assert "_get_work_path(" in code, \
        "l'admin mesure une racine différente de celle sur laquelle le quota " \
        "est appliqué → chiffres incomparables"
    assert "_get_sandbox_path(" not in code


def test_admin_passe_par_le_compteur_en_cache():
    src = inspect.getsource(AU.api_users_with_groups)
    code = "\n".join(l for l in src.splitlines() if not l.lstrip().startswith("#"))
    assert "sandbox_usage_bytes(" in code, \
        "un du -sb synchrone par utilisateur : route en O(N × arbre)"
    assert "_sandbox_size_bytes(" not in code


def test_admin_et_jauge_utilisateur_partagent_l_entree_de_cache(monkeypatch, tmp_path):
    """Conséquence utile du correctif de périmètre : les deux vues mesurent la
    MÊME racine, donc un utilisateur actif a déjà réchauffé l'entrée que lit
    l'admin — la liste devient quasi gratuite."""
    H.reset_sandbox_usage_cache()
    work = tmp_path / "work"
    work.mkdir()
    calls = []
    monkeypatch.setattr(H, "_sandbox_size_bytes", lambda r: calls.append(str(r)) or 4096)
    H.sandbox_usage_bytes(7, work)          # jauge de l'utilisateur
    H.sandbox_usage_bytes(7, work)          # liste admin, même racine
    assert len(calls) == 1
    H.reset_sandbox_usage_cache()


# ── Bornage de l'arbre ───────────────────────────────────────────────────

def _mk_tree(root, n_dirs, per_dir):
    for d in range(n_dirs):
        sub = root / f"d{d:03d}"
        sub.mkdir()
        for f in range(per_dir):
            (sub / f"f{f:03d}.txt").write_text("x")


def _count(nodes):
    return sum(1 + _count(n.get("children", [])) for n in nodes)


def _arbre(tmp_path, monkeypatch, n_dirs, per_dir, cap=None):
    import shared_infra.sandbox.routes_files as SF
    from tests.conftest import arbre_editeur
    root = tmp_path / "w"
    root.mkdir()
    _mk_tree(root, n_dirs, per_dir)
    if cap is not None:
        monkeypatch.setattr(SF, "TREE_MAX_ENTRIES", cap)
    return arbre_editeur(monkeypatch, root)


def test_arbre_borne_et_troncature_signalee(tmp_path, monkeypatch):
    rep = _arbre(tmp_path, monkeypatch, 10, 10, cap=25)     # 10 dossiers + 100 fichiers
    total = _count(rep["items"])
    assert total <= 25, f"{total} entrées remontées malgré un plafond de 25"
    assert rep["truncated"] is True, "troncature SILENCIEUSE"
    assert rep["max_entries"] == 25


def test_petit_arbre_non_tronque(tmp_path, monkeypatch):
    rep = _arbre(tmp_path, monkeypatch, 2, 3)                # 2 + 6 = 8 entrées
    assert _count(rep["items"]) == 8
    assert rep["truncated"] is False


def test_plafond_sur_le_total(tmp_path, monkeypatch):
    """Le plafond porte sur le TOTAL, pas par dossier : sinon un arbre large
    mais peu profond passait entre les mailles."""
    rep = _arbre(tmp_path, monkeypatch, 5, 20, cap=12)       # 5 + 100 = 105
    assert _count(rep["items"]) <= 12
    assert rep["truncated"] is True


def test_le_front_affiche_la_troncature():
    from pathlib import Path
    front = Path(__file__).resolve().parents[2] / "frontend"
    js = (front / "js" / "editor" / "_sandbox_fs.js").read_text(encoding="utf-8")
    assert "treeTruncated" in js and "data.truncated" in js
    html = (front / "includes" / "main" / "editor.html").read_text(encoding="utf-8")
    assert 'v-if="treeTruncated"' in html, \
        "l'arbre est tronqué sans que l'utilisateur en soit informé"


# ── Import mort ──────────────────────────────────────────────────────────

def test_pas_d_import_mort_de_count_user_sessions():
    import shared_infra.terminal.routes as T
    src = inspect.getsource(T)
    ligne = [l for l in src.splitlines() if "from shared_infra.terminal.pty import" in l]
    assert ligne and "_count_user_sessions" not in ligne[0], \
        "import mort : remplacé par _next_default_session_name"
