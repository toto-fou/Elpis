# SPDX-License-Identifier: MIT
"""
tests/shared_infra/test_audit_couche_entree2_2026_08_23.py — audit du cœur
2026-08-23 (suite).

  6. POOL MCP — sauvegarder ses réglages MCP appelait ``mcp_pool.reset()``, qui
     fermait TOUTES les entrées du worker, y compris l'entrée PERSISTANTE du
     serveur d'outils locaux (fs/shell/git), délibérément unique et partagée
     par tous les utilisateurs. ``_close_entry_unsafe`` force au bout de 10 s
     (« le subprocess sera tué ») : la sauvegarde d'un utilisateur arrachait
     donc l'``execute_shell`` en vol d'un autre.

  7. CONFIG.JSON — les deux écrivains construisaient le MÊME nom de temporaire
     (``config.json.tmp``). Le renommage est atomique, l'écriture ne l'est pas :
     deux écrivains simultanés s'entrelaçaient dans le même tampon, l'un
     renommant le fichier à moitié écrit par l'autre. Un ``config.json``
     invalide est un fail-open : gunicorn rebinde ``0.0.0.0`` malgré HTTPS.

  8. ROUTINES — la boucle d'outils ne LÈVE pas quand l'appel LLM meurt après
     ses reprises : elle RETOURNE le partiel avec ``ended_with_error``. La
     routine était donc journalisée 'ok', notifiée en succès, et déclenchait la
     chaîne aval — propageant un travail interrompu comme s'il était complet.
"""
from __future__ import annotations

import asyncio
import json
import os
import threading

import pytest


# ── 6. Le pool MCP épargne l'entrée partagée ─────────────────────────────────

class _EntreeFactice:
    def __init__(self, persistent: bool):
        self.persistent = persistent


async def test_reset_epargne_les_entrees_persistantes():
    from llm_core._mcp_pool import MCPConnectionPool

    pool = MCPConnectionPool()
    pool._pool = {"outils-locaux": _EntreeFactice(True),
                  "mcp-perso-alice": _EntreeFactice(False),
                  "mcp-perso-bob": _EntreeFactice(False)}
    fermees = []

    async def _ferme(cle):
        fermees.append(cle)
        pool._pool.pop(cle, None)
    pool._close_entry = _ferme

    await pool.reset()

    assert "outils-locaux" not in fermees, \
        "le sous-process d'outils partagé par tout le worker a été tué"
    assert sorted(fermees) == ["mcp-perso-alice", "mcp-perso-bob"]
    assert "outils-locaux" in pool._pool


async def test_reset_complet_reste_possible():
    """Un vrai recyclage doit rester atteignable — la garde ne doit pas créer
    d'entrée intouchable."""
    from llm_core._mcp_pool import MCPConnectionPool

    pool = MCPConnectionPool()
    pool._pool = {"outils-locaux": _EntreeFactice(True)}
    fermees = []

    async def _ferme(cle):
        fermees.append(cle)
        pool._pool.pop(cle, None)
    pool._close_entry = _ferme

    await pool.reset(keep_persistent=False)
    assert fermees == ["outils-locaux"]


# ── 7. Écriture atomique de config.json ──────────────────────────────────────

def test_les_deux_ecrivains_n_utilisent_plus_le_meme_temporaire(tmp_path, monkeypatch):
    """Le nom de temporaire ne doit plus être déductible du nom de la cible :
    c'est ce qui permettait à deux écrivains de partager le même tampon."""
    from shared_infra import config as C

    cible = tmp_path / "config.json"
    cible.write_text("{}", encoding="utf-8")

    vus = []
    vrai_mkstemp = C.tempfile.mkstemp

    def _espion(**kw):
        fd, chemin = vrai_mkstemp(**kw)
        vus.append(chemin)
        return fd, chemin
    monkeypatch.setattr(C.tempfile, "mkstemp", _espion)

    C.write_text_atomic(cible, '{"a": 1}')
    C.write_text_atomic(cible, '{"a": 2}')

    assert len(vus) == 2 and vus[0] != vus[1], \
        f"temporaire réutilisé entre deux écritures : {vus}"
    assert all(os.path.dirname(v) == str(tmp_path) for v in vus), \
        "le temporaire doit rester dans le même système de fichiers que la cible"
    assert json.loads(cible.read_text(encoding="utf-8")) == {"a": 2}
    assert not list(tmp_path.glob("*.tmp")), "temporaire laissé derrière"


