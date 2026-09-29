# SPDX-License-Identifier: MIT
"""AUDIT 2026-09-26 (4e passe du cœur du harnais) — tests de non-régression.
"""
from __future__ import annotations

import asyncio
import json
import subprocess
import tempfile
import time
import types
from pathlib import Path

import pytest

import llm_core.tools.fs_tools as fs_tools


class _FakeMCP:
    def __init__(self):
        self.tools = {}

    def tool(self, **kw):
        def deco(fn):
            self.tools[fn.__name__] = fn
            return fn
        return deco


@pytest.fixture()
def fs(tmp_path, monkeypatch):
    base = tmp_path / "sandboxes"
    base.mkdir()
    monkeypatch.setenv("APP_SANDBOX_DIR", str(base))
    mcp = _FakeMCP()
    fs_tools.register(mcp, base)
    work = base / "guest" / "work"
    work.mkdir(parents=True, exist_ok=True)
    return mcp.tools, work


def _d(r):
    return r if isinstance(r, dict) else r.model_dump()


# ── MCP : -32000 n'est PAS toujours une panne de tuyau ────────────────────

def test_limiteur_de_debit_mcp_n_est_pas_une_panne_de_transport():
    from mcp.shared.exceptions import McpError
    from mcp.types import ErrorData

    from llm_core._mcp_pool import _is_transport_error

    assert not _is_transport_error(McpError(ErrorData(code=-32000, message="Rate limit exceeded")))
    assert not _is_transport_error(McpError(ErrorData(code=-32000, message="Permission denied")))
    assert _is_transport_error(McpError(ErrorData(code=-32000, message="Connection closed")))
    assert _is_transport_error(McpError(ErrorData(code=32600, message="Session terminated")))


def test_todowrite_declare_serie():
    from llm_core.tools import todo_tools

    mcp = types.SimpleNamespace(kw=None)

    def tool(**kw):
        mcp.kw = kw
        return lambda fn: fn
    mcp.tool = tool
    todo_tools.register(mcp)
    pol = (mcp.kw.get("meta") or {}).get("policy") or {}
    assert pol.get("serial") is True


def test_store_de_reprise_elague_sous_verrou():
    from llm_core.tools import task_tool as T
    assert hasattr(T, "_RESUME_LOCK")
    T._prune_resume_store()                       # pas d'exception


# ── Budget dur ────────────────────────────────────────────────────────────

def _tc(cid):
    return {"id": cid, "type": "function", "function": {"name": "read_file", "arguments": "{}"}}


def _budget_env(monkeypatch, per_msg):
    from llm_core.context import pruning as P

    async def _counts(messages, model_id=None):
        return [per_msg(m) for m in messages]
    monkeypatch.setattr(P, "count_messages_tokens_per_msg", _counts)
    return P


async def test_compteur_de_retrait_meme_quand_l_ancre_compense(monkeypatch):
    """Retrait d'UN message + ``user`` de raccord : longueurs égales, mais la
    vue a bien été élaguée — le compteur doit le dire."""
    P = _budget_env(monkeypatch, lambda m: 3000 if m.get("content") == "grosse" else 100)
    msgs = [{"role": "system", "content": "S"},
            {"role": "user", "content": "grosse"},
            {"role": "assistant", "content": None, "tool_calls": [_tc("a")]},
            {"role": "tool", "tool_call_id": "a", "content": "obs"},
            {"role": "assistant", "content": "fin"},
            {"role": "user", "content": "question"}]
    for i in range(15):
        msgs += [{"role": "assistant", "content": None, "tool_calls": [_tc(f"c{i}")]},
                 {"role": "tool", "tool_call_id": f"c{i}", "content": f"o{i}"}]
    st: dict = {}
    out = await P.fit_context(msgs, ctx_size=10_000, model_id="m", thinking_mode=False,
                              tools_fixed_tokens=0, stats_out=st)
    assert all(m.get("content") != "grosse" for m in out)
    assert st["dropped"] > 0


