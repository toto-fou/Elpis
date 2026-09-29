# SPDX-License-Identifier: MIT
"""``/api/sandbox/git/tree`` et ``/api/sandbox/git/repos`` — confinement et
robustesse face aux symlinks posés depuis le terminal sandbox.

Audit 2026-08-08. Ces deux routes étaient les JUMELLES NON DURCIES de
``_helpers._build_file_tree`` (correctif F6) : elles utilisaient
``entry.is_dir()`` / ``entry.stat()`` / ``Path.exists()``, qui DÉRÉFÉRENCENT
les liens. Trois défauts mesurés, tous reproduits ci-dessous :

  1. ``ln -s /un/dossier/hote x`` → ``/git/tree`` listait l'arborescence HÔTE
     (noms + tailles) hors sandbox, et ``/git/repos`` exécutait ``_git_run``
     dans un dépôt hors sandbox.
  2. ``ln -s . loop``  → OSError ELOOP non attrapée (seul ``PermissionError``
     l'était) → HTTP 500 sur ``/git/tree``.
  3. ``ln -s /root x`` → ``Path.exists()`` n'avale que ENOENT/ENOTDIR/EBADF/
     ELOOP, donc EACCES REMONTAIT → HTTP 500 DÉFINITIF sur ``/git/repos``,
     route appelée à chaque ouverture de l'éditeur (panneau Git mort).

Depuis L4.4, l'agent de la sandbox liste (en ``lstat``, sous /work) et git y
tourne : ces garanties tiennent sans contrôle côté hôte.
"""
import os

import pytest

import shared_infra.sandbox.routes_git as gitmod


class _Req:
    """Requête minimale : les routes ne lisent que ``query_params``."""

    def __init__(self, **qp):
        self.query_params = qp


@pytest.fixture
def work(tmp_path, monkeypatch):
    """Racine de travail (``P/work``) branchée sur les routes, servie par
    l'agent en thread."""
    from tests.conftest import editeur_sur_agent
    w = tmp_path / "sb" / "u" / "work"
    w.mkdir(parents=True)
    editeur_sur_agent(monkeypatch, w)
    monkeypatch.setattr(gitmod, "require_user_id", lambda request: 7)
    monkeypatch.setattr(gitmod, "_get_work_path", lambda uid: w)
    return w


def _mk_repo(parent, name):
    repo = parent / name
    (repo / ".git").mkdir(parents=True)
    return repo


# ── /git/tree ────────────────────────────────────────────────────────────

async def test_tree_ne_liste_pas_a_travers_un_symlink_sortant(work, tmp_path):
    """Le lien vers un dossier HÔTE ne doit produire AUCUNE entrée."""
    outside = tmp_path / "host_secrets"
    (outside / "sub").mkdir(parents=True)
    (outside / "credentials.txt").write_text("TOKEN=abc")

    repo = _mk_repo(work, "proj")
    (repo / "reel.py").write_text("ok")
    os.symlink(str(outside), repo / "fuite")

    items = (await gitmod.api_git_tree(_Req(repo="proj")))["items"]
    assert [i["name"] for i in items] == ["reel.py"]
    # Aucune trace du contenu hôte, à aucune profondeur.
    assert "credentials.txt" not in repr(items)


async def test_tree_survit_a_une_boucle_de_symlink(work):
    """``ln -s . loop`` levait OSError ELOOP → 500. Doit être ignoré."""
    repo = _mk_repo(work, "proj")
    (repo / "a.txt").write_text("x")
    os.symlink(".", repo / "loop")

    items = (await gitmod.api_git_tree(_Req(repo="proj")))["items"]
    assert [i["name"] for i in items] == ["a.txt"]


async def test_tree_survit_a_un_lien_mort(work):
    """``ln -s /cible/morte x`` levait FileNotFoundError sur stat() → 500."""
    repo = _mk_repo(work, "proj")
    (repo / "a.txt").write_text("x")
    os.symlink("/nexiste/pas", repo / "dangling")

    items = (await gitmod.api_git_tree(_Req(repo="proj")))["items"]
    assert [i["name"] for i in items] == ["a.txt"]


async def test_tree_liste_toujours_l_arbre_legitime(work):
    """Non-régression : le durcissement ne doit rien masquer de légitime."""
    repo = _mk_repo(work, "proj")
    (repo / "src").mkdir()
    (repo / "src" / "main.py").write_text("print(1)")
    (repo / "README.md").write_text("# hi")

    items = (await gitmod.api_git_tree(_Req(repo="proj")))["items"]
    par_nom = {i["name"]: i for i in items}
    assert set(par_nom) == {"src", "README.md"}
    assert par_nom["src"]["type"] == "folder"
    assert [c["name"] for c in par_nom["src"]["children"]] == ["main.py"]
    assert par_nom["README.md"]["size"] == len("# hi")


async def test_tree_borne_la_profondeur(work, monkeypatch):
    """Garde-fou de profondeur, même si un lien échappait au filtre."""
    monkeypatch.setattr(gitmod, "_TREE_MAX_DEPTH", 3)
    repo = _mk_repo(work, "proj")
    deep = repo
    for i in range(8):
        deep = deep / f"n{i}"
    deep.mkdir(parents=True)

    items = (await gitmod.api_git_tree(_Req(repo="proj")))["items"]

    def profondeur(nodes, d=1):
        enfants = [c for n in nodes for c in n.get("children", [])]
        return profondeur(enfants, d + 1) if enfants else d

    assert profondeur(items) <= gitmod._TREE_MAX_DEPTH + 1


# ── /git/repos ───────────────────────────────────────────────────────────

async def test_repos_ne_plante_pas_sur_un_lien_illisible(work):
    """``ln -s /root x`` faisait remonter EACCES → 500 définitif."""
    _mk_repo(work, "projet")
    os.symlink("/root", work / "x")

    out = await gitmod.api_git_repos(_Req())
    assert [r["path"] for r in out["repos"]] == ["projet"]


async def test_repos_n_execute_pas_git_hors_sandbox(work, tmp_path, monkeypatch):
    """Un lien vers un dépôt HÔTE n'est ni listé ni un dossier où git tourne."""
    from shared_infra.sandbox import agent_client as AC
    outside = _mk_repo(tmp_path, "depot_hote")
    os.symlink(str(outside), work / "innocent")

    cwds = []
    vrai = AC.AgentClient.git

    async def espion(self, cwd, *a, **k):
        cwds.append(cwd)
        return await vrai(self, cwd, *a, **k)
    monkeypatch.setattr(AC.AgentClient, "git", espion)

    out = await gitmod.api_git_repos(_Req())
    assert out["repos"] == []
    assert cwds == [], f"git a tourné hors sandbox : {cwds}"


async def test_repos_trouve_toujours_les_depots_reels(work):
    """Non-régression : racine, niveau 1 et niveau 2 restent détectés."""
    (work / ".git").mkdir()
    _mk_repo(work, "niveau1")
    _mk_repo(work / "conteneur", "niveau2")
    _mk_repo(work / ".cache", "cache")                   # dossier caché : non listé

    paths = {r["path"] for r in (await gitmod.api_git_repos(_Req()))["repos"]}
    assert paths == {".", "niveau1", os.path.join("conteneur", "niveau2")}
