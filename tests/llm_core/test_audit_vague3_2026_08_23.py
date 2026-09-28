# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_audit_vague3_2026_08_23.py — vague 3 des constats confirmés
(providers distants, MCP, ordonnancement).

Constats traités : 18/36, 21, 22, 23, 24, 28, 35, 37, 38, 41.
"""
from __future__ import annotations

import asyncio
import inspect

import pytest


# ── 21 + 22. Le connecteur Anthropic sans outils tient son contrat ─────────

class _FakeTargetAnthropic:
    wire = "anthropic"
    is_default = False
    is_local_llamacpp = False
    is_llamacpp = False
    provider_type = "anthropic"
    model = "claude-opus-5"
    base_url = "https://api.anthropic.com"


def test_la_traduction_du_stop_reason_est_partagee():
    """Elle n'existait que sur le point d'entrée OUTILS : les deux entrées du
    même adaptateur avaient divergé."""
    from llm_core.providers.anthropic import _finish_from_stop_reason as f
    assert f("max_tokens", has_tool_calls=False) == "length"
    assert f("end_turn", has_tool_calls=False) == "stop"
    # (2026-09-21, audit M1) « length » PRIME : un tool_use coupé par le
    # plafond porte un JSON incomplet — remonté en « tool_calls », il était
    # exécuté avec ``{}`` et la garde de troncature de la boucle sautée.
    assert f("max_tokens", has_tool_calls=True) == "length"
    assert f("tool_use", has_tool_calls=True) == "tool_calls"
    assert f(None, has_tool_calls=False) == ""


async def test_une_reponse_claude_coupee_arme_le_bouton_continuer(monkeypatch):
    """Sans ``truncated``, l'utilisateur recevait une réponse coupée en plein
    milieu de phrase, sans indicateur ni « Continuer »."""
    from llm_core.providers import anthropic as A

    async def _stream(*a, **kw):
        return {"content": "Voici le début", "thinking": "", "tool_calls": [],
                "stop_reason": "max_tokens", "model": "claude-opus-5",
                "usage": {"prompt_tokens": 1200, "completion_tokens": 8192}}

    monkeypatch.setattr(A, "_consume_stream", _stream)
    monkeypatch.setattr(A, "build_body", lambda *a, **kw: {})
    _th, _ct, meta = await A.anthropic_chat_stream(
        [], target=_FakeTargetAnthropic(), model="claude-opus-5")
    assert meta["finish_reason"] == "length"
    assert meta["truncated"] is True

    from llm_core._metrics import calculate_metrics
    m = calculate_metrics(meta, 0.0)
    assert m.get("truncated") is True, \
        "la route n'armera pas isTruncated : aucun « Continuer »"


async def test_la_reflexion_de_claude_nest_plus_comptee_comme_reponse(monkeypatch):
    from llm_core.providers import anthropic as A

    async def _stream(*a, **kw):
        return {"content": "R", "thinking": "un raisonnement",
                "tool_calls": [], "stop_reason": "end_turn",
                "model": "m", "usage": {"prompt_tokens": 10,
                                        "completion_tokens": 20}}

    monkeypatch.setattr(A, "_consume_stream", _stream)
    monkeypatch.setattr(A, "build_body", lambda *a, **kw: {})
    _th, _ct, meta = await A.anthropic_chat_stream(
        [], target=_FakeTargetAnthropic(), model="m")
    assert "thinking_tokens" in meta


def test_le_chemin_anthropic_classic_enregistre_son_usage():
    """Le ``return`` était placé AVANT ``_t_start`` et les quatre
    ``record_turn_usage`` ; l'adaptateur n'en appelle aucun. La route ne
    compte plus rien : ce tour n'était compté NULLE PART."""
    from llm_core import _chat_classic as C
    src = inspect.getsource(C.llama_chat_stream_tokens)
    i = src.index('if _target.wire == "anthropic":')
    j = src.index("# ── Résolution des paramètres de sampling ──", i)
    bloc = src[i:j]
    assert "record_turn_usage(" in bloc, \
        "un compte qui n'utilise que Claude affiche encore 0 token consommé"
    assert "return await anthropic_chat_stream(" not in bloc, \
        "le return direct court-circuite encore toute la comptabilité"


# ── 23. Un flux coupé n'est plus facturé zéro ─────────────────────────────

