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
    gt._remember_work_root("/srv/sandboxes/alice/work", "alice")
    assert gt._container_cwd("/srv/sandboxes/alice/work") == "/work"


def test_sous_dossier_dune_racine_connue():
    gt._remember_work_root("/srv/sandboxes/alice/work", "alice")
    assert gt._container_cwd("/srv/sandboxes/alice/work/proj") == "/work/proj"
    assert gt._container_cwd("/srv/sandboxes/alice/work/a/b") == "/work/a/b"


def test_prefixe_frere_nest_pas_confondu():
    """``alice2`` ne doit pas être vu comme un sous-chemin d'``alice``."""
    gt._remember_work_root("/srv/sb/alice/work", "alice")
    gt._remember_work_root("/srv/sb/alice2/work", "alice")
    assert gt._container_cwd("/srv/sb/alice2/work/p") == "/work/p"


def test_racine_la_plus_longue_gagne():
    gt._remember_work_root("/srv/sb/a/work", "alice")
    gt._remember_work_root("/srv/sb/a/work/nested/work", "alice")
    assert gt._container_cwd("/srv/sb/a/work/nested/work/x") == "/work/x"


def test_sans_racine_enregistree():
    """Racine inconnue : la racine du conteneur, jamais le chemin hôte ; et
    aucune commande (pas d'agent à qui la demander)."""
    assert gt._container_cwd("/tmp/pytest-42/work/proj") == "/work"
    with pytest.raises(ValueError, match="sandbox root unknown"):
        gt._run_cmd("/tmp/pytest-42/work/proj", ["git", "status"])


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
    gt._remember_work_root(work, "alice")         # l'agent (en thread) sert cette racine

    r = gt._run_cmd(repo, ["git", "--version"], timeout=10)
    assert r["ok"] is True
    assert r["cwd"] == "/work/proj", r["cwd"]
    assert str(tmp_path) not in r["cwd"]


def test_run_cmd_en_timeout_ne_publie_pas_de_cwd(tmp_path):
    """La branche timeout ne renvoie pas de ``cwd`` : rien à fuiter."""
    work = tmp_path / "sbx" / "alice" / "work"
    work.mkdir(parents=True)
    gt._remember_work_root(work, "alice")
    r = gt._run_cmd(work, ["git", "-c", "alias.dort=!sleep 5", "dort"], timeout=1)
    assert r["ok"] is False and r["error"] == "timeout"
    assert str(tmp_path) not in repr(r)


# ── borne mémoire du registre ────────────────────────────────────────────

def test_le_registre_de_racines_est_borne():
    for i in range(gt._WORK_ROOTS_MAX + 5):
        gt._remember_work_root(f"/srv/sb/u{i}/work", "alice")
    assert len(gt._WORK_ROOTS) <= gt._WORK_ROOTS_MAX


def test_le_registre_reste_utilisable_apres_purge():
    for i in range(gt._WORK_ROOTS_MAX + 1):
        gt._remember_work_root(f"/srv/sb/u{i}/work", "alice")
    gt._remember_work_root("/srv/sb/fresh/work", "alice")
    assert gt._container_cwd("/srv/sb/fresh/work/p") == "/work/p"


def test_registre_des_racines_sous_appels_paralleles():
    """(Relecture L4.4, 2026-09-30) Appels d'outils git parallèles (fils de
    FastMCP) : lecture et écriture du registre sous verrou, jamais
    « dictionary keys changed during iteration »."""
    import threading
    gt._WORK_ROOTS.clear()
    erreurs: list = []
    fin = threading.Event()

    def ecrire(i):
        n = 0
        while not fin.is_set():
            gt._remember_work_root(f"/sb/u{i}-{n % 700}/work", f"u{i}")
            n += 1

    def lire():
        while not fin.is_set():
            try:
                gt._root_of("/sb/u0-1/work/depot")
            except Exception as e:                       # noqa: BLE001
                erreurs.append(e)
                return
    fils = [threading.Thread(target=ecrire, args=(i,)) for i in range(3)]
    fils += [threading.Thread(target=lire) for _ in range(3)]
    for f in fils:
        f.start()
    threading.Event().wait(0.5)
    fin.set()
    for f in fils:
        f.join()
    gt._WORK_ROOTS.clear()
    assert erreurs == []
