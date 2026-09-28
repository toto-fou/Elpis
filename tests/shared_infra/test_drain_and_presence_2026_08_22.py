# SPDX-License-Identifier: MIT
"""
tests/shared_infra/test_drain_and_presence_2026_08_22.py — audit du harnais
2026-08-22, lots A et B.

Ce que ces tests verrouillent :

  A1  Pendant le drain d'un worker, le HEARTBEAT gunicorn continue. Sans lui,
      ``murder_workers`` SIGABRT le worker à ``timeout`` (600 s) en plein
      drain : partiel non persisté, sous-process MCP orphelins.
  A2  Le drain attend la fin RÉELLE des runs (chat, routines, scénarios) et
      non la fermeture des connexions HTTP — un run détaché n'a plus de
      connexion, et une mission dépasse tout ``timeout_graceful_shutdown``.
  B1  Le verrou de présence est transmis au registre au lieu d'être
      ré-acquis (il échouerait, on le tient déjà) ; une passation reste
      possible sans fuir de descripteur.
  D4  Les verrous de présence se comptent PAR UTILISATEUR.
  D8  Les canaux inter-process partent d'une racine commune, et un fichier de
      bus qui n'est pas à nous fait renoncer à la propagation.

Aucun réseau, aucun vrai worker : on manipule directement les primitives.
"""
from __future__ import annotations

import asyncio
import os

import pytest

from shared_infra.runtime import chat_locks
from shared_infra.routes import _state


# ─────────────────────────────────────────────────────────────────────────────
#  A1/A2 — drain applicatif
# ─────────────────────────────────────────────────────────────────────────────
async def test_le_drain_attend_la_fin_des_runs(monkeypatch):
    from server import uvicorn_worker as uw

    restant = {"n": 3}
    monkeypatch.setattr(uw, "_active_run_count", lambda: restant["n"])
    monkeypatch.setattr(uw, "DRAIN_MAX_S", 60)

    task = asyncio.create_task(uw._await_runs_finished())
    await asyncio.sleep(1.2)
    assert not task.done(), "le drain n'a pas attendu les runs en cours"

    restant["n"] = 0
    await asyncio.wait_for(task, timeout=5)


async def test_le_drain_a_un_plafond(monkeypatch):
    """Un run qui ne finit jamais ne doit pas garder le worker éternellement
    (la RAM de l'ancien worker s'ajoute à celle du neuf)."""
    from server import uvicorn_worker as uw

    monkeypatch.setattr(uw, "_active_run_count", lambda: 1)
    monkeypatch.setattr(uw, "DRAIN_MAX_S", 1)
    monkeypatch.setattr(uw, "DRAIN_LOG_EVERY_S", 0.2)
    await asyncio.wait_for(uw._await_runs_finished(), timeout=8)


async def test_le_heartbeat_bat_pendant_le_drain(monkeypatch):
    """C'est CE battement qui empêche gunicorn d'abattre un worker en train
    de finir proprement ses missions."""
    from server import uvicorn_worker as uw

    battements = []

    class _Cfg:
        async def callback_notify(self):
            battements.append(1)

    class _Server:
        config = _Cfg()

    monkeypatch.setattr(uw, "DRAIN_HEARTBEAT_S", 0.05)
    task = asyncio.create_task(uw._heartbeat_during_drain(_Server()))
    await asyncio.sleep(0.3)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert len(battements) >= 3, (
        f"seulement {len(battements)} battement(s) — le worker cesserait de "
        f"donner signe de vie pendant le drain")


def test_le_compteur_de_runs_voit_les_trois_familles(monkeypatch):
    """Chats et routines : le drain doit les attendre tous, pas seulement
    les chats. (Les rejeux de scénario du Studio ont été retirés le 2026-09-12.)"""
    class _Task:
        def __init__(self, done=False):
            self._done = done

        def done(self):
            return self._done

    monkeypatch.setattr(_state, "_active_chat_tasks",
                        {(1, "c1"): _Task(), (1, "c2"): _Task(done=True)})

    import shared_infra.scheduling.routines_scheduler as _rs
    monkeypatch.setattr(_rs, "_running_tasks", {"r1": _Task()}, raising=False)

    assert _state.active_run_count() == 2