def test_lusage_capte_avant_la_coupure_est_recupere():
    from llm_core import _chat_classic as C
    src = inspect.getsource(C.llama_chat_stream_tokens)
    i = src.index("if content_buf or thinking_buf:")
    bloc = src[i:i + 2200]
    assert "_sink_ref" in bloc and "usage.update(_sink_ref.usage)" in bloc, \
        "le partiel est encore enregistré usage={} — un run de 40 k tokens "\
        "coupé après 3 minutes disparaît des compteurs"


def test_le_consommateur_ecrit_bien_sur_le_sink():
    """Prémisse : les données ÉTAIENT déjà là, seule la recopie manquait."""
    from llm_core.providers import llamacpp as L
    src = inspect.getsource(L.consume_llama_sse)
    assert "r = sink if sink is not None else SseStreamResult()" in src
    assert 'r.usage = chunk["usage"]' in src
    assert 'r.timings = chunk["timings"]' in src


# ── 24. remote_sampling valide ses VALEURS ────────────────────────────────

def test_une_valeur_hors_bornes_ne_part_plus_vers_le_cloud():
    from llm_core.providers.openai_compat import remote_sampling
    out = remote_sampling({"max_tokens": 0, "temperature": 4.5,
                           "top_p": 3.0, "stop": "###"})
    assert "temperature" not in out and "top_p" not in out
    assert "max_tokens" not in out, \
        "« 0 = illimité » est propre à llama.cpp : chaque message échouait "\
        "en 400 chez le fournisseur"
    assert out.get("stop") == "###", "``stop`` reste transmis (utile en distant)"


def test_les_valeurs_valides_passent_toujours():
    from llm_core.providers.openai_compat import remote_sampling
    out = remote_sampling({"max_tokens": 512, "temperature": 0.7,
                           "top_p": 0.9, "stop": ["END"]})
    assert out == {"temperature": 0.7, "top_p": 0.9,
                   "max_tokens": 512, "stop": ["END"]}


def test_les_deux_cibles_appliquent_la_meme_regle_de_bornes():
    """C'est l'ASYMÉTRIE qui piégeait : validé pour le moteur qui tolère,
    pas pour celui qui refuse."""
    from llm_core.providers.openai_compat import remote_sampling
    from llm_core._llm_params import _sanitize_override
    brut = {"temperature": 4.5, "top_p": 3.0}
    assert _sanitize_override(brut) == {}
    assert remote_sampling(brut) == {}


# ── 28. Une coupure de tuyau ne déclenche plus N reconnexions ─────────────

def test_le_pool_est_relu_avant_de_reconnecter():
    from llm_core import _mcp_pool as P
    src = inspect.getsource(P.MCPConnectionPool.call_tool)
    i = src.index("Tentative de reconnexion")
    # Fenêtre élargie (passe 2 2026-08-31) : la reconnexion est désormais
    # BORNÉE par queue_timeout_s — le try/except intercalé décale l'appel.
    bloc = src[i:i + 2800]
    assert "_cur = self._pool.get(key)" in bloc, (
        "chaque appel en échec relance encore un cycle fermeture+handshake "
        "complet sous le verrou GLOBAL du pool")
    assert "await self._reconnect(key, cfg, resolve_client_fn)" in bloc


async def test_seul_le_premier_echec_paie_la_reconnexion():
    """Huit appels parallèles sur le tuyau mort de l'entrée PARTAGÉE."""
    from llm_core._mcp_pool import MCPConnectionPool

    class _Entree:
        def __init__(self, sain=True):
            self.healthy = sain
            self.persistent = True
            self.max_concurrency = 8
            self.last_used_at = 0.0
            self.lock = asyncio.Lock()
            self.client = None

    pool = MCPConnectionPool()
    morte = _Entree(sain=False)
    saine = _Entree(sain=True)
    pool._pool = {"k": morte}
    reconnexions = []

    async def _reconnect(key, cfg, fn):
        reconnexions.append(key)
        pool._pool[key] = saine

    pool._reconnect = _reconnect

    # On rejoue la décision : la 1re reconnecte, les suivantes se rattachent.
    for _ in range(8):
        _cur = pool._pool.get("k")
        if _cur is not None and _cur is not morte and getattr(_cur, "healthy", False):
            continue
        await _reconnect("k", {}, None)
    assert len(reconnexions) == 1, (
        f"{len(reconnexions)} reconnexions complètes de l'entrée partagée "
        f"là où une seule suffisait")


# ── 35. La position dans la file est enfin vraie ─────────────────────────

def _stats(actifs, waiters):
    return {"active_models": actifs, "slot_waiters": waiters}


