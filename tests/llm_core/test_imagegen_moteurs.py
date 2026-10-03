# SPDX-License-Identifier: MIT
"""Moteurs d'images : sd-server natif, service compatible OpenAI, validation,
capacités, créneaux partagés, TLS, avancée, enrichissement.

Faux serveurs posés par ``httpx.MockTransport`` sur ``http._TRANSPORT`` : on
vérifie la FORME de ce qui part (routes, champs) et la lecture des réponses,
sans réseau.
"""
from __future__ import annotations

import asyncio
import base64
import io
import json
import ssl

import httpx
import pytest

from llm_core.imagegen import http as transport_mod, sdcpp as sdcpp_mod, service, slots
from llm_core.imagegen.base import ImageError, ImageRequest
from llm_core.imagegen.openai import OpenAIProvider, endpoint
from llm_core.imagegen.sdcpp import SdcppProvider


def png(w=64, h=48, couleur=(200, 30, 30)) -> bytes:
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (w, h), couleur).save(buf, "PNG")
    return buf.getvalue()


PNG_B64 = base64.b64encode(png()).decode()


@pytest.fixture()
def reseau(monkeypatch):
    """``reseau(handler)`` installe un faux serveur ; ``reseau.vues`` liste les
    requêtes reçues."""
    vues: list = []

    class Reseau:
        def __call__(self, handler):
            def _h(req: httpx.Request):
                vues.append(req)
                return handler(req)
            monkeypatch.setattr(transport_mod, "_TRANSPORT", httpx.MockTransport(_h))
    r = Reseau()
    r.vues = vues
    monkeypatch.setattr(sdcpp_mod, "_POLL_FIRST", 0.0)
    monkeypatch.setattr(sdcpp_mod, "_POLL_MAX", 0.0)
    service.forget_capabilities()
    yield r
    service.forget_capabilities()


async def _sans_suivi(state, qp=None, info=None):
    pass


def _run(coro):
    return asyncio.run(coro)


def _chemins(vues):
    return [(r.method, r.url.path) for r in vues]


# ── sd-server ─────────────────────────────────────────────────────────────

def test_sdcpp_file_puis_termine(reseau):
    etats = iter([
        {"status": "queued", "queue_position": 2},
        {"status": "generating"},
        {"status": "completed", "result": {"images": [{"b64_json": PNG_B64},
                                                      {"b64_json": PNG_B64}]}},
    ])

    def h(req):
        if req.url.path == "/sdcpp/v1/img_gen":
            return httpx.Response(202, json={"id": "j1", "status": "queued"})
        if req.url.path == "/sdcpp/v1/jobs/j1":
            return httpx.Response(200, json=next(etats))
        return httpx.Response(404)
    reseau(h)
    vus = []

    async def suivi(state, qp=None, info=None):
        vus.append((state, qp))

    req = ImageRequest(prompt="un chat", width=512, height=768, n=2, seed=7,
                       negative_prompt="flou", steps=8)
    out = _run(SdcppProvider("http://sd:8083/").generate(req, suivi, lambda: False))
    assert len(out) == 2 and out[0].mime == "image/png"
    assert (out[0].width, out[0].height) == (64, 48), "taille RÉELLE lue"
    assert [o.seed for o in out] == [7, 8]
    assert vus == [("queued", 2), ("generating", None)]
    assert json.loads(reseau.vues[0].content) == {
        "prompt": "un chat", "width": 512, "height": 768, "seed": 7, "batch_count": 2,
        "output_format": "png", "negative_prompt": "flou",
        "sample_params": {"sample_steps": 8}}
    assert ("POST", "/sdcpp/v1/jobs/j1/cancel") not in _chemins(reseau.vues)


def test_sdcpp_graine_tiree_si_absente(reseau):
    def h(req):
        if req.url.path.endswith("img_gen"):
            return httpx.Response(202, json={"id": "j"})
        return httpx.Response(200, json={"status": "completed",
                                         "result": {"images": [{"b64_json": PNG_B64}]}})
    reseau(h)
    req = ImageRequest(prompt="x", width=64, height=64)
    out = _run(SdcppProvider("http://sd").generate(req, _sans_suivi, lambda: False))
    assert out[0].seed and out[0].seed > 0
    assert json.loads(reseau.vues[0].content)["seed"] == out[0].seed


