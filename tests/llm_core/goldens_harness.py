# SPDX-License-Identifier: MIT
"""tests/llm_core/goldens_harness.py — harnais partagé des goldens Phase 0.

Les goldens capturent le CONTRAT du pipeline avant le refactor (programme
Phase 0→7) : payload JSON exact envoyé au LLM, séquence d'events NDJSON,
parité des compteurs de tokens. Toute phase suivante doit les laisser
byte-identiques — une dérive volontaire se fait via ``GOLDEN_UPDATE=1``
(le diff du fichier golden EST la review).

Hermétique : zéro réseau, zéro DB, zéro horloge. Tous les points de sortie
sont patchés par ``patch_hermetic`` — le même golden passe sur la VM dev
(sans llama-server) et sur un poste avec serveur.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

GOLDENS_DIR = Path(__file__).resolve().parents[1] / "goldens"


# ── Faux client HTTP (SSE scripté, multi-appels) ────────────────────────────

class FakeResp:
    """Réponse de stream factice : async context manager + aiter_lines."""

    status_code = 200

    def __init__(self, lines: List[str]):
        self._lines = lines

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_a):
        return False

    async def aiter_lines(self):
        for line in self._lines:
            yield line

    async def aclose(self):
        pass


class FakeClient:
    """Client httpx factice : sert un script SSE PAR APPEL et capture chaque
    payload envoyé (``payloads[i]`` = i-ème appel LLM du tour)."""

    def __init__(self, scripts: List[List[str]]):
        self._scripts = list(scripts)
        self._call = 0
        self.payloads: List[Dict[str, Any]] = []
        self.urls: List[str] = []

    def stream(self, _method, url, json=None, headers=None, **_kw):  # noqa: A002 — **_kw : le vrai httpx accepte timeout= par requête
        self.payloads.append(json)
        self.urls.append(url)
        idx = min(self._call, len(self._scripts) - 1)
        self._call += 1
        return FakeResp(self._scripts[idx])


# ── Patch hermétique de run_chat_multi_mcp ──────────────────────────────────

def patch_hermetic(monkeypatch, scripts: List[List[str]]) -> FakeClient:
    """Neutralise tout accès réseau/DB de la boucle et installe le faux
    client. Retourne le FakeClient (payloads capturés)."""
    import llm_core._chat_with_tools as _cwt
    import llm_core._constants as _const
    from llm_core import _llm_params
    from llm_core.providers import openai_compat as _oai

    async def _anoop(*_a, **_k):
        return None

    async def _afalse(*_a, **_k):
        return False

    async def _azero(*_a, **_k):
        return 0

    async def _asampling(*_a, **_k):
        return {}

    import llm_core.context.tokens as _ctx_tokens

    monkeypatch.setattr(_cwt, "verify_llm_availability", _anoop)
    monkeypatch.setattr(_cwt, "_model_supports_vision", _afalse)
    monkeypatch.setattr(_cwt, "get_model_context_size", _azero)
    # /tokenize indisponible → chemin d'estimation heuristique, déterministe
    # (l'autorité tokens vit dans llm_core.context.tokens depuis la Phase 1).
    monkeypatch.setattr(_ctx_tokens, "count_tokens_exact", _anoop)
    monkeypatch.setattr(_llm_params, "resolve_sampling", _asampling)
    # Slot pinning : contrat int, -1 = laisser llama-server choisir —
    # déterministe quel que soit l'hôte (jamais de round-trip /slots).
    async def _aslot(_chat_id):
        return -1

    if hasattr(_const, "resolve_slot_id_async"):
        monkeypatch.setattr(_const, "resolve_slot_id_async", _aslot)
    # Observabilité : pas d'écriture DB depuis les goldens.
    monkeypatch.setattr(_cwt, "_record_tool_call_metric_safe",
                        lambda *a, **k: None)

    fake = FakeClient(scripts)
    monkeypatch.setattr(_oai, "_get_llm_client", lambda *a, **k: fake)
    return fake


# ── Outils builtin déterministes ────────────────────────────────────────────

def builtin_tools() -> Dict[str, Any]:
    """Deux outils au nom volontairement NON trié (zeta avant alpha) pour
    vérifier le tri déterministe du payload ``tools``."""
    def _echo(args):
        return json.dumps({"ok": True, "echo": args}, ensure_ascii=False)

    def _add(args):
        return json.dumps(
            {"ok": True, "sum": (args.get("a") or 0) + (args.get("b") or 0)},
            ensure_ascii=False,
        )

    return {
        "zeta_echo": {
            "definition": {"type": "function", "function": {
                "name": "zeta_echo",
                "description": "Renvoie ses arguments (outil de test golden).",
                "parameters": {"type": "object", "properties": {
                    "msg": {"type": "string"}}},
            }},
            "handler": _echo,
        },
        "alpha_add": {
            "definition": {"type": "function", "function": {
                "name": "alpha_add",
                "description": "Additionne a et b (outil de test golden).",
                "parameters": {"type": "object", "properties": {
                    "a": {"type": "number"}, "b": {"type": "number"}}},
            }},
            "handler": _add,
        },
    }


# ── Scripts SSE canoniques ──────────────────────────────────────────────────

def sse_tool_call(name: str, arguments: str, call_id: str = "call_1") -> List[str]:
    """Un appel d'outil NATIF (delta tool_calls) puis finish=tool_calls."""
    delta = {"choices": [{"delta": {"tool_calls": [{
        "index": 0, "id": call_id, "type": "function",
        "function": {"name": name, "arguments": arguments},
    }]}}]}
    fin = {"choices": [{"delta": {}, "finish_reason": "tool_calls"}],
           "usage": {"prompt_tokens": 120, "completion_tokens": 15},
           "timings": {"prompt_n": 120}}
    return [f"data: {json.dumps(delta)}", f"data: {json.dumps(fin)}", "data: [DONE]"]