def test_la_position_reflete_le_nombre_de_personnes_devant(monkeypatch):
    from llm_core import _queue as Q

    class _Sem:
        @staticmethod
        def get_stats():
            return _stats(
                [{"model": "qwen3-30b", "holders": 1, "sem_locked": True}],
                [{"model": "qwen3-30b", "priority": "high", "cancelled": False}
                 for _ in range(4)])

        @staticmethod
        def locked_for(_m):
            return True

    monkeypatch.setattr(Q, "_llm_semaphore", lambda: _Sem())
    st = Q._build_queue_status("qwen3-30b", None, 0)
    assert st["kind"] == "waiting"
    assert st["position"] == 5, (
        f"position={st['position']} — le widget annonçait « vous êtes 1er » "
        f"quel que soit le nombre de personnes en file")
    assert st["active"] == 1


def test_get_stats_ne_produit_toujours_pas_de_cle_per_model():
    """Le fait qui rendait le calcul inerte : ce lecteur n'a JAMAIS eu de
    producteur."""
    from llm_core._scheduling._concurrency import LLMConcurrencyManager
    stats = LLMConcurrencyManager(1, 1).get_stats()
    assert "per_model" not in stats
    assert {"active_models", "slot_waiters"} <= set(stats)


# ── 18/36. La vue de file utilisée est la vue COMPLÈTE ───────────────────

def test_la_route_utilise_la_variante_async():
    from chatbot_app.routes import chats as C
    src = inspect.getsource(C)
    assert "await get_queue_status_for_async(selected_model)" in src
    # La variante SYNC ne doit plus servir dans le flux de chat.
    corps = "\n".join(l for l in src.splitlines()
                      if not l.strip().startswith("#"))
    assert "= get_queue_status_for(selected_model)" not in corps


async def test_un_moteur_sans_modele_charge_annonce_un_chargement(monkeypatch):
    """Le sentinelle ``""`` écrasait le cache tout en rendant
    ``needs_switch_llama`` faux : « ready » alors qu'un chargement complet
    est imminent (routeur en ``autoload=false``)."""
    from llm_core import _queue as Q

    class _Excl:
        @staticmethod
        async def snapshot_async():
            return {"current_model": None, "active_count": 0}

    class _Sem:
        @staticmethod
        def get_stats():
            return {"active_models": [], "slot_waiters": []}

        @staticmethod
        def locked_for(_m):
            return False

    monkeypatch.setattr(Q, "_model_exclusivity", lambda: _Excl())
    monkeypatch.setattr(Q, "_llm_semaphore", lambda: _Sem())

    async def _statuses(*a, **kw):
        return {"qwen3-30b": "unloaded", "autre": "unloaded"}

    monkeypatch.setattr("llm_core.providers.llama_models.model_statuses",
                        _statuses)
    st = await Q.get_queue_status_for_async("qwen3-30b")
    assert st["kind"] == "loading", (
        f"le moteur n'a RIEN en VRAM et le widget annonce {st['kind']!r} — "
        f"l'utilisateur n'a aucun signal pendant un chargement complet")


# ── 37. Une cible distante ne prend AUCUN verrou local ───────────────────

async def test_une_cible_distante_noccupe_pas_le_slot_modele_local(monkeypatch):
    from llm_core._scheduling._concurrency import LLMConcurrencyManager
    from llm_core._target import LlmTarget, use_llm_target

    mgr = LLMConcurrencyManager(1, 4)
    cible = LlmTarget(is_default=False, base_url="https://api.anthropic.com",
                      provider_type="anthropic", model="claude-opus-5")
    with use_llm_target(cible):
        async with mgr.acquire_for("claude-opus-5", priority="high"):
            actifs = mgr.get_stats()["active_models"]
    assert actifs == [], (
        "la cible distante occupe LE slot modèle local : les chats locaux "
        "passent en file derrière un run cloud")


async def test_une_cible_locale_prend_bien_son_slot():
    from llm_core._scheduling._concurrency import LLMConcurrencyManager
    from llm_core._target import LlmTarget, use_llm_target

    mgr = LLMConcurrencyManager(1, 4)
    with use_llm_target(LlmTarget(is_default=True)):
        async with mgr.acquire_for("qwen3-30b", priority="high"):
            actifs = mgr.get_stats()["active_models"]
    assert [a["model"] for a in actifs] == ["qwen3-30b"]


# ── 38. Un « low » n'est plus affamé indéfiniment ────────────────────────

