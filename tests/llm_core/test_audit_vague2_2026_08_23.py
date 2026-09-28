# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_audit_vague2_2026_08_23.py — vague 2 des constats confirmés
(streaming, réflexion, cycle de vie du moteur).

Constats traités : 11, 12, 13, 15, 16, 17, 19, 20, 26, 27.
"""
from __future__ import annotations

import inspect

import pytest


# ── 12. Le splitter n'indexe plus une chaîne à partir d'une autre ───────────

def test_un_caractere_dont_la_minuscule_change_de_longueur():
    """``'İ'.lower()`` rend DEUX caractères (U+0130 — le seul codepoint du
    plan concerné). Les indices calculés sur ``data.lower()`` étaient ensuite
    appliqués à ``data`` : tout le chunk se décalait d'un caractère."""
    from llm_core._stream_tag_parser import ThinkTagSplitter
    assert len("İ".lower()) == 2, "prémisse Unicode"
    assert ThinkTagSplitter().feed("İ<think>abc</think>fin") == [
        ("content", "İ"), ("thinking", "abc"), ("content", "fin")]


def test_le_cas_ascii_de_controle_est_inchange():
    from llm_core._stream_tag_parser import ThinkTagSplitter
    assert ThinkTagSplitter().feed("X<think>abc</think>fin") == [
        ("content", "X"), ("thinking", "abc"), ("content", "fin")]


def test_la_casse_de_la_balise_reste_toleree():
    from llm_core._stream_tag_parser import ThinkTagSplitter
    assert ThinkTagSplitter().feed("a<THINK>b</Think>c") == [
        ("content", "a"), ("thinking", "b"), ("content", "c")]


def test_le_prefixe_partage_ne_compare_plus_deux_chaines_de_longueurs_differentes():
    """DURCISSEMENT, pas un défaut observable : ``_shared_prefix_with_tag``
    calculait ``max_k`` sur la longueur d'ORIGINE puis comparait les versions
    minusculées. Les balises étant ASCII, le caractère fautif ne peut pas
    tomber dans le suffixe retenu — aucun cas ne se manifeste aujourd'hui. On
    verrouille quand même la forme, pour qu'un futur dialecte non-ASCII ne
    réveille pas le vice."""
    from llm_core import _stream_tag_parser as S
    src = inspect.getsource(S._shared_prefix_with_tag)
    assert "tail_l.endswith" not in src
    assert "zip(tail[-k:], tag[:k])" in src
    assert S._shared_prefix_with_tag("hello </th", "</think>") == 4
    assert S._shared_prefix_with_tag("hello world", "</think>") == 0


def test_une_balise_coupee_entre_deux_chunks_est_toujours_recollee():
    from llm_core._stream_tag_parser import ThinkTagSplitter
    sp = ThinkTagSplitter()
    assert sp.feed("avant <thi") == [("content", "avant ")]
    assert sp.feed("nk>dedans</think>après") == [
        ("thinking", "dedans"), ("content", "après")]


# ── 11. Le dialecte <|thinking|> ne fuit plus dans la bulle ────────────────

def test_le_splitter_connait_le_second_dialecte():
    from llm_core._stream_tag_parser import ThinkTagSplitter
    assert ThinkTagSplitter().feed(
        "<|thinking|>je reflechis<|/thinking|>Voici la reponse.") == [
        ("thinking", "je reflechis"), ("content", "Voici la reponse.")]


def test_le_second_dialecte_survit_a_une_coupure_de_chunk():
    from llm_core._stream_tag_parser import ThinkTagSplitter
    sp = ThinkTagSplitter()
    assert sp.feed("avant <|thin") == [("content", "avant ")]
    assert sp.feed("king|>dedans<|/thinking|>après") == [
        ("thinking", "dedans"), ("content", "après")]


def test_le_buffer_streame_ne_court_circuite_plus_le_nettoyage():
    """``final_clean = _streamed_content or …`` faisait gagner la version
    BRUTE dès qu'un token avait été streamé."""
    from llm_core import _chat_with_tools as W
    src = inspect.getsource(W._run_chat_multi_mcp_impl)
    i = src.index("_streamed_content = \"\".join(_iter_content_parts)")
    bloc = src[i:i + 2600]
    assert 'final_clean = _streamed_content or final_clean' not in bloc, \
        "le buffer brut prime encore sur le contenu nettoyé"
    assert "_st_think, _st_clean = _extract_thinking(" in bloc


