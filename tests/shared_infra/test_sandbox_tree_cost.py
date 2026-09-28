# SPDX-License-Identifier: MIT
"""``_build_file_tree`` : même arbre, sans le coût par entrée.

C'est la route la plus appelée du panneau éditeur (``GET /api/sandbox/tree``)
et elle est SYNCHRONE : ce qu'elle consomme, elle le prend au GIL de son worker,
donc à tous les autres utilisateurs servis par ce worker. Sous 60 utilisateurs,
elle passait de 43 ms à 934 ms et entraînait tout le reste avec elle.

Deux dépenses par entrée ont été supprimées :

- ``entry.resolve()`` → ``realpath()`` → **9 ``lstat`` par entrée** ;
- ``Path.relative_to().as_posix()`` → **60 % du temps total** à lui seul.

Sur un arbre de 520 entrées : 43,5 ms → 3,4 ms, sortie identique octet pour
octet.

Ces tests verrouillent les DEUX choses qui pourraient se perdre : le résultat,
et les garanties de sécurité (audit F6) qui justifiaient le ``resolve()`` par
entrée — on ne les a pas abandonnées, on les a démontrées par récurrence :
la racine est résolue une fois, chaque entrée retenue n'est pas un lien
symbolique, et un nom de dirent ne contient pas de séparateur.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from shared_infra.routes import _helpers as H  # noqa: E402


@pytest.fixture()
def arbre(tmp_path):
    """Un arbre volontairement biscornu : profondeur, accents, dotfiles,
    fichiers vides, gros fichier, dossier vide."""
    (tmp_path / "a" / "b" / "c").mkdir(parents=True)
    (tmp_path / "vide").mkdir()
    (tmp_path / ".cache").mkdir()
    (tmp_path / ".cache" / "dedans.txt").write_text("x", encoding="utf-8")
    (tmp_path / "Zebre.txt").write_text("z", encoding="utf-8")
    (tmp_path / "alpha.txt").write_text("", encoding="utf-8")
    (tmp_path / "éàü.md").write_text("accents", encoding="utf-8")
    (tmp_path / "a" / "fichier.py").write_text("print(1)\n", encoding="utf-8")
    (tmp_path / "a" / "b" / "c" / "profond.txt").write_text("y" * 100, encoding="utf-8")
    (tmp_path / ".secret").write_text("s", encoding="utf-8")
    return tmp_path


# ── Référence : l'implémentation d'AVANT, recopiée telle quelle ─────────────

def _implementation_precedente(path, relative_root, include_hidden=False,
                               _root_res=None, _depth=0, _budget=None):
    items = []
    if _budget is None:
        _budget = {"left": H.TREE_MAX_ENTRIES, "truncated": False}
    if _depth > 40:
        return items
    if _root_res is None:
        try:
            _root_res = relative_root.resolve()
        except OSError:
            return items
    try:
        entries = sorted(os.scandir(path),
                         key=lambda e: (not e.is_dir(follow_symlinks=False), e.name.lower()))
    except OSError:
        return items
    for entry in entries:
        try:
            if _budget["left"] <= 0:
                _budget["truncated"] = True
                break
            if not include_hidden and entry.name.startswith("."):
                continue
            if entry.is_symlink():
                continue
            entry_path = Path(entry.path)
            try:
                rel_path = entry_path.relative_to(relative_root).as_posix()
            except ValueError:
                continue
            if not H._path_inside(entry_path.resolve(), _root_res):
                continue
            is_dir = entry.is_dir(follow_symlinks=False)
            _budget["left"] -= 1
            item = {"name": entry.name, "path": rel_path,
                    "type": "folder" if is_dir else "file"}
            if is_dir:
                item["children"] = _implementation_precedente(
                    entry_path, relative_root, include_hidden, _root_res,
                    _depth + 1, _budget)
            else:
                item["size"] = entry.stat().st_size
            items.append(item)
        except OSError:
            continue
    return items


# ── Équivalence ─────────────────────────────────────────────────────────────

@pytest.mark.parametrize("caches", [False, True])
def test_arbre_identique_a_l_implementation_precedente(arbre, caches):
    assert (H._build_file_tree(arbre, arbre, include_hidden=caches)
            == _implementation_precedente(arbre, arbre, include_hidden=caches))


def test_les_chemins_relatifs_sont_bien_formes(arbre):
    chemins = set()

    def collecter(items):
        for it in items:
            chemins.add(it["path"])
            collecter(it.get("children", []))

    collecter(H._build_file_tree(arbre, arbre))
    assert "a/b/c/profond.txt" in chemins
    assert "éàü.md" in chemins
    assert not any(c.startswith("/") for c in chemins), "chemins RELATIFS attendus"


def test_les_tailles_sont_justes(arbre):
    items = {i["name"]: i for i in H._build_file_tree(arbre, arbre)}
    assert items["alpha.txt"]["size"] == 0
    assert items["Zebre.txt"]["size"] == 1


def test_l_ordre_est_preserve(arbre):
    """Dossiers d'abord, puis tri par nom INSENSIBLE à la casse — sinon
    ``Zebre.txt`` passerait avant ``alpha.txt`` (majuscules d'abord en ASCII)."""
    items = H._build_file_tree(arbre, arbre)
    types = [i["type"] for i in items]
    assert types == sorted(types, key=lambda t: t != "folder")
    fichiers = [i["name"] for i in items if i["type"] == "file"]
    assert fichiers == sorted(fichiers, key=str.lower)
    assert fichiers.index("alpha.txt") < fichiers.index("Zebre.txt")


# ── Sécurité (audit F6) — ce que le resolve() par entrée protégeait ─────────

def test_un_lien_vers_une_autre_sandbox_n_est_pas_liste(tmp_path):
    victime = tmp_path / "victime" / "work"
    victime.mkdir(parents=True)
    (victime / "prive.txt").write_text("secret", encoding="utf-8")
    moi = tmp_path / "moi" / "work"
    moi.mkdir(parents=True)
    (moi / "a_moi.txt").write_text("ok", encoding="utf-8")
    os.symlink(victime, moi / "evasion")

    noms = {i["name"] for i in H._build_file_tree(moi, moi)}
    assert noms == {"a_moi.txt"}, f"lien symbolique suivi : {noms}"


def test_une_boucle_symbolique_ne_fait_pas_exploser(tmp_path):
    (tmp_path / "reel").mkdir()
    os.symlink(tmp_path, tmp_path / "boucle")
    items = H._build_file_tree(tmp_path, tmp_path)          # ne doit pas lever
    assert {i["name"] for i in items} == {"reel"}


def test_un_ancetre_symbolique_reste_contenu(tmp_path):
    """Le cas précis que le ``resolve()`` par entrée couvrait : la RACINE
    passée est atteinte via un lien symbolique. La racine, elle, est toujours
    résolue une fois — c'est de là que part la récurrence."""
    vrai = tmp_path / "vrai"
    (vrai / "sous").mkdir(parents=True)
    (vrai / "sous" / "f.txt").write_text("v", encoding="utf-8")
    via_lien = tmp_path / "via_lien"
    os.symlink(vrai, via_lien)

    items = H._build_file_tree(via_lien, via_lien)
    assert [i["name"] for i in items] == ["sous"]
    assert items[0]["children"][0]["path"] == "sous/f.txt"


def test_un_lien_dans_un_sous_dossier_est_ignore_aussi(tmp_path):
    dehors = tmp_path / "dehors"
    dehors.mkdir()
    (dehors / "vol.txt").write_text("x", encoding="utf-8")
    racine = tmp_path / "racine"
    (racine / "sous").mkdir(parents=True)
    os.symlink(dehors, racine / "sous" / "echappe")
    (racine / "sous" / "legitime.txt").write_text("y", encoding="utf-8")

    items = H._build_file_tree(racine, racine)
    enfants = {i["name"] for i in items[0]["children"]}
    assert enfants == {"legitime.txt"}


# ── Plafond d'entrées ───────────────────────────────────────────────────────

def test_le_plafond_est_toujours_respecte_et_signale(tmp_path):
    for i in range(30):
        (tmp_path / f"f{i:02d}.txt").write_text("x", encoding="utf-8")
    budget = {"left": 10, "truncated": False}
    items = H._build_file_tree(tmp_path, tmp_path, _budget=budget)
    assert len(items) == 10 and budget["truncated"] is True


# ── Le coût, qui est l'objet du correctif ───────────────────────────────────

def test_aucune_resolution_de_chemin_par_entree(arbre, monkeypatch):
    """Verrou anti-retour : ``Path.resolve`` déclenche un ``realpath()``, soit
    une poignée de ``lstat`` par appel. Sur un arbre de 20 000 entrées (le
    plafond), un appel par entrée se compte en centaines de milliers de
    syscalls — et ce, pendant que le worker tient son GIL."""
    compte = {"n": 0}
    vrai_resolve = Path.resolve

    def compter(self, *a, **k):
        compte["n"] += 1
        return vrai_resolve(self, *a, **k)

    monkeypatch.setattr(Path, "resolve", compter)
    items = H._build_file_tree(arbre, arbre)
    assert items, "l'arbre ne doit pas être vide"
    assert compte["n"] <= 1, (
        f"{compte['n']} résolutions de chemin : le coût par entrée est revenu")


def test_le_travail_reste_proportionnel_au_nombre_d_entrees(tmp_path):
    """Garde-fou de complexité : doubler la profondeur ne doit pas multiplier
    le nombre d'appels système. On compte les ``scandir`` — un par dossier,
    jamais plus."""
    profond = tmp_path
    for i in range(12):
        profond = profond / f"n{i}"
    profond.mkdir(parents=True)
    (profond / "f.txt").write_text("x", encoding="utf-8")

    compte = {"n": 0}
    vrai_scandir = os.scandir

    def compter(p):
        compte["n"] += 1
        return vrai_scandir(p)

    import shared_infra.routes._helpers as mod
    original = mod.os.scandir
    mod.os.scandir = compter
    try:
        H._build_file_tree(tmp_path, tmp_path)
    finally:
        mod.os.scandir = original
    assert compte["n"] == 13, f"{compte['n']} scandir pour 13 dossiers"
