# SPDX-License-Identifier: MIT
"""OPTIM 2026-09-26 — passe d'optimisation du cœur du harnais.

Mesures (micro-banc de la boucle outillée, LLM factice) :
- comptage par message : plus de tâche asyncio pour un message déjà
  mémorisé (23 → 12 ms par itération sur 800 messages) ;
- ``/tokenize`` injoignable : disjoncteur + concurrence bornée (330 → 7 ms
  par itération, et plus d'attente de timeout par message) ;
- télémétrie d'outil : attente bornée (une écriture SQLite en contention ne
  retient plus le résultat de l'outil).
"""
from __future__ import annotations

import asyncio
import json
import threading
import time

from llm_core import _llama_http
from llm_core.context import tokens as _tok


class _FakeEngine:
    is_llamacpp = True
    is_builtin = False
    base_root = "http://tokenize.test"

    def cache_key(self, model_id):
        return f"fake:{model_id or ''}"

    def header_dict(self):
        return {}


def _msgs(n, tag):
    return [{"role": "user", "content": f"{tag} message {i} " + "x" * 40}
            for i in range(n)]


async def test_messages_memorises_sans_tache_asyncio(monkeypatch):
    async def _exact(text, model_id=None, **_k):
        return len(text) // 4

    monkeypatch.setattr(_tok, "count_tokens_exact", _exact)
    msgs = _msgs(30, "memo")
    first, _ = await _tok.count_messages_tokens_per_msg_ex(msgs, "m-memo")

    gathered: list = []
    _real_gather = asyncio.gather

    def _spy(*aws, **kw):
        gathered.append(len(aws))
        return _real_gather(*aws, **kw)

    monkeypatch.setattr(_tok.asyncio, "gather", _spy)
    again, fb = await _tok.count_messages_tokens_per_msg_ex(msgs, "m-memo")
    assert again == first and fb == 0
    assert gathered == [], "des tâches ont été créées pour des messages mémorisés"

    # Un seul message nouveau : UNE tâche, pas une par message.
    again, _ = await _tok.count_messages_tokens_per_msg_ex(
        msgs + _msgs(1, "neuf"), "m-memo")
    assert gathered == [1]
    assert again[:30] == first


async def test_disjoncteur_tokenize_serveur_injoignable(monkeypatch):
    posts: list = []

    async def _post(path, body, timeout=60.0, *, engine=None):
        posts.append(path)
        await asyncio.sleep(0.01)
        return {"_status": 0, "error": "connection refused", "error_type": "ConnectError"}

    monkeypatch.setattr(_llama_http, "_engine", lambda engine=None: _FakeEngine())
    monkeypatch.setattr(_llama_http, "_llama_post", _post)
    monkeypatch.setattr(_tok, "count_tokens_exact", _llama_http.count_tokens_exact)

    counts, fb = await _tok.count_messages_tokens_per_msg_ex(_msgs(60, "dead"), "m")
    assert len(counts) == 60 and fb == 60          # estimation par message
    # Concurrence bornée à 8 : seule la première vague part au réseau.
    assert len(posts) <= 8, len(posts)
    assert _llama_http.tokenize_backoff_active(_FakeEngine())

    posts.clear()
    await _tok.count_messages_tokens_per_msg_ex(_msgs(60, "dead2"), "m")
    assert posts == [], "disjoncteur ouvert : aucune requête attendue"


async def test_disjoncteur_se_referme_et_ignore_les_refus_http(monkeypatch):
    status = {"v": 0}
    posts: list = []

    async def _post(path, body, timeout=60.0, *, engine=None):
        posts.append(path)
        if status["v"] == 200:
            return {"_status": 200, "tokens": [1, 2, 3]}
        return {"_status": status["v"], "error": "x",
                "error_type": status.get("et", "ConnectError")}

    monkeypatch.setattr(_llama_http, "_engine", lambda engine=None: _FakeEngine())
    monkeypatch.setattr(_llama_http, "_llama_post", _post)

    # Un refus HTTP (404, 400…) n'est pas une panne de transport.
    status["v"] = 404
    assert await _llama_http.count_tokens_exact("a", "m") is None
    assert not _llama_http.tokenize_backoff_active(_FakeEngine())

    status["v"] = 0
    assert await _llama_http.count_tokens_exact("b", "m") is None
    assert await _llama_http.count_tokens_exact("c", "m") is None
    assert posts == ["/tokenize", "/tokenize"]     # « c » court-circuité

    # Pool saturé ou lecture lente d'un GROS texte : pas une panne serveur.
    _llama_http._TOKENIZE_DOWN_UNTIL.clear()
    status["et"] = "PoolTimeout"
    assert await _llama_http.count_tokens_exact("e", "m") is None
    assert not _llama_http.tokenize_backoff_active(_FakeEngine())
    status["et"] = "ReadTimeout"
    assert await _llama_http.count_tokens_exact("x" * 50_000, "m") is None
    assert not _llama_http.tokenize_backoff_active(_FakeEngine())
    # … mais un délai de lecture sur un texte COURT signe un serveur figé.
    assert await _llama_http.count_tokens_exact("f", "m") is None
    assert _llama_http.tokenize_backoff_active(_FakeEngine())

    # Délai écoulé : le comptage exact reprend.
    monkeypatch.setattr(_llama_http, "_TOKENIZE_BACKOFF_S", 0.0)
    _llama_http._TOKENIZE_DOWN_UNTIL.clear()
    status["v"] = 200
    assert await _llama_http.count_tokens_exact("d", "m") == 3