@pytest.mark.parametrize("statut_annulation", [200, 409])
def test_sdcpp_stop_en_file_ou_en_cours(reseau, statut_annulation):
    """En file : annulé ; en cours : sd-server répond 409, le job est
    abandonné et l'erreur reste « annulée »."""
    def h(req):
        if req.url.path.endswith("img_gen"):
            return httpx.Response(202, json={"id": "j9"})
        if req.url.path.endswith("/cancel"):
            return httpx.Response(statut_annulation, json={})
        return httpx.Response(200, json={"status": "generating"})
    reseau(h)
    appels = {"n": 0}

    def stop():
        appels["n"] += 1
        return appels["n"] > 2

    with pytest.raises(ImageError) as e:
        _run(SdcppProvider("http://sd").generate(
            ImageRequest(prompt="x", width=64, height=64), _sans_suivi, stop))
    assert e.value.code == "cancelled"
    assert ("POST", "/sdcpp/v1/jobs/j9/cancel") in _chemins(reseau.vues)


def test_sdcpp_job_termine_jamais_annule(reseau):
    def h(req):
        if req.url.path.endswith("img_gen"):
            return httpx.Response(202, json={"id": "j2"})
        return httpx.Response(200, json={"status": "failed", "error": {"message": "OOM"}})
    reseau(h)
    with pytest.raises(ImageError) as e:
        _run(SdcppProvider("http://sd").generate(
            ImageRequest(prompt="x", width=64, height=64), _sans_suivi, lambda: False))
    assert e.value.code == "refused" and "OOM" in e.value.detail
    assert "OOM" not in e.value.message, "le détail du moteur reste au journal"
    assert not any(p.endswith("/cancel") for _m, p in _chemins(reseau.vues))


def test_sdcpp_delai_compte_depuis_le_debut_du_calcul(reseau, monkeypatch):
    """Cinq secondes en file ne consomment pas le délai de 2 s : il part du
    début du calcul."""
    horloge = {"t": 1000.0}
    monkeypatch.setattr(sdcpp_mod.time, "monotonic", lambda: horloge["t"])
    monkeypatch.setattr(sdcpp_mod.time, "time", lambda: horloge["t"])
    etats = iter([{"status": "queued", "queue_position": 1}] * 5
                 + [{"status": "generating"},
                    {"status": "completed", "result": {"images": [PNG_B64]}}])

    def h(req):
        if req.url.path.endswith("img_gen"):
            return httpx.Response(202, json={"id": "j3"})
        horloge["t"] += 1.0
        return httpx.Response(200, json=next(etats))
    reseau(h)
    out = _run(SdcppProvider("http://sd", timeout_sec=2).generate(
        ImageRequest(prompt="x", width=64, height=64), _sans_suivi, lambda: False))
    assert len(out) == 1


def test_sdcpp_delai_de_calcul_depasse(reseau, monkeypatch):
    horloge = {"t": 1000.0}
    monkeypatch.setattr(sdcpp_mod.time, "monotonic", lambda: horloge["t"])
    monkeypatch.setattr(sdcpp_mod.time, "time", lambda: horloge["t"])

    def h(req):
        if req.url.path.endswith("img_gen"):
            return httpx.Response(202, json={"id": "j4"})
        if req.url.path.endswith("/cancel"):
            return httpx.Response(409, json={})
        horloge["t"] += 1.0
        return httpx.Response(200, json={"status": "generating"})
    reseau(h)
    with pytest.raises(ImageError) as e:
        _run(SdcppProvider("http://sd", timeout_sec=3).generate(
            ImageRequest(prompt="x", width=64, height=64), _sans_suivi, lambda: False))
    assert e.value.code == "timeout"


def test_sdcpp_job_perdu_et_file_pleine(reseau):
    def perdu(req):
        if req.url.path.endswith("img_gen"):
            return httpx.Response(202, json={"id": "j5"})
        return httpx.Response(404)
    reseau(perdu)
    with pytest.raises(ImageError) as e:
        _run(SdcppProvider("http://sd").generate(
            ImageRequest(prompt="x", width=64, height=64), _sans_suivi, lambda: False))
    assert e.value.code == "engine"
    assert not any(p.endswith("/cancel") for _m, p in _chemins(reseau.vues))

    reseau(lambda req: httpx.Response(429, json={"error": "queue full"}))
    with pytest.raises(ImageError) as e:
        _run(SdcppProvider("http://sd").generate(
            ImageRequest(prompt="x", width=64, height=64), _sans_suivi, lambda: False))
    assert e.value.code == "busy" and e.value.retryable