def test_le_plafond_de_drain_est_reglable(monkeypatch):
    """L'exploitant doit pouvoir arbitrer « mission longue » contre « RAM »
    sans toucher au code."""
    import runpy
    monkeypatch.setenv("APP_DRAIN_MAX_S", "1800")
    ns = runpy.run_path("server/uvicorn_worker.py")
    assert ns["DRAIN_MAX_S"] == 1800


# ─────────────────────────────────────────────────────────────────────────────
#  B1 — verrou de présence transmis, jamais ré-acquis
# ─────────────────────────────────────────────────────────────────────────────
class _DummyTask:
    def done(self):
        return False


def test_le_verrou_pris_par_le_handler_est_repris_par_le_registre(tmp_path,
                                                                  monkeypatch):
    monkeypatch.setattr(chat_locks, "LOCK_DIR", tmp_path / "locks")
    fd = chat_locks.acquire("gen", 7, "chatA")
    assert fd is not None

    # Le handler tient déjà le verrou : sans transmission, register_chat_task
    # tenterait de le reprendre — en vain, puisqu'il est tenu — et la clé
    # resterait SANS descripteur, donc jamais relâchée.
    task = _DummyTask()
    _state.register_chat_task(7, task, "chatA", presence_fd=fd)
    assert _state._activity_fds.get((7, "chatA")) == fd

    assert chat_locks.is_held("gen", 7, "chatA")
    _state.unregister_chat_task(7, "chatA", task)
    assert not chat_locks.is_held("gen", 7, "chatA"), (
        "le verrou n'a pas été relâché : ce chat répondrait 409 pour toujours")


def test_une_passation_ne_fuit_pas_de_descripteur(tmp_path, monkeypatch):
    """Édition d'un message puis régénération : l'ancien run tient encore la
    clé quand le nouveau s'enregistre. Le descripteur en trop doit être
    relâché, sinon le verrou survivrait au run."""
    monkeypatch.setattr(chat_locks, "LOCK_DIR", tmp_path / "locks")
    fd1 = chat_locks.acquire("gen", 8, "chatB")
    t1 = _DummyTask()
    _state.register_chat_task(8, t1, "chatB", presence_fd=fd1)

    # Le nouveau tour arrive avec SON propre descripteur (cas dégénéré, mais
    # c'est celui qui fuyait).
    fd2 = os.dup(fd1)
    t2 = _DummyTask()
    _state.register_chat_task(8, t2, "chatB", presence_fd=fd2)
    assert _state._activity_fds.get((8, "chatB")) == fd1

    _state.unregister_chat_task(8, "chatB", t2)
    assert not chat_locks.is_held("gen", 8, "chatB")


# ─────────────────────────────────────────────────────────────────────────────
#  D4 — comptage des générations PAR UTILISATEUR
# ─────────────────────────────────────────────────────────────────────────────
def test_les_generations_se_comptent_par_utilisateur(tmp_path, monkeypatch):
    monkeypatch.setattr(chat_locks, "LOCK_DIR", tmp_path / "locks")
    fds = [chat_locks.acquire("gen", 1, f"c{i}") for i in range(3)]
    fds.append(chat_locks.acquire("gen", 2, "autre"))
    assert all(f is not None for f in fds)

    assert chat_locks.count_held("gen", user_id=1) == 3
    assert chat_locks.count_held("gen", user_id=2) == 1
    assert chat_locks.count_held("gen") == 4        # vue globale inchangée

    for f in fds:
        chat_locks.release(f)
    assert chat_locks.count_held("gen", user_id=1) == 0


# ─────────────────────────────────────────────────────────────────────────────
#  D8 — racine commune des canaux inter-process
# ─────────────────────────────────────────────────────────────────────────────
_CANAUX = (
    ("chat_cancel.jsonl", "ELPIS_CANCEL_FILE", "/tmp/elpis_chat_cancel.jsonl"),
    ("chat_locks",        "ELPIS_CHAT_LOCK_DIR", "/tmp/elpis_chat_locks"),
    ("task_resume",       "ELPIS_TASK_RESUME_DIR", "/tmp/elpis_task_resume"),
    ("cron.lock",         "CRON_LOCK_PATH", "/tmp/.elpis_cron.lock"),
)


