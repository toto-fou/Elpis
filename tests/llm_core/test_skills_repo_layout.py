# SPDX-License-Identifier: MIT
"""Garde-fou sur le CONTENU réel du repo ``skills/`` (lecture seule).

La bibliothèque curée est versionnée : ce test verrouille la structure attendue
au modèle Agent Skill — 3 packages de domaine (``ansible``, ``python``,
``robotframework``, chacun avec 3 sous-skills et un bundle par sous-skill) +
le méta-skill « creer-un-skill ». Le package d'exemple historique ``jenkins``
a été RETIRÉ (2026-08-02, demande utilisateur : hors périmètre du produit).
Il pointe explicitement le ``skills/`` du dépôt (pas de fixture tmp) et
n'écrit RIEN.
"""
from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

import llm_core.skills as sk
from llm_core._frontmatter import split_frontmatter
from llm_core._skill_validate import validate_frontmatter

REPO_SKILLS = Path(__file__).resolve().parents[2] / "skills"

# Racines attendues, triées par (domain, id) — creer-un-skill (domaine vide)
# passe devant les packages de domaine.
EXPECTED_ROOTS = ["creer-un-skill", "ansible", "python", "robotframework"]
PACKAGES = ["ansible", "python", "robotframework"]

EXPECTED_CHILDREN = {
    "ansible/ansible-debug-runs": ["scripts/safe_run.sh"],
    "ansible/ansible-inventory-vault": ["references/inventory.example.yml"],
    "ansible/ansible-write-playbook": ["references/playbook.example.yml"],
    "python/python-debug-profile": ["scripts/profile_hotspots.sh"],
    "python/python-env-deps": ["scripts/make_venv.sh"],
    "python/python-tests-pytest": ["references/conftest.example.py"],
    "robotframework/robotframework-run-and-debug": ["scripts/run_suite.sh"],
    "robotframework/robotframework-selenium-web": ["references/selenium-patterns.robot"],
    "robotframework/robotframework-write-tests": ["references/suite.example.robot"],
}


@pytest.fixture()
def repo_specs(monkeypatch):
    monkeypatch.setattr(sk, "_global_skills_root", lambda: REPO_SKILLS)
    return sk.discover_skills_by_source("global")


def test_repo_layout_packages_plus_children(repo_specs):
    roots = [s for s in repo_specs if s.depth == 0]
    assert [s.id for s in roots] == EXPECTED_ROOTS
    meta = next(s for s in roots if s.id == "creer-un-skill")
    assert meta.is_folder and meta.description and meta.tags
    assert not [s for s in repo_specs if s.parent_id == "creer-un-skill"]
    for pkg_id in PACKAGES:
        pkg = next(s for s in roots if s.id == pkg_id)
        assert pkg.is_folder
        # Package posé à la racine du domaine : le chemin ne donne pas de
        # domaine → surcharge frontmatter obligatoire (cf. README).
        assert pkg.domain == pkg_id
        assert pkg.description
    children = {s.id: s for s in repo_specs if s.depth == 1}
    assert set(children) == set(EXPECTED_CHILDREN)
    for cid, files in EXPECTED_CHILDREN.items():
        c = children[cid]
        assert c.parent_id == cid.split("/")[0]
        assert c.is_folder
        assert c.files == files, f"{cid}: bundle inattendu {c.files}"
        assert c.description and c.tags


def test_repo_frontmatters_validate(repo_specs):
    for s in repo_specs:
        fm, _ = split_frontmatter(Path(s.path).read_text(encoding="utf-8"))
        errs = validate_frontmatter({**fm, "name": s.name}, dir_name=s.name)
        assert not errs, f"{s.id}: frontmatter non conforme : {errs}"


def test_repo_package_body_orients_to_children(repo_specs):
    # La table d'orientation de chaque package référence chaque sous-skill
    # par son id qualifié (chargé via skill_get("pkg/enfant")).
    for pkg_id in PACKAGES:
        pkg = next(s for s in repo_specs if s.id == pkg_id)
        for cid in (c for c in EXPECTED_CHILDREN if c.startswith(pkg_id + "/")):
            assert cid in pkg.body, f"le SKILL.md de {pkg_id} n'oriente pas vers {cid}"


def test_repo_children_reference_bundle_via_tools(repo_specs):
    # Le mount RO `/work/.skills` a été RETIRÉ : un corps qui y référence ses
    # fichiers envoie le modèle dans un mur (`No such file or directory`).
    # Chaque sous-skill à bundle doit passer par les outils : skill_run_script
    # pour les scripts, skill_read_file pour les références — toujours avec
    # l'id qualifié `pkg/enfant`.
    for cid in EXPECTED_CHILDREN:
        c = next(s for s in repo_specs if s.id == cid)
        assert "/work/.skills" not in c.body, \
            f"{cid}: référence le mount /work/.skills retiré"
        has_script = any(f.startswith("scripts/") for f in c.files)
        tool = "skill_run_script" if has_script else "skill_read_file"
        assert tool in c.body, f"{cid}: le corps ne référence pas {tool}"
        assert f'name="{cid}"' in c.body, \
            f"{cid}: l'appel outillé n'utilise pas l'id qualifié"


def test_repo_no_body_references_dead_mount(repo_specs):
    # Ceinture-bretelles au niveau racine : AUCUN corps (packages compris) ne
    # doit plus mentionner l'ancien chemin stagé.
    for s in repo_specs:
        assert "/work/.skills" not in s.body, f"{s.id}: chemin stagé mort"


def test_repo_shell_scripts_parse():
    scripts = sorted(REPO_SKILLS.rglob("scripts/*.sh"))
    assert len(scripts) == 4
    for s in scripts:
        proc = subprocess.run(["bash", "-n", str(s)], capture_output=True, text=True)
        assert proc.returncode == 0, f"bash -n {s.name}: {proc.stderr}"


def test_repo_no_stray_markdown_in_packages():
    # Un mono-fichier .md résiduel dans un package serait masqué par le
    # dossier-skill (« interne ») sans jamais être découvert — et le package
    # jenkins retiré ne doit pas réapparaître.
    assert not (REPO_SKILLS / "jenkins").exists(), "le package jenkins a été retiré"
    for pkg_id in PACKAGES:
        stray = [p for p in (REPO_SKILLS / pkg_id).rglob("*.md") if p.name != "SKILL.md"]
        assert stray == [], f"mono-fichiers résiduels sous {pkg_id}/ : {stray}"
