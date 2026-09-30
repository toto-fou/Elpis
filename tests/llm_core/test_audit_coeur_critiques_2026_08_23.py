# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_audit_coeur_critiques_2026_08_23.py — audit du cœur
2026-08-23, les huit constats CRITIQUES.

C1 STREAM   Une fin de flux sans ``finish_reason`` s'auto-désarmait dès qu'un
            delta ``tool_calls`` avait été reçu — c'est-à-dire exactement le cas
            d'une coupure au milieu des ARGUMENTS. Le JSON tronqué était accepté,
            l'outil exécuté avec ``args={}``, son résultat parasite persisté.
C2 CAPS     Une sonde /props en échec était mémorisée 300 s comme un succès.
            ``resumable_stream`` exigeant une preuve, l'arrêt moteur devenait un
            no-op silencieux : le modèle continuait de générer après le Stop.
C3 MCP      La sentinelle interne « entry évincée » était une ``RuntimeError``
            nue : classée « erreur SERVEUR », elle partait vers le modèle et
            remettait ``healthy=True`` sur une entrée qui n'est plus la nôtre.
C4 FS       ``manage_files(delete, '/work')`` effaçait TOUT le bac à sable et
            rendait ``ok: true``. « . », « work », « ./work » y menaient aussi —
            et « . » est le défaut de ``list_files``.
C5 PRUNE    Deux sorties identiques d'un outil idempotent partagent la même clé
            d'élagage : marquer l'ancienne effaçait la RÉCENTE.
C6 SHELL    ``execute_shell(background=true)`` ne satisfaisait aucune branche de
            son ``outputSchema`` : l'appel échouait toujours, APRÈS avoir lancé
            le processus.
C7 RAG      La collection choisie n'était jamais transmise : recherche sur la
            collection par défaut, nom voulu recollé sur les résultats.
C8 PW       Aucun contrôle de propriété sur les sessions Playwright côté outils.
"""
from __future__ import annotations

import json

import pytest

# ── C4 — la racine du bac à sable n'est pas supprimable ──────────────────────

def test_la_racine_du_bac_a_sable_est_refusee_a_la_suppression(tmp_path):
    from llm_core.tools.fs_tools import _rel

    sb = tmp_path / "work"
    for variante in ("/work", "work", "./work", ".", ""):
        with pytest.raises(ValueError):
            _rel(sb, variante, allow_root=False)

    # …et un enfant reste évidemment résoluble.
    assert _rel(sb, "projet/main.py", allow_root=False) == "projet/main.py"
    # Le défaut historique n'a pas bougé (list_files, read_file…).
    assert _rel(sb, ".") == ""


def test_les_branches_destructrices_refusent_la_racine(tmp_path, monkeypatch):
    """delete, move et batch_delete refusent la racine ; rien n'est touché."""
    from llm_core.tools import fs_tools

    class _MCP:
        tools: dict = {}

        def tool(self, **kw):
            def deco(fn):
                self.tools[fn.__name__] = fn
                return fn
            return deco
    base = tmp_path / "sandboxes"
    work = base / "guest" / "work"
    (work / "projet").mkdir(parents=True)
    (work / "projet" / "main.py").write_text("x", encoding="utf-8")
    monkeypatch.setenv("APP_SANDBOX_DIR", str(base))
    mcp = _MCP()
    fs_tools.register(mcp, base)
    mf = mcp.tools["manage_files"]

    for variante in ("/work", "work", "./work", "."):
        for act in ("delete", "move"):
            r = mf(None, action=act, path=variante, dest="ailleurs", recursive=True)
            assert r["ok"] is False and r["error"] == "refus_racine", (act, variante, r)
    r = mf(None, action="batch_delete", paths=["projet/main.py", "."], recursive=True)
    assert r["ok"] is False and r["error"].startswith("bad_path")
    assert (work / "projet" / "main.py").read_text(encoding="utf-8") == "x"


# ── C5 — une signature ambiguë n'est jamais marquée ──────────────────────────