async def test_ancre_lourde_pas_retiree_pour_la_seule_marge(monkeypatch):
    def _w(m):
        return {"mission": 1000, "vieux": 500, "rep": 700}.get(m.get("content"), 100)
    P = _budget_env(monkeypatch, _w)
    budget = 6000
    overhead = 100_000 - P.BUDGET.reserve_tokens(100_000, 0) - budget
    msgs = [{"role": "system", "content": "S"},
            {"role": "user", "content": "vieux"}, {"role": "assistant", "content": "rep"},
            {"role": "user", "content": "mission"}]
    for i in range(20):
        msgs += [{"role": "assistant", "content": None, "tool_calls": [_tc(f"c{i}")]},
                 {"role": "tool", "tool_call_id": f"c{i}", "content": f"o{i}"}]
    out = await P.enforce_context_budget(msgs, 100_000, model_id="m", gen_cap_tokens=0,
                                         fixed_overhead_tokens=overhead)
    assert any(m.get("content") == "mission" for m in out), "ancre retirée pour la marge"


async def test_plancher_du_tour_courant_revient_tout_ou_rien(monkeypatch):
    """Place revenue (sorties élaguées) : les groupes du tour courant retirés
    reviennent ENSEMBLE sous le filigrane bas, jamais un par un."""
    heavy = {"v": True}
    P = _budget_env(monkeypatch, lambda m: (200 if heavy["v"] else 10)
                    if m.get("role") == "tool" else 50)
    budget = 3000
    overhead = 100_000 - P.BUDGET.reserve_tokens(100_000, 0) - budget
    msgs = [{"role": "system", "content": "S"}, {"role": "user", "content": "mission"}]
    for i in range(20):
        msgs += [{"role": "assistant", "content": None, "tool_calls": [_tc(f"c{i}")]},
                 {"role": "tool", "tool_call_id": f"c{i}", "content": f"o{i}"}]
    st1: dict = {}
    await P.enforce_context_budget(msgs, 100_000, model_id="m", gen_cap_tokens=0,
                                   fixed_overhead_tokens=overhead, stats_out=st1)
    k = st1["drop_floor"]
    assert k > 0
    heavy["v"] = False                                  # sorties élaguées
    st2: dict = {}
    out = await P.enforce_context_budget(msgs, 100_000, model_id="m", gen_cap_tokens=0,
                                         fixed_overhead_tokens=overhead, stats_out=st2,
                                         drop_floor=k)
    assert out == msgs and st2["drop_floor"] == 0


async def test_marque_d_elagage_comptee_une_seule_fois(monkeypatch):
    from llm_core.context import tokens as T
    from llm_core.context.pruning import PRUNE_CLEARED_MARKER
    calls = []

    async def _exact(text, model_id=None, **_k):
        calls.append(text)
        return 7
    monkeypatch.setattr(T, "count_tokens_exact", _exact)
    for _ in range(3):
        # Copies NEUVES à chaque itération, comme ``apply_prune_marks``.
        msgs = [{"role": "tool", "tool_call_id": f"c{i}", "content": PRUNE_CLEARED_MARKER}
                for i in range(50)]
        await T.count_messages_tokens_per_msg_ex(msgs, "m-marque")
    assert len(calls) == 50                         # 1re itération seulement


async def test_disjoncteur_couvre_le_comptage_par_messages(monkeypatch):
    from llm_core import _llama_http as H
    posts = []

    class _E:
        is_llamacpp = True
        is_builtin = False
        base_root = "http://t.test"
        def cache_key(self, m): return m or ""
        def header_dict(self): return {}

    async def _post(path, body, timeout=60.0, *, engine=None):
        posts.append(path)
        return {"_status": 0, "error": "down", "error_type": "ConnectError"}
    monkeypatch.setattr(H, "_engine", lambda engine=None: _E())
    monkeypatch.setattr(H, "_llama_post", _post)
    msgs = [{"role": "user", "content": f"m{i}"} for i in range(40)]
    assert await H.count_tokens_for_messages(msgs, "m") is None
    assert posts == ["/apply-template"], posts      # rendu en échec → disjoncteur
    posts.clear()
    assert await H.count_tokens_for_messages(msgs, "m") is None
    assert posts == []


