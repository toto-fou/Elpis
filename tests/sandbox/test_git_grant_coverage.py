# SPDX-License-Identifier: MIT
"""Réalignement des droits hôte↔conteneur après CHAQUE op git qui réécrit
l'arbre de travail.

Audit 2026-08-08. Le module pose l'invariant lui-même (``_grant_after_git``) :
le git tourne côté HÔTE (UID de l'app), donc tout ce qu'il réécrit sort en
``mcp:mcp 0664`` (fichiers) / ``0775`` (dossiers neufs) — or l'hôte et le
conteneur (UID 10001) ne partagent AUCUN groupe, donc 10001 tombe dans
« other » : ``r--`` sur les fichiers, ``r-x`` sur les dossiers → le shell
in-container ne peut plus ni éditer, ni créer, ni supprimer.

7 routes appelaient bien le helper ; **4 l'oubliaient** alors qu'elles
réécrivent tout autant l'arbre : rebase, stash, restore-commit, revert-last.
L'ACL ``default`` posée par init/clone ne couvre PAS le cas d'un dépôt cloné
depuis le TERMINAL (aucune ACL) — c'est là que le trou mordait.

Le grant doit aussi tourner sur ÉCHEC : un rebase ou un stash pop qui s'arrête
sur conflit a déjà posé les fichiers à résoudre, qui doivent rester éditables
(même contrat que la route ``merge``, qui grante déjà dans sa branche conflit).
"""
import pytest

import shared_infra.sandbox.routes_git as gitmod


class _R:
    """CompletedProcess minimal."""

    def __init__(self, returncode=0, stdout="", stderr=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


class _Req:
    def __init__(self, body):
        self._body = body

    async def json(self):
        return self._body


@pytest.fixture
def env(tmp_path, monkeypatch):
    """Racine de travail + dépôt + espions sur ``_git_run`` / ``_grant_after_git``."""
    work = tmp_path / "work"
    (work / "proj" / ".git").mkdir(parents=True)

    grants = []
    runs = []
    responses = {}          # 1er token de la commande → _R

    async def _fake_grant(uid, sb, repo):
        grants.append((uid, str(repo)))

    def _fake_git_run(repo_dir, *args, **kw):
        runs.append(args)
        return responses.get(args[0], _R(0, stdout="ok"))

    monkeypatch.setattr(gitmod, "require_user_id", lambda request: 7)
    monkeypatch.setattr(gitmod, "_get_work_path", lambda uid: work)
    monkeypatch.setattr(gitmod, "_grant_after_git", _fake_grant)
    monkeypatch.setattr(gitmod, "_git_run", _fake_git_run)

    return {"work": work, "grants": grants, "runs": runs, "responses": responses}


# ── Chemin nominal : les 4 routes doivent granter ────────────────────────

async def test_rebase_grante(env):
    await gitmod.api_git_rebase(_Req({"repo": "proj", "branch": "main"}))
    assert env["grants"], "rebase réécrit l'arbre sans réaligner les droits"


async def test_stash_pop_grante(env):
    await gitmod.api_git_stash(_Req({"repo": "proj", "action": "pop"}))
    assert env["grants"], "stash pop réécrit l'arbre sans réaligner les droits"


async def test_stash_push_grante(env):
    await gitmod.api_git_stash(_Req({"repo": "proj", "action": "push"}))
    assert env["grants"], "stash push réécrit l'arbre sans réaligner les droits"


async def test_stash_list_ne_grante_pas(env):
    """``list`` est une lecture pure : pas de grant inutile."""
    await gitmod.api_git_stash(_Req({"repo": "proj", "action": "list"}))
    assert env["grants"] == []


async def test_restore_commit_grante(env):
    env["responses"]["rev-parse"] = _R(0, stdout="a" * 40)
    env["responses"]["status"] = _R(0, stdout="")          # arbre propre
    await gitmod.api_git_restore_commit(_Req({"repo": "proj", "hash": "b" * 40}))
    assert env["grants"], "restore-commit réécrit l'arbre sans réaligner les droits"


async def test_revert_last_grante(env):
    await gitmod.api_git_revert_last(_Req({"repo": "proj"}))
    assert env["grants"], "revert-last réécrit l'arbre sans réaligner les droits"


# ── Chemin d'échec : l'arbre est réécrit AUSSI quand git sort en erreur ──

async def test_rebase_en_conflit_grante_avant_de_lever(env):
    env["responses"]["rebase"] = _R(1, stderr="CONFLICT (content): merge conflict")
    with pytest.raises(gitmod.HTTPException):
        await gitmod.api_git_rebase(_Req({"repo": "proj", "branch": "main"}))
    assert env["grants"], "conflit de rebase : fichiers à résoudre non éditables"


async def test_stash_pop_en_conflit_grante_avant_de_lever(env):
    env["responses"]["stash"] = _R(1, stderr="CONFLICT (content)")
    with pytest.raises(gitmod.HTTPException):
        await gitmod.api_git_stash(_Req({"repo": "proj", "action": "pop"}))
    assert env["grants"], "conflit de stash pop : fichiers à résoudre non éditables"


async def test_revert_en_conflit_grante_apres_abort(env):
    env["responses"]["revert"] = _R(1, stderr="error: could not revert")
    with pytest.raises(gitmod.HTTPException):
        await gitmod.api_git_revert_last(_Req({"repo": "proj"}))
    assert env["grants"], "revert --abort restaure l'arbre sans réaligner les droits"


async def test_restore_commit_checkout_ko_grante_avant_de_lever(env):
    env["responses"]["rev-parse"] = _R(0, stdout="a" * 40)
    env["responses"]["status"] = _R(0, stdout="")
    env["responses"]["checkout"] = _R(1, stderr="error: pathspec")
    with pytest.raises(gitmod.HTTPException):
        await gitmod.api_git_restore_commit(_Req({"repo": "proj", "hash": "b" * 40}))
    assert env["grants"], "checkout partiel : arbre réécrit sans réaligner les droits"


# ── Garde-fou global : aucune route mutante ne doit re-perdre le grant ───

def test_toutes_les_routes_qui_reecrivent_l_arbre_appellent_le_grant():
    """Verrou de source : la liste des routes qui touchent l'arbre de travail
    et le jeu de celles qui granteent doivent rester alignés. Ajouter une
    route mutante sans ``_grant_after_git`` casse ce test."""
    import inspect

    src = inspect.getsource(gitmod)
    attendu = [
        "api_git_discard", "api_git_pull", "api_git_checkout", "api_git_merge",
        "api_git_merge_abort", "api_git_merge_resolve", "api_git_rebase",
        "api_git_stash", "api_git_restore_commit", "api_git_revert_last",
    ]
    manquants = []
    for nom in attendu:
        i = src.index(f"async def {nom}(")
        # Fin de la fonction = début de la suivante (ou du bloc __all__).
        suivants = [src.index(m, i + 1) for m in ("\n@router.", "\n__all__")
                    if m in src[i + 1:]]
        corps = src[i:min(suivants)] if suivants else src[i:]
        # On cherche l'APPEL, pas la mention : un commentaire qui cite le
        # helper ne réaligne aucun droit.
        if "await _grant_after_git(" not in corps:
            manquants.append(nom)
    assert manquants == [], f"routes sans réalignement des droits : {manquants}"
