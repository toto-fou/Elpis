# SPDX-License-Identifier: MIT
"""tests/llm_core/test_fs_perm_heal.py — auto-réparation des permissions
croisées conteneur→hôte (``_guarded_write_healing``, 2026-07-21).

Contexte : un sous-arbre créé CÔTÉ CONTENEUR avec des modes restrictifs
(``git clone`` tapé dans un terminal antérieur au wrapper umask 0000,
``tar -x`` qui préserve les modes de l'archive…) appartient à l'UID 10001 :
le process hôte (outils fs write/edit) se prend un ``PermissionError``.
``_guarded_write_healing`` déclenche alors ``repair_work_perms`` (chmod root
DANS le conteneur, via le bridge) puis retente UNE fois.

Sans Docker ici : ``repair_work_perms`` est monkeypatché ; on valide le
protocole (déclenchement, arguments, retry unique, propagation d'échec).
"""
from __future__ import annotations

import pytest

import llm_core.tools._exec_bridge as B
import llm_core.tools.fs_tools as F


@pytest.fixture()
def no_flock(monkeypatch):
    # Le verrou flock n'est pas l'objet du test — désactivé pour l'isoler.
    monkeypatch.setattr(F, "_FSTOOLS_FLOCK", False)


def _flaky_writer(target, fail_times: int):
    """write_fn qui échoue en PermissionError ``fail_times`` fois puis écrit."""
    calls = {"n": 0}

    def _fn():
        calls["n"] += 1
        if calls["n"] <= fail_times:
            raise PermissionError(13, "Permission denied", str(target))
        target.write_text("ok", encoding="utf-8")

    return _fn, calls


def test_heal_repairs_then_retries_once(tmp_path, monkeypatch, no_flock):
    root = tmp_path / "work"
    (root / "repo" / "sub").mkdir(parents=True)
    target = root / "repo" / "sub" / "f.txt"
    seen = {}

    def _repair(*, username, sandbox_root, rel_path=""):
        seen.update(username=username, sandbox_root=sandbox_root, rel_path=rel_path)
        return True

    monkeypatch.setattr(B, "repair_work_perms", _repair)
    write_fn, calls = _flaky_writer(target, fail_times=1)

    out = F._guarded_write_healing("alice", root, target, "", write_fn)

    assert out is None                       # écriture réussie au retry
    assert calls["n"] == 2                   # 1 échec + 1 retry
    assert target.read_text(encoding="utf-8") == "ok"
    assert seen["username"] == "alice"
    # rel_path : relatif à la racine sandbox → premier segment = le dépôt.
    assert seen["rel_path"].split("/")[0] == "repo"


def test_heal_propagates_when_repair_fails(tmp_path, monkeypatch, no_flock):
    root = tmp_path / "work"
    root.mkdir()
    target = root / "repo" / "f.txt"
    monkeypatch.setattr(B, "repair_work_perms",
                        lambda **kw: False)   # conteneur indisponible
    write_fn, calls = _flaky_writer(target, fail_times=99)

    with pytest.raises(PermissionError):
        F._guarded_write_healing("alice", root, target, "", write_fn)
    assert calls["n"] == 1                   # pas de retry si la réparation échoue


def test_heal_single_retry_only(tmp_path, monkeypatch, no_flock):
    # La réparation « réussit » mais l'écriture échoue toujours (autre cause,
    # ex. read-only fs) : l'erreur d'origine remonte après UN seul retry.
    root = tmp_path / "work"
    root.mkdir()
    target = root / "repo" / "f.txt"
    monkeypatch.setattr(B, "repair_work_perms", lambda **kw: True)
    write_fn, calls = _flaky_writer(target, fail_times=99)

    with pytest.raises(PermissionError):
        F._guarded_write_healing("alice", root, target, "", write_fn)
    assert calls["n"] == 2


def test_heal_outside_root_propagates(tmp_path, monkeypatch, no_flock):
    # Cible hors racine sandbox (défense en profondeur) : pas de réparation.
    root = tmp_path / "work"
    root.mkdir()
    outside = tmp_path / "elsewhere" / "f.txt"
    outside.parent.mkdir()
    called = {"n": 0}

    def _repair(**kw):
        called["n"] += 1
        return True

    monkeypatch.setattr(B, "repair_work_perms", _repair)
    write_fn, _ = _flaky_writer(outside, fail_times=99)

    with pytest.raises(PermissionError):
        F._guarded_write_healing("alice", root, outside, "", write_fn)
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