async def test_une_sortie_identique_recente_n_est_pas_effacee(monkeypatch):
    from llm_core.context import pruning as P

    async def _compte(msgs, model_id=None):
        return [len(m["content"]) for m in msgs]
    monkeypatch.setattr(P, "count_messages_tokens_per_msg", _compte)

    sortie = "total 4\ndrwxr-xr-x projet\n" + "x" * 4000
    msgs = [{"role": "system", "content": "s"},
            {"role": "user", "content": "u"}]
    for i in range(12):
        msgs.append({"role": "assistant", "content": None, "tool_calls": [
            {"id": "call_0", "type": "function",
             "function": {"name": "execute_shell", "arguments": "{}"}}]})
        # itérations 0 et 11 : MÊME sortie (ls d'un dossier inchangé)
        contenu = sortie if i in (0, 11) else f"sortie unique {i}" + "y" * 4000
        msgs.append({"role": "tool", "tool_call_id": "call_0", "content": contenu})

    keys = await P.select_prune_keys(msgs, model_id="m", ctx_size=8192)
    cle_ambigue = P._prune_key({"tool_call_id": "call_0", "content": sortie})
    assert cle_ambigue not in keys, (
        "la clé partagée par une sortie ancienne ET la plus récente a été "
        "marquée : le modèle relirait « [Old tool output cleared] » à la place "
        "du résultat qu'il vient de produire")


def test_marquer_une_sortie_unique_reste_possible():
    """La garde ne doit pas neutraliser l'élagage : une signature qui
    n'apparaît qu'une fois reste marquable."""
    from llm_core.context.pruning import PRUNE_CLEARED_MARKER, _prune_key, apply_prune_marks

    msgs = [{"role": "tool", "tool_call_id": "call_0", "content": "A" * 100},
            {"role": "tool", "tool_call_id": "call_0", "content": "B" * 100}]
    k = _prune_key(msgs[0])
    vue = apply_prune_marks(msgs, {k})
    assert vue[0]["content"] == PRUNE_CLEARED_MARKER
    assert vue[1]["content"] == "B" * 100


# ── C6 — le mode détaché a enfin une branche de schéma ───────────────────────

def test_le_retour_du_mode_detache_valide_son_schema():
    from llm_core.tools._models import BackgroundShellResult

    charge = {"ok": True, "background": True, "pid": 4242,
              "cmd": "python3 -m http.server",
              "log": "/work/.logs/http.log", "hint": "kill 4242"}
    m = BackgroundShellResult(**charge)
    assert m.ok is True and m.pid == 4242


def test_execute_shell_annonce_les_trois_branches():
    import inspect

    from llm_core.tools import shell_tools

    src = inspect.getsource(shell_tools)
    assert "Union[ExecuteShellResult, BackgroundShellResult, ErrEnvelope]" in src, \
        "le mode background n'a pas de branche dans l'outputSchema"


# ── C7 — la collection demandée arrive jusqu'à la recherche ──────────────────

def test_la_collection_est_transmise_a_la_recherche():
    from llm_core.tools.rag_tools import _run_search

    vus = {}

    class _Mod:
        @staticmethod
        def rag_search_only(**kw):
            vus.update(kw)
            return {"ok": True, "results": [{"text": "t"}]}

    _run_search(_Mod(), {"collection": "juridique"}, "contrat", 5, True, True)
    assert vus.get("collection") == "juridique", \
        f"la collection choisie n'atteint pas la recherche : {vus}"


def test_un_service_rag_plus_ancien_reste_utilisable():
    """rag_app se déploie séparément : un service qui ignore le paramètre ne
    doit pas casser l'outil."""
    from llm_core.tools.rag_tools import _run_search

    class _Ancien:
        @staticmethod
        def rag_search_only(question, top_k=10, use_hybrid=True, use_mmr=True):
            return {"ok": True, "results": [{"text": "ancien"}]}

    res = _run_search(_Ancien(), {"collection": "juridique"}, "q", 5, True, True)
    assert res == [{"text": "ancien"}]


def test_rag_search_only_accepte_la_collection():
    import inspect

    from rag_app.rag_query import rag_search_only

    assert "collection" in inspect.signature(rag_search_only).parameters


# ── C8 — une session Playwright n'est pilotable que par son propriétaire ─────

def test_une_session_d_autrui_est_refusee(monkeypatch):
    from llm_core.tools import firefox_tools as F

    monkeypatch.setattr("llm_core._pw_session.get_pw_session_owner",
                        lambda sid: "alice")
    refus = F._refus_session_d_autrui("S_A", "bob")
    assert refus is not None
    charge = json.loads(refus) if isinstance(refus, str) else refus
    assert "not_your_session" in json.dumps(charge, ensure_ascii=False)


def test_sa_propre_session_passe(monkeypatch):
    from llm_core.tools import firefox_tools as F

    monkeypatch.setattr("llm_core._pw_session.get_pw_session_owner",
                        lambda sid: "alice")
    assert F._refus_session_d_autrui("S_A", "alice") is None


