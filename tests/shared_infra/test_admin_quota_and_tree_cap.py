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

from shared_infra.routes import _helpers as H
import shared_infra.routes.admin.users as AU


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


def test_arbre_borne_et_troncature_signalee(tmp_path, monkeypatch):
    monkeypatch.setattr(H, "TREE_MAX_ENTRIES", 25)
    _mk_tree(tmp_path, 10, 10)              # 10 dossiers + 100 fichiers = 110
    budget = {"left": 25, "truncated": False}
    items = H._build_file_tree(tmp_path, tmp_path, _budget=budget)

    def _count(nodes):
        return sum(1 + _count(n.get("children", [])) for n in nodes)

    total = _count(items)
    assert total <= 25, f"{total} entrées remontées malgré un plafond de 25"
    assert budget["truncated"] is True, "troncature SILENCIEUSE"


def test_petit_arbre_non_tronque(tmp_path):
    _mk_tree(tmp_path, 2, 3)                # 2 + 6 = 8 entrées
    budget = {"left": H.TREE_MAX_ENTRIES, "truncated": False}
    items = H._build_file_tree(tmp_path, tmp_path, _budget=budget)

    def _count(nodes):
        return sum(1 + _count(n.get("children", [])) for n in nodes)

    assert _count(items) == 8
    assert budget["truncated"] is False


def test_budget_partage_par_toute_la_recursion(tmp_path, monkeypatch):
    """Le plafond porte sur le TOTAL, pas par dossier : sinon un arbre large
    mais peu profond passait entre les mailles."""
    monkeypatch.setattr(H, "TREE_MAX_ENTRIES", 12)
    _mk_tree(tmp_path, 5, 20)               # 5 + 100 = 105
    budget = {"left": 12, "truncated": False}
    items = H._build_file_tree(tmp_path, tmp_path, _budget=budget)

    def _count(nodes):
        return sum(1 + _count(n.get("children", [])) for n in nodes)

    assert _count(items) <= 12
    assert budget["truncated"] is True


def test_appel_sans_budget_reste_compatible(tmp_path):
    """Les appelants existants (aucun ``_budget``) doivent continuer à
    marcher : le budget se crée tout seul au plafond par défaut."""
    _mk_tree(tmp_path, 1, 2)
    items = H._build_file_tree(tmp_path, tmp_path)
    assert len(items) == 1 and len(items[0]["children"]) == 2


def test_la_route_tree_expose_la_troncature():
    import shared_infra.sandbox.routes_files as SF
    src = inspect.getsource(SF.api_get_sandbox_tree)
    assert '"truncated"' in src and "max_entries" in src


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
