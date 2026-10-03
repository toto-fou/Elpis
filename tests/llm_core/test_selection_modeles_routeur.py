# SPDX-License-Identifier: MIT
"""llama-server en mode ROUTEUR à une instance : une requête qui nomme un
modèle sans ``autoload=false`` le charge et décharge celui qui tourne.

* les lectures d'information (panneau Sampling, propriétés d'un modèle)
  sondent sans charger, et un modèle non lu ne laisse rien en cache ;
* ``/metrics`` et ``/slots`` nomment le modèle CHARGÉ, ou ne partent pas ;
* la sonde des capacités ne nomme jamais le modèle par défaut de la config ;
* un modèle dont le dernier chargement a échoué est signalé « failed ».
"""
from __future__ import annotations

import asyncio

import pytest

import llm_core
import llm_core._llm_params as lp
from llm_core.providers.llama_caps import EngineCaps

ROUTEUR = EngineCaps(known=True, build=10545, is_router=True)
MONO = EngineCaps(known=True, build=10545, is_router=False)


@pytest.fixture(autouse=True)
def _caches_vides():
    lp.invalidate_params_cache()
    yield
    lp.invalidate_params_cache()


def _moteur(monkeypatch, caps, charge="ornith"):
    import llm_core._health as H
    from llm_core.providers import llama_caps

    async def _caps(*a, **k):
        return caps

    async def _charge():
        return charge
    monkeypatch.setattr(llama_caps, "engine_caps", _caps)
    monkeypatch.setattr(H, "get_currently_loaded_model", _charge)


# ── /metrics et /slots ───────────────────────────────────────────────────────

async def test_metrics_et_slots_nomment_le_modele_charge(monkeypatch):
    from llm_core._llama_http import _per_model_path
    _moteur(monkeypatch, ROUTEUR, charge="qwen 3.6/27b")
    assert await _per_model_path("/metrics") == "/metrics?model=qwen%203.6%2F27b&autoload=false"
    assert await _per_model_path("/slots") == "/slots?model=qwen%203.6%2F27b&autoload=false"
    assert await _per_model_path("/props") == "/props"
    assert await _per_model_path("/slots?model=x") == "/slots?model=x"


async def test_aucun_modele_charge_aucune_requete(monkeypatch):
    from llm_core import _llama_http as LH
    _moteur(monkeypatch, ROUTEUR, charge=None)
    assert await LH._per_model_path("/metrics") is None

    class _Client:
        async def get(self, *a, **k):
            raise AssertionError("aucune requête attendue")
    monkeypatch.setattr(LH, "_get_admin_client", lambda: _Client())
    assert await LH._llama_get_text("/metrics") is None
    assert await LH._llama_get("/slots") is None


async def test_metrics_non_activees_plus_redemandees(monkeypatch):
    """Modèle lancé sans ``--metrics`` (501) : une seule demande, pas une
    erreur toutes les 10 s ; un autre modèle reste interrogé."""
    from llm_core import _llama_http as LH
    LH._metrics_off_until.clear()
    charge = {"id": "ornith"}
    _moteur(monkeypatch, ROUTEUR, charge="ornith")
    import llm_core._health as H

    async def _charge():
        return charge["id"]
    monkeypatch.setattr(H, "get_currently_loaded_model", _charge)
    vus = []

    class _Rep:
        status_code = 501
        text = ""

    class _Client:
        async def get(self, url, **k):
            vus.append(url)
            return _Rep()
    monkeypatch.setattr(LH, "_get_admin_client", lambda: _Client())
    for _ in range(3):
        assert await LH._llama_get_text("/metrics") is None
    assert len(vus) == 1, vus
    charge["id"] = "gemma"
    await LH._llama_get_text("/metrics")
    assert len(vus) == 2 and "model=gemma" in vus[-1]
    LH._metrics_off_until.clear()


async def test_serveur_mono_modele_inchange(monkeypatch):
    from llm_core._llama_http import _per_model_path
    _moteur(monkeypatch, MONO)
    assert await _per_model_path("/metrics") == "/metrics"


# ── Lectures d'information de /props ─────────────────────────────────────────

def _props_routeur(vus, charges=("ornith",)):
    async def _get(path, timeout=None):
        vus.append(path)
        if path == "/props":
            return {"role": "router", "default_generation_settings": {"params": None}}
        modele = path.split("model=", 1)[1].split("&", 1)[0]
        if "autoload=false" in path and modele not in charges:
            return None                         # 400 « model is not loaded »
        return {"default_generation_settings": {"params": {"temperature": 0.6}},
                "chat_template": "{% if enable_thinking %}<think>{% endif %}"}
    return _get


async def _suffixe():
    return "&autoload=false"


async def test_panneau_sampling_ne_charge_pas_le_modele(monkeypatch):
    import llm_core._model_info as MI
    vus = []
    monkeypatch.setattr(llm_core, "_llama_get", _props_routeur(vus))
    monkeypatch.setattr(MI, "_autoload_suffix", _suffixe)
    d = await lp.describe_effective_params(model_id="gemma", task="chat")
    modeles = [p for p in vus if "model=" in p]
    assert modeles and all("autoload=false" in p for p in modeles), vus
    assert d["param_sources"]["temperature"] == "fallback"
    # Une seule lecture brute pour les trois capacités.
    assert sum(1 for p in vus if p.startswith("/props?model=gemma")) <= 2, vus