def sse_final(text: str, *, finish: str = "stop",
              prompt_tokens: int = 150) -> List[str]:
    """Réponse texte finale streamée en 2 chunks + usage/timings."""
    mid = len(text) // 2
    c1 = {"choices": [{"delta": {"content": text[:mid]}}]}
    c2 = {"choices": [{"delta": {"content": text[mid:]}}]}
    fin = {"choices": [{"delta": {}, "finish_reason": finish}],
           "usage": {"prompt_tokens": prompt_tokens, "completion_tokens": 8},
           "timings": {"prompt_n": prompt_tokens}}
    return [f"data: {json.dumps(c1)}", f"data: {json.dumps(c2)}",
            f"data: {json.dumps(fin)}", "data: [DONE]"]


def sse_text(text: str, *, finish: str = "stop") -> List[str]:
    """Réponse texte d'un seul bloc (chemin legacy : tool call en texte)."""
    c = {"choices": [{"delta": {"content": text}}]}
    fin = {"choices": [{"delta": {}, "finish_reason": finish}],
           "usage": {"prompt_tokens": 100, "completion_tokens": 20},
           "timings": {"prompt_n": 100}}
    return [f"data: {json.dumps(c)}", f"data: {json.dumps(fin)}", "data: [DONE]"]


# ── Comparaison aux goldens ─────────────────────────────────────────────────

def canon(obj: Any) -> str:
    """Sérialisation canonique : clés triées, indentée, UTF-8 lisible."""
    return json.dumps(obj, ensure_ascii=False, indent=2, sort_keys=True)


def assert_matches_golden(name: str, obj: Any) -> None:
    """Compare ``obj`` au fichier golden ; ``GOLDEN_UPDATE=1`` régénère.

    Un golden manquant est une ERREUR (pas d'auto-création silencieuse en
    CI) : générer explicitement via ``GOLDEN_UPDATE=1 pytest …``.
    """
    path = GOLDENS_DIR / f"{name}.json"
    got = canon(obj) + "\n"
    if os.environ.get("GOLDEN_UPDATE") == "1":
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(got, encoding="utf-8")
    assert path.exists(), (
        f"golden manquant : {path} — générer via GOLDEN_UPDATE=1 pytest"
    )
    want = path.read_text(encoding="utf-8")
    assert got == want, (
        f"dérive vs golden « {name} » — si le changement est INTENTIONNEL, "
        f"régénérer via GOLDEN_UPDATE=1 et faire relire le diff du .json"
    )
