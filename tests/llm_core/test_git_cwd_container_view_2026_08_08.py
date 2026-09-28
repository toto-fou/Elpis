# SPDX-License-Identifier: MIT
"""``git_*`` rendait des chemins HÔTE dans ``cwd`` (mission 2026-08-08).

Le modèle raisonne dans l'espace de chemins du CONTENEUR : son shell tourne
dans ``/work``, ``fs_tools`` rend ``/work/...``, ``shell_tools`` rend
``cwd: "/work"``. Seuls les outils git — qui s'exécutent côté hôte —
renvoyaient ``cwd: "/srv/elpis/user_sandboxes/<user>/work/<repo>"`` sur CHAQUE
``git_query``/``git_action``. Un chemin qu'aucun autre outil n'accepte, et la
topologie de l'hôte exposée à chaque appel.

Le schéma déclaré (``GitQueryResult.cwd``) promettait déjà « container
path » : c'est le code qui mentait.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from llm_core.tools import git_tools as gt


@pytest.fixture(autouse=True)
def _clean_roots():
    gt._WORK_ROOTS.clear()
    yield
    gt._WORK_ROOTS.clear()


# ── mapping racine connue → vue conteneur ────────────────────────────────

def test_racine_connue_donne_work():
    gt._remember_work_root("/srv/sandboxes/alice/work")
    assert gt._container_cwd("/srv/sandboxes/alice/work") == "/work"


def test_sous_dossier_dune_racine_connue():
    gt._remember_work_root("/srv/sandboxes/alice/work")
    assert gt._container_cwd("/srv/sandboxes/alice/work/proj") == "/work/proj"
    assert gt._container_cwd("/srv/sandboxes/alice/work/a/b") == "/work/a/b"


def test_prefixe_frere_nest_pas_confondu():
    """``alice2`` ne doit pas être vu comme un sous-chemin d'``alice``."""
    gt._remember_work_root("/srv/sb/alice/work")
    gt._remember_work_root("/srv/sb/alice2/work")
    assert gt._container_cwd("/srv/sb/alice2/work/p") == "/work/p"


def test_racine_la_plus_longue_gagne():
    gt._remember_work_root("/srv/sb/a/work")
    gt._remember_work_root("/srv/sb/a/work/nested/work")
    assert gt._container_cwd("/srv/sb/a/work/nested/work/x") == "/work/x"


def test_repli_sans_racine_enregistree():
    """Appel direct de ``_run_cmd`` (tests unitaires) : on coupe au premier
    segment ``work``, jamais on ne rend le chemin hôte."""
    assert gt._container_cwd("/tmp/pytest-42/work/proj") == "/work/proj"


def test_jamais_de_chemin_hote_meme_sans_segment_work():
    out = gt._container_cwd("/etc/somewhere/else")
    assert out == "/work"
    assert "/etc" not in out


@pytest.mark.parametrize("host", [
    "/srv/elpis/user_sandboxes/admin/work",
    "/srv/elpis/user_sandboxes/admin/work/pr_mission",
    "/tmp/x/work/repo",
    "/nowhere",
])
def test_la_sortie_est_toujours_dans_lespace_conteneur(host):
    out = gt._container_cwd(host)
    assert out == "/work" or out.startswith("/work/")
    assert "user_sandboxes" not in out


# ── bout en bout : _run_cmd ne publie plus le chemin hôte ────────────────

def test_run_cmd_rend_un_cwd_conteneur(tmp_path):
    work = tmp_path / "sbx" / "alice" / "work"
    repo = work / "proj"
    repo.mkdir(parents=True)
    gt._remember_work_root(work)

    r = gt._run_cmd(repo, ["git", "--version"], timeout=10)
    assert r["ok"] is True
    assert r["cwd"] == "/work/proj", r["cwd"]
    assert str(tmp_path) not in r["cwd"]


def test_run_cmd_en_timeout_ne_publie_pas_de_cwd(tmp_path, monkeypatch):
    """La branche timeout ne renvoie pas de ``cwd`` : rien à fuiter."""
    import subprocess

    work = tmp_path / "work"
    work.mkdir()
    gt._remember_work_root(work)

    def boom(*a, **kw):
        raise subprocess.TimeoutExpired(cmd="git", timeout=1)

    monkeypatch.setattr(subprocess, "run", boom)
    # Le garde-fou de config (2026-09-21) lit la config par subprocess lui
    # aussi : neutralisé ici, c'est le timeout de la commande qui est testé.
    import shared_infra.sandbox.git_env as _ge
    monkeypatch.setattr(_ge, "unsafe_repo_config", lambda *a, **k: None)
    r = gt._run_cmd(work, ["git", "status"], timeout=1)
    assert r["ok"] is False and r["error"] == "timeout"
    assert str(tmp_path) not in repr(r)


# ── borne mémoire du registre ────────────────────────────────────────────

def test_le_registre_de_racines_est_borne():
    for i in range(gt._WORK_ROOTS_MAX + 5):
        gt._remember_work_root(f"/srv/sb/u{i}/work")
    assert len(gt._WORK_ROOTS) <= gt._WORK_ROOTS_MAX


def test_le_registre_reste_utilisable_apres_purge():
    for i in range(gt._WORK_ROOTS_MAX + 1):
        gt._remember_work_root(f"/srv/sb/u{i}/work")
    gt._remember_work_root("/srv/sb/fresh/work")
    assert gt._container_cwd("/srv/sb/fresh/work/p") == "/work/p"