def test_sdcpp_reponse_trop_volumineuse(reseau, monkeypatch):
    monkeypatch.setattr(sdcpp_mod, "LARGE_BYTES", 1000)

    def h(req):
        if req.url.path.endswith("img_gen"):
            return httpx.Response(202, json={"id": "j6"})
        if req.url.path.endswith("/cancel"):
            return httpx.Response(200, json={})
        return httpx.Response(200, content=b"{" + b" " * 5000 + b"}")
    reseau(h)
    with pytest.raises(ImageError) as e:
        _run(SdcppProvider("http://sd").generate(
            ImageRequest(prompt="x", width=64, height=64), _sans_suivi, lambda: False))
    assert e.value.code == "too_large"


def test_sdcpp_capacites(reseau):
    reseau(lambda req: httpx.Response(200, json={
        "model": {"name": "qwen-image-Q8_0.gguf"}, "current_mode": "img_gen",
        "limits": {"max_width": 2048, "max_batch_count": 8},
        "defaults_by_mode": {"img_gen": {"sample_steps": 20}}}))
    caps = _run(SdcppProvider("http://sd").capabilities())
    assert caps == {"model": "qwen-image-Q8_0.gguf", "mode": "img_gen",
                    "limits": {"max_width": 2048, "max_batch_count": 8},
                    "defaults": {"sample_steps": 20}}


def test_moteur_injoignable(reseau):
    def h(req):
        raise httpx.ConnectError("refusé", request=req)
    reseau(h)
    with pytest.raises(ImageError) as e:
        _run(SdcppProvider("http://sd").capabilities())
    assert e.value.code == "unavailable" and "refusé" in e.value.detail


# ── OpenAI-compatible ─────────────────────────────────────────────────────

def test_openai_generations(reseau):
    reseau(lambda req: httpx.Response(200, json={"data": [
        {"b64_json": PNG_B64, "revised_prompt": "a red square"}]}))
    p = OpenAIProvider("http://h/v1", model="sd-cpp-local", api_key="k")
    out = _run(p.generate(ImageRequest(prompt="x", width=1024, height=1024, n=1),
                          _sans_suivi, lambda: False))
    assert out[0].revised_prompt == "a red square"
    r = reseau.vues[0]
    assert r.url.path == "/v1/images/generations" and r.headers["authorization"] == "Bearer k"
    assert json.loads(r.content) == {"prompt": "x", "n": 1, "size": "1024x1024",
                                     "model": "sd-cpp-local", "response_format": "b64_json"}


def test_openai_gpt_image_sans_response_format_et_url_sans_cle(reseau):
    def h(req):
        if req.url.host == "stockage":
            return httpx.Response(200, content=png())
        return httpx.Response(200, json={"data": [{"url": "https://stockage/x.png"}]})
    reseau(h)
    p = OpenAIProvider("https://api", model="gpt-image-1", api_key="secret")
    _run(p.generate(ImageRequest(prompt="x", width=1024, height=1024), _sans_suivi,
                    lambda: False))
    assert "response_format" not in json.loads(reseau.vues[0].content)
    assert "authorization" not in reseau.vues[1].headers, "la clé ne part pas au stockage"


def test_openai_edition_multipart(reseau):
    reseau(lambda req: httpx.Response(200, json={"data": [{"b64_json": PNG_B64}]}))
    req = ImageRequest(prompt="en bleu", width=64, height=64, init_image=png())
    _run(OpenAIProvider("http://h", model="m").generate(req, _sans_suivi, lambda: False))
    r = reseau.vues[0]
    assert r.url.path == "/v1/images/edits"
    assert b'name="image"; filename="source.png"' in r.content


def test_openai_cle_refusee(reseau):
    reseau(lambda req: httpx.Response(401, json={"error": {"message": "bad key sk-123"}}))
    with pytest.raises(ImageError) as e:
        _run(OpenAIProvider("http://h", model="m").generate(
            ImageRequest(prompt="x", width=64, height=64), _sans_suivi, lambda: False))
    assert e.value.code == "unavailable" and "sk-123" not in e.value.message


def test_openai_stop_abandonne_l_appel(reseau, monkeypatch):
    async def scenario():
        bloque = asyncio.Event()

        async def lent(req):
            await bloque.wait()
            return httpx.Response(200, json={"data": []})
        monkeypatch.setattr(transport_mod, "_TRANSPORT", httpx.MockTransport(lent))
        n = {"i": 0}

        def stop():
            n["i"] += 1
            return n["i"] > 1
        with pytest.raises(ImageError) as e:
            await OpenAIProvider("http://h", model="m").generate(
                ImageRequest(prompt="x", width=64, height=64), _sans_suivi, stop)
        assert e.value.code == "cancelled"
    _run(scenario())


