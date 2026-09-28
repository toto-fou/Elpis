# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_desktop_transport_retry.py — retransmission transport R3.

``_agent_req`` rejoue les erreurs RÉSEAU (ConnectionError/Timeout) UNIQUEMENT
pour les endpoints IDEMPOTENTS (lecture pure), jamais pour les endpoints MUTANTS
(risque de double action). Un ReadTimeout sur /wait_* n'est PAS rejoué (on a déjà
attendu). Une réponse 503 agent_busy est une réponse HTTP → aucun retry.
"""
from __future__ import annotations

import pytest
import requests

from llm_core.tools import desktop_tools as dt


class _Resp:
    def __init__(self, status=200, payload=None):
        self.status_code = status
        self._payload = payload if payload is not None else {"ok": True}
        self.text = ""

    def json(self):
        return self._payload


class _FakeSession:
    """Session dont get/post lèvent l'exception programmée aux N premiers appels,
    puis répondent 200. Journalise le nombre total d'appels par endpoint."""

    def __init__(self, exc=None, fail_times=0, final=None):
        self.exc = exc
        self.fail_times = fail_times
        self.final = final if final is not None else _Resp(200)
        self.calls = 0

    def _do(self, url, **kw):
        self.calls += 1
        if self.calls <= self.fail_times and self.exc is not None:
            raise self.exc
        return self.final

    def get(self, url, timeout=None, **kw):
        return self._do(url, **kw)

    def post(self, url, json=None, timeout=None, **kw):
        return self._do(url, **kw)


TARGET = {"name": "vm1", "agent_url": "http://vm1:8765"}


@pytest.fixture(autouse=True)
def _no_sleep(monkeypatch):
    monkeypatch.setattr(dt.time, "sleep", lambda s: None)


def _run(monkeypatch, endpoint, *, exc, fail_times, retries=1, method="POST"):
    monkeypatch.setattr(dt._cfg, "DESKTOP_TRANSPORT_RETRIES", retries, raising=False)
    sess = _FakeSession(exc=exc, fail_times=fail_times)
    monkeypatch.setattr(dt, "_AGENT_SESSION", sess)
    out = dt._agent_req(TARGET, endpoint, method=method)
    return out, sess


def test_idempotent_conn_error_retried_then_succeeds(monkeypatch):
    out, sess = _run(monkeypatch, "/ui_tree",
                     exc=requests.exceptions.ConnectionError(), fail_times=1)
    assert out.get("ok") is True
    assert sess.calls == 2, "1 échec réseau + 1 retry réussi"


def test_mutating_endpoint_never_retried(monkeypatch):
    out, sess = _run(monkeypatch, "/click",
                     exc=requests.exceptions.ConnectionError(), fail_times=1)
    assert out.get("error") == "agent_unreachable"
    assert sess.calls == 1, "un endpoint mutant n'est JAMAIS rejoué"


def test_element_is_mutating_not_retried(monkeypatch):
    # /element = action sémantique (toggle/click/set_value) → MUTANT.
    out, sess = _run(monkeypatch, "/element",
                     exc=requests.exceptions.ConnectionError(), fail_times=1)
    assert out.get("error") == "agent_unreachable"
    assert sess.calls == 1


def test_wait_endpoint_not_retried_on_timeout(monkeypatch):
    # ReadTimeout sur /wait_* : on a déjà attendu → pas de retry.
    out, sess = _run(monkeypatch, "/wait_element",
                     exc=requests.exceptions.Timeout(), fail_times=1)
    assert out.get("error") == "agent_timeout"
    assert sess.calls == 1


def test_wait_endpoint_retried_on_conn_error(monkeypatch):
    # ConnectionError (connexion jamais établie) sur /wait_* : rejouable.
    out, sess = _run(monkeypatch, "/wait_element",
                     exc=requests.exceptions.ConnectionError(), fail_times=1)
    assert out.get("ok") is True
    assert sess.calls == 2


def test_retries_bounded(monkeypatch):
    # Échec réseau persistant → au plus 1 + retries tentatives, puis abandon.
    out, sess = _run(monkeypatch, "/ui_tree",
                     exc=requests.exceptions.ConnectionError(), fail_times=99, retries=2)
    assert out.get("error") == "agent_unreachable"
    assert sess.calls == 3, "1 essai initial + 2 retries"


def test_retries_disabled(monkeypatch):
    out, sess = _run(monkeypatch, "/ui_tree",
                     exc=requests.exceptions.ConnectionError(), fail_times=99, retries=0)
    assert out.get("error") == "agent_unreachable"
    assert sess.calls == 1, "transport_retries=0 → comportement historique"


def test_503_maps_to_agent_busy_no_retry(monkeypatch):
    monkeypatch.setattr(dt._cfg, "DESKTOP_TRANSPORT_RETRIES", 2, raising=False)
    sess = _FakeSession(final=_Resp(503, {"detail": "op 'click' bloquée"}))
    monkeypatch.setattr(dt, "_AGENT_SESSION", sess)
    out = dt._agent_req(TARGET, "/ui_tree")
    # err() n'ajoute la clé ``retryable`` que si True → absente = non-rejouable.
    assert out.get("error") == "agent_busy" and not out.get("retryable")
    assert "bloquée" in (out.get("message") or "")
    assert sess.calls == 1, "503 = réponse HTTP, pas d'erreur transport → aucun retry"