async def test_telemetrie_lente_ne_retient_pas_le_resultat(monkeypatch):
    from llm_core.engine import tool_exec

    done = threading.Event()

    def _slow_metric(*_a, **_k):
        time.sleep(1.0)                             # SQLite en contention
        done.set()

    monkeypatch.setattr(tool_exec, "log_metric", lambda *a, **k: None)

    async def execute_single(name, _args, meta=None, **_kw):
        return json.dumps({"ok": True})

    t0 = time.perf_counter()
    res = await tool_exec.execute_tool_batch(
        [{"call_id": "c0", "tool_name": "read_file", "final_args": {},
          "meta": None}],
        execute_single=execute_single,
        record_metric=_slow_metric,
        is_tool_failure=lambda _r: False,
        on_event=None, username="u", chat_id="c",
        on_cancel_snapshot=lambda: asyncio.sleep(0), iteration=0,
        is_cancelled=lambda: False,
    )
    dt = time.perf_counter() - t0
    assert json.loads(res[0])["ok"] is True
    assert dt < 0.8, f"résultat retenu {dt:.2f} s par la télémétrie"
    # L'écriture n'est pas perdue : elle se termine en arrière-plan.
    assert await asyncio.to_thread(done.wait, 3.0)


async def test_telemetrie_en_erreur_reste_silencieuse(monkeypatch):
    from llm_core.engine import tool_exec

    def _boom(*_a, **_k):
        raise RuntimeError("database is locked")

    monkeypatch.setattr(tool_exec, "log_metric", lambda *a, **k: None)

    async def execute_single(name, _args, meta=None, **_kw):
        return json.dumps({"ok": True})

    res = await tool_exec.execute_tool_batch(
        [{"call_id": "c0", "tool_name": "read_file", "final_args": {},
          "meta": None}],
        execute_single=execute_single, record_metric=_boom,
        is_tool_failure=lambda _r: False,
        on_event=None, username="u", chat_id="c",
        on_cancel_snapshot=lambda: asyncio.sleep(0), iteration=0,
        is_cancelled=lambda: False,
    )
    assert json.loads(res[0])["ok"] is True


# ── Titre hors du slot du chat ────────────────────────────────────────────

def test_slot_annexe_evite_celui_du_chat():
    from llm_core._constants import resolve_slot_id

    for cid in ("c-1", "c-2", "chat-xyz", "42"):
        own = resolve_slot_id(cid, 4, frozenset())
        away = resolve_slot_id(cid, 4, frozenset(), avoid_own=True)
        assert 0 <= away < 4 and away != own
        # Déterministe, et jamais sur un slot en traitement.
        assert resolve_slot_id(cid, 4, frozenset(), avoid_own=True) == away
        busy = frozenset(s for s in range(4) if s not in (own, 3 if own != 3 else 2))
        free = [s for s in range(4) if s not in busy and s != own]
        assert resolve_slot_id(cid, 4, busy, avoid_own=True) == free[0]
        # Tous les autres occupés : le slot du chat plutôt qu'un run en cours.
        others_busy = frozenset(s for s in range(4) if s != own)
        assert resolve_slot_id(cid, 4, others_busy, avoid_own=True) == own


def test_slot_annexe_sans_effet_sur_un_seul_slot():
    from llm_core import _constants as C
    assert C.resolve_slot_id("c-1", 1, None, avoid_own=True) == \
        C.resolve_slot_id("c-1", 1, None)


async def test_payload_titre_pose_un_slot_distinct(monkeypatch):
    from llm_core import _constants as C
    from llm_core.providers import llamacpp as P

    seen: list = []

    async def _slot(chat_id, *, avoid_own=False):
        seen.append(avoid_own)
        return 3 if avoid_own else 1

    monkeypatch.setattr(C, "resolve_slot_id_async", _slot)

    async def _payload(**kw):
        return await P.build_llama_payload(
            [{"role": "user", "content": "q"}], target_model="m", user_id="u",
            sampling_params={}, llama_native=True, local_llamacpp=True,
            thinking_mode=False, chat_id="c-1", **kw)

    try:
        p_chat = await _payload()
        p_title = await _payload(slot_avoid_own=True)
    except Exception as e:                     # sondes /props indisponibles
        import pytest
        pytest.skip(f"payload non constructible hors serveur : {e}")
    assert seen == [False, True]
    assert p_chat.get("id_slot") == 1 and p_title.get("id_slot") == 3