def _fresh_runtime_dir(monkeypatch, racine=None):
    import runpy
    for _n, var, _l in _CANAUX:
        monkeypatch.delenv(var, raising=False)
    if racine is None:
        monkeypatch.delenv("ELPIS_RUNTIME_DIR", raising=False)
    else:
        monkeypatch.setenv("ELPIS_RUNTIME_DIR", str(racine))
    return runpy.run_path("shared_infra/runtime/runtime_dir.py")


def test_une_racine_posee_regroupe_les_quatre_canaux(monkeypatch, tmp_path):
    """C'est la propriété qui manque le jour où un déploiement systemd active
    ``PrivateTmp`` : les quatre canaux doivent pouvoir être déplacés ENSEMBLE,
    d'un seul geste."""
    ns = _fresh_runtime_dir(monkeypatch, tmp_path / "rt")
    for nom, var, legacy in _CANAUX:
        assert str(ns["runtime_path"](nom, var, legacy)).startswith(
            str(tmp_path / "rt"))


def test_sans_racine_les_chemins_historiques_sont_conserves(monkeypatch):
    """⚠ Propriété DÉLIBÉRÉE : un rechargement gracieux fait cohabiter des
    workers anciens et neufs pendant des heures (drain « linger »). Si les
    chemins par défaut changeaient, ces deux générations de workers ne
    partageraient plus RIEN — Stop qui ne traverse pas, garde 409 aveugle,
    deux leaders de routines."""
    ns = _fresh_runtime_dir(monkeypatch, None)
    for nom, var, legacy in _CANAUX:
        assert str(ns["runtime_path"](nom, var, legacy)) == legacy


def test_la_surcharge_dediee_reste_prioritaire(monkeypatch, tmp_path):
    ns = _fresh_runtime_dir(monkeypatch, tmp_path / "rt")
    monkeypatch.setenv("ELPIS_CHAT_LOCK_DIR", str(tmp_path / "ailleurs"))
    assert str(ns["runtime_path"]("chat_locks", "ELPIS_CHAT_LOCK_DIR",
                                  "/tmp/elpis_chat_locks")) \
        == str(tmp_path / "ailleurs")


def test_un_fichier_de_bus_etranger_fait_renoncer(tmp_path, monkeypatch):
    """``/tmp`` est partagé par tous les comptes : accepter d'écrire dans un
    fichier qui n'est pas à nous reviendrait à laisser un tiers déposer des
    demandes d'annulation — donc tuer les générations d'autrui."""
    from shared_infra.runtime import cancel_bus

    cible = tmp_path / "cancel.jsonl"
    cible.write_text("", encoding="utf-8")
    monkeypatch.setattr(cancel_bus, "CANCEL_FILE", cible)

    # Fichier à nous, droits trop larges → RÉPARÉ, pas refusé (un umask
    # permissif n'est pas une attaque, mais ne doit pas rester).
    os.chmod(cible, 0o644)
    cancel_bus.publish_cancel(1, "chat")
    assert (os.stat(cible).st_mode & 0o077) == 0
    assert cible.read_text(encoding="utf-8").strip(), "la ligne n'a pas été écrite"

    # Fichier d'un AUTRE propriétaire → on renonce (simulé en trompant la
    # vérification d'appartenance).
    from shared_infra.runtime import runtime_dir
    monkeypatch.setattr(runtime_dir, "file_is_safe", lambda p: False)
    monkeypatch.setattr(cancel_bus, "_file_is_safe", lambda p: False)
    avant = cible.read_text(encoding="utf-8")
    cancel_bus.publish_cancel(2, "chat2")
    assert cible.read_text(encoding="utf-8") == avant, (
        "une ligne a été écrite dans un fichier qui ne nous appartient pas")
