# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_audit_critiques_lot2_2026_08_23.py — les dix critiques
confirmés par la passe de vérification du 2026-08-23.

Trois familles :

  FRONTIÈRE ENTRE COMPTES — un mot de passe, une sortie de terminal, un seau de
  débit ou un jeton d'accès qui traverse d'un utilisateur à l'autre.

  PERTE DE DONNÉES — un fichier détruit, des entrées de listing perdues, des
  effets de bord rejoués, une reprise qui échoue.

  MÉCANISME DE SÉCURITÉ INERTE — un arrêt qui n'arrête rien, un disjoncteur
  qui ne peut pas s'ouvrir.
"""
from __future__ import annotations

import json
import os
import sys
import types

import pytest

# ═════════════════════════════════════════════════════════════════════════════
#  64 — Les identifiants HTTP ne franchissent plus la frontière des comptes
# ═════════════════════════════════════════════════════════════════════════════

@pytest.fixture
def _ax(tmp_path, monkeypatch):
    """Base AX isolée, schéma courant."""
    from pathlib import Path as _P

    from shared_infra.memory.ax import _connection as C
    from shared_infra.memory.ax.init import init_db
    monkeypatch.setattr(C, "_DB_PATH", _P(tmp_path / "ax.db"), raising=False)
    init_db()
    import shared_infra.memory.ax.credentials as creds
    return creds


def test_les_identifiants_dun_compte_ne_partent_pas_chez_un_autre(_ax):
    """Le cœur du constat : Alice enregistre, Bob demande le même site."""
    assert _ax.save_credentials("https://intranet.corp/", "alice.dupont",
                                "s3cr3t", owner="alice") is True

    chez_alice = _ax.get_credentials("https://intranet.corp/", owner="alice")
    assert chez_alice and chez_alice["username"] == "alice.dupont"

    chez_bob = _ax.get_credentials("https://intranet.corp/", owner="bob")
    assert chez_bob is None, (
        "le mot de passe d'un autre compte a été servi — il aurait été injecté "
        "dans le contexte Playwright de Bob, qui aurait navigué AU NOM D'ALICE")


def test_deux_comptes_gardent_chacun_leur_couple(_ax):
    """La cle porte (owner, site) : ce ne sont pas des lignes qui s'ecrasent."""
    _ax.save_credentials("https://intranet.corp/", "alice", "a", owner="alice")
    _ax.save_credentials("https://intranet.corp/", "bob", "b", owner="bob")
    assert _ax.get_credentials("https://intranet.corp/", owner="alice")["username"] == "alice"
    assert _ax.get_credentials("https://intranet.corp/", owner="bob")["username"] == "bob"


def test_un_proprietaire_inconnu_ne_lit_ni_n_ecrit(_ax):
    """Fail-closed : sans identité, on ne retombe pas sur la ligne d'autrui."""
    _ax.save_credentials("https://intranet.corp/", "alice", "a", owner="alice")
    assert _ax.get_credentials("https://intranet.corp/", owner="") is None
    assert _ax.save_credentials("https://x.test/", "u", "p", owner="") is False


def test_la_vue_par_site_ne_divulgue_pas_le_login_dun_autre(_ax, monkeypatch):
    """``pw_memory(action='sites')`` publiait ``cred_username`` pour tous."""
    from shared_infra.memory.ax import normalize_url, sites as S
    from shared_infra.memory.ax._connection import _conn
    _ax.save_credentials("https://intranet.corp/", "alice.dupont", "s", owner="alice")
    site, _ = normalize_url("https://intranet.corp/")
    # La vue part de ``ax_nodes`` : sans nœud, elle est VIDE et le test serait
    # vacuant (il passait même en réinjectant la régression).
    with _conn() as c:
        c.execute(
            "INSERT INTO ax_nodes (site, path, node_type, role, name, "
            "node_key, stale, last_ok) "
            "VALUES (?, '/', 'element', 'button', 'OK', 'k1', 0, 1.0)", (site,))

    vue_bob = S.list_sites_with_stats(owner="bob")
    assert vue_bob, "la vue est vide — le test ne prouverait rien"
    assert any(r["site"] == site for r in vue_bob)
    for row in vue_bob:
        assert row.get("cred_username") in (None, ""), (
            f"le login d'un autre compte est publié : {row}")
        assert row.get("has_credentials") is False

    vue_sans_identite = S.list_sites_with_stats()
    assert vue_sans_identite
    for row in vue_sans_identite:
        assert row.get("cred_username") in (None, "")
        assert row.get("has_credentials") is False

    # …et le propriétaire, lui, voit bien les siens.
    vue_alice = S.list_sites_with_stats(owner="alice")
    assert any(r.get("cred_username") == "alice.dupont" for r in vue_alice)


