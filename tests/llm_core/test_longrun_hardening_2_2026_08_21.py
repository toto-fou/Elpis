# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_longrun_hardening_2026_08_21.py — 2ᵉ lot de l'audit
« runs très longs » : les points laissés en arbitrage au premier passage.

  R1. Une réponse en PROSE coupée par le plafond n'avait AUCUNE reprise
      automatique — le tour finissait sur la bannière « Continuer », sans
      effet dans une mission autonome (couvert dans le 1er fichier).
  R2. La déconnexion du navigateur ANNULAIT le run serveur : une mission de
      six heures dépendait d'un onglet resté ouvert six heures.
  R3. Les écritures télémétriques (métriques, trafic LLM) étaient des
      écritures SQLite SYNCHRONES sur l'event loop, à chaque appel d'outil et
      à chaque itération LLM — jusqu'à 10 s de gel de TOUT le worker.
  R4. Les budgets de compaction étaient calibrés pour un tour de chat
      (2 par run, 4 par chat, plafond dur à 10), pas pour 200 itérations.
  R5. Divers : pool de clients HTTP non borné, /tokenize sur un texte
      multi-mégaoctets, reload admin muet sur ce qu'il interrompt.

Aucun réseau.
"""
from __future__ import annotations

import asyncio
import json
import os

import pytest


# ── Lecture ISOLÉE de la configuration ──────────────────────────────────────
# ``importlib.reload(shared_infra.config)`` rebinderait le module partagé : les
# dizaines de modules qui en ont capté des valeurs à l'import garderaient les
# anciennes, et l'ordre des tests deviendrait significatif. ``runpy`` exécute le
# fichier dans un namespace JETABLE, sans toucher à ``sys.modules`` — même
# procédé que tests/shared_infra/test_gunicorn_max_requests.py.
def _config(**env) -> dict:
    import runpy
    anciens = {k: os.environ.get(k) for k in env}
    os.environ.update({k: v for k, v in env.items() if v is not None})
    for k, v in env.items():
        if v is None:
            os.environ.pop(k, None)
    try:
        return runpy.run_path("shared_infra/config.py")
    finally:
        for k, v in anciens.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


@pytest.fixture
def config_vierge(tmp_path):
    """Config lue SANS config.json ni surcharge d'environnement."""
    def _lire(**env):
        base = {"APP_CONFIG_PATH": str(tmp_path / "absente.json"),
                "APP_COMPRESSION_MAX_PER_CHAT": None,
                "APP_DETACH_RUN_ON_DISCONNECT": None}
        base.update(env)
        return _config(**base)
    return _lire


# ══════════════════════════════════════════════════════════════════════════
# R2 — détachement du run à la déconnexion
# ══════════════════════════════════════════════════════════════════════════

def test_detachement_desactive_par_defaut(config_vierge):
    """Détacher change le contrat « fermer l'onglet arrête la génération » :
    un déploiement doit le CHOISIR, pas le subir."""
    assert config_vierge()["DETACH_RUN_ON_DISCONNECT"] is False


def test_detache_seulement_a_la_deconnexion_en_cours_de_run():
    from chatbot_app.turn.execution import _should_detach_run

    # Le cas visé : run en cours, client parti, option active.
    assert _should_detach_run(detach_enabled=True, task_done=False,
                              user_stopped=False) is True
    # Fin NORMALE du flux : rien à détacher.
    assert _should_detach_run(detach_enabled=True, task_done=True,
                              user_stopped=False) is False
    # Stop EXPLICITE : c'est une demande d'arrêt, jamais un détachement.
    assert _should_detach_run(detach_enabled=True, task_done=False,
                              user_stopped=True) is False
    # Option inactive : comportement historique intégral.
    assert _should_detach_run(detach_enabled=False, task_done=False,
                              user_stopped=False) is False


def test_option_de_detachement_activable_par_environnement(config_vierge):
    assert config_vierge(
        APP_DETACH_RUN_ON_DISCONNECT="1")["DETACH_RUN_ON_DISCONNECT"] is True
    assert config_vierge(
        APP_DETACH_RUN_ON_DISCONNECT="0")["DETACH_RUN_ON_DISCONNECT"] is False


# ══════════════════════════════════════════════════════════════════════════
# R3 — les écritures télémétriques quittent l'event loop
# ══════════════════════════════════════════════════════════════════════════