def test_extract_thinking_reconnait_bien_ce_dialecte():
    """Prémisse : c'est parce que ``_extract_thinking`` savait le retirer, et
    pas le splitter, que les deux chemins divergeaient."""
    from llm_core._chat_classic import _extract_thinking
    t, c = _extract_thinking("<|thinking|>je reflechis<|/thinking|>Voici.")
    assert t == "je reflechis" and c == "Voici."


# ── 13. Cible distante : racine d'URL et capacités ─────────────────────────

@pytest.mark.parametrize("url,attendu", [
    ("https://api.exemple.com/v1", "https://api.exemple.com"),
    ("https://gpu.interne/v1/", "https://gpu.interne"),
    ("http://127.0.0.1:8080/v1/chat/completions", "http://127.0.0.1:8080"),
    ("http://127.0.0.1:8080/chat/completions", "http://127.0.0.1:8080"),
    ("http://x/y", "http://x/y"),
])
def test_la_racine_dendpoint_retire_aussi_v1(url, attendu):
    """``…/v1`` manquait de la liste ⇒ ``GET …/v1/v1/stream``, reprise perdue
    et « Stop » sur un 404 avalé."""
    from llm_core._chat_with_tools import _endpoint_base
    assert _endpoint_base(url) == attendu


def test_les_trois_implementations_du_calcul_saccordent():
    from llm_core._chat_with_tools import _endpoint_base
    from llm_core.providers.llama_caps import _base as caps_base
    for u in ("https://api.exemple.com/v1",
              "http://127.0.0.1:8080/v1/chat/completions"):
        assert _endpoint_base(u) == caps_base(u), u


def test_les_capacites_sont_sondees_sur_la_cible_reelle():
    from llm_core import _chat_with_tools as W
    src = inspect.getsource(W._llama_chat_with_tools_stream)
    i = src.index("engine_caps as _eng_caps")
    bloc = src[i:i + 1400]
    assert "await _eng_caps()" not in bloc, \
        "on décide encore des capacités du serveur distant en sondant le local"
    # 2026-09-16 : le serveur de la cible est passé en ENTIER (base + en-tête
    # d'auth), cf. llm_core.engines ; la base seule rendait 401 sur --api-key.
    assert "_eng_caps(engine=_cur_engine())" in bloc


# ── 15. Un suivi de chargement ne prend plus le pool de monitoring ─────────

def test_watch_load_ouvre_son_propre_client():
    from llm_core.providers import llama_models as LM
    src = inspect.getsource(LM.watch_load)
    assert "_get_admin_client" not in src, (
        "un flux de 600 s occupe encore une des 8 connexions partagées avec "
        "/props, /tokenize et /apply-template")
    assert "_new_sse_client(" in src


def test_le_client_dedie_est_borne_et_referme():
    from llm_core.providers.llama_models import _new_sse_client, watch_load
    c = _new_sse_client(42.0)
    try:
        assert c.timeout.read == 42.0
        assert hasattr(c, "__aenter__"), "il doit être refermé par watch_load"
    finally:
        import asyncio
        asyncio.get_event_loop_policy().new_event_loop().run_until_complete(
            c.aclose())
    assert "async with _sse_client" in inspect.getsource(watch_load)


# ── 16. Un hoquet n'efface plus le dernier modèle connu ────────────────────

async def test_une_panne_passagere_ne_poisonne_plus_le_cache(monkeypatch):
    import llm_core._health as H
    H._loaded_model_cache["id"] = "ornith-1.0-9b-Q8_0"
    H._loaded_model_cache["ts"] = 0.0

    async def _panne():
        return [], False            # serveur injoignable

    monkeypatch.setattr(H, "_remote_models_probe", _panne)
    assert await H.get_currently_loaded_model() == "ornith-1.0-9b-Q8_0", \
        "une coupure d'une seconde a EFFACÉ le dernier modèle connu"
    assert H._loaded_model_cache["ts"] == 0.0, \
        "l'horodatage a été rafraîchi : None serait verrouillé pour tout le TTL"


