# SPDX-License-Identifier: MIT
"""Audit indépendant du 2026-09-30 (sandbox, mise à jour) — correctifs :

  • conteneur d'une version précédente, image attendue absente : l'agent n'est
    pas attendu en vain, le message dit quoi faire ;
  • échec du lancement de l'agent : ``AgentError`` et pause avant de réessayer
    (plus d'erreur brute ni de ``docker exec`` à chaque requête) ;
  • ``install.sh`` ne change plus le propriétaire du contenu des sandboxes ;
  • marqueurs de droits de la version précédente retirés (retour arrière) ;
  • archive d'image cherchée à la racine de l'application ;
  • ``--init`` (processus orphelins récoltés) ;
  • import par morceaux : le fichier provisoire ne survit pas à un disque plein.
"""
from __future__ import annotations

import asyncio
import os
import re
import subprocess
import types
from pathlib import Path

import pytest
from fastapi import HTTPException

from shared_infra.sandbox import agent_client as AC
from shared_infra.sandbox.agent_client import AgentClient, AgentError
from shared_infra.sandbox.executors._user_sandbox import (
    _MODES_MARKER,
    _PERMS_MARKER_LEGACY,
    RUN_SPEC,
    ExecError,
    UserSandbox,
)

RACINE = Path(__file__).resolve().parents[2]


# ── Conteneur hérité sans agent ─────────────────────────────────────────────

class _Cli:
    def __init__(self):
        self.calls: list = []

    async def call(self, *args, timeout=None):
        self.calls.append(args)
        return (0, b"", b"")


@pytest.mark.agent_reel
def test_conteneur_herite_image_absente_message_explicite():
    sb = UserSandbox.__new__(UserSandbox)
    sb._cli = _Cli()
    sb.cfg = types.SimpleNamespace(image="elpis/sandbox:1.7.0", exec_user="")
    sb.username = "t"

    async def pas_a_jour():
        return False

    async def sans_image():
        raise ExecError("image absente")
    sb._config_matches = pas_a_jour
    sb._ensure_image = sans_image
    sb._config_verified = True
    sb._config_retry_at = 0.0
    sb._recreation_reportee = ""
    assert asyncio.run(sb._stale()) is False               # l'ancien conteneur est gardé
    with pytest.raises(ExecError) as e:
        asyncio.run(sb.start_agent())
    assert "elpis/sandbox:1.7.0" in str(e.value) and "install.sh --sandbox build" in str(e.value)
    assert sb._cli.calls == []                             # aucun docker exec inutile


class _SandboxQuiEchoue:
    def __init__(self, racine: Path):
        self.sandbox_path = racine / "work"
        self.sandbox_path.mkdir(parents=True)
        (racine / AC.AGENT_RUN_DIR).mkdir()
        self.lancements = 0

    async def ensure_running(self):
        return types.SimpleNamespace(running=True)

    async def status(self):
        return types.SimpleNamespace(running=True)

    async def start_agent(self, replace: bool = False):
        self.lancements += 1
        raise ExecError("image absente : ./install.sh --sandbox build")


def test_echec_de_lancement_de_l_agent_propre_et_espace(tmp_path):
    sb = _SandboxQuiEchoue(tmp_path)
    c = AgentClient(sb)
    for _ in range(3):
        with pytest.raises(AgentError) as e:
            asyncio.run(c.hello())
        assert e.value.code == "agent_unavailable"
    assert "install.sh" in str(e.value)                   # cause rendue telle quelle
    assert sb.lancements == 1                              # pause avant de réessayer


# ── install.sh : /work jamais re-possédé par l'hôte ─────────────────────────

def _fonction_bash(nom: str) -> str:
    src = (RACINE / "install.sh").read_text(encoding="utf-8")
    m = re.search(rf"^{nom}\(\) \{{\n.*?^\}}\n", src, re.S | re.M)
    assert m, nom
    return m.group(0)