def test_un_proprietaire_inconnu_est_refuse(monkeypatch):
    """2026-09-30 : plus de passe-droit pour une session inconnue du
    registre. ``pw_session(action='start')`` la rend au compte (il réutilise
    son instance et réenregistre la propriété)."""
    from llm_core.tools import firefox_tools as F

    monkeypatch.setattr("llm_core._pw_session.get_pw_session_owner",
                        lambda sid: None)
    r = F._refus_session_d_autrui("S_A", "bob")
    assert r is not None and r.get("ok") is False
    assert "pw_session(action='start'" in r.get("fix", "")


def test_tous_les_outils_pw_a_session_controlent_la_propriete():
    """Le défaut n'était pas l'absence de registre mais l'absence de LECTURE :
    chaque outil posait ``_username`` puis ne le relisait jamais."""
    import ast
    import inspect

    from llm_core.tools import firefox_tools as F

    src = inspect.getsource(F)
    manquants = []
    for n in ast.walk(ast.parse(src)):
        if not isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        args = {a.arg for a in n.args.args} | {a.arg for a in n.args.kwonlyargs}
        if "session_id" not in args or "ctx" not in args:
            continue
        seg = ast.get_source_segment(src, n) or ""
        if "_refus_session_d_autrui(session_id" not in seg:
            manquants.append(n.name)
    assert not manquants, f"outils pw_* sans contrôle de propriété : {manquants}"


# ── C2 — un échec de sonde n'est pas mémorisé comme un succès ────────────────

def test_une_sonde_en_echec_expire_vite():
    from llm_core.providers import llama_caps as LC

    assert LC.CAPS_FAIL_TTL_S < LC.CAPS_TTL_S / 10, \
        "un échec de sonde reste mémorisé aussi longtemps qu'un succès"


async def test_l_echec_n_est_pas_mis_en_cache_pour_cinq_minutes(monkeypatch):
    from llm_core.providers import llama_caps as LC

    LC.invalidate()

    class _Client:
        async def get(self, *a, **k):
            raise OSError("moteur en plein pré-remplissage")

    monkeypatch.setattr("llm_core._llama_http._get_admin_client", lambda: _Client())
    caps = await LC.engine_caps("http://x:1")
    assert not caps.known

    ts, _ = LC._cache["http://x:1"]
    import time as _t
    age = _t.monotonic() - ts if ts < 10**6 else 0
    reste = LC.CAPS_TTL_S - (_t.time() - ts)
    assert reste <= LC.CAPS_FAIL_TTL_S + 1, \
        f"l'échec est mémorisé encore {reste:.0f} s (attendu ≤ {LC.CAPS_FAIL_TTL_S})"


def test_l_arret_moteur_ne_depend_plus_d_une_sonde_vivante():
    """La garde doit être ASYMÉTRIQUE et SANS I/O : on ne renonce que sur la
    preuve que le moteur est trop ancien, jamais sur une absence de preuve —
    et surtout pas en sondant pendant un Stop utilisateur."""
    import inspect

    from chatbot_app.routes import chats as C

    src = inspect.getsource(C._cancel_engine_stream)
    # Les commentaires citent l'ancien code : on ne lit que les instructions.
    code = "\n".join(l for l in src.split("\n")
                     if not l.strip().startswith("#"))
    assert "cached_caps" in code, "l'arrêt moteur sonde encore le moteur"
    assert "await engine_caps()" not in code
    assert "_caps.known and not _caps.resumable_stream" in code


# ── C3 — la sentinelle d'éviction ne part plus vers le modèle ────────────────

def test_la_sentinelle_d_eviction_a_son_propre_type():
    from llm_core import _mcp_pool as P

    assert issubclass(P._EntryEvicted, RuntimeError)
    src = __import__("inspect").getsource(P)
    assert '_EntryEvicted("entry évincée' in src, \
        "la sentinelle est encore une RuntimeError nue"
    assert "_evincee = isinstance(_call_err, _EntryEvicted)" in src
    assert "if not _evincee and not tool_traits(tool_name).replay_safe:" in src, \
        "une entrée évincée doit être rejouée même pour un outil mutant : la " \
        "requête n'a jamais quitté le process"


# ── C1 — un flux coupé pendant les arguments n'exécute rien ──────────────────

def test_une_coupure_pendant_les_arguments_abandonne_les_tool_calls():
    import inspect

    from llm_core import _chat_with_tools as W

    src = inspect.getsource(W)
    assert "_silent_cut = bool(not finish_reason)" in src, \
        "la détection de coupure s'auto-désarme encore en présence de tool_calls"
    assert "if _silent_cut and built_tcs:" in src
    assert "built_tcs = []" in src, \
        "les tool_calls aux arguments tronqués doivent être abandonnés, " \
        "comme le fait déjà le chemin d'exception"
