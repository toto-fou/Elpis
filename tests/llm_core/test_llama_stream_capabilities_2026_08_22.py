# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_llama_stream_capabilities_2026_08_22.py — capacités
llama-server b10545 câblées dans le harnais.

Tout ce qui est verrouillé ici a d'abord été VÉRIFIÉ contre un llama-server
réel (b10545, mode routeur) : les chaînes d'erreur, les codes HTTP et le
comportement de la reprise viennent de rejeux, pas de la documentation.

  Flux REPRENABLE — l'en-tête ``X-Conversation-Id`` fait survivre la
    génération à la coupure du transport ; on relit le tampon du moteur au
    lieu de rendre un partiel. ⚠ Contrepartie : fermer la connexion n'arrête
    plus le modèle — l'arrêt DOIT passer par ``DELETE /v1/stream``.
  Progression du pré-remplissage — la phase muette (33 s mesurées pour 4 339
    tokens) devient observable, et ``cache/total`` donne enfin le taux de
    réutilisation réel du préfixe KV.
  Contrôle du raisonnement — la seule prise possible sur le chemin OUTILS,
    où ``thinking_budget_tokens`` + ``tools[]`` = 400.
  Sonde sans chargement — ``autoload=false`` : lire les propriétés d'un
    modèle déchargé ne le charge plus.
