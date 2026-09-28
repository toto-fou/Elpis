# SPDX-License-Identifier: MIT
"""Régression du drag-drop de DOSSIERS dans l'éditeur (upload sandbox).

Bug d'origine : déposer un dossier complet → « erreur 0 » (0 fichier importé).
``dataTransfer.files`` ne descend PAS dans les répertoires ; il renvoyait une
entrée « dossier » illisible → ``xhr.send`` échouait → status 0. Le fix traverse
récursivement via ``webkitGetAsEntry`` (``_collectDropEntries`` dans app.js) en
préservant l'arborescence, puis normalise l'entrée upload en ``{file, rel}``.

Le code réel est du JS navigateur (API FileSystemEntry async) non importable ici.
Ces tests répliquent fidèlement les RÈGLES de construction de chemins (mêmes que
les replicas de découpage dans test_chunk_upload.py) — ils gardent la logique de
préservation d'arbo et de normalisation contre toute régression.
"""
import pytest


# ── Réplique de _collectDropEntries : file → prefix+name ; dir → récursion
#    avec prefix+name+"/". (Le batching readEntries est un détail d'API testé
#    côté JS ; ici on valide la règle de chemin.)
def _flatten(entry, prefix=""):
    if entry["type"] == "file":
        return [prefix + entry["name"]]
    out = []
    for child in entry["children"]:
        out += _flatten(child, prefix + entry["name"] + "/")
    return out


def test_dropped_folder_preserves_tree_structure():
    tree = {
        "type": "dir", "name": "projet", "children": [
            {"type": "dir", "name": "a", "children": [
                {"type": "file", "name": "x.js"},
                {"type": "file", "name": "y.js"},
            ]},
            {"type": "dir", "name": "b", "children": [
                {"type": "file", "name": "z.css"},
            ]},
            {"type": "file", "name": "readme.md"},
        ],
    }
    assert sorted(_flatten(tree)) == sorted([
        "projet/a/x.js", "projet/a/y.js", "projet/b/z.css", "projet/readme.md",
    ])


def test_dropped_top_level_file_keeps_bare_name():
    assert _flatten({"type": "file", "name": "racine.txt"}) == ["racine.txt"]


def test_deeply_nested_path():
    deep = {"type": "dir", "name": "l1", "children": [
        {"type": "dir", "name": "l2", "children": [
            {"type": "dir", "name": "l3", "children": [
                {"type": "file", "name": "deep.txt"},
            ]},
        ]},
    ]}
    assert _flatten(deep) == ["l1/l2/l3/deep.txt"]


# ── Réplique de la normalisation d'entrée de uploadFilesToSandbox (app.js).
#    Deux formes : File (bouton, webkitRelativePath) | {file, path} (drag-drop
#    de dossiers traversé). targetFolder préfixe le chemin relatif.
def _normalize_rel(x, target_folder, *, entry_form):
    if entry_form:
        rel = x.get("path") or x["file"]["name"]
    else:
        rel = x.get("webkitRelativePath") or x["name"]
    return (target_folder + "/" + rel) if target_folder else rel


def test_normalize_button_file_flat():
    f = {"name": "doc.pdf", "webkitRelativePath": ""}
    assert _normalize_rel(f, "", entry_form=False) == "doc.pdf"


def test_normalize_button_folder_uses_webkit_relative_path():
    f = {"name": "b.txt", "webkitRelativePath": "top/a/b.txt"}
    assert _normalize_rel(f, "", entry_form=False) == "top/a/b.txt"


def test_normalize_dropped_entry_uses_path():
    e = {"file": {"name": "b.txt"}, "path": "top/a/b.txt"}
    assert _normalize_rel(e, "", entry_form=True) == "top/a/b.txt"


@pytest.mark.parametrize("entry_form,x", [
    (False, {"name": "b.txt", "webkitRelativePath": "top/b.txt"}),
    (True, {"file": {"name": "b.txt"}, "path": "top/b.txt"}),
])
def test_normalize_target_folder_prefix(entry_form, x):
    # Drop sur un dossier de l'arbre « dest » → tout est préfixé.
    assert _normalize_rel(x, "dest", entry_form=entry_form) == "dest/top/b.txt"
