# SPDX-License-Identifier: MIT
"""tests/llm_core/test_fs_perm_heal.py — auto-réparation des permissions
croisées conteneur→hôte (``_ecrire_garde``, 2026-07-21 ; par l'agent
depuis L4.2).

Contexte : un sous-arbre créé CÔTÉ CONTENEUR avec des modes restrictifs
(``git clone`` tapé dans un terminal antérieur au wrapper umask 0000,
``tar -x`` qui préserve les modes de l'archive…) appartient à l'UID 10001 :
l'écriture est refusée (``denied``). ``_ecrire_garde`` déclenche alors
``repair_work_perms`` (chmod root DANS le conteneur, via le bridge) puis
retente UNE fois.

Sans Docker ici : ``repair_work_perms`` est monkeypatché ; on valide le
protocole (déclenchement, arguments, retry unique, propagation d'échec).
"""
from __future__ import annotations

import pytest

import llm_core.tools._exec_bridge as B
import llm_core.tools.fs_tools as F
from shared_infra.sandbox.agent_client import AgentError


@pytest.fixture()
def no_flock(monkeypatch):
    # Le verrou flock n'est pas l'objet du test — désactivé pour l'isoler.
    monkeypatch.setattr(F, "_FSTOOLS_FLOCK", False)


class _EspRefus:
    """Espace dont les ``refus`` premières écritures sont refusées (``code``)."""

    def __init__(self, refus: int, code: str = "denied"):
        self.refus, self.code, self.ecritures = refus, code, 0

    def ecrire(self, rel, data, **kw):
        self.ecritures += 1
        if self.ecritures <= self.refus:
            raise AgentError(self.code, "refusé")
        return {"size": len(data), "created": True}


_ABSENT = ({"kind": "missing"}, None, "")


def _ecrire(esp, root, rel):
    return F._ecrire_garde(esp, "alice", root, root / rel, rel, b"ok", etat=_ABSENT)


def test_heal_repairs_then_retries_once(tmp_path, monkeypatch, no_flock):
    seen = {}

    def _repair(*, username, sandbox_root, rel_path=""):
        seen.update(username=username, sandbox_root=sandbox_root, rel_path=rel_path)
        return True

    monkeypatch.setattr(B, "repair_work_perms", _repair)
    esp = _EspRefus(1)
    r, err = _ecrire(esp, tmp_path / "work", "repo/sub/f.txt")
    assert err is None and r["created"]     # écriture réussie au retry
    assert esp.ecritures == 2               # 1 refus + 1 retry
    assert seen["username"] == "alice"
    # rel_path : relatif à la racine sandbox → premier segment = le dépôt.
    assert seen["rel_path"].split("/")[0] == "repo"


def test_heal_propagates_when_repair_fails(tmp_path, monkeypatch, no_flock):
    monkeypatch.setattr(B, "repair_work_perms",
                        lambda **kw: False)   # conteneur indisponible
    esp = _EspRefus(99)
    with pytest.raises(AgentError):
        _ecrire(esp, tmp_path / "work", "repo/f.txt")
    assert esp.ecritures == 1               # pas de retry si la réparation échoue


def test_heal_single_retry_only(tmp_path, monkeypatch, no_flock):
    # La réparation « réussit » mais l'écriture reste refusée (autre cause,
    # ex. read-only fs) : l'erreur d'origine remonte après UN seul retry.
    monkeypatch.setattr(B, "repair_work_perms", lambda **kw: True)
    esp = _EspRefus(99)
    with pytest.raises(AgentError):
        _ecrire(esp, tmp_path / "work", "repo/f.txt")
    assert esp.ecritures == 2


def test_heal_outside_root_propagates(tmp_path, monkeypatch, no_flock):
    # Refus de confinement (lien hors de /work) : pas de réparation.
    called = {"n": 0}

    def _repair(**kw):
        called["n"] += 1
        return True

    monkeypatch.setattr(B, "repair_work_perms", _repair)
    with pytest.raises(AgentError):
        _ecrire(_EspRefus(99, "outside_root"), tmp_path / "work", "lien/f.txt")
    assert called["n"] == 0


def test_pty_terminal_forces_umask_0000(tmp_path):
    """Le TERMINAL interactif doit RÉELLEMENT retomber sur umask 0000.

    Sans lui, un ``git clone`` tapé dans le terminal crée des fichiers 0664 /
    dossiers 0775 (UID 10001) que les outils fs HÔTE ne peuvent plus modifier
    — la cause racine que ce module répare.

    ⚠ Un simple ``sh -c 'umask 0000; exec /bin/bash'`` NE SUFFIT PAS (bug
    2026-07-30) : ce bash-là est INTERACTIF (docker exec -it), donc il source
    ``/etc/bash.bashrc``, que l'image remplit avec ``umask 0002`` (Dockerfile
    + entrypoint le ré-ajoutent à chaque boot) — le umask était écrasé juste
    après. Vérifié dans elpis/sandbox:1.5.0 : umask sh 0000 → umask bash 0002.
    Le bootstrap doit donc repasser derrière via un ``--rcfile``, lu APRÈS
    ``/etc/bash.bashrc`` (il ne remplace que ``~/.bashrc``, qu'on source).
    """
    import importlib
    import subprocess

    P = importlib.import_module("shared_infra.terminal.pty")
    boot = P._TERM_BOOTSTRAP

    assert "--rcfile" in boot, (
        "sans --rcfile, /etc/bash.bashrc (umask 0002) gagne en dernier"
    )
    # Le snippet est exécuté tel quel dans un sh local (partie génération du
    # rcfile, avant le ``exec bash``) : on valide la syntaxe ET le contenu.
    rc = tmp_path / "termrc"
    snippet = boot.replace(P._TERM_RCFILE, str(rc)).split("&& exec")[0]
    subprocess.run(["/bin/sh", "-c", snippet], check=True, timeout=20)

    lines = [ln.strip() for ln in rc.read_text(encoding="utf-8").splitlines() if ln.strip()]
    assert lines[-1] == "umask 0000", (
        f"umask 0000 doit être la DERNIÈRE directive du rcfile, vu : {lines}"
    )
    assert any(".bashrc" in ln for ln in lines), (
        "le rcfile doit sourcer ~/.bashrc (perso utilisateur préservées)"
    )