def test_endpoint():
    assert endpoint("http://h:8080", "/v1/models") == "http://h:8080/v1/models"
    assert endpoint("http://h/v1", "/v1/models") == "http://h/v1/models"
    assert endpoint("http://h/v1/models", "/v1/models") == "http://h/v1/models"


# ── Validation ────────────────────────────────────────────────────────────

def _cfg(**k):
    base = {"provider": "sdcpp", "url": "http://sd", "model": "", "max_n": 4, "max_side": 2048,
            "default_side": 1024, "size_policy": "free", "sizes": [], "edit_mode": "init",
            "timeout_sec": 180, "keep_per_user": 50, "max_concurrent": 1}
    base.update(k)
    return base


def test_validation_tailles_libres():
    req = service.build_request(_cfg(), " un phare ", {"size": "1000x570", "n": 2, "seed": 5,
                                                      "steps": 30, "negative_prompt": "flou"})
    assert (req.prompt, req.width, req.height, req.n) == ("un phare", 1024, 576, 2)
    assert (req.seed, req.steps, req.negative_prompt) == (5, 30, "flou")
    for opts, motif in (({"size": "4096x4096"}, "trop grande"), ({"n": 9}, "entre 1 et 4"),
                        ({"size": "abc"}, "invalide")):
        with pytest.raises(ImageError) as e:
            service.build_request(_cfg(), "x", opts)
        assert e.value.code == "invalid" and e.value.status == 400 and motif in e.value.message
    with pytest.raises(ImageError):
        service.build_request(_cfg(), "  ", {})
    with pytest.raises(ImageError) as e:
        service.build_request(_cfg(), "x", {"size": "1024x1024"},
                              caps={"limits": {"max_width": 768}})
    assert "hors des limites" in e.value.message
    with pytest.raises(ImageError):
        service.build_request(_cfg(), "x", {"n": 3}, caps={"limits": {"max_batch_count": 2}})


def test_validation_service_openai():
    cfg = _cfg(provider="openai", size_policy="fixed", sizes=["1024x1024", "1536x1024"],
               model="dall-e-3")
    req = service.build_request(cfg, "x", {"size": "1536x1024", "seed": 5, "steps": 30,
                                           "negative_prompt": "n"})
    assert (req.width, req.seed, req.steps, req.negative_prompt) == (1536, -1, 0, "")
    with pytest.raises(ImageError) as e:
        service.build_request(cfg, "x", {"size": "1000x1000"})
    assert "1536x1024" in e.value.message
    with pytest.raises(ImageError):
        service.build_request(cfg, "x", {"size": "1024x1024", "n": 2})


def test_image_source_recadree():
    req = service.build_request(_cfg(), "x", {"size": "128x64", "strength": 0.4},
                                source=png(100, 100))
    from PIL import Image
    with Image.open(io.BytesIO(req.init_image)) as im:
        assert im.size == (128, 64)
    assert req.strength == 0.4 and req.edit_mode == "init"
    with pytest.raises(ImageError) as e:
        service.build_request(_cfg(), "x", {}, source=b"pas une image")
    assert e.value.code == "invalid"


# ── Capacités : cache et cache négatif ────────────────────────────────────

def test_capacites_en_cache_et_echec_garde(reseau):
    reseau(lambda req: httpx.Response(200, json={"model": {"name": "m"}, "limits": {}}))
    cfg = _cfg()
    assert _run(service.capabilities(cfg))["model"] == "m"
    assert _run(service.capabilities(cfg))["model"] == "m"
    assert len(reseau.vues) == 1, "gardées 60 s"

    service.forget_capabilities()
    reseau.vues.clear()

    def panne(req):
        raise httpx.ConnectError("éteint", request=req)
    reseau(panne)
    for _ in range(3):
        with pytest.raises(ImageError) as e:
            _run(service.capabilities(cfg))
        assert e.value.code == "unavailable"
    assert len(reseau.vues) == 1, "échec gardé : pas de nouvelle connexion"
    assert _run(service.capabilities(_cfg(provider="openai"))) == {}


# ── Créneaux partagés ─────────────────────────────────────────────────────

