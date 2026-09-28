# SPDX-License-Identifier: MIT
"""tests/llm_core/test_llm_error_taxonomy.py — familles de panne LLM.

``llm_error_is_fatal`` répond « faut-il retenter ? » ; ça ne suffit pas à
PARLER à l'utilisateur. Un 400 « conversation trop longue » et un 400 « schéma
d'outil invalide » sont tous deux fatals, mais seul le premier se résout en
compactant. Avant cette taxonomie, les deux sortaient en « Requête LLM rejetée
par le serveur : Client error '400 Bad Request' for url … », et le chemin
classic les affichait même tous les deux comme « Erreur de connexion au
modèle » (le test ``"http" in str(err)`` matchait l'URL de TOUTE erreur httpx).
"""
from __future__ import annotations

import httpx
import pytest

from llm_core._llm_retry import (
    KIND_CONTEXT_OVERFLOW,
    KIND_INVALID_REQUEST,
    KIND_LOADING,
    KIND_RATE_LIMITED,
    KIND_TIMEOUT,
    KIND_UNREACHABLE,
    LLMFailure,
    llm_error_kind,
    llm_error_user_message,
)


def _http_error(status: int, body: str = "") -> httpx.HTTPStatusError:
    req = httpx.Request("POST", "http://127.0.0.1:8080/v1/chat/completions")
    resp = httpx.Response(status, text=body, request=req)
    return httpx.HTTPStatusError("boom", request=req, response=resp)


# ─── Dépassement de contexte : le cas nommé ──────────────────────────────────

@pytest.mark.parametrize("body", [
    # Formulations réellement émises par llama-server selon les versions…
    '{"error":{"message":"the request exceeds the available context size. '
    'try increasing the context size or enable context shift","code":400}}',
    '{"error":{"message":"input is too large to process. increase the physical '
    'batch size","code":400}}',
    # …et par les cibles distantes OpenAI-compatible.
    '{"error":{"message":"This model\'s maximum context length is 8192 tokens",'
    '"code":"context_length_exceeded"}}',
])
def test_contexte_depasse_est_reconnu(body):
    e = _http_error(400, body)
    assert llm_error_kind(e) == KIND_CONTEXT_OVERFLOW


def test_message_contexte_est_actionnable():
    """Le message doit dire QUOI FAIRE, pas seulement ce qui s'est passé."""
    msg = llm_error_user_message(_http_error(
        400, '{"error":{"message":"the request exceeds the available context size"}}'))
    assert "contexte" in msg.lower()
    assert "compactez" in msg.lower()          # geste n° 1
    assert "nouveau chat" in msg.lower()       # geste n° 2
    assert "http" not in msg.lower()           # aucun jargon de transport


def test_400_non_contextuel_reste_distinct():
    """Un schéma d'outil refusé ne doit PAS conseiller de compacter."""
    e = _http_error(400, '{"error":{"message":"invalid tool schema: missing '
                         'required property \'name\'"}}')
    assert llm_error_kind(e) == KIND_INVALID_REQUEST
    assert "compactez" not in llm_error_user_message(e).lower()


# ─── Les autres familles ─────────────────────────────────────────────────────

def test_familles_transport_et_statut():
    req = httpx.Request("POST", "http://127.0.0.1:8080/v1/chat/completions")
    assert llm_error_kind(httpx.ConnectError("refused", request=req)) == KIND_UNREACHABLE
    assert llm_error_kind(httpx.ReadTimeout("slow", request=req)) == KIND_TIMEOUT
    assert llm_error_kind(_http_error(503)) == KIND_LOADING
    assert llm_error_kind(_http_error(429)) == KIND_RATE_LIMITED


def test_chaque_famille_a_un_message_distinct_et_actionnable():
    req = httpx.Request("POST", "http://127.0.0.1:8080/v1/chat/completions")
    msgs = [
        llm_error_user_message(x) for x in (
            _http_error(400, "exceeds the available context size"),
            _http_error(400, "invalid tool schema"),
            _http_error(503), _http_error(429),
            httpx.ConnectError("refused", request=req),
            httpx.ReadTimeout("slow", request=req),
        )
    ]
    assert len(set(msgs)) == len(msgs), "deux familles partagent le même message"
    for m in msgs:
        assert m.endswith("."), m
        # Chaque message porte un geste : impératif ou infinitif d'action.
        assert any(v in m.lower() for v in (
            "compactez", "réessayer", "relancez", "patientez", "vérifiez",
            "changez", "ouvrez")), m


# ─── LLMFailure : message pour l'humain, détail pour le journal ──────────────

def test_llmfailure_expose_message_et_detail_separement():
    """``str(exc)`` remonte tel quel jusqu'à la bulle de chat : il doit être
    lisible. Le motif technique reste disponible à côté, pas à la place."""
    cause = _http_error(400, '{"error":{"message":"the request exceeds the '
                             'available context size"}}')
    exc = LLMFailure(cause, attempts=1)

    assert exc.kind == KIND_CONTEXT_OVERFLOW
    assert "compactez" in str(exc).lower()
    assert "400" not in str(exc)                     # pas de jargon HTTP
    assert "HTTPStatusError" in exc.detail           # …conservé dans le détail
    assert "exceeds the available context size" in exc.detail
    assert "1 tentative(s)" in exc.detail


def test_corps_illisible_retombe_sur_le_code_http():
    """Réponse streaming jamais lue (``ResponseNotRead``) : on ne doit pas
    planter, juste classer d'après le statut."""
    req = httpx.Request("POST", "http://x/v1/chat/completions")
    resp = httpx.Response(400, request=req,
                          stream=httpx.ByteStream(b"peu importe"))
    e = httpx.HTTPStatusError("boom", request=req, response=resp)
    with pytest.raises(httpx.ResponseNotRead):
        _ = resp.text                                 # le piège est bien réel
    assert llm_error_kind(e) == KIND_INVALID_REQUEST  # …et il est absorbé
