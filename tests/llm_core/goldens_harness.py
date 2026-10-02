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
    # Fenêtre de contexte : ``_model_info`` est lu À L'APPEL par la boucle,
    # la fonction de flux, la construction du payload et
    # ``resolve_context_window``. Sans ce patch, la vraie fonction sonderait le
    # moteur (ou rendrait la valeur laissée en cache par un autre test du même
    # worker) : le plafond de génération du payload dépendrait de l'ordre des
    # tests.
    import llm_core._model_info as _mi
    monkeypatch.setattr(_mi, "get_model_context_size", _azero)
    _mi._cached_context_size.clear()
    _mi._cached_context_size_ts.clear()
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


def patch_ids_deterministes(monkeypatch) -> None:
    """``secrets.token_hex`` déterministe : un compteur, unique au sein du
    test (jamais deux fois la même valeur), même suite d'une exécution à
    l'autre. Pour les goldens qui figent des ids générés (dédoublonnage des
    ids d'appel, collisions d'ids du canal texte, jeton de routage des
    journaux d'outils)."""
    import itertools
    import secrets

    _compteur = itertools.count(1)

    def _token_hex(nbytes: Optional[int] = None) -> str:
        largeur = 2 * (nbytes if nbytes is not None else 32)
        return format(next(_compteur), "x").rjust(largeur, "0")[-largeur:]

    monkeypatch.setattr(secrets, "token_hex", _token_hex)


def sommeil_instantane(monkeypatch) -> List[float]:
    """``asyncio.sleep`` sans attente réelle : les backoffs de la boucle
    (hoquet moteur, réponse vide : 2 s × n) rendent la main tout de suite.
    Renvoie la liste des délais demandés, pour les vérifier."""
    import asyncio

    _vrai_sleep = asyncio.sleep
    demandes: List[float] = []

    async def _sleep(delay, result=None):
        demandes.append(float(delay))
        return await _vrai_sleep(0, result)

    monkeypatch.setattr(asyncio, "sleep", _sleep)
    return demandes


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


# ── Goldens de tour complet ────────────────────────────────────────────────

# Champs qui dépendent de l'horloge ou du débit de la machine : retirés avant
# comparaison (tout le reste est figé).
VOLATILS = frozenset({
    "duration", "duration_ms", "elapsed_ms", "elapsed_s", "time_ms",
    "read_tps", "write_tps", "ts", "timestamp", "wait_ms",
})

# Au-delà, une liste de payloads est figée par empreinte plutôt qu'en clair.
PAYLOAD_CLAIR_MAX = 60_000


def assainir(obj: Any) -> Any:
    """Copie de ``obj`` sans les champs ``VOLATILS`` (à toute profondeur)."""
    if isinstance(obj, dict):
        return {k: assainir(v) for k, v in obj.items() if k not in VOLATILS}
    if isinstance(obj, list):
        return [assainir(v) for v in obj]
    return obj


def empreinte(obj: Any) -> str:
    """Empreinte courte et stable de la forme canonique de ``obj``."""
    import hashlib
    return hashlib.sha256(canon(obj).encode("utf-8")).hexdigest()[:16]


def payloads_figes(payloads: List[Dict[str, Any]]) -> Any:
    """Les payloads en clair s'ils restent lisibles, sinon leur empreinte :
    rôles, taille et empreinte de chaque message, empreinte globale. Une
    seule différence d'octet change l'empreinte."""
    if len(canon(payloads)) <= PAYLOAD_CLAIR_MAX:
        return payloads
    out = []
    for p in payloads:
        msgs = p.get("messages") or []
        out.append({
            "cles": sorted(p.keys()),
            "max_tokens": p.get("max_tokens"),
            "outils": [t["function"]["name"] for t in (p.get("tools") or [])],
            "messages": [{"role": m.get("role"),
                          "taille": len(canon(m.get("content"))),
                          "empreinte": empreinte(m)} for m in msgs],
            "empreinte": empreinte(p),
        })
    return out


def figer_tour(nom: str, fake: "FakeClient", evenements: List[Dict[str, Any]],
               final: str, metrics: Dict[str, Any]) -> None:
    """Golden complet d'un tour de boucle (``tests/goldens/boucle_<nom>``) :
    texte final, événements et ``metrics`` assainis, payloads envoyés, et les
    appels remplacés par une panne s'il y en a (``fake.appels_interceptes``,
    ce que la boucle leur a transmis : ils n'atteignent pas le faux client)."""
    fige: Dict[str, Any] = {
        "final": final,
        "evenements": assainir(evenements),
        "metrics": assainir(metrics),
        "payloads": payloads_figes(fake.payloads),
    }
    interceptes = getattr(fake, "appels_interceptes", None)
    if interceptes is not None:
        fige["appels_interceptes"] = payloads_figes(interceptes)
    assert_matches_golden(f"boucle_{nom}", fige)


# ── Tour complet hermétique, pannes et scripts libres ──────────────────────

def etat_de_processus_vierge(monkeypatch) -> None:
    """Remet à neuf les mémoires de processus qu'un autre test du même worker
    a pu remplir et qui changent le déroulé d'un tour : ratio caractères /
    jeton mesuré, support connu de ``continue_final_message`` (canal des
    reprises)."""
    import llm_core._llm_params as _lp
    import llm_core.context.tokens as _tok

    monkeypatch.setattr(_tok, "_measured_ratio", {})
    monkeypatch.setattr(_lp, "_continue_final_cache", {})
    monkeypatch.setattr(_lp, "_continue_final_cache_ts", {})