# ── Boucle : usage, synthèse, rappel todo ─────────────────────────────────

def test_usage_du_run_annule_compte_l_appel_en_vol(monkeypatch):
    import llm_core._chat_with_tools as C
    rec = []
    monkeypatch.setattr(C, "record_turn_usage", lambda **kw: rec.append(kw))
    acc = {"in": 1000, "out": 50, "inflight_in": 8000, "iterations": 2}
    C._record_cancelled_run_usage(acc, time.time())
    assert rec and rec[0]["input_tokens"] == 9000 and rec[0]["status"] == "cancelled"
    rec.clear()
    C._record_cancelled_run_usage({"in": 10, "out": 1}, time.time(),
                                  status="error", error_kind="KeyError")
    assert rec[0]["status"] == "error" and rec[0]["error_kind"] == "KeyError"


async def test_exception_du_run_enregistre_l_usage(monkeypatch):
    import llm_core._chat_with_tools as C
    rec = []
    monkeypatch.setattr(C, "record_turn_usage", lambda **kw: rec.append(kw))

    async def _impl(*a, **k):
        C._RUN_USAGE_ACC.get().update({"in": 500, "out": 20, "iterations": 1})
        raise KeyError("post-traitement")
    monkeypatch.setattr(C, "_run_chat_multi_mcp_impl", _impl)
    with pytest.raises(KeyError):
        await C._run_chat_multi_mcp_wrapper([], [], username="u", chat_id="c")
    assert rec and rec[0]["status"] == "error" and rec[0]["input_tokens"] == 500


async def _run_loop(monkeypatch, messages, *, n_iter=2):
    import llm_core._chat_with_tools as _cwt
    import llm_core._target as _tgt

    async def _anoop(*_a, **_k): return None
    async def _avision(*_a, **_k): return False
    async def _actx(*_a, **_k): return 32000

    class _T:
        is_local_llamacpp = True
    monkeypatch.setattr(_cwt, "verify_llm_availability", _anoop)
    monkeypatch.setattr(_cwt, "_model_supports_vision", _avision)
    monkeypatch.setattr(_cwt, "get_model_context_size", _actx)
    monkeypatch.setattr(_tgt, "current_target", lambda: _T())
    sent = []
    cnt = {"n": 0}

    async def _fake_stream(msgs, tools_payload, **kw):
        sent.append(msgs)
        cnt["n"] += 1
        if cnt["n"] <= n_iter:
            return {"choices": [{"finish_reason": "tool_calls", "message": {
                "role": "assistant", "content": "",
                "tool_calls": [{"id": f"c{cnt['n']}", "type": "function",
                                "function": {"name": "lire", "arguments": "{}"}}]}}],
                "usage": {"prompt_tokens": 100, "completion_tokens": 5}, "timings": {}}
        return {"choices": [{"finish_reason": "stop", "message": {
            "role": "assistant", "content": "fin", "tool_calls": None}}],
            "usage": {"prompt_tokens": 100, "completion_tokens": 5}, "timings": {}}
    monkeypatch.setattr(_cwt, "_llama_chat_with_tools_stream", _fake_stream)
    fits = []
    _real_fit = _cwt._fit_context

    async def _spy_fit(*a, **k):
        fits.append(k)
        return await _real_fit(*a, **k)
    monkeypatch.setattr(_cwt, "_fit_context", _spy_fit)

    async def _lire(_a):
        return {"ok": True}
    await _cwt.run_chat_multi_mcp(
        messages, [], username="u", chat_id="c-t",
        builtin_tools={"lire": {"definition": {"type": "function", "function": {
            "name": "lire", "parameters": {"type": "object"}}}, "handler": _lire}},
        sampling_override={"max_tool_iterations": n_iter})
    return sent, fits


async def test_tour_de_synthese_recoit_le_plancher(monkeypatch):
    _sent, fits = await _run_loop(monkeypatch, [{"role": "user", "content": "go"}])
    assert fits and all("drop_floor" in k for k in fits), \
        "un appel de _fit_context sans plancher (synthèse ?)"