def test_deux_ecrivains_concurrents_ne_corrompent_pas_le_fichier(tmp_path, monkeypatch):
    """Reproduction du défaut : un gros payload et un petit, écrits en même
    temps sur la même cible. Avant, le fichier finissait en JSON invalide."""
    from shared_infra import config as C

    cible = tmp_path / "config.json"
    cible.write_text("{}", encoding="utf-8")

    gros = json.dumps({"welcome": "X" * 400_000})
    petit = json.dumps({"a": 1})
    erreurs = []

    def _ecrit(charge, n):
        for _ in range(n):
            try:
                C.write_text_atomic(cible, charge)
            except Exception as e:                       # noqa: BLE001
                erreurs.append(repr(e))

    fils = [threading.Thread(target=_ecrit, args=(gros, 8)),
            threading.Thread(target=_ecrit, args=(petit, 40))]
    for f in fils:
        f.start()
    for f in fils:
        f.join()

    assert not erreurs, f"un écrivain a échoué : {erreurs[:3]}"
    lu = cible.read_text(encoding="utf-8")
    charge = json.loads(lu)          # lève si le fichier est corrompu
    assert charge in (json.loads(gros), json.loads(petit)), \
        "le fichier ne contient ni l'un ni l'autre des payloads entiers"


def test_le_mode_du_fichier_existant_est_conserve(tmp_path):
    """``mkstemp`` crée en 0600 : sans reprise du mode, une configuration
    lisible par le master gunicorn deviendrait illisible."""
    from shared_infra import config as C

    cible = tmp_path / "config.json"
    cible.write_text("{}", encoding="utf-8")
    os.chmod(cible, 0o644)

    C.write_text_atomic(cible, '{"a": 1}')
    assert (os.stat(cible).st_mode & 0o777) == 0o644


# ── 8. Une routine dont la génération échoue n'est pas « ok » ────────────────

def _un_run(nom: str) -> int:
    """Routine + run 'running', même recette que test_routines_route.py."""
    import shared_infra.scheduling.routines_store as R
    from shared_infra.accounts.users import create_user

    uid = create_user(nom, "motdepasse")
    rid = R.create_routine(uid, name=nom, cron_expr="* * * * *", model=None,
                           system_prompt="", task_prompt="t", mcp_servers=[],
                           skills=[], thinking_mode=False, enabled=True)
    run_id = R.admit_and_insert_run(rid, uid, trigger="manual", cap=10,
                                    worker_boot_id="b")
    assert run_id
    return run_id


def test_mark_run_error_conserve_le_bilan():
    """Un échec après 40 itérations a produit un partiel, consommé des tokens
    et parfois écrit des fichiers : l'échec ne doit pas être une ligne vide."""
    from shared_infra.scheduling.routines_store import mark_run_error
    from shared_infra.observability.usage_store import db_conn

    run_id = _un_run("routinier")
    assert mark_run_error(run_id, error="génération interrompue",
                          duration_ms=1234, summary="travail partiel",
                          input_tokens=40, output_tokens=12,
                          files=["/work/a.txt"]) is True
    with db_conn() as conn:
        ligne = conn.execute(
            "SELECT status, summary, input_tokens, output_tokens, files "
            "FROM editor_routine_runs WHERE id=?", (run_id,)).fetchone()
    assert ligne["status"] == "error"
    assert ligne["summary"] == "travail partiel"
    assert ligne["input_tokens"] == 40 and ligne["output_tokens"] == 12
    assert "a.txt" in (ligne["files"] or "")