def avec_pannes(monkeypatch, fake: "FakeClient", panne) -> None:
    """Enveloppe la fonction de flux de la boucle : ``panne(i, kwargs)`` lève
    ou rend une réponse à la place du i-ème appel au moteur ; ``None`` laisse
    passer l'appel réel (faux client HTTP). Ce que la boucle a transmis aux
    appels remplacés est gardé dans ``fake.appels_interceptes``."""
    import llm_core._chat_with_tools as _cwt

    _reel = _cwt._llama_chat_with_tools_stream
    _n = [0]
    fake.appels_interceptes = []

    async def _flux(messages, tools=None, **kw):
        i = _n[0]
        _n[0] += 1
        # Copie profonde : la boucle peut modifier ses listes ensuite.
        trace = json.loads(json.dumps({
            "messages": messages, "tools": tools or [],
            "tool_choice": kw.get("tool_choice")}, ensure_ascii=False))
        try:
            r = panne(i, kw)
        except BaseException:
            fake.appels_interceptes.append(trace)
            raise
        if r is None:
            return await _reel(messages, tools, **kw)
        fake.appels_interceptes.append(trace)
        return r

    monkeypatch.setattr(_cwt, "_llama_chat_with_tools_stream", _flux)


async def jouer_tour(monkeypatch, scripts: List[List[str]], *,
                     socle: str = "SOCLE GOLDEN",
                     messages: Optional[List[Dict[str, Any]]] = None,
                     builtin: Optional[Dict[str, Any]] = None,
                     ctx: Optional[int] = None,
                     panne=None, on_event=None, v2: bool = False,
                     **run_kw):
    """Joue un tour complet de ``run_chat_multi_mcp`` (ou de sa variante
    ``_v2`` à sémaphore inline), hermétique et déterministe : faux client,
    ids et backoffs déterministes, mémoires de processus vierges, échelle
    ``ctx`` optionnelle, pannes optionnelles (``avec_pannes``).

    Renvoie ``(fake, evenements, final, metrics)``. ``on_event`` est appelé
    pour chaque événement APRÈS sa capture (il peut lever, pour simuler un
    Stop pendant une émission)."""
    import llm_core._chat_with_tools as _cwt

    if ctx:
        from tests.llm_core.ctx_scale_harness import hermetic_at_scale
        fake = hermetic_at_scale(monkeypatch, scripts, ctx)
    else:
        fake = patch_hermetic(monkeypatch, scripts)
    patch_ids_deterministes(monkeypatch)
    sommeil_instantane(monkeypatch)
    etat_de_processus_vierge(monkeypatch)
    if panne is not None:
        avec_pannes(monkeypatch, fake, panne)

    evenements: List[Dict[str, Any]] = []
    fake.evenements = evenements

    async def _cb(ev):
        evenements.append(ev)
        if on_event is not None:
            await on_event(ev)

    run = _cwt.run_chat_multi_mcp_v2 if v2 else _cwt.run_chat_multi_mcp
    final, _ev, metrics = await run(
        messages or [
            {"role": "system", "content": socle},
            {"role": "user", "content": "Utilise l'outil zeta_echo puis conclus."},
        ],
        mcp_configs=[],
        builtin_tools=builtin if builtin is not None else builtin_tools(),
        username="golden", chat_id="golden-chat", model="golden-model",
        memory_enabled=False, on_event=_cb, **run_kw)
    return fake, evenements, final, metrics


def _ligne_sse(obj: Dict[str, Any]) -> str:
    return f"data: {json.dumps(obj, ensure_ascii=False)}"


def sse_script(*, raisonnement: str = "", contenu: str = "",
               appel: Optional[Dict[str, str]] = None,
               appels: Optional[List[Dict[str, str]]] = None,
               finish: Optional[str] = "stop",
               prompt_tokens: int = 100, completion_tokens: int = 20) -> List[str]:
    """Flux scripté libre : raisonnement natif (``reasoning_content``), prose,
    puis un appel (``appel``) ou un lot d'appels natifs (``appels``, dans
    l'ordre), puis la ligne de fin. ``finish=None`` : le flux se ferme sans
    ``finish_reason`` (coupure silencieuse)."""
    lignes: List[str] = []
    for texte, cle in ((raisonnement, "reasoning_content"), (contenu, "content")):
        for morceau in (texte[: len(texte) // 2], texte[len(texte) // 2:]):
            if morceau:
                lignes.append(_ligne_sse({"choices": [{"delta": {cle: morceau}}]}))
    lot = list(appels or []) + ([appel] if appel else [])
    if lot:
        lignes.append(_ligne_sse({"choices": [{"delta": {"tool_calls": [{
            "index": i, "id": a.get("id", f"call_{i + 1}"), "type": "function",
            "function": {"name": a["name"], "arguments": a["arguments"]},
        } for i, a in enumerate(lot)]}}]}))
    if finish is not None:
        lignes.append(_ligne_sse({
            "choices": [{"delta": {}, "finish_reason": finish}],
            "usage": {"prompt_tokens": prompt_tokens,
                      "completion_tokens": completion_tokens},
            "timings": {"prompt_n": prompt_tokens},
        }))
    lignes.append("data: [DONE]")
    return lignes


def erreur_http(code: int, corps: str = ""):
    """``httpx.HTTPStatusError`` au corps lisible, comme celle que lève la
    fonction de flux après lecture de la réponse."""
    import httpx

    req = httpx.Request("POST", "http://moteur.invalid/v1/chat/completions")
    resp = httpx.Response(code, request=req, text=corps)
    return httpx.HTTPStatusError(f"HTTP {code}", request=req, response=resp)