# ── Route : passation, recollage, suffixes ────────────────────────────────

def test_recalage_de_passation_limite_au_partiel_du_run_stoppe():
    from chatbot_app.routes.chats import _handover_rebaseline_ok as ok
    base = [{"role": "user", "content": "q"}]
    tronque = {"role": "assistant", "content": "part", "isTruncated": True}
    assert ok(base, list(base))
    assert ok(base, base + [tronque])
    assert ok(base + [{"role": "assistant", "content": "x", "isTruncated": True}],
              base + [tronque])
    # Tour NORMAL d'un autre onglet : jamais adopté.
    assert not ok(base, base + [{"role": "user", "content": "q2"},
                                {"role": "assistant", "content": "r2"}])
    assert not ok(base, base + [{"role": "assistant", "content": "complet"}])


def test_travail_d_outils_d_un_tour_stoppe_recolle():
    from chatbot_app.routes.chats import _CANCEL_PLACEHOLDER, _graft_stopped_turn_state
    th = [{"role": "assistant", "tool_calls": [_tc("w")]},
          {"role": "tool", "tool_call_id": "w", "content": "écrit"}]
    db = [{"role": "user", "content": "fais"},
          {"role": "assistant", "content": _CANCEL_PLACEHOLDER, "isTruncated": True,
           "tool_history": th}]
    client = [{"role": "user", "content": "fais"},
              {"role": "assistant", "content": _CANCEL_PLACEHOLDER},
              {"role": "user", "content": "continue"}]
    pers = [dict(m) for m in client]
    assert _graft_stopped_turn_state(client, pers, db) == 1
    assert client[1]["tool_history"] == th and pers[1]["tool_history"] == th
    # Question différente juste avant : aucune greffe.
    client2 = [{"role": "user", "content": "autre"}, {"role": "assistant", "content": ""}]
    assert _graft_stopped_turn_state(client2, [dict(m) for m in client2], db) == 0


def test_suffixe_rejoue_sur_la_question_reprise_par_continuer():
    from chatbot_app.routes.chats import _expand_history_for_llm
    from llm_core.context.pruning import user_suffix_sig
    msgs = [{"role": "user", "content": "q"},
            {"role": "assistant", "content": "début", "isTruncated": True}]
    sfx = {user_suffix_sig(0, "q"): "<todo_status>x</todo_status>"}
    out = _expand_history_for_llm(msgs, is_continue=True, user_suffixes=sfx)
    assert "<todo_status>x</todo_status>" in out[0]["content"]


def test_store_retire_les_suffixes_de_l_ancienne_branche(tmp_path, monkeypatch):
    from shared_infra.chat import store
    meta = {"llm_user_suffixes": {"0:aa": "s0", "1:bb": "s1", "2:cc": "s2"}}

    def _merge(user_id, chat_id, mutate):
        mutate(meta)
        return True
    monkeypatch.setattr(store, "_merge_meta_json", _merge)
    store.finalize_turn_meta(1, "c", None, None, False,
                             user_suffixes={"1:dd": None}, suffix_drop_from_rank=1)
    assert meta["llm_user_suffixes"] == {"0:aa": "s0"}
    store.finalize_turn_meta(1, "c", None, None, False,
                             user_suffixes={"1:ee": "neuf"}, suffix_drop_from_rank=1)
    assert meta["llm_user_suffixes"] == {"0:aa": "s0", "1:ee": "neuf"}


# ── Moteur d'édition ─────────────────────────────────────────────────────

def test_multi_insertion_et_remplacement_sur_la_meme_ligne():
    txt = "".join(f"L{i}\n" for i in range(1, 8))
    cur = txt
    for _i, ed in fs_tools._order_multi_edits([
            {"action": "replace", "start_line": 5, "end_line": 6, "content": "R"},
            {"action": "insert", "start_line": 5, "content": "INS"}]):
        cur, _ = fs_tools._apply_one_edit(cur, ed)
    assert cur == "L1\nL2\nL3\nL4\nINS\nR\nL7\n"