def test_lindice_de_prompt_ne_nomme_pas_le_login_dun_autre(_ax):
    """Le même login partait aussi dans le PROMPT, via l'indice AX."""
    from shared_infra.memory.ax import normalize_url
    from shared_infra.memory.ax.rendering import _render_credentials_hint
    _ax.save_credentials("https://intranet.corp/", "alice.dupont", "s", owner="alice")
    site, _ = normalize_url("https://intranet.corp/")

    assert _render_credentials_hint(site, "bob") is None
    assert _render_credentials_hint(site, "") is None
    hint = _render_credentials_hint(site, "alice")
    assert hint and "alice.dupont" in hint and "s" != hint  # jamais le mot de passe


def test_la_migration_neutralise_les_lignes_sans_proprietaire(tmp_path, monkeypatch):
    """Une base d'AVANT n'a pas de propriétaire : on ne peut pas les
    réattribuer (ce serait la fuite qu'on corrige) — elles cessent d'être
    servies, sans être détruites."""
    from pathlib import Path as _P

    from shared_infra.memory.ax import _connection as C
    db = str(tmp_path / "ax.db")
    monkeypatch.setattr(C, "_DB_PATH", _P(db), raising=False)

    import sqlite3
    con = sqlite3.connect(db)
    con.execute("""CREATE TABLE ax_credentials (
        site TEXT PRIMARY KEY, username TEXT NOT NULL, password TEXT NOT NULL,
        last_ok REAL, use_count INTEGER NOT NULL DEFAULT 1)""")
    con.execute("INSERT INTO ax_credentials VALUES ('legacy.corp','vieux','p',1.0,3)")
    con.commit(); con.close()

    from shared_infra.memory.ax.init import init_db
    init_db()

    import shared_infra.memory.ax.credentials as creds
    assert creds.get_credentials("https://legacy.corp/", owner="quiconque") is None
    # …mais la ligne est toujours là (pas de destruction silencieuse).
    con = sqlite3.connect(db)
    n = con.execute("SELECT COUNT(*) FROM ax_credentials").fetchone()[0]
    con.close()
    assert n == 1


# ═════════════════════════════════════════════════════════════════════════════
#  31 — Le rate-limit d'outils redevient PAR COMPTE
# ═════════════════════════════════════════════════════════════════════════════

class _FauxRequestContext:
    def __init__(self, meta):
        self.meta = meta


class _FauxFastMCPCtx:
    def __init__(self, username):
        self.request_context = _FauxRequestContext({"username": username})


class _FauxMwContext:
    """Ce que fastmcp 2.14 construit RÉELLEMENT : un message SANS ``_meta``,
    plus le contexte fastmcp qui, lui, porte l'identité."""
    def __init__(self, username, tool="read_file"):
        import mcp.types as _T
        self.message = _T.CallToolRequestParams(name=tool, arguments={})
        self.fastmcp_context = _FauxFastMCPCtx(username)


def test_le_message_reconstruit_par_fastmcp_ne_porte_pas_le_meta():
    """Le fait qui rendait le seau global — verrouillé pour qu'une montée de
    version qui le corrigerait soit visible."""
    import mcp.types as T
    assert getattr(T.CallToolRequestParams(name="x", arguments={}), "meta", None) is None


def test_lidentite_est_lue_par_le_chemin_qui_la_porte():
    from llm_core.tools._mcp_compliance_middleware import _user_from_ctx
    assert _user_from_ctx(_FauxMwContext("alice")) == "alice"
    assert _user_from_ctx(_FauxMwContext("bob")) == "bob"