def test_creneaux_partages_et_attente(tmp_path, monkeypatch):
    monkeypatch.setattr(slots, "SLOT_DIR", tmp_path / "slots")
    monkeypatch.setattr(slots, "_POLL_S", 0.01)

    async def scenario():
        attentes = []

        async def on_wait():
            attentes.append(1)
        a = await slots.acquire("http://gpu", 1, on_wait=on_wait, cancelled=lambda: False)
        second = asyncio.ensure_future(
            slots.acquire("http://gpu", 1, on_wait=on_wait, cancelled=lambda: False))
        await asyncio.sleep(0.05)
        assert not second.done() and attentes == [1]
        a.release_after(0.05)
        b = await asyncio.wait_for(second, 2)
        autre = await slots.acquire("http://autre", 1, on_wait=on_wait, cancelled=lambda: False)
        b.release()
        autre.release()
        tenu = await slots.acquire("http://gpu", 1, on_wait=on_wait, cancelled=lambda: False)
        with pytest.raises(ImageError) as e:
            await slots.acquire("http://gpu", 1, on_wait=on_wait, cancelled=lambda: True)
        assert e.value.code == "cancelled"
        tenu.release()
    _run(scenario())


def test_creneau_garde_apres_un_stop_openai(tmp_path, monkeypatch):
    monkeypatch.setattr(slots, "SLOT_DIR", tmp_path / "slots")

    class Faux:
        async def generate(self, req, on_progress, cancelled):
            raise ImageError("Génération annulée.", code="cancelled")
    monkeypatch.setattr(service, "get_provider", lambda cfg: Faux())

    async def scenario():
        cfg = _cfg(provider="openai", url="http://gpu")
        with pytest.raises(ImageError):
            await service.run_generation(cfg, ImageRequest(prompt="x", width=64, height=64),
                                         _sans_suivi, lambda: False, eta_s=0.2)
        attente = []

        async def on_wait():
            attente.append(1)
        s = await slots.acquire("http://gpu", 1, on_wait=on_wait, cancelled=lambda: False)
        assert attente == [1], "créneau encore tenu après le Stop"
        s.release()
    monkeypatch.setattr(slots, "_POLL_S", 0.05)
    _run(scenario())


# ── TLS ───────────────────────────────────────────────────────────────────

def test_tls_magasin_du_systeme_et_ca():
    assert transport_mod.tls(False) is False
    assert isinstance(transport_mod.tls(True, ""), ssl.SSLContext)
    with pytest.raises(ImageError) as e:
        transport_mod.tls(True, "-----BEGIN CERTIFICATE-----\nnimporte\n-----END CERTIFICATE-----")
    assert e.value.code == "unavailable"


# ── Avancée ───────────────────────────────────────────────────────────────

def test_avancee_sans_pourcentage_invente():
    t = service.ProgressTracker(ImageRequest(prompt="x", width=64, height=32, n=2), eta_s=29.6)
    ev = t.event()
    assert (ev["pct"], ev["pct_real"], ev["eta_s"], ev["state"]) == (None, False, 30, "queued")
    t.update("generating", None, {"pct": 40.0, "preview": "data:image/png;base64,xx"})
    ev = t.event(source="tool")
    assert (ev["pct"], ev["pct_real"], ev["source"]) == (40, True, "tool")
    assert ev["preview"] and "preview" not in t.event(), "aperçu envoyé une fois"


def test_progress_info_ne_lit_que_ce_qui_existe():
    assert sdcpp_mod.progress_info({"status": "generating", "started": 12.5}) == {"started_at": 12.5}
    info = sdcpp_mod.progress_info({"progress": {"step": 5, "steps": 20}})
    assert info["pct"] == 25.0


# ── Enrichissement ────────────────────────────────────────────────────────

def test_enrichissement():
    from llm_core.imagegen import enhance

    async def modele(msgs):
        assert msgs[0]["role"] == "system" and "diffusion" in msgs[0]["content"]
        return "<think>…</think> Prompt: \"A lighthouse in a storm, engraving style\""
    out, why = _run(enhance.enhance_prompt("un phare", model=None, llm_call=modele))
    assert out == "A lighthouse in a storm, engraving style" and why == ""

    async def panne(msgs):
        raise RuntimeError("moteur coupé")
    assert _run(enhance.enhance_prompt("un phare", model=None, llm_call=panne)) == (
        None, "modèle indisponible")
    assert enhance.clean("<think>pas fini", "x") is None