def test_multi_regex_count_moins_un():
    out, info = fs_tools._apply_one_edit("a a a\n", {"action": "regex", "pattern": "a",
                                                      "replacement": "b", "count": -1})
    assert out == "b b b\n" and info["replacements"] == 3


def test_ancre_terminee_par_saut_de_ligne():
    out, _ = fs_tools._apply_one_edit("a\nb\nc\n", {"action": "anchor", "anchor_str": "a\n",
                                                     "position": "after", "content": "X"})
    assert out == "a\nX\nb\nc\n"


def test_ancre_derniere_occurrence_chevauchante():
    txt = "x\n\n\nfin\n"
    out, _ = fs_tools._apply_one_edit(txt, {"action": "anchor", "anchor_str": "\n\n",
                                            "position": "after", "occurrence": -1,
                                            "content": "Z"})
    # Dernière correspondance (chevauchante) de « \n\n » : lignes 2-3.
    assert out == "x\n\n\nZ\nfin\n"


def test_action_simple_crlf_normalise_le_remplacement(fs):
    tools, work = fs
    (work / "w.txt").write_bytes(b"un\r\ndeux\r\n")
    r = _d(tools["edit_file"](None, path="w.txt", action="regex", pattern="deux",
                              replacement="trois\r\nquatre"))
    assert r.get("ok"), r
    assert (work / "w.txt").read_bytes() == b"un\r\ntrois\r\nquatre\r\n"


# ── Lecture en flux des gros fichiers ─────────────────────────────────────

def _big(tmp_path, name, data):
    p = tmp_path / name
    p.write_bytes(data)
    return p


def _rd(p, **k):
    base = dict(enc="utf-8", head=0, tail=0, start_line=0, end_line=0, grep="",
                grep_context=0, ignore_case=False, with_line_numbers=True, max_chars=20_000)
    base.update(k)
    return _d(fs_tools._read_large_text(lambda: open(p, "rb"), {"size": p.stat().st_size}, **base))


def test_flux_une_seule_ligne_geante_bornee(tmp_path):
    p = _big(tmp_path, "one.txt", b"x" * 3_000_000)
    for mode in ({}, {"head": 5}, {"tail": 5}, {"start_line": 1, "end_line": 2}, {"grep": "x"}):
        r = _rd(p, **mode)
        assert len(r["content"]) < 21_000 and r["truncated"], mode


def test_flux_numerotation_au_seul_saut_de_ligne(tmp_path):
    p = _big(tmp_path, "cr.txt", b"a\rb\rc\nd\ne\n")
    r = _rd(p, grep="^d")
    assert r["total_lines"] == 3 and r["content"] == "2:d"


def test_flux_tail_lineaire(tmp_path):
    p = _big(tmp_path, "many.txt", b"".join(b"line %d\n" % i for i in range(100_000)))
    t0 = time.perf_counter()
    r = _rd(p, tail=100_000)
    assert time.perf_counter() - t0 < 5
    assert r["content"].rstrip().endswith("line 99999")


# ── list_files / search_text ──────────────────────────────────────────────

def test_glob_recursif_ne_descend_pas_dans_les_dependances(fs, monkeypatch):
    tools, work = fs
    nm = work / "node_modules"
    for i in range(30):
        (nm / f"p{i}").mkdir(parents=True)
        (nm / f"p{i}" / "x.py").write_text("")
    (work / "src").mkdir()
    (work / "src" / "app.py").write_text("")
    monkeypatch.setattr(fs_tools, "MAX_WALK", 20)
    r = _d(tools["list_files"](None, path=".", pattern="**/*.py"))
    assert r.get("ok"), r
    noms = json.dumps(r["items"])
    assert "app.py" in noms and "node_modules" not in noms


def test_recherche_numerote_comme_grep(fs):
    tools, work = fs
    (work / "log.txt").write_bytes(b"a\rb\rc\ncible\n")
    r = _d(tools["list_files"](None, path=".", search_text="cible"))
    assert r["hits"][0]["line"] == 2