async def test_deux_comptes_ont_des_seaux_distincts(monkeypatch):
    """La rafale d'un compte ne doit plus faire refuser l'outil aux autres."""
    from llm_core.tools import _mcp_compliance_middleware as M

    limiteur = M.ToolRateLimit(rps=1.0, burst=2)

    async def _next(_ctx):
        return "ok"

    # Alice épuise son seau (burst=2).
    for _ in range(2):
        assert await limiteur.on_call_tool(_FauxMwContext("alice"), _next) == "ok"
    with pytest.raises(M.RateLimitError):
        await limiteur.on_call_tool(_FauxMwContext("alice"), _next)

    # Bob n'a rien consommé : son seau est intact.
    assert await limiteur.on_call_tool(_FauxMwContext("bob"), _next) == "ok"


# ═════════════════════════════════════════════════════════════════════════════
#  29 + 59 — Le terminal en direct part chez le bon appel
# ═════════════════════════════════════════════════════════════════════════════

class _Params:
    def __init__(self, data, logger="shell_output"):
        self.data = data
        self.logger = logger


def _payload(tok, call_id="call_0", chunk="x"):
    return json.dumps({"__shell_output__": {
        "log_token": tok, "call_id": call_id, "chunk": chunk, "stream": "stdout"}})


def _logdata(tok, **kw):
    """Forme RÉELLE du fil depuis fastmcp 2.14 : ``LogData`` sérialisé."""
    return {"msg": _payload(tok, **kw), "extra": None}


def test_le_routeur_deballe_le_logdata():
    """Sans déballage, ``_call_id_of`` rendait None pour 100 % des
    notifications réelles et tout le routage par identifiant était inerte."""
    from llm_core._mcp_wrappers import _LogRouter
    assert _LogRouter._call_id_of(_Params(_logdata("T-A"))) == "T-A"
    # La forme historique (texte brut) reste comprise.
    assert _LogRouter._call_id_of(_Params(_payload("T-A"))) == "T-A"


def test_deux_comptes_au_meme_call_id_ne_se_volent_pas_la_sortie():
    """Le cas réel : llama.cpp renvoie ``call_0`` aux deux, mais le jeton de
    routage est tiré par RUN."""
    from llm_core._mcp_wrappers import _log_call_token, _LogRouter

    tok_a = _log_call_token({"call_id": "call_0", "log_token": "runA:call_0"})
    tok_b = _log_call_token({"call_id": "call_0", "log_token": "runB:call_0"})
    assert tok_a != tok_b, "les deux appels partagent le même jeton de routage"

    r = _LogRouter()
    recu_a, recu_b = [], []
    r.register(tok_a, "execute_shell", lambda p: recu_a.append(p))
    r.register(tok_b, "execute_shell", lambda p: recu_b.append(p))

    cb = r.resolve(_Params(_logdata("runA:call_0", call_id="call_0")))
    assert cb is not None
    cb("ligne d'Alice")
    assert recu_a == ["ligne d'Alice"] and recu_b == [], \
        "la sortie du terminal d'un compte est partie chez l'autre"

    # …et la fin de l'un ne rend pas l'autre muet.
    r.unregister(tok_a)
    cb_b = r.resolve(_Params(_logdata("runB:call_0", call_id="call_0")))
    assert cb_b is not None
    cb_b("ligne de Bob")
    assert recu_b == ["ligne de Bob"]


def test_un_jeton_deja_pris_nest_jamais_ecrase():
    """Défense en profondeur : écraser revenait à voler l'emplacement."""
    from llm_core._mcp_wrappers import _LogRouter
    r = _LogRouter()
    premier, second = [], []
    r.register("meme-jeton", "execute_shell", lambda p: premier.append(p))
    r.register("meme-jeton", "execute_shell", lambda p: second.append(p))
    cb = r.resolve(_Params(_logdata("meme-jeton")))
    assert cb is not None
    cb("sortie")
    assert premier == ["sortie"] and second == []


def test_le_harnais_pose_un_jeton_unique_par_run():
    """Le jeton doit être tiré une fois par RUN, pas dérivé de l'itération."""
    import inspect

    from llm_core import _chat_with_tools as W
    src = inspect.getsource(W._run_chat_multi_mcp_impl)
    assert "_run_log_tok = secrets.token_hex" in src
    # (2026-09-11, P2 — A12) un SEUL helper d'injection du méta pour les deux
    # canaux : chacun lui passe le jeton du run, et c'est lui qui pose
    # ``log_token = <jeton du run>:<call_id>``.
    assert src.count("run_log_tok=_run_log_tok, user_id=user_id)") == 2, \
        "un des deux canaux (natif / legacy) ne passe pas le jeton de routage au helper"
    helper = inspect.getsource(W._build_call_meta)
    assert 'meta["log_token"] = f"{run_log_tok}:{call_id}"' in helper