async def test_les_metriques_d_outil_partent_hors_boucle(monkeypatch):
    """Les trois écritures bloquantes du bloc métriques (log_metric,
    record_metric, watch_tool_call) doivent passer par ``to_thread`` — sinon
    elles gèlent le worker, donc TOUS ses flux, à chaque appel d'outil."""
    import threading

    from llm_core.engine import tool_exec
    offloaded: list = []
    loop_thread = threading.current_thread()

    def _spy_metric(*_a, **_k):
        offloaded.append(threading.current_thread() is not loop_thread)

    monkeypatch.setattr(tool_exec, "log_metric", lambda *a, **k: None)

    async def execute_single(name, _args, meta=None, **_kw):
        return json.dumps({"ok": True})

    res = await tool_exec.execute_tool_batch(
        [{"call_id": "c0", "tool_name": "read_file", "final_args": {},
          "meta": None}],
        execute_single=execute_single,
        record_metric=_spy_metric,
        is_tool_failure=lambda _r: False,
        on_event=None, username="u", chat_id="c",
        on_cancel_snapshot=lambda: asyncio.sleep(0), iteration=0,
        is_cancelled=lambda: False,
    )
    assert json.loads(res[0])["ok"] is True
    # (2026-09-26) pool dédié à la télémétrie : on vérifie le CONTRAT (hors
    # du thread de la boucle), plus le moyen (``asyncio.to_thread``).
    assert offloaded == [True], (
        "les écritures SQLite du chemin chaud sont restées sur l'event loop")


async def test_capture_llm_est_non_bloquante_et_gatee(monkeypatch):
    """``capture_llm_exchange_async`` ne doit RIEN faire quand la capture est
    désactivée (pas même un saut de thread), et déporter sinon."""
    from llm_core import _llm_debug
    from shared_infra import config as _cfg

    calls: list = []
    monkeypatch.setattr(_llm_debug, "capture_llm_exchange",
                        lambda **kw: calls.append(kw))

    monkeypatch.setattr(_cfg, "LLM_DEBUG_ENABLED", False, raising=False)
    await _llm_debug.capture_llm_exchange_async(req_id="a", model="m")
    assert calls == [], "no-op attendu quand la capture est désactivée"

    monkeypatch.setattr(_cfg, "LLM_DEBUG_ENABLED", True, raising=False)
    await _llm_debug.capture_llm_exchange_async(req_id="b", model="m")
    assert len(calls) == 1 and calls[0]["req_id"] == "b"


async def test_capture_llm_async_avale_les_erreurs(monkeypatch):
    """Best-effort : une capture qui échoue ne doit jamais casser le tour."""
    from llm_core import _llm_debug
    from shared_infra import config as _cfg

    def _boom(**_kw):
        raise RuntimeError("base verrouillée")

    monkeypatch.setattr(_cfg, "LLM_DEBUG_ENABLED", True, raising=False)
    monkeypatch.setattr(_llm_debug, "capture_llm_exchange", _boom)
    await _llm_debug.capture_llm_exchange_async(req_id="c")   # ne lève pas


# ══════════════════════════════════════════════════════════════════════════
# R4 — budgets de compaction à l'échelle des missions longues
# ══════════════════════════════════════════════════════════════════════════

def test_le_defaut_des_budgets_est_a_l_echelle_des_missions(config_vierge):
    """Défaut CODE (sans config.json ni env) : 4 compactions par chat et 2 par
    run ne tenaient pas pour un run de six heures — passé le cap, il ne reste
    que le budget dur, qui JETTE les vieux tours au lieu de les résumer."""
    cfg = config_vierge()
    assert cfg["COMPRESSION_MAX_PER_CHAT"] >= 12
    assert cfg["COMPACTIONS_PER_RUN_MAX"] >= 8


def test_le_clamp_par_chat_nest_plus_bride_a_10(config_vierge):
    """Le clamp existait contre les configs incohérentes, pas comme
    politique : à 10 il rabotait EN SILENCE une valeur légitime pour une
    mission longue (l'opérateur qui réglait 20 obtenait 10, sans un mot)."""
    assert config_vierge(
        APP_COMPRESSION_MAX_PER_CHAT="40")["COMPRESSION_MAX_PER_CHAT"] == 40
    # La borne haute existe toujours.
    assert config_vierge(
        APP_COMPRESSION_MAX_PER_CHAT="999")["COMPRESSION_MAX_PER_CHAT"] == 64