# ── Noms longs, git_write, save_stdout ────────────────────────────────────

def _write_beneath_borne_en_octets() -> bool:
    from shared_infra.sandbox import paths
    return hasattr(paths, "_short_leaf")


@pytest.mark.skipif(not _write_beneath_borne_en_octets(),
                    reason="write_beneath sans nom temporaire borné en octets "
                           "(correctif de la passe sandbox du 26/09)")
def test_ecriture_d_un_nom_long_legal(fs):
    tools, work = fs
    nom = "界" * 80 + ".txt"                       # 244 octets : légal
    r = _d(tools["write_file"](None, path=nom, content="ok"))
    assert r.get("ok"), r
    assert (work / nom).read_text() == "ok"


def test_ecriture_ne_suit_pas_un_dossier_lien(fs, tmp_path):
    tools, work = fs
    ailleurs = tmp_path / "ailleurs"
    ailleurs.mkdir()
    (work / "d").mkdir()
    p = work / "d" / "f.txt"
    p.write_text("v1")
    # Dossier remplacé par un lien qui sort de /work : l'agent refuse.
    (work / "d" / "f.txt").unlink()
    (work / "d").rmdir()
    (work / "d").symlink_to(ailleurs, target_is_directory=True)
    r = tools["write_file"](None, path="d/f.txt", content="v2")
    assert r["ok"] is False and r["error"] == "outside_sandbox", r
    assert not (ailleurs / "f.txt").exists()


@pytest.fixture()
def git(tmp_path, monkeypatch):
    import llm_core.tools.git_tools as git_tools
    monkeypatch.setenv("APP_SANDBOX_DIR", str(tmp_path))
    monkeypatch.setattr(git_tools, "_grant_sandbox_access", lambda *a, **k: None)
    mcp = _FakeMCP()
    git_tools.register(mcp, tmp_path)
    work = tmp_path / "guest" / "work"
    work.mkdir(parents=True, exist_ok=True)
    return mcp.tools, work


def test_git_write_preserve_crlf_et_refuse_le_non_utf8(git):
    tools, work = git
    r = tools["git_action"](None, repo="proj", action="init")
    assert _d(r).get("ok"), r
    (work / "proj" / "crlf.txt").write_bytes(b"un\r\ndeux\r\n")
    r = _d(tools["git_write"](None, repo="proj", action="replace", path="crlf.txt",
                              find="deux", replace="trois"))
    assert r.get("ok"), r
    assert (work / "proj" / "crlf.txt").read_bytes() == b"un\r\ntrois\r\n"
    (work / "proj" / "latin.txt").write_bytes("café\n".encode("latin-1"))
    r = _d(tools["git_write"](None, repo="proj", action="replace", path="latin.txt",
                              find="caf", replace="the"))
    assert not r.get("ok")
    assert (work / "proj" / "latin.txt").read_bytes() == "café\n".encode("latin-1")


def test_git_write_regex_garde_anti_redos(git):
    tools, work = git
    tools["git_action"](None, repo="proj", action="init")
    (work / "proj" / "f.txt").write_text("aaaa\n")
    r = _d(tools["git_write"](None, repo="proj", action="replace", path="f.txt",
                              find="(a+)+$", replace="b", regex=True))
    assert not r.get("ok")


def test_save_stdout_ecrit_la_sortie_complete(tmp_path):
    from llm_core.tools import _exec_bridge as B
    root = (tmp_path / "w").resolve()
    root.mkdir()
    res = types.SimpleNamespace(stdout=b"TETE...[omis]...QUEUE", stderr=b"")
    sp = tempfile.SpooledTemporaryFile(max_size=10)
    sp.write(b"A" * 100_000)
    f: dict = {}
    B._save_outputs(f, res, root, root / "out.bin", None, None, sp, None)
    assert f["saved_bytes"] == 100_000 and (root / "out.bin").stat().st_size == 100_000
    # Exécuteur sans ``on_chunk`` : repli sur la capture.
    f = {}
    B._save_outputs(f, res, root, root / "o2.bin", None, None,
                    tempfile.SpooledTemporaryFile(), None)
    assert (root / "o2.bin").read_bytes() == res.stdout