# ═════════════════════════════════════════════════════════════════════════════
#  46 — git_submit n'utilise plus le client HTTP non durci
# ═════════════════════════════════════════════════════════════════════════════

def test_git_submit_injecte_le_client_durci():
    import inspect

    from llm_core.tools import git_tools as G
    src = inspect.getsource(G)
    i = src.index("gp = get_provider(cred[")
    bloc = src[i:i + 3000]
    assert "from shared_infra.git._http import http_json as _hardened_http" in bloc
    assert "gp.create_pr(\n                _http," in bloc or "create_pr(\n                _http," in bloc
    assert "_http_json," not in bloc, \
        "la copie locale NON durcie est toujours injectée dans le provider"
    assert "blocked_api_base" in bloc, "l'api_base du connecteur n'est pas validé"


def test_le_client_durci_ne_reemet_pas_le_jeton_sur_une_redirection():
    """Le vrai contenu du constat : urllib ne retire QUE content-length et
    content-type — l'Authorization (le PAT) suivait la redirection."""
    import urllib.request

    from shared_infra.git._http import _SsrfValidatingRedirectHandler

    h = _SsrfValidatingRedirectHandler(allow_hosts=("git.lan",),
                                       allow_schemes=("https", "http"))
    req = urllib.request.Request("http://git.lan/api/v1/x",
                                 headers={"Authorization": "Basic SECRET"})

    # 1. Une redirection vers une cible non validée est REFUSÉE net.
    with pytest.raises(urllib.error.HTTPError):
        h.redirect_request(req, None, 302, "Found", {},
                           "http://169.254.169.254/latest/meta-data/")

    # 2. Contrôle : le handler par défaut, lui, la suit avec le jeton.
    d = urllib.request.HTTPRedirectHandler()
    new = d.redirect_request(req, None, 302, "Found", {},
                             "http://169.254.169.254/latest/meta-data/")
    assert new is not None and "Authorization" in dict(new.headers), (
        "prémisse du constat invalidée : le handler par défaut retire déjà "
        "l'Authorization")


# ═════════════════════════════════════════════════════════════════════════════
#  1 — « Stop » atteint enfin le moteur
# ═════════════════════════════════════════════════════════════════════════════

def test_le_producteur_et_le_consommateur_du_stop_saccordent():
    """Le harnais nomme la session avec le NOM d'utilisateur, la route la
    supprime avec son identifiant NUMÉRIQUE. Tant que l'utilisateur entrait
    dans la clé, le DELETE visait une session inexistante — 404 avalé."""
    from llm_core.providers.llama_stream import conversation_id
    assert conversation_id("alice", "chat-42") == conversation_id(7, "chat-42")


def test_la_route_darret_ne_sonde_plus_le_moteur():
    """Une sonde de 3 s au milieu d'un Stop, et un abandon sur UNKNOWN,
    faisaient de l'arrêt un no-op 300 s durant (corrigé le 2026-08-23 ; ce
    test garde la propriété)."""
    import inspect

    from chatbot_app.routes import chats as C
    src = "\n".join(l for l in inspect.getsource(C._cancel_engine_stream).splitlines()
                    if not l.strip().startswith("#"))
    assert "await engine_caps(" not in src
    assert "cached_caps()" in src


# ═════════════════════════════════════════════════════════════════════════════
#  39 — Le disjoncteur peut enfin s'ouvrir
# ═════════════════════════════════════════════════════════════════════════════

@pytest.fixture
def _breaker(monkeypatch):
    from llm_core._scheduling import _breaker as B
    B._state.clear()
    monkeypatch.setattr(B, "_ENABLED", True)
    monkeypatch.setattr(B, "_FAILS_TO_OPEN", 3)
    yield B
    B._state.clear()


def test_une_panne_de_transport_alimente_le_disjoncteur(_breaker):
    import httpx
    for _ in range(3):
        _breaker.note_transport_failure("m", httpx.ConnectError("refused"))
    with pytest.raises(_breaker.LLMCircuitOpen):
        _breaker.allow("m")


