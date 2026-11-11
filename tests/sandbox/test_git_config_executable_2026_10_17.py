# SPDX-License-Identifier: MIT
"""GI-15 : un ``.git/config`` hostile ne fait exécuter aucun programme au
``git`` de l'agent du bac. ``diff.external`` (lancé par ``diff`` / ``log -p``),
``core.sshCommand`` et les éditeurs sont vidés en portée « command », au-dessus
de la config du dépôt — le témoin n'est jamais créé.

LIMITE connue (cf. ``_GIT_CONFIG``) : les pilotes NOMMÉS
(``filter.<n>.clean/smudge``, ``diff.<n>.command``) n'ont pas de joker ; ils
exigent que l'agent écrive lui-même ``.gitattributes`` ET ``.git/config``, or
``git_write`` refuse ``.git`` et clone n'importe pas la config du distant.
"""
import shutil
import subprocess
from pathlib import Path

import pytest

from tests.agent_bac import S

Agent, _ecrire_config_git = S.Agent, S._ecrire_config_git

pytestmark = pytest.mark.skipif(
    shutil.which("git") is None, reason="requires git"
)


def _agent(tmp_path):
    work = tmp_path / "work"
    work.mkdir(parents=True)
    config = _ecrire_config_git(str(tmp_path))
    return Agent(str(work), config_git=config), work


def _git(agent, *args):
    return agent.git({"cwd": "", "args": list(args), "timeout_s": 30, "max_out": 1 << 20})


def _init_repo(work):
    env = {"GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_SYSTEM": "/dev/null",
           "HOME": str(work), "PATH": "/usr/bin:/bin"}
    for cmd in (["git", "init", "-q"], ["git", "config", "user.email", "t@t"],
                ["git", "config", "user.name", "t"]):
        subprocess.run(cmd, cwd=work, check=True, env=env, capture_output=True)
    (work / "f.txt").write_text("v1\n")
    subprocess.run(["git", "add", "f.txt"], cwd=work, check=True, env=env, capture_output=True)
    subprocess.run(["git", "commit", "-qm", "a"], cwd=work, check=True, env=env, capture_output=True)
    return env


def test_diff_external_malveillant_non_execute(tmp_path):
    agent, work = _agent(tmp_path)
    env = _init_repo(work)
    temoin = tmp_path / "temoin-diff"
    subprocess.run(["git", "config", "diff.external", f"touch {temoin}; true"],
                   cwd=work, check=True, env=env, capture_output=True)
    (work / "f.txt").write_text("v2\n")

    # Repère : le diff.external hostile EST lancé par le git nu de l'hôte.
    subprocess.run(["git", "diff"], cwd=work, check=True, env=env, capture_output=True)
    assert temoin.exists(), "pré-condition : sans durcissement, diff.external s'exécute"
    temoin.unlink()

    # L'agent injecte --no-ext-diff : le témoin n'est pas recréé, le diff reste rendu.
    for i, args in enumerate((("diff",), ("log", "-p", "-1"), ("show", "HEAD"),
                              ("-c", "core.quotePath=false", "diff"))):
        a2, w2 = _agent(tmp_path / f"c{i}")
        e2 = _init_repo(w2)
        subprocess.run(["git", "config", "diff.external", f"touch {temoin}; true"],
                       cwd=w2, check=True, env=e2, capture_output=True)
        (w2 / "f.txt").write_text("v2\n")
        res = _git(a2, *args)
        assert res["returncode"] == 0, res["stderr"]
        assert "f.txt" in res["stdout"], f"diff non rendu pour {args}: {res['stdout']!r}"
        assert not temoin.exists(), f"diff.external exécuté pour {args}"


def test_valeurs_executables_videes_en_portee_command(tmp_path):
    agent, work = _agent(tmp_path)
    env = _init_repo(work)
    for cle, val in (("core.sshCommand", "/bin/false"), ("core.editor", "/bin/false"),
                     ("sequence.editor", "/bin/false"), ("gpg.program", "/bin/false")):
        subprocess.run(["git", "config", cle, val], cwd=work, check=True, env=env,
                       capture_output=True)
        res = _git(agent, "config", "--get", cle)
        assert res["returncode"] == 0 and res["stdout"].strip() == "", (
            f"{cle} non vidé : {res['stdout']!r}")


def test_commit_marche_malgre_un_editeur_hostile(tmp_path):
    agent, work = _agent(tmp_path)
    env = _init_repo(work)
    temoin = tmp_path / "temoin-editor"
    subprocess.run(["git", "config", "core.editor", f"touch {temoin}; false"],
                   cwd=work, check=True, env=env, capture_output=True)
    (work / "f.txt").write_text("v2\n")
    _git(agent, "add", "-A")
    res = _git(agent, "commit", "-m", "b")
    assert res["returncode"] == 0, res["stderr"]
    assert not temoin.exists()