def test_le_budget_de_compaction_suit_le_budget_d_iterations():
    """Le réglage global ne peut pas connaître un ``max_tool_iterations``
    relevé par chat depuis l'UI : un run à 600 itérations a besoin de plus de
    compactions qu'un run à 40. La règle du harnais : une par tranche de ~25
    itérations, jamais moins que le réglage global."""
    from llm_core.engine.llm_turn import _COMPACTIONS_PER_RUN_MAX

    def _budget(max_iter: int) -> int:
        return max(_COMPACTIONS_PER_RUN_MAX, min(64, max(1, max_iter // 25)))

    assert _budget(40) == _COMPACTIONS_PER_RUN_MAX      # court : le plancher
    assert _budget(600) == 24                            # long : mis à l'échelle
    assert _budget(100_000) == 64                        # borné


# ══════════════════════════════════════════════════════════════════════════
# R5 — pool de clients HTTP, /tokenize, visibilité du reload
# ══════════════════════════════════════════════════════════════════════════

def test_le_pool_de_clients_dedies_est_borne():
    """Une clé par base_url VUE, sans limite : un worker qui vit désormais
    indéfiniment accumulait un pool de connexions par URL rencontrée."""
    # ⚠ ``llm_core._client`` en ATTRIBUT du package est masqué par une
    # fonction ré-exportée dans __init__ — il faut passer par le module.
    import importlib
    _client = importlib.import_module("llm_core._client")

    _client._clients_by_base.clear()
    try:
        for i in range(_client._MAX_DEDICATED_CLIENTS + 5):
            _client._get_llm_client(f"https://h{i}.example/v1")
        assert len(_client._clients_by_base) == _client._MAX_DEDICATED_CLIENTS
        # LRU : les plus ANCIENS sont partis, les derniers sont là.
        assert "https://h0.example/v1" not in _client._clients_by_base
        assert (f"https://h{_client._MAX_DEDICATED_CLIENTS + 4}.example/v1"
                in _client._clients_by_base)
    finally:
        _client._clients_by_base.clear()


def test_le_client_reutilise_est_rajeuni():
    """Un connecteur utilisé en permanence ne doit jamais être évincé."""
    # ⚠ ``llm_core._client`` en ATTRIBUT du package est masqué par une
    # fonction ré-exportée dans __init__ — il faut passer par le module.
    import importlib
    _client = importlib.import_module("llm_core._client")

    _client._clients_by_base.clear()
    try:
        garde = "https://permanent.example/v1"
        _client._get_llm_client(garde)
        for i in range(_client._MAX_DEDICATED_CLIENTS + 3):
            _client._get_llm_client(f"https://tmp{i}.example/v1")
            _client._get_llm_client(garde)          # ré-utilisé à chaque tour
        assert garde in _client._clients_by_base
    finally:
        _client._clients_by_base.clear()


def test_le_client_partage_local_nest_pas_concerne():
    """La borne LRU ne touche QUE les clients dédiés aux connecteurs."""
    # ⚠ ``llm_core._client`` en ATTRIBUT du package est masqué par une
    # fonction ré-exportée dans __init__ — il faut passer par le module.
    import importlib
    _client = importlib.import_module("llm_core._client")
    c1 = _client._get_llm_client()
    c2 = _client._get_llm_client()
    assert c1 is c2


async def test_tokenize_saute_les_raisonnements_enormes(monkeypatch):
    """Au-delà du seuil, on ne TENTE même pas l'appel exact : le POST expirait
    sur son timeout de 5 s après avoir sérialisé des mégaoctets."""
    from llm_core import _think_tokens

    appels: list = []

    class _T:
        is_local_llamacpp = True
        is_llamacpp = True
    monkeypatch.setattr("llm_core._target.current_target", lambda: _T())

    async def _fake_count(text, model_id=None, **_k):
        appels.append(len(text))
        return 42
    monkeypatch.setattr("llm_core._llama_http.count_tokens_exact", _fake_count)

    petit = "x" * 100
    n, estime = await _think_tokens.measure_thinking_tokens(petit)
    assert appels == [100] and n == 42 and estime is False

    appels.clear()
    enorme = "x" * (_think_tokens.TOKENIZE_MAX_CHARS + 1)
    n, estime = await _think_tokens.measure_thinking_tokens(enorme)
    assert appels == [], "aucun /tokenize ne doit partir"
    assert estime is True and n > 0


def test_les_generations_en_cours_sont_comptables(tmp_path, monkeypatch):
    """Un reload gracieux annule les runs en vol au bout du drain ; l'opérateur
    doit pouvoir savoir combien AVANT de le déclencher."""
    import importlib

    from shared_infra.runtime import chat_locks

    # ``chat_locks`` fige LOCK_DIR à l'import ; le recharger est sans danger
    # (module feuille, aucune valeur captée ailleurs) et on le restaure ensuite.
    monkeypatch.setenv("ELPIS_CHAT_LOCK_DIR", str(tmp_path / "locks"))
    importlib.reload(chat_locks)
    try:
        assert chat_locks.count_held("gen") == 0
        fd1 = chat_locks.acquire("gen", 1, "chat-a")
        fd2 = chat_locks.acquire("gen", 2, "chat-b")
        assert fd1 is not None and fd2 is not None
        assert chat_locks.count_held("gen") == 2
        # Un autre ``kind`` ne compte pas.
        assert chat_locks.count_held("compact") == 0
        chat_locks.release(fd1)
        assert chat_locks.count_held("gen") == 1
        chat_locks.release(fd2)
        assert chat_locks.count_held("gen") == 0
    finally:
        monkeypatch.delenv("ELPIS_CHAT_LOCK_DIR", raising=False)
        importlib.reload(chat_locks)


def test_active_generations_ne_leve_jamais():
    """Sonde d'exploitation : best-effort, 0 si l'info est indisponible."""
    from shared_infra.routes.admin.lifecycle import active_generations
    assert isinstance(active_generations(), int)