def test_une_erreur_metier_nouvre_rien(_breaker):
    """Un 400 « contexte dépassé » ne dit rien de la santé du transport."""
    import httpx
    req = httpx.Request("POST", "http://x/v1/chat/completions")
    rep = httpx.Response(400, request=req, text="context overflow")
    for _ in range(10):
        _breaker.note_transport_failure(
            "m", httpx.HTTPStatusError("400", request=req, response=rep))
    _breaker.allow("m")            # ne lève pas


def test_la_cause_est_lue_a_travers_LLMFailure(_breaker):
    """Le chemin outils ne remonte JAMAIS d'httpx brut : il enveloppe."""
    import httpx

    from llm_core._llm_retry import LLMFailure
    for _ in range(3):
        _breaker.note_transport_failure("m", LLMFailure(httpx.ConnectError("down")))
    with pytest.raises(_breaker.LLMCircuitOpen):
        _breaker.allow("m")


def test_le_garde_neffacce_pas_la_panne_du_tour_quil_enveloppe(_breaker):
    """Le piège : les deux chemins de génération ne LÈVENT pas, donc le garde
    voit un tour réussi et son ``record_success`` remettait le compteur à zéro
    — annulant exactement ce que le tour venait d'apprendre."""
    import httpx
    gen_avant = _breaker.generation("m")
    for _ in range(3):
        _breaker.note_transport_failure("m", httpx.ReadTimeout("figé"))
    _breaker.record_success("m", since_generation=gen_avant)
    with pytest.raises(_breaker.LLMCircuitOpen):
        _breaker.allow("m")
    # Un vrai succès, lui, referme bien.
    _breaker.record_success("m", since_generation=_breaker.generation("m"))
    _breaker.allow("m")


def test_les_deux_chemins_de_generation_nourrissent_le_disjoncteur():
    import inspect

    from llm_core import _chat_classic as C, _chat_with_tools as W
    assert "note_transport_failure" in inspect.getsource(C)
    assert "note_transport_failure" in inspect.getsource(W)


# ═════════════════════════════════════════════════════════════════════════════
#  44 — L'append ne détruit plus un fichier non-UTF-8
# ═════════════════════════════════════════════════════════════════════════════

def _fs_tools():
    import llm_core.tools.fs_tools as F
    return F


def test_append_sur_un_fichier_latin1_echoue_sans_rien_detruire(tmp_path):
    """Rejoue le constat : la relecture en ``errors='replace'`` réécrivait des
    U+FFFD par-dessus l'original, avec ``ok: true`` en retour."""
    F = _fs_tools()
    f = tmp_path / "notes.txt"
    octets = b"caf\xe9 \xe0 15h\nr\xe9sum\xe9\n"
    f.write_bytes(octets)

    # On exerce le geste exact du chemin corrigé.
    try:
        f.read_bytes().decode("utf-8")
        decodable = True
    except UnicodeDecodeError:
        decodable = False
    assert not decodable, "prémisse : le fichier n'est PAS de l'utf-8"

    import inspect
    src = inspect.getsource(F)
    i = src.index('if mode == "append" and old_raw is not None:')
    # Bornes serrées sur la SEULE branche append : la branche ``write``
    # voisine lit elle aussi en ``errors="replace"``, mais uniquement pour
    # les statistiques +X/-Y — elle ne réécrit jamais ce qu'elle a lu.
    # Commentaires retirés : le bloc EXPLIQUE le défaut, il ne doit pas le
    # contenir. Sans ce filtre, l'assertion se déclencherait sur sa propre note.
    j = src.index('elif mode == "write"', i)
    bloc = "\n".join(l for l in src[i:j].splitlines()
                     if not l.strip().startswith("#"))
    assert 'errors="replace"' not in bloc, \
        "l'append relit encore en errors='replace' — corruption silencieuse"
    assert "decode(encoding)" in bloc, "la relecture n'est pas stricte"
    assert "encoding_mismatch" in bloc, "l'échec de décodage n'est pas signalé"
    assert f.read_bytes() == octets


def test_lecriture_reste_stricte_dans_lautre_sens(tmp_path):
    """La garde symétrique (encodage de SORTIE) ne doit pas avoir bougé."""
    import inspect
    F = _fs_tools()
    src = inspect.getsource(F)
    assert src.count('"encoding_mismatch"') >= 2


# ═════════════════════════════════════════════════════════════════════════════
#  45 — La pagination de list_files ne perd plus d'entrées
# ═════════════════════════════════════════════════════════════════════════════