"""
from __future__ import annotations

import asyncio

import httpx
import pytest

from llm_core.engine.llm_stream import (
    _endpoint_base,
    _reasoning_cap_chars,
    _resume_cut_stream,
    _skipping,
)
from llm_core.providers import llama_stream as ls
from llm_core.providers.llamacpp import (
    SseStreamResult,
    build_llama_payload,
    consume_llama_sse,
)


# ─────────────────────────────────────────────────────────────────────────────
#  Identité de session
# ─────────────────────────────────────────────────────────────────────────────
def test_lidentifiant_de_session_est_stable_entre_workers():
    """Il doit survivre à un recyclage : c'est ce qui permet à un AUTRE worker
    de reprendre le flux."""
    assert ls.conversation_id(1, "chatA") == ls.conversation_id(1, "chatA")


def test_lidentifiant_ne_melange_pas_les_usages():
    a = ls.conversation_id(1, "chatA")
    assert a != ls.conversation_id(1, "chatB")
    # ⚠ Une requête au MÊME identifiant évince la session précédente côté
    # moteur : une compaction ne doit jamais tuer le run qu'elle sert.
    assert a != ls.conversation_id(1, "chatA", purpose="compact")


def test_les_deux_cotes_du_stop_calculent_le_meme_identifiant():
    """AUDIT 2026-08-23 — le producteur (harnais) ne connaît que le NOM
    d'utilisateur, le consommateur (route d'annulation) que son identifiant
    NUMÉRIQUE. Tant que ``user_id`` entrait dans la clé, les deux HMAC
    différaient et ``DELETE /v1/stream`` visait une session inexistante — 404
    classé en succès, aucun journal, génération jamais arrêtée.

    Ce test échoue si quelqu'un remet l'utilisateur dans la dérivation."""
    depuis_le_harnais = ls.conversation_id("alice", "chat-42")   # str
    depuis_la_route   = ls.conversation_id(7, "chat-42")         # int
    assert depuis_le_harnais == depuis_la_route
    assert depuis_le_harnais != ""


def test_pas_didentifiant_sans_conversation():
    assert ls.conversation_id(1, None) == ""
    assert ls.headers_with_conv({"a": "1"}, "") == {"a": "1"}


def test_lidentifiant_nexpose_pas_la_conversation():
    """Le serveur de modèles n'authentifie personne : qui connaît un id peut
    LIRE le flux. Un ``chat`` en clair serait devinable.

    NB : on n'assère plus l'absence de l'identifiant NUMÉRIQUE dans le digest
    — un « 42 » a une chance sur deux d'apparaître dans 32 chiffres hex, et
    l'utilisateur n'entre de toute façon plus dans la clé (cf. le test de
    concordance plus haut)."""
    cid = ls.conversation_id(42, "mon-chat")
    assert "mon-chat" not in cid
    assert len(cid) == 32 and all(c in "0123456789abcdef" for c in cid)


def test_lentete_est_pose_quand_lidentifiant_existe():
    h = ls.headers_with_conv({"Authorization": "x"}, "abc")
    assert h["X-Conversation-Id"] == "abc" and h["Authorization"] == "x"


# ─────────────────────────────────────────────────────────────────────────────
#  Anti-duplication de la reprise
# ─────────────────────────────────────────────────────────────────────────────
async def test_la_reprise_ne_re_affiche_pas_ce_qui_a_deja_ete_lu():
    """La reprise rejoue le flux DEPUIS LE DÉBUT (compteurs en caractères,
    tampon serveur en octets : on ne fait pas coïncider les deux sur de
    l'UTF-8). Ne doit ressortir que l'inédit."""
    vu = []
    cb = _skipping(lambda s: vu.append(s) or asyncio.sleep(0), 5)
    for seg in ("abc", "de", "fgh"):
        await cb(seg)
    assert "".join(vu) == "fgh"


async def test_le_saut_de_reprise_tombe_juste_au_milieu_dun_segment():
    vu = []
    async def _sink(s): vu.append(s)
    cb = _skipping(_sink, 4)
    await cb("abcdef")
    assert vu == ["ef"]


async def test_sans_rien_de_deja_lu_tout_passe():
    vu = []
    async def _sink(s): vu.append(s)
    cb = _skipping(_sink, 0)
    await cb("tout")
    assert vu == ["tout"]


def test_racine_du_serveur_depuis_lurl_de_completion():
    for u, want in (
        ("http://h:8080/v1/chat/completions", "http://h:8080"),
        ("http://h:8080/chat/completions", "http://h:8080"),
        ("http://h:8080", "http://h:8080"),
    ):
        assert _endpoint_base(u) == want


# ─────────────────────────────────────────────────────────────────────────────
#  Quand la reprise ne doit PAS s'appliquer
# ─────────────────────────────────────────────────────────────────────────────
class _T:
    base_url = "http://h:8080"


async def test_pas_de_reprise_sans_session():
    assert await _resume_cut_stream(
        None, _T(), "", "m", httpx.ReadError("x"), req_id="r", user_id="u",
        previous=None, is_cancelled=None,
        on_thinking_token=None, on_content_token=None, stream_timeout=None,
    ) is None


async def test_pas_de_reprise_sur_un_refus_http():
    """Un 4xx/5xx n'a créé AUCUNE session : il n'y a rien à reprendre, et
    réessayer masquerait un refus qu'il faut remonter."""
    err = httpx.HTTPStatusError(
        "400", request=httpx.Request("POST", "http://h/"),
        response=httpx.Response(400))
    assert await _resume_cut_stream(
        None, _T(), "conv", "m", err, req_id="r", user_id="u",
        previous=None, is_cancelled=None,
        on_thinking_token=None, on_content_token=None, stream_timeout=None,
    ) is None


async def test_pas_de_reprise_sur_une_annulation():
    """Une annulation est un ARRÊT VOULU : la reprendre ressusciterait ce que
    l'utilisateur vient d'arrêter."""
    assert await _resume_cut_stream(
        None, _T(), "conv", "m", asyncio.CancelledError(), req_id="r",
        user_id="u", previous=None, is_cancelled=None,
        on_thinking_token=None, on_content_token=None, stream_timeout=None,
    ) is None


# ─────────────────────────────────────────────────────────────────────────────
#  Client HTTP des routes de flux
# ─────────────────────────────────────────────────────────────────────────────
class _FakeResp:
    def __init__(self, status=200, payload=None, text=""):
        self.status_code = status
        self._payload = payload
        self.text = text

    def json(self):
        return self._payload


class _FakeClient:
    def __init__(self, resp):
        self.resp = resp
        self.calls = []

    async def post(self, url, json=None, timeout=None):
        self.calls.append(("POST", url, json))
        return self.resp

    async def request(self, method, url, params=None, timeout=None):
        self.calls.append((method, url, params))
        return self.resp


async def test_lookup_ne_rend_que_les_sessions_demandees():
    c = _FakeClient(_FakeResp(200, [{"conversation_id": "a", "is_done": False}]))
    out = await ls.lookup_streams(c, "http://h:8080", ["a"], "m")
    assert out["a"]["is_done"] is False
    assert c.calls[0][1].endswith("/v1/streams/lookup")


async def test_lookup_ne_leve_jamais():
    class _Boom:
        async def post(self, *a, **k):
            raise RuntimeError("réseau")
    assert await ls.lookup_streams(_Boom(), "http://h", ["a"]) == {}


async def test_larret_moteur_accepte_204_et_404():
    """204 = évincée ; 404 = déjà partie. Les deux valent « c'est arrêté »."""
    for code in (200, 204, 404):
        c = _FakeClient(_FakeResp(code))
        assert await ls.cancel_stream(c, "http://h", "conv") is True


async def test_larret_moteur_est_un_no_op_sans_session():
    c = _FakeClient(_FakeResp(204))
    assert await ls.cancel_stream(c, "http://h", "") is False
    assert not c.calls


async def test_fin_de_raisonnement_exige_un_succes_explicite():
    c = _FakeClient(_FakeResp(200, {"success": False}, "not armed"))
    assert await ls.end_reasoning(c, "http://h", "cmpl-1", "m") is False
    c2 = _FakeClient(_FakeResp(200, {"success": True}))
    assert await ls.end_reasoning(c2, "http://h", "cmpl-1", "m") is True
    assert c2.calls[0][2]["action"] == "reasoning_end"


async def test_fin_de_raisonnement_sans_identifiant_ne_part_pas():
    c = _FakeClient(_FakeResp(200, {"success": True}))
    assert await ls.end_reasoning(c, "http://h", "") is False
    assert not c.calls


# ─────────────────────────────────────────────────────────────────────────────
#  Seuil de fermeture du raisonnement
# ─────────────────────────────────────────────────────────────────────────────
def test_aucun_seuil_quand_la_reflexion_est_non_plafonnee(monkeypatch):
    """⚠ Le mur de réflexion a été RETIRÉ volontairement (2026-08-17). Sans
    ``max_tokens`` ni budget explicite, ce garde-fou doit rester muet."""
    from shared_infra import config as cfg
    monkeypatch.setattr(cfg, "LLAMA_REASONING_SOFT_BUDGET_TOKENS", 0)
    assert _reasoning_cap_chars({}) == 0


def test_le_seuil_suit_le_plafond_de_generation(monkeypatch):
    from llm_core.context.tokens import CHARS_PER_TOKEN
    from shared_infra import config as cfg
    monkeypatch.setattr(cfg, "LLAMA_REASONING_SOFT_BUDGET_TOKENS", 0)
    assert _reasoning_cap_chars({"max_tokens": 1000}) == int(800 * CHARS_PER_TOKEN)


def test_le_budget_explicite_gagne_sil_est_plus_bas(monkeypatch):
    from llm_core.context.tokens import CHARS_PER_TOKEN
    from shared_infra import config as cfg
    monkeypatch.setattr(cfg, "LLAMA_REASONING_SOFT_BUDGET_TOKENS", 100)
    assert _reasoning_cap_chars({"max_tokens": 1000}) == int(100 * CHARS_PER_TOKEN)


# ─────────────────────────────────────────────────────────────────────────────
#  Payload : les trois réglages, et seulement sur une cible llama.cpp
# ─────────────────────────────────────────────────────────────────────────────
async def _payload(**kw):
    base = dict(target_model="m", user_id="u", sampling_params={},
                llama_native=True, local_llamacpp=False, thinking_mode=False,
                chat_id=None)
    base.update(kw)
    return await build_llama_payload([{"role": "user", "content": "x"}], **base)


async def test_progression_et_ping_sont_demandes_a_llamacpp():
    p = await _payload()
    assert p["return_progress"] is True
    assert p["sse_ping_interval"] > 0


async def test_rien_de_tout_ca_sur_une_cible_non_llamacpp():
    """Un fournisseur strict rejette un champ inconnu — l'inverse de
    llama.cpp, qui les ignore."""
    p = await _payload(llama_native=False)
    for k in ("return_progress", "sse_ping_interval", "reasoning_control"):
        assert k not in p


async def test_le_controle_du_raisonnement_est_arme_avec_la_reflexion():
    assert (await _payload(thinking_mode=True)).get("reasoning_control") is True
    assert "reasoning_control" not in (await _payload(thinking_mode=False))


# ─────────────────────────────────────────────────────────────────────────────
#  Lecture du flux : identifiant de complétion + progression
# ─────────────────────────────────────────────────────────────────────────────
class _FakeStream:
    def __init__(self, lines):
        self._lines = lines

    async def aiter_lines(self):
        for l in self._lines:
            yield l

    async def aclose(self):
        pass


async def test_le_flux_capture_lidentifiant_et_la_progression():
    vus = []
    async def _pp(pp): vus.append(pp)
    from llm_core._stream_tag_parser import ThinkTagSplitter
    r = await consume_llama_sse(
        _FakeStream([
            'data: {"id":"cmpl-42","prompt_progress":{"total":10,"cache":4,"processed":4,"time_ms":90}}',
            'data: {"id":"cmpl-42","prompt_progress":{"total":10,"cache":4,"processed":10,"time_ms":180}}',
            'data: {"id":"cmpl-42","choices":[{"delta":{"content":"salut"}}]}',
            'data: [DONE]',
        ]),
        tag_splitter=ThinkTagSplitter(), req_id="r", user_id="u",
        on_prompt_progress=_pp)
    assert r.completion_id == "cmpl-42"
    assert r.prompt_progress["processed"] == 10
    assert len(vus) == 2, "chaque progression doit être relayée"
    assert r.content() == "salut", (
        "un chunk de progression ne doit pas polluer le contenu")


async def test_une_ligne_de_ping_ne_casse_pas_le_flux():
    """Le serveur ping avec des lignes de COMMENTAIRE SSE (« : ping ») dès
    qu'il reste muet — c'est ce qui rend le pré-remplissage observable."""
    from llm_core._stream_tag_parser import ThinkTagSplitter
    r = await consume_llama_sse(
        _FakeStream([': ping', '', 'data: {"choices":[{"delta":{"content":"ok"}}]}']),
        tag_splitter=ThinkTagSplitter(), req_id="r", user_id="u")
    assert r.content() == "ok"


# ─────────────────────────────────────────────────────────────────────────────
#  Inventaire des modèles + sonde sans chargement
# ─────────────────────────────────────────────────────────────────────────────
async def test_linventaire_lit_le_statut_de_chaque_modele(monkeypatch):
    from llm_core.providers import llama_models as lm
    lm._cache["ts"] = 0.0
    class _C:
        async def get(self, url, timeout=None):
            return _FakeResp(200, {"data": [
                {"id": "a", "status": {"value": "loaded"}},
                {"id": "b", "status": {"value": "unloaded"}}]})
    # ⚠ ``llm_core.__init__`` expose une fonction ``_client`` qui MASQUE le
    # sous-module du même nom : ``import llm_core._client as x`` rend la
    # fonction. On passe par sys.modules.
    import sys as _sys
    monkeypatch.setattr(_sys.modules["llm_core._client"],
                        "_get_llm_client", lambda *a, **k: _C())
    st = await lm.model_statuses("http://h:8080", force=True)
    assert st == {"a": "loaded", "b": "unloaded"}
    assert await lm.is_loaded("a", "http://h:8080") is True
    assert await lm.is_loaded("b", "http://h:8080") is False


async def test_serveur_sans_inventaire_rend_inconnu_pas_decharge(monkeypatch):
    """``None`` ≠ ``False`` : un build mono-modèle ne doit pas passer pour un
    modèle déchargé, sinon le widget annoncerait un chargement fantôme."""
    from llm_core.providers import llama_models as lm
    lm._cache["ts"] = 0.0
    class _C:
        async def get(self, url, timeout=None):
            return _FakeResp(404, None)
    # ⚠ ``llm_core.__init__`` expose une fonction ``_client`` qui MASQUE le
    # sous-module du même nom : ``import llm_core._client as x`` rend la
    # fonction. On passe par sys.modules.
    import sys as _sys
    monkeypatch.setattr(_sys.modules["llm_core._client"],
                        "_get_llm_client", lambda *a, **k: _C())
    assert await lm.is_loaded("a", "http://h:8080") is None


@pytest.mark.asyncio
async def test_la_sonde_de_contexte_ninterdit_plus_le_chargement_par_accident(
        monkeypatch):
    """``autoload=false`` sur les sondes ``/props?model=`` : lire les
    propriétés d'un modèle déchargé le CHARGEAIT (invariant historique
    model-select-no-autoload).

    Vérifié sur les URL RÉELLEMENT construites, et non sur le texte du module :
    le suffixe dépend désormais des capacités du moteur (cf. ``llama_caps``),
    donc il ne s'écrit plus en toutes lettres dans le code.
    """
    import llm_core._model_info as mi

    vues = []

    async def _get(path, timeout=None):
        vues.append(path)
        return None                     # aucune donnée : on ne teste que l'URL

    monkeypatch.setattr(mi, "_llama_get", _get, raising=True)
    mi.invalidate_context_size_cache()
    await mi.get_model_context_size("mon-modele")
    await mi.get_model_total_slots("mon-modele")

    ciblees = [p for p in vues if p.startswith("/props?model=")]
    assert len(ciblees) == 2, vues
    assert all("autoload=false" in p for p in ciblees), ciblees


def test_le_widget_de_file_suit_le_moteur_et_non_notre_cache():
    from llm_core._queue import _build_queue_status
    # Notre cache est vide/faux ; le moteur dit « c'est bien ce modèle ».
    assert _build_queue_status("m", None, 0, "m") == {"kind": "ready"}
    # Le moteur dit qu'un AUTRE modèle est chargé → chargement annoncé.
    assert _build_queue_status("m", None, 0, "autre")["kind"] == "loading"