async def test_un_serveur_sans_modele_charge_rend_bien_none(monkeypatch):
    """Contrôle : « répond une liste vide » ≠ « ne répond pas »."""
    import llm_core._health as H
    H._loaded_model_cache["id"] = "ancien"
    H._loaded_model_cache["ts"] = 0.0

    async def _vide():
        return [], True

    monkeypatch.setattr(H, "_remote_models_probe", _vide)
    assert await H.get_currently_loaded_model() is None
    assert H._loaded_model_cache["ts"] > 0.0


async def test_la_sonde_distingue_les_deux_cas(monkeypatch):
    import llm_core._health as H

    class _R:
        status_code = 200

        @staticmethod
        def json():
            return {"data": [{"id": "m", "status": {"value": "loaded"}}]}

    class _C:
        async def get(self, url, timeout=None):
            return _R()

    monkeypatch.setattr(H, "_get_llm_client", lambda *a, **k: _C())
    modeles, joignable = await H._remote_models_probe()
    assert joignable is True and modeles == [{"id": "m", "status": "loaded"}]

    class _CKo:
        async def get(self, url, timeout=None):
            raise OSError("down")

    monkeypatch.setattr(H, "_get_llm_client", lambda *a, **k: _CKo())
    modeles, joignable = await H._remote_models_probe()
    assert joignable is False and modeles == []


# ── 17. Le préflight de chaque tour est borné ─────────────────────────────

def test_le_preflight_borne_et_choisit_son_client():
    import llm_core._health as H
    src = inspect.getsource(H.verify_llm_availability)
    assert "await client.get(base_url, timeout=3.0" in src, \
        "la seule sonde qui tourne à CHAQUE tour est encore sans borne (600 s)"
    assert "_get_llm_client(base_url if _externe else None)" in src


# ── 19. L'échec de /slots est mémorisé ────────────────────────────────────

async def test_une_sonde_slots_en_echec_nest_pas_rejouee_a_chaque_appel(monkeypatch):
    import llm_core._model_info as MI
    MI._slots_busy_cache = None
    MI._slots_busy_ts = 0.0
    appels = {"n": 0}

    async def _ko(path, timeout=None):
        appels["n"] += 1
        return None

    monkeypatch.setattr(MI, "_llama_get", _ko)
    for _ in range(5):
        await MI.get_busy_slots_snapshot()
    assert appels["n"] <= 2, (
        f"{appels['n']} sondes HTTP pour 5 appels — sur une mission de 200 "
        f"itérations c'est 400 requêtes perdues, 2 s + 2 s chacune sur un "
        f"serveur figé")
    MI._slots_busy_cache = None
    MI._slots_busy_ts = 0.0


def test_le_nom_de_modele_est_echappe_dans_lurl():
    import llm_core._model_info as MI
    src = inspect.getsource(MI.get_busy_slots_snapshot)
    assert "quote(LLAMA_MODEL" in src, \
        "LLAMA_MODEL est interpolé brut, contrairement aux deux /props voisins"


# ── 20. Le cache total_slots a TTL et clé de modèle ───────────────────────

async def test_le_cache_total_slots_expire(monkeypatch):
    import llm_core._model_info as MI
    MI.invalidate_total_slots_cache()
    reponses = [{"total_slots": 4}, {"total_slots": 1}]

    async def _props(path, timeout=None):
        return reponses[min(len(MI._total_slots_cache), len(reponses) - 1)]

    monkeypatch.setattr(MI, "_llama_get", _props)

    async def _suffix():
        return ""

    monkeypatch.setattr(MI, "_autoload_suffix", _suffix)

    assert await MI.get_model_total_slots() == 4
    # Le TTL n'est pas écoulé : valeur mémorisée.
    assert await MI.get_model_total_slots() == 4
    # On périme l'entrée : la nouvelle réalité (-np 1) est vue.
    MI._total_slots_cache[""] = (4, 0.0)
    assert await MI.get_model_total_slots() == 1, \
        "un scalaire figé à vie : passer -np 4 à -np 1 restait invisible"
    MI.invalidate_total_slots_cache()


async def test_le_cache_total_slots_est_indexe_par_modele(monkeypatch):
    import llm_core._model_info as MI
    MI.invalidate_total_slots_cache()

    async def _props(path, timeout=None):
        return {"total_slots": 8 if "gros" in path else 2}

    monkeypatch.setattr(MI, "_llama_get", _props)

    async def _suffix():
        return ""

    monkeypatch.setattr(MI, "_autoload_suffix", _suffix)

    assert await MI.get_model_total_slots("gros") == 8
    assert await MI.get_model_total_slots("petit") == 2, \
        "le scalaire non indexé rendait 8 pour le second modèle"
    MI.invalidate_total_slots_cache()