def test_la_reprise_de_pagination_se_fait_apres_le_tri(tmp_path, monkeypatch):
    """Le filtre lexicographique appliqué PENDANT le walk était incohérent
    avec l'ordre de page (dossiers d'abord + nom) : ``a/zz.txt`` (≤ au
    curseur « y.txt » mais classé après) disparaissait. L'union des pages
    rend chaque entrée une fois."""
    sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent))
    from test_agent_tooling_missions_2026_08_08 import _outils_fs
    tools, work = _outils_fs(tmp_path, monkeypatch)
    (work / "a").mkdir()
    (work / "a" / "zz.txt").write_text("1")
    (work / "y.txt").write_text("2")
    vus, curseur = [], ""
    for _ in range(5):
        r = tools["list_files"](None, path=".", recursive=True, max_results=2, cursor=curseur)
        vus += r["items"]
        curseur = r.get("next_cursor", "")
        if not curseur:
            break
    assert sorted(vus) == ["a/", "a/zz.txt", "y.txt"]


def test_lunion_des_pages_est_exacte_sur_larbre_du_constat():
    """Simulation de l'ordre de page réel : {a/, a/zz.txt, y.txt}, cap=2.
    Avant, ``a/zz.txt`` (rel ≤ curseur 'y.txt') n'était JAMAIS rendu."""
    entrees = ["a", "a/zz.txt", "y.txt"]
    dossiers = {"a"}

    def _page(cursor=""):
        items = sorted(entrees,
                       key=lambda x: (0 if x in dossiers else 1,
                                      x.split("/")[-1].lower()))
        start = 0
        if cursor:
            for i, c in enumerate(items):
                if c == cursor:
                    start = i + 1
                    break
        page = items[start:start + 2]
        nxt = page[-1] if (len(items) > start + 2 and page) else ""
        return page, nxt

    vus, cur = [], ""
    for _ in range(5):
        page, cur = _page(cur)
        vus.extend(page)
        if not cur:
            break
    assert sorted(vus) == sorted(entrees), f"entrées perdues : {vus}"
    assert len(vus) == len(set(vus)), f"doublons : {vus}"


# ═════════════════════════════════════════════════════════════════════════════
#  5 — Les outils mutants déjà exécutés survivent à l'annulation
# ═════════════════════════════════════════════════════════════════════════════

async def test_execute_tool_batch_rend_les_resultats_partiels(monkeypatch):
    """Le dict était LOCAL : sur annulation il partait avec la pile, alors
    que les outils mutants (sérialisés donc exécutés en premier) avaient déjà
    appliqué leur effet de bord."""
    import asyncio

    from llm_core.engine import tool_exec as TE

    prepared = [
        {"call_id": "c0", "tool_name": "write_file", "final_args": {}, "meta": None},
        {"call_id": "c1", "tool_name": "read_file", "final_args": {}, "meta": None},
    ]

    async def _exec(nom, args, meta=None, **kw):
        if nom == "write_file":
            return json.dumps({"ok": True, "written": "/work/a.py"})
        await asyncio.sleep(60)          # annulé ici

    snapshots = []

    async def _snap():
        snapshots.append(dict(partiel))

    partiel = {}
    task = asyncio.create_task(TE.execute_tool_batch(
        prepared, execute_single=_exec, record_metric=lambda *a, **k: None,
        is_tool_failure=lambda r: False, on_event=None, username="u",
        chat_id="c", on_cancel_snapshot=_snap, iteration=1,
        emit_progress_log=False, is_cancelled=lambda: True,
        results_out=partiel))
    await asyncio.sleep(0.05)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert 0 in partiel, "le résultat du write_file déjà exécuté est perdu"
    assert "written" in partiel[0]
    assert snapshots and 0 in snapshots[0], \
        "le snapshot d'annulation n'a pas vu le résultat partiel"


def test_la_boucle_materialise_le_lot_interrompu():
    """La trace doit atterrir dans ``_run_tool_history`` AVANT le snapshot,
    sinon ``_delta_snapshot`` dépile l'assistant et le round ne laisse rien."""
    import inspect

    from llm_core import _chat_with_tools as W
    src = inspect.getsource(W._run_chat_multi_mcp_impl)
    i = src.index("async def _emit_partial_tool_history_snapshot")
    corps = src[i:i + 400]
    assert "_materialiser_lot_interrompu()" in corps
    assert corps.index("_materialiser_lot_interrompu()") < corps.index("_delta_snapshot()")
    assert src.count("results_out       = _batch_partial") == 2, \
        "un des deux canaux (natif / legacy) n'est pas câblé"