def test_mark_run_error_sans_bilan_reste_compatible():
    """Les appelants historiques ne passent que ``error`` : rien ne doit
    changer pour eux."""
    from shared_infra.scheduling.routines_store import mark_run_error
    from shared_infra.observability.usage_store import db_conn

    run_id = _un_run("routinier2")
    assert mark_run_error(run_id, error="boum") is True
    with db_conn() as conn:
        ligne = conn.execute(
            "SELECT status, error, summary FROM editor_routine_runs WHERE id=?",
            (run_id,)).fetchone()
    assert ligne["status"] == "error" and ligne["error"] == "boum"
    assert (ligne["summary"] or "") == ""


async def test_une_generation_interrompue_ne_passe_pas_pour_un_succes(monkeypatch):
    """Le cœur du constat, joué de bout en bout : la boucle d'outils RETOURNE
    ``ended_with_error`` au lieu de lever. La boucle de reprise ne voyait donc
    aucune exception et faisait « break # succès »."""
    import contextlib as _ctx
    import llm_core
    import shared_infra.db as db
    import shared_infra.scheduling.routines_scheduler as S

    routine = {"id": 1, "owner_user_id": 1, "model": None, "system_prompt": "",
               "task_prompt": "t", "mcp_servers": [], "skills": [],
               "thinking_mode": False, "name": "r", "enabled": 1,
               "agents_enabled": 0}

    monkeypatch.setattr("shared_infra.accounts.users.get_username_by_id", lambda uid: "alice")
    monkeypatch.setattr("shared_infra.accounts.users.get_user_settings", lambda uid: {})
    monkeypatch.setattr(S, "get_routine_internal", lambda rid: dict(routine))
    monkeypatch.setattr(llm_core, "resolve_scheduling_mode", lambda: "classic")

    @_ctx.asynccontextmanager
    async def _garde(model, use_mcp_path, priority="high"):
        yield
    monkeypatch.setattr(llm_core, "llm_scheduling_guard", _garde)

    async def _run_qui_meurt(messages, **kwargs):
        # Exactement ce que renvoie _chat_with_tools.py quand l'appel LLM
        # échoue après ses reprises internes.
        return ("réponse partielle", [],
                {"input_tokens": 40, "output_tokens": 12,
                 "tool_iterations": 37, "ended_with_error": True,
                 "truncated": True})
    monkeypatch.setattr(llm_core, "run_chat_multi_mcp", _run_qui_meurt)
    monkeypatch.setattr(S, "heartbeat_run", lambda rid: True)

    vus = {}
    monkeypatch.setattr(S, "mark_run_ok",
                        lambda run_id, **k: vus.setdefault("ok", (run_id, k)))
    monkeypatch.setattr(S, "mark_run_error",
                        lambda run_id, **k: vus.setdefault("err", (run_id, k)) or True)
    notifs = []
    monkeypatch.setattr(S, "_emit_run_notification",
                        lambda uid, rid, nom, *, ok, detail: notifs.append(ok))
    chaine = []

    async def _chaine(routine, run_id, *, status, summary, chain_depth):
        chaine.append(status)
    monkeypatch.setattr(S, "_fire_chained_routines", _chaine)

    await S.execute_routine_run(dict(routine), 9)

    assert "ok" not in vus, "une génération interrompue a été journalisée « ok »"
    assert "err" in vus, "l'échec n'a pas été journalisé"
    assert vus["err"][1]["summary"] == "réponse partielle", \
        "le partiel a été perdu du journal"
    assert vus["err"][1]["input_tokens"] == 40, "les tokens dépensés sont perdus"
    assert notifs == [False], f"notification de succès envoyée : {notifs}"
    assert chaine == ["error"], \
        f"la chaîne aval est partie comme si le travail était complet : {chaine}"