async def test_modele_non_lu_rien_en_cache(monkeypatch):
    """Un modèle non chargé ne doit pas figer « pas de réflexion » : le tour
    qui le charge relit ses vraies capacités."""
    import llm_core._model_info as MI
    vus = []
    monkeypatch.setattr(llm_core, "_llama_get", _props_routeur(vus))
    monkeypatch.setattr(MI, "_autoload_suffix", _suffixe)
    assert await lp.get_thinking_support("qwen-x", autoload=False) is False
    assert await lp._get_cached_props("qwen-x", autoload=False) == {}
    # Le tour (chargement permis) obtient les vraies valeurs.
    assert await lp.get_thinking_support("qwen-x") is True
    assert (await lp._get_cached_props("qwen-x"))["temperature"] == 0.6


async def test_tour_de_chat_garde_son_chargement(monkeypatch):
    import llm_core._model_info as MI
    vus = []
    monkeypatch.setattr(llm_core, "_llama_get", _props_routeur(vus))
    monkeypatch.setattr(MI, "_autoload_suffix", _suffixe)
    await lp.resolve_sampling("gemma")
    assert "/props?model=gemma" in vus, vus


async def test_lectures_brutes_partagees(monkeypatch):
    vus = []

    async def _get(path, timeout=None):
        vus.append(path)
        await asyncio.sleep(0.01)
        return {"chat_template": "x"}
    monkeypatch.setattr(llm_core, "_llama_get", _get)
    r = await asyncio.gather(*(lp._fetch_raw_props("m") for _ in range(4)))
    assert all(x == {"chat_template": "x"} for x in r)
    assert len(vus) == 1, vus


# ── Sonde des capacités ──────────────────────────────────────────────────────

class _Rep:
    def __init__(self, code, data):
        self.status_code, self._data = code, data

    def json(self):
        return self._data


def _client_routeur(vus, charges):
    class _Client:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url, **k):
            vus.append(url)
            if url.endswith("/props"):
                return _Rep(200, {"role": "router", "max_instances": 1})
            if url.endswith("/v1/models"):
                return _Rep(200, {"data": [
                    {"id": m, "status": {"value": "loaded" if m in charges else "unloaded"}}
                    for m in ("ornith", "gemma")]})
            if "/slots?model=" in url:
                return _Rep(200, [{"id": 0, "state": 0}])
            return _Rep(400, {})
    return _Client


@pytest.mark.parametrize("charges", [("gemma",), ()])
def test_sonde_des_capacites_ne_charge_jamais(monkeypatch, charges):
    import httpx

    import shared_infra.config as cfg
    from llm_core import _capabilities as C
    vus = []
    monkeypatch.setattr(httpx, "AsyncClient", _client_routeur(vus, charges))
    monkeypatch.setattr(C, "_LLAMA_CAPABILITIES", dict(C._LLAMA_CAPABILITIES), raising=False)
    monkeypatch.setattr(cfg, "LLAMA_MODEL", "ornith")
    caps = asyncio.run(C.detect_llama_capabilities(timeout_s=0.2))
    assert not any("model=ornith" in u for u in vus), vus
    slots = [u for u in vus if "/slots" in u]
    if charges:
        assert slots == [u for u in slots if "model=gemma&autoload=false" in u] and slots
        assert caps["slots_endpoint"] and caps["loaded_model"] == "gemma"
    else:
        assert not slots, vus
        assert caps["slots_endpoint"] is False and caps["probe_error"] is None


# ── Statut « failed » ────────────────────────────────────────────────────────

async def test_statut_echec_de_chargement(monkeypatch):
    from llm_core.providers import llama_models as LM

    class _Client:
        async def get(self, url, **k):
            return _Rep(200, {"data": [
                {"id": "a", "status": {"value": "loaded"}},
                {"id": "b", "status": {"value": "unloaded", "failed": True, "exit_code": 1}},
                {"id": "c", "status": {"value": "unloaded"}}]})
    monkeypatch.setattr("llm_core._client._get_llm_client", lambda *a, **k: _Client())
    LM.invalidate_statuses()
    st = await LM.model_statuses(base_url="http://llama:8080", force=True)
    assert st == {"a": "loaded", "b": "failed", "c": "unloaded"}


def test_sante_synchrone_metrics_du_modele_charge():
    from llm_core._health import _router_metrics_path
    routeur = {"data": [{"id": "a b", "status": {"value": "loaded"}},
                        {"id": "c", "status": {"value": "unloaded"}}]}
    assert _router_metrics_path(routeur) == "/metrics?model=a%20b&autoload=false"
    assert _router_metrics_path({"data": [{"id": "c", "status": {"value": "unloaded"}}]}) is None
    assert _router_metrics_path({"data": [{"id": "seul"}]}) == "/metrics"