def test_linvalidation_vide_les_deux_vues():
    import llm_core._model_info as MI
    MI._total_slots_cache["x"] = (4, 1.0)
    MI._cached_total_slots = 4
    MI.invalidate_total_slots_cache()
    assert not MI._total_slots_cache and MI._cached_total_slots == 0


# ── 26. Le probe « auto » se répare tout seul ─────────────────────────────

def test_un_probe_en_echec_est_retente(monkeypatch):
    """Systemd lance l'app avant llama-server : les N workers figeaient
    « classic » DÉFINITIVEMENT, sans TTL ni re-tentative."""
    import llm_core._capabilities as C
    C._LLAMA_CAPABILITIES.update({"probed": True, "slots_endpoint": False,
                                  "probe_error": "connect refused"})
    C._probe_state.update({"ts": 0.0, "inflight": False})
    lancé = {"n": 0}

    async def _detect(timeout_s=3.0):
        lancé["n"] += 1
        return {}

    monkeypatch.setattr(C, "detect_llama_capabilities", _detect)
    # ``resolve_scheduling_mode`` importe la fonction LOCALEMENT depuis
    # shared_infra.config : c'est là qu'il faut la remplacer.
    monkeypatch.setattr("shared_infra.config.live_config_value",
                        lambda *a, **k: "auto")

    import asyncio

    async def _tour():
        # Par le VRAI point d'entrée : c'est ``resolve_scheduling_mode`` qui
        # doit déclencher la re-sonde, pas un appel direct au helper.
        assert C.resolve_scheduling_mode() in ("classic", "optimized")
        await asyncio.sleep(0)
        await asyncio.sleep(0)

    asyncio.run(_tour())
    assert lancé["n"] == 1, "aucune re-tentative après un probe en échec"


def test_un_probe_reussi_nest_pas_reoue(monkeypatch):
    """Coût nul en régime normal : un moteur ne perd pas ``--slots``."""
    import llm_core._capabilities as C
    C._LLAMA_CAPABILITIES.update({"probed": True, "slots_endpoint": True,
                                  "probe_error": None})
    C._probe_state.update({"ts": 0.0, "inflight": False})
    lancé = {"n": 0}

    async def _detect(timeout_s=3.0):
        lancé["n"] += 1
        return {}

    monkeypatch.setattr(C, "detect_llama_capabilities", _detect)
    import asyncio

    async def _tour():
        for _ in range(5):
            C._maybe_reprobe_capabilities()
        await asyncio.sleep(0)

    asyncio.run(_tour())
    assert lancé["n"] == 0


# ── 27. L'étiquette « fallback » est atteignable ──────────────────────────

async def test_les_valeurs_de_repli_sont_annoncees_comme_telles(monkeypatch):
    import llm_core._llm_params as P

    async def _pas_de_props(model_id, **kw):
        return {}

    monkeypatch.setattr(P, "_get_cached_props", _pas_de_props)
    res = await P.describe_effective_params("modele-inexistant", "chat")
    assert res["props_unavailable"] is True
    assert set(res["param_sources"].values()) == {"fallback"}, (
        "le panneau attribue au MODÈLE des valeurs qu'il n'a jamais fournies")


async def test_des_props_reels_restent_etiquetes_props(monkeypatch):
    import llm_core._llm_params as P

    async def _props(model_id, **kw):
        return {"temperature": 0.31}

    monkeypatch.setattr(P, "_get_cached_props", _props)
    res = await P.describe_effective_params("m", "chat")
    assert res["props_unavailable"] is False
    assert res["param_sources"]["temperature"] == "props"


def test_le_panneau_dit_defaut_quand_les_props_manquent():
    from pathlib import Path
    html = (Path(__file__).resolve().parents[2]
            / "frontend/includes/main/panel_sampling.html").read_text(encoding="utf-8")
    assert 'font-mono">modèle <span' not in html, \
        "le panneau annonce encore « modèle » pour des valeurs de repli"
    assert html.count("props_unavailable ? 'défaut' : 'modèle'") >= 4