def test_install_ne_rend_pas_le_contenu_des_sandboxes_a_l_hote(tmp_path):
    root = tmp_path / "depot"
    (root / "user_db").mkdir(parents=True)
    (root / "user_db" / "app.db").write_text("x")
    work = root / "user_sandboxes" / "alice" / "work"
    (work / "src").mkdir(parents=True)
    (work / "src" / "a.py").write_text("x")
    faux = tmp_path / "bin"
    faux.mkdir()
    journal = tmp_path / "chown.log"
    (faux / "chown").write_text(f'#!/bin/sh\nprintf "%s\\n" "$@" >> "{journal}"\n')
    (faux / "chown").chmod(0o755)
    script = _fonction_bash("chown_depot") + "chown_depot\n"
    subprocess.run(["bash", "-c", script], check=True,
                   env={**os.environ, "PATH": f"{faux}:{os.environ['PATH']}",
                        "ROOT": str(root), "APP_USER": "elpis"})
    touches = set(journal.read_text().split())
    assert str(root / "user_db" / "app.db") in touches
    assert str(root / "user_sandboxes") in touches and str(root / "user_sandboxes" / "alice") in touches
    assert not any(t.startswith(str(work)) for t in touches)
    assert 'chown -R "$APP_USER": "$ROOT"' not in (RACINE / "install.sh").read_text(encoding="utf-8")


# ── Retour arrière : anciens marqueurs retirés ───────────────────────────────

class _CliModes:
    def __init__(self):
        self.calls: list = []

    async def call(self, *args, timeout=None):
        self.calls.append(args)
        return (0, b"", b"")


def test_marqueurs_de_la_version_precedente_retires(tmp_path):
    work = tmp_path / "work"
    work.mkdir()
    for ancien in _PERMS_MARKER_LEGACY:
        (tmp_path / ancien).write_text("x")
    sb = UserSandbox.__new__(UserSandbox)
    sb.username, sb.sandbox_path, sb._cli = "t", work, _CliModes()
    sb._modes_verified = False
    sb.cfg = types.SimpleNamespace(exec_user="")
    asyncio.run(sb._reconcile_work_modes())
    assert (tmp_path / _MODES_MARKER).exists()
    assert not any((tmp_path / ancien).exists() for ancien in _PERMS_MARKER_LEGACY)


def test_marqueurs_synchronises_avec_paths():
    from shared_infra.sandbox import paths
    assert tuple(paths._PERMS_MARKER_LEGACY) == tuple(_PERMS_MARKER_LEGACY)


# ── Image, options de lancement ──────────────────────────────────────────────

def test_archive_d_image_cherchee_a_la_racine_de_l_application():
    from shared_infra.sandbox.executors import _image_loader as il
    chemins = il._candidate_tar_paths("elpis/sandbox:1.7.0")
    assert RACINE / "deploy" / "docker" / "sandbox" / "elpis-sandbox-1.7.0.tar.gz" in chemins


def test_init_et_version_des_options():
    src = Path(UserSandbox.__module__.replace(".", "/") + ".py")
    texte = (RACINE / src).read_text(encoding="utf-8")
    assert '"run", "-d", "--init",' in texte and RUN_SPEC == "6"


# ── Import par morceaux : disque plein ──────────────────────────────────────

def test_disque_plein_supprime_le_fichier_provisoire(monkeypatch):
    import shared_infra.sandbox.exec_bridge as xb
    import shared_infra.sandbox.routes_files as rf
    supprimes = []

    async def plein(user_id, rel, data, truncate):
        raise HTTPException(507, "Espace disque insuffisant")

    async def supprimer(user_id, rel):
        supprimes.append(rel)
    monkeypatch.setattr(xb, "sandbox_append_chunk", plein)
    monkeypatch.setattr(xb, "sandbox_delete", supprimer)
    monkeypatch.setattr(rf, "invalidate_sandbox_usage", lambda uid: None)
    with pytest.raises(HTTPException) as e:
        asyncio.run(rf._ajouter_morceau(1, "gros.bin.elpis-upload.part", b"x", truncate=False))
    assert e.value.status_code == 507 and supprimes == ["gros.bin.elpis-upload.part"]