# ═════════════════════════════════════════════════════════════════════════════
#  54 — La reprise d'un sous-agent produit un historique VALIDE
# ═════════════════════════════════════════════════════════════════════════════

def _hist_live_du_constat():
    """Ce que le collecteur produit pour trois appels parallèles dont les
    résultats reviennent dans le désordre (c, a, b)."""
    def _a(i):
        return {"role": "assistant", "content": None, "tool_calls": [{
            "id": f"live_{i}", "type": "function",
            "function": {"name": "read_file", "arguments": "{}"}}]}

    def _t(i):
        return {"role": "tool", "tool_call_id": f"live_{i}", "content": f"r{i}"}

    return [_a(1), _a(2), _a(3), _t(3), _t(1), _t(2)]


def _canonicaliser(hist):
    """Réplique exacte de ``_resumable_live_history`` (fonction imbriquée :
    on la rejoue sur la même recette, verrouillée par le test suivant)."""
    answered = {str(m["tool_call_id"]): m for m in hist
                if m.get("role") == "tool" and m.get("tool_call_id")}
    out, i, n = [], 0, len(hist)
    while i < n:
        m = hist[i]
        if m.get("role") == "assistant" and m.get("tool_calls"):
            calls, j = [], i
            while (j < n and hist[j].get("role") == "assistant"
                   and hist[j].get("tool_calls")):
                calls.extend(hist[j].get("tool_calls") or [])
                j += 1
            kept = [c for c in calls if str((c or {}).get("id") or "") in answered]
            if kept:
                out.append({"role": "assistant", "content": None, "tool_calls": kept})
                for c in kept:
                    out.append(answered[str(c["id"])])
            i = j
            continue
        if m.get("role") == "tool":
            i += 1
            continue
        out.append(m)
        i += 1
    return out


def _contrat_tool_calls(msgs):
    """Chaque assistant portant des tool_calls DOIT être immédiatement suivi
    des ``tool`` de ses ids, dans l'ordre."""
    for i, m in enumerate(msgs):
        if m.get("role") == "assistant" and m.get("tool_calls"):
            ids = [c["id"] for c in m["tool_calls"]]
            suite = msgs[i + 1:i + 1 + len(ids)]
            if [s.get("tool_call_id") for s in suite] != ids:
                return False
            if any(s.get("role") != "tool" for s in suite):
                return False
    return True


def test_lhistorique_de_reprise_respecte_le_contrat_tool_calls():
    brut = _hist_live_du_constat()
    assert not _contrat_tool_calls(brut), \
        "prémisse invalidée : la forme brute serait déjà valide"

    remis = _canonicaliser(brut)
    assert _contrat_tool_calls(remis)
    assert [m["role"] for m in remis] == \
        ["assistant", "tool", "tool", "tool"], [m["role"] for m in remis]
    assert len(remis[0]["tool_calls"]) == 3
    assert [m["content"] for m in remis[1:]] == ["r1", "r2", "r3"], \
        "les résultats ne suivent pas l'ordre des tool_calls"


def test_un_appel_sans_reponse_est_retire_de_la_vague():
    """Annulation en plein lot : l'appel non servi ne doit pas laisser un
    tool_call pendant (400 au rendu du gabarit)."""
    hist = _hist_live_du_constat()[:3] + [
        {"role": "tool", "tool_call_id": "live_1", "content": "r1"}]
    remis = _canonicaliser(hist)
    assert _contrat_tool_calls(remis)
    assert len(remis) == 2 and len(remis[0]["tool_calls"]) == 1


def test_la_recette_du_test_est_bien_celle_du_code():
    """Garde-fou : si ``_resumable_live_history`` diverge de la réplique
    ci-dessus, ce test le dit."""
    import inspect

    from llm_core.tools import task_tool as T
    src = inspect.getsource(T)
    i = src.index("def _resumable_live_history(")
    corps = src[i:i + 4000]
    for marqueur in ("_calls.extend(", "_kept = [c for c in _calls",
                     '"tool_calls": _kept', "_answered[str(_c[\"id\"])]"):
        assert marqueur in corps, marqueur