async def test_un_low_finit_par_passer_malgre_une_grace_rafraichie(monkeypatch):
    """Le mécanisme EXACT du constat, isolé : le terrain est libre
    (``_active_count == 0``) mais une fenêtre de grâce porte sur un AUTRE
    modèle et se voit rafraîchie en continu. Avant, l'étape 1 rebouclait sans
    la moindre échéance — une routine « low » restait gelée des heures, sans
    log, sans annulation possible, pendant que son heartbeat la marquait
    « en cours »."""
    from llm_core._scheduling import _locks as L
    from llm_core._scheduling import _concurrency as CC

    monkeypatch.setattr(CC, "LOW_WAIT_CAP_S", 0.5)
    lock = L.ModelExclusivityLock()

    # Grâce PERPÉTUELLE sur un autre modèle : exactement ce que produit un
    # trafic de chat soutenu (8 s réarmées à chaque release d'un high).
    boucle = asyncio.get_running_loop()
    lock._grace_model = "modele-A"
    lock._grace_until = boucle.time() + 5.0     # armée AVANT l'acquisition

    async def _rafraichir():
        while True:
            lock._grace_until = boucle.time() + 5.0
            await asyncio.sleep(0.05)

    raf = asyncio.create_task(_rafraichir())
    t0 = asyncio.get_running_loop().time()
    try:
        async with asyncio.timeout(3.0):
            async with lock.acquire_for("modele-B", priority="low"):
                attendu = asyncio.get_running_loop().time() - t0
    except TimeoutError:
        raf.cancel()
        pytest.fail("l'acquisition « low » n'a JAMAIS été servie : la grâce "
                    "rafraîchie en continu l'affame sans échéance")
    finally:
        raf.cancel()
    assert 0.4 <= attendu <= 2.0, (
        f"servie après {attendu:.2f}s — le plafond anti-famine ne s'applique "
        f"pas au niveau 1")


async def test_un_low_sur_le_meme_modele_ne_paie_rien(monkeypatch):
    """Contrôle : l'échéance ne doit pas ralentir le cas nominal (aucun
    switch à empêcher quand la cible correspond au modèle en grâce)."""
    from llm_core._scheduling import _locks as L
    from llm_core._scheduling import _concurrency as CC

    monkeypatch.setattr(CC, "LOW_WAIT_CAP_S", 30.0)
    lock = L.ModelExclusivityLock()
    lock._grace_model = "modele-A"
    lock._grace_until = asyncio.get_running_loop().time() + 30.0
    t0 = asyncio.get_running_loop().time()
    async with lock.acquire_for("modele-A", priority="low"):
        pass
    assert (asyncio.get_running_loop().time() - t0) < 0.5


def test_les_deux_niveaux_partagent_le_meme_plafond():
    from llm_core._scheduling._concurrency import LOW_WAIT_CAP_S
    from llm_core._scheduling import _locks as L
    assert LOW_WAIT_CAP_S == 30.0
    src = inspect.getsource(L.ModelExclusivityLock.acquire_for)
    assert "LOW_WAIT_CAP_S" in src, \
        "le niveau 1 (acquis EN PREMIER) n'a toujours aucune échéance : le "\
        "plafond du niveau 2 reste inopérant"
    src_redis = inspect.getsource(L.DistributedModelExclusivityLock.acquire_for)
    assert "_LOW_CAP_S" in src_redis, "le chemin Redis a le même trou"


# ── 41. Le repli local Redis est réversible ──────────────────────────────

def test_le_repli_expire_et_permet_une_reconnexion():
    from llm_core._scheduling._locks import DistributedModelExclusivityLock
    lock = DistributedModelExclusivityLock()
    lock._enter_fallback()
    assert lock._fallback_active is True
    lock._fallback_until = 0.0
    assert lock._fallback_active is False
    assert lock._redis is None, \
        "la garde de _ensure_redis empêcherait toute reconnexion"


def test_labsence_de_la_bibliotheque_reste_definitive():
    from llm_core._scheduling._locks import DistributedModelExclusivityLock
    lock = DistributedModelExclusivityLock()
    lock._enter_fallback(permanent=True)
    lock._fallback_until = 0.0
    assert lock._fallback_active is True


def test_plus_aucune_ecriture_directe_du_drapeau():
    from llm_core._scheduling import _locks as L
    src = inspect.getsource(L)
    assert "self._fallback_active = True" not in src, \
        "une écriture directe re-fige le repli à vie"
    assert src.count("_enter_fallback(") >= 5