# ── Suites de la passe (26/09, après-midi) ───────────────────────────────

async def test_payload_tool_choice_none_garde_les_outils(monkeypatch):
    """``tool_choice="none"`` : ``tools[]`` reste dans la requête (préfixe KV),
    seule la valeur de ``tool_choice`` change."""
    import llm_core._chat_with_tools as C
    seen = {}

    class _Stop(Exception):
        pass

    async def _post(payload, *a, **k):
        seen.update(payload)
        raise _Stop()
    import llm_core._target as _tgt

    class _T:
        is_local_llamacpp = True
        provider_type = "llamacpp"
        is_llamacpp = True
        wire = "openai"
        model = "m"
    monkeypatch.setattr(_tgt, "current_target", lambda: _T())
    captured = []
    from llm_core.providers import openai_compat as _oai

    def _spy(p, target):
        captured.append(dict(p))
        raise _Stop()
    monkeypatch.setattr(_oai, "sanitize_payload", _spy)
    monkeypatch.setattr(_oai, "endpoint", lambda _t: (None, "http://x.test", {}))
    tools = [{"type": "function", "function": {"name": "t", "parameters": {"type": "object"}}}]
    for choice in ("auto", "none"):
        with pytest.raises(_Stop):
            await C._llama_chat_with_tools_stream(
                [{"role": "user", "content": "q"}], tools, tool_choice=choice)
    assert [c.get("tool_choice") for c in captured] == ["auto", "none"]
    assert all(c.get("tools") for c in captured)


async def test_verrous_asynchrones_hors_boucle(tmp_path, monkeypatch):
    import threading

    from shared_infra.runtime import chat_locks as L
    monkeypatch.setattr(L, "LOCK_DIR", tmp_path / "locks")
    seen = []
    _real = L.acquire

    def _spy(*a, **k):
        seen.append(threading.current_thread() is threading.main_thread())
        return _real(*a, **k)
    monkeypatch.setattr(L, "acquire", _spy)
    fd = await L.acquire_async("gen", 7, "c-async")
    try:
        assert fd is not None and seen == [False]
        assert await L.acquire_async("gen", 7, "c-async") is None   # déjà tenu
        assert await L.count_held_async("gen", user_id=7) == 1
    finally:
        L.release(fd)
    assert await L.count_held_async("gen", user_id=7) == 0


def test_stop_sans_texte_garde_la_bulle_d_outils():
    """Front : la bulle stoppée pendant les outils, sans texte, reçoit le
    placeholder du serveur (sinon ``_keepForPersist`` la retirait)."""
    src = (Path(__file__).resolve().parents[2] / "frontend/js/app-chat.js").read_text()
    i = src.index("function stopGeneration()")
    body = src[i:i + 20000]
    assert "_hadTools" in body and "'_(génération interrompue)_'" in body


# ── Client RAG (constats de la passe RAG, 26/09) ─────────────────────────

def test_rag_jeton_configure_jamais_envoye_a_une_url_tierce(monkeypatch):
    from llm_core import _rag_client as R
    monkeypatch.setattr(R, "get_service_url", lambda: "http://rag.local:8000/")
    monkeypatch.setattr(R, "get_service_token", lambda: "SECRET")
    assert R._token_for(None, None) == "SECRET"
    assert R._token_for("http://rag.local:8000", None) == "SECRET"
    assert R._token_for("http://ailleurs.example", None) == ""
    assert R._token_for("http://ailleurs.example", "explicite") == "explicite"


def test_rag_delais_par_phase_et_pool_elargi():
    from llm_core import _rag_client as R
    t = R._request_timeout(30.0)
    assert t.read == 30.0 and t.connect == 5.0 and t.pool == 10.0
    R._shared_client = None
    c = R._http_client()
    try:
        assert c._transport._pool._max_connections == 32
    finally:
        c.close()
        R._shared_client = None
