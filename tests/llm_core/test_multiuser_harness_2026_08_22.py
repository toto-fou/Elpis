# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_multiuser_harness_2026_08_22.py — audit du harnais
2026-08-22 (lots C et D), volet ``llm_core``.

Ce que ces tests verrouillent, dans l'ordre du rapport :

  C1  Une erreur qui vient du SERVEUR (rate-limit, erreur applicative) ne doit
      plus détruire la connexion partagée ni rejouer l'outil ; seule une
      rupture de TUYAU autorise une reconnexion, et jamais un rejeu d'outil
      mutant.
  C2  Deux appels concurrents sur la même session MCP doivent voir leurs
      notifications de log revenir CHACUNE à leur appelant.
  C3  Une annulation pendant le handshake doit refermer la connexion à moitié
      ouverte (sinon un sous-process orphelin par occurrence).
  C6  L'historique d'outils d'un run est borné en octets, sans jamais casser
      l'appariement appel ↔ résultat.
  C7  Le comptage de tokens ne re-tokenise pas un message inchangé.
  D3  Les slots du llama-server se PARTAGENT entre les workers gunicorn.
  D5  Sur l'entrée d'outils partagée, un utilisateur ne peut pas prendre toute
      la largeur de concurrence.

Aucun réseau.
"""
from __future__ import annotations

import asyncio

import pytest

from llm_core import _mcp_pool as _pool, _mcp_wrappers as _wrap


# ─────────────────────────────────────────────────────────────────────────────
#  C1 — reconnexion ciblée, rejeu interdit sur les outils mutants
# ─────────────────────────────────────────────────────────────────────────────
class _FakeMcpError(Exception):
    """Sosie d'une ``McpError`` : une réponse JSON-RPC d'erreur, pas une
    panne de transport (c'est la forme que prend le rate-limit du serveur
    d'outils locaux)."""


def test_erreur_serveur_nest_pas_une_erreur_de_transport():
    assert not _pool._is_transport_error(_FakeMcpError("rate limit exceeded"))
    assert not _pool._is_transport_error(ValueError("champ manquant"))


def test_rupture_de_tuyau_reconnue_meme_enveloppee():
    class ClosedResourceError(Exception):
        pass

    brute = ClosedResourceError()
    assert _pool._is_transport_error(brute)

    # Les transports MCP remontent leurs pannes dans un groupe anyio : le
    # test doit passer sous cette forme aussi, sinon le filtre laisserait
    # tomber les vraies reconnexions.
    groupe = ExceptionGroup("transport", [ClosedResourceError()])
    assert _pool._is_transport_error(groupe)

    # …et sous forme chaînée (``raise X from Y``).
    enveloppe = RuntimeError("échec")
    enveloppe.__cause__ = ClosedResourceError()
    assert _pool._is_transport_error(enveloppe)


@pytest.mark.parametrize("tool", [
    "execute_shell", "write_file", "git_commit", "sandbox_exec",
    "memory_write", "task", "desktop_act", "pw_page",
])
def test_outils_mutants_jamais_rejoues(tool):
    assert not _pool._is_replay_safe(tool), f"{tool} ne doit jamais être rejoué"


@pytest.mark.parametrize("tool", ["read_file", "grep_files", "list_directory"])
def test_outils_de_lecture_rejouables(tool):
    assert _pool._is_replay_safe(tool)


async def test_call_tool_ne_detruit_pas_lentree_sur_erreur_serveur(monkeypatch):
    """Le cas de production : un lot d'outils parallèles déclenche le
    limiteur de débit du serveur. AVANT, l'entrée PARTAGÉE (tous les
    utilisateurs du worker) était fermée et l'outil rejoué."""
    reconnects = []

    class _Client:
        def __init__(self):
            self.calls = 0

        async def call_tool(self, name, args, **kw):
            self.calls += 1
            raise _FakeMcpError("Rate limit exceeded for tool 'read_file'")

    client = _Client()
    pool = _pool.MCPConnectionPool()
    key = "k"
    entry = _pool._PoolEntry(key=key, client=client, tools=[], healthy=True,
                             tools_fetched_at=9e18, last_used_at=0.0)
    pool._pool[key] = entry
    monkeypatch.setattr(pool, "_make_key", lambda cfg: key)

    async def _no_reconnect(*a, **k):
        reconnects.append(1)
    monkeypatch.setattr(pool, "_reconnect", _no_reconnect)

    with pytest.raises(_FakeMcpError):
        await pool.call_tool({"name": "Outils Locaux"}, "read_file", {})

    assert client.calls == 1, "l'outil a été rejoué"
    assert not reconnects, "la connexion partagée a été détruite pour rien"
    assert entry.healthy, "l'entrée a été marquée en panne alors qu'elle va bien"


async def test_call_tool_reconnecte_mais_ne_rejoue_pas_un_mutant(monkeypatch):
    class ClosedResourceError(Exception):
        pass

    class _Client:
        def __init__(self):
            self.calls = 0

        async def call_tool(self, name, args, **kw):
            self.calls += 1
            raise ClosedResourceError()

    client = _Client()
    pool = _pool.MCPConnectionPool()
    key = "k"
    entry = _pool._PoolEntry(key=key, client=client, tools=[], healthy=True,
                             tools_fetched_at=9e18, last_used_at=0.0)
    pool._pool[key] = entry
    monkeypatch.setattr(pool, "_make_key", lambda cfg: key)

    reconnected = []

    async def _reconnect(*a, **k):
        reconnected.append(1)
    monkeypatch.setattr(pool, "_reconnect", _reconnect)

    with pytest.raises(ClosedResourceError):
        await pool.call_tool({"name": "Outils Locaux"}, "execute_shell",
                             {"cmd": "rm -rf /tmp/x"})

    assert reconnected, "un vrai défaut de transport doit assainir l'entrée"
    assert client.calls == 1, "un shell a été rejoué après reconnexion"


# ─────────────────────────────────────────────────────────────────────────────
#  C2 — routage des logs par appel
# ─────────────────────────────────────────────────────────────────────────────
class _Params:
    def __init__(self, data, logger=None):
        self.data = data
        self.logger = logger


def _shell_payload(call_id, chunk):
    import json as _json
    return _json.dumps({"__shell_output__": {
        "stream": "stdout", "chunk": chunk, "seq": 1,
        "done": False, "call_id": call_id}})


def test_logs_rendus_a_leur_appel_quand_deux_outils_tournent():
    router = _wrap._LogRouter()
    recus_a, recus_b = [], []
    router.register("call-A", "execute_shell", lambda p: recus_a.append(p))
    router.register("call-B", "execute_shell", lambda p: recus_b.append(p))

    cb = router.resolve(_Params(_shell_payload("call-A", "sortie de A")))
    assert cb is not None
    cb(None)
    assert len(recus_a) == 1 and not recus_b, "la sortie de A est partie chez B"

    cb = router.resolve(_Params(_shell_payload("call-B", "sortie de B")))
    cb(None)
    assert len(recus_b) == 1


def test_un_seul_appel_en_vol_garde_le_comportement_historique():
    router = _wrap._LogRouter()
    seen = []
    router.register("call-A", "read_file", lambda p: seen.append(p))
    # Une notification SANS identifiant (un simple ``ctx.info`` d'outil) :
    # un seul appel en vol ⇒ elle lui revient, comme avant.
    assert router.resolve(_Params("message libre")) is not None


def test_notification_ambigue_est_jetee_plutot_que_mal_attribuee():
    router = _wrap._LogRouter()
    router.register("call-A", "read_file", lambda p: None)
    router.register("call-B", "grep_files", lambda p: None)
    # Deux appels, aucun identifiant, loggers qui ne départagent pas :
    # mieux vaut perdre la ligne que la donner au mauvais utilisateur.
    assert router.resolve(_Params("message libre")) is None
    # …mais un logger qui NOMME l'outil départage.
    assert router.resolve(_Params("message libre", logger="grep_files")) is not None


def test_appel_termine_ne_recupere_pas_les_logs_dun_autre():
    router = _wrap._LogRouter()
    router.register("call-A", "execute_shell", lambda p: None)
    router.unregister("call-A")
    router.register("call-B", "execute_shell", lambda p: None)
    # Une notification en retard, estampillée A, ne doit pas atterrir chez B.
    assert router.resolve(_Params(_shell_payload("call-A", "retardataire"))) is None


def test_jeton_de_routage_suit_lidentifiant_du_harnais():
    assert _wrap._log_call_token({"call_id": "abc123"}) == "abc123"
    anon = _wrap._log_call_token(None)
    assert anon.startswith("_anon_") and anon != _wrap._log_call_token(None)


# ─────────────────────────────────────────────────────────────────────────────
#  C3 — annulation pendant le handshake : la connexion est refermée
# ─────────────────────────────────────────────────────────────────────────────
async def test_handshake_annule_referme_la_connexion(monkeypatch):
    closed = []

    class _Client:
        async def __aenter__(self):
            await asyncio.sleep(30)          # handshake qui traîne

        async def __aexit__(self, *a):
            closed.append(1)

        async def list_tools(self):
            return []

    pool = _pool.MCPConnectionPool()
    task = asyncio.create_task(
        pool._connect_new("k", {"name": "x"}, lambda cfg: _Client()))
    await asyncio.sleep(0.05)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert closed, ("le sous-process MCP est resté orphelin : ``__aexit__`` "
                    "n'a pas été appelé sur annulation")


# ─────────────────────────────────────────────────────────────────────────────
#  C6 — historique d'outils du run borné
# ─────────────────────────────────────────────────────────────────────────────
def _run_history(n_iterations: int, taille: int):
    hist = []
    for i in range(n_iterations):
        hist.append({"role": "assistant", "tool_calls": [
            {"id": f"c{i}", "type": "function",
             "function": {"name": "read_file", "arguments": "{}"}}]})
        hist.append({"role": "tool", "tool_call_id": f"c{i}", "content": "x" * taille})
    return hist


def test_tool_history_bornee_en_octets():
    from llm_core._chat_with_tools import _cap_run_tool_history
    hist = _run_history(300, 100_000)          # ~30 Mo
    borne = 2 * 1024 * 1024
    out = _cap_run_tool_history(hist, max_bytes=borne)
    total = sum(len(m.get("content") or "") for m in out)
    assert total <= borne * 1.1, f"encore {total} octets après élagage"


def test_elagage_preserve_lappariement_appel_resultat():
    from llm_core._chat_with_tools import _cap_run_tool_history
    hist = _run_history(200, 100_000)
    out = _cap_run_tool_history(hist, max_bytes=1024 * 1024)
    assert len(out) == len(hist), "des messages ont DISPARU (appariement cassé)"
    ids_appels = [tc["id"] for m in out if m.get("tool_calls")
                  for tc in m["tool_calls"]]
    ids_resultats = [m["tool_call_id"] for m in out if m.get("role") == "tool"]
    assert ids_appels == ids_resultats


def test_la_fin_du_run_est_preservee():
    """Le travail RÉCENT est celui qu'un « Continuer » relit : il doit
    survivre à l'élagage."""
    from llm_core._chat_with_tools import _cap_run_tool_history
    hist = _run_history(100, 100_000)
    hist[-1]["content"] = "RESULTAT FINAL" + "y" * 1000
    out = _cap_run_tool_history(hist, max_bytes=1024 * 1024)
    assert out[-1]["content"].startswith("RESULTAT FINAL")


def test_petit_historique_intact():
    from llm_core._chat_with_tools import _cap_run_tool_history
    hist = _run_history(3, 100)
    assert _cap_run_tool_history(hist, max_bytes=1024 * 1024) is hist


# ─────────────────────────────────────────────────────────────────────────────
#  C7 — comptage de tokens mémoïsé
# ─────────────────────────────────────────────────────────────────────────────
async def test_message_inchange_nest_pas_retokenise(monkeypatch):
    from llm_core.context import tokens as _tok

    appels = []

    async def _fake_exact(text, model_id=None, **kw):
        appels.append(text)
        return max(1, len(text) // 4)

    monkeypatch.setattr(_tok, "count_tokens_exact", _fake_exact)
    _tok._MSG_TOKEN_MEMO.clear()

    messages = [{"role": "user", "content": "bonjour " * 100},
                {"role": "assistant", "content": "réponse " * 100}]
    a, _ = await _tok.count_messages_tokens_per_msg_ex(messages, "m1")
    n1 = len(appels)
    b, _ = await _tok.count_messages_tokens_per_msg_ex(messages, "m1")
    assert a == b, "le mémo change le résultat"
    assert len(appels) == n1, "les messages inchangés ont été re-tokenisés"


async def test_message_modifie_est_recompte(monkeypatch):
    from llm_core.context import tokens as _tok

    async def _fake_exact(text, model_id=None, **kw):
        return max(1, len(text) // 4)

    monkeypatch.setattr(_tok, "count_tokens_exact", _fake_exact)
    _tok._MSG_TOKEN_MEMO.clear()

    m = {"role": "assistant", "content": "court"}
    counts, _ = await _tok.count_messages_tokens_per_msg_ex([m], "m1")
    avant = counts[0]
    m["content"] = "beaucoup plus long " * 200
    counts, _ = await _tok.count_messages_tokens_per_msg_ex([m], "m1")
    apres = counts[0]
    assert apres > avant, "le mémo a rendu un compte périmé"


async def test_changer_de_modele_invalide_le_memo(monkeypatch):
    """Deux modèles = deux tokenizers : un compte mémorisé pour l'un ne vaut
    rien pour l'autre."""
    from llm_core.context import tokens as _tok

    async def _fake_exact(text, model_id=None, **kw):
        return 10 if model_id == "m1" else 40

    monkeypatch.setattr(_tok, "count_tokens_exact", _fake_exact)
    _tok._MSG_TOKEN_MEMO.clear()
    m = [{"role": "user", "content": "texte"}]
    a, _ = await _tok.count_messages_tokens_per_msg_ex(m, "m1")
    b, _ = await _tok.count_messages_tokens_per_msg_ex(m, "m2")
    assert a != b


# ─────────────────────────────────────────────────────────────────────────────
#  D3 — les slots llama.cpp se partagent entre workers
# ─────────────────────────────────────────────────────────────────────────────
def test_slots_partages_entre_workers(monkeypatch):
    from llm_core._scheduling._concurrency import _share_slots_across_workers

    monkeypatch.delenv("APP_WORKERS_EFFECTIVE", raising=False)
    assert _share_slots_across_workers(4) == 4          # worker unique

    monkeypatch.setenv("APP_WORKERS_EFFECTIVE", "3")
    assert _share_slots_across_workers(4) == 1          # 4 slots / 3 workers
    assert _share_slots_across_workers(12) == 4
    assert _share_slots_across_workers(1) == 1          # jamais zéro

    monkeypatch.setenv("APP_WORKERS_EFFECTIVE", "pas-un-nombre")
    assert _share_slots_across_workers(4) == 4          # valeur illisible → sûr


# ─────────────────────────────────────────────────────────────────────────────
#  D5 — part de concurrence par utilisateur sur l'entrée partagée
# ─────────────────────────────────────────────────────────────────────────────
async def test_un_utilisateur_ne_prend_pas_toute_la_largeur():
    entry = _pool._PoolEntry(key="local", client=object(), max_concurrency=8,
                             call_sem=asyncio.Semaphore(8))
    en_vol = 0
    max_vu = 0
    libere = asyncio.Event()

    async def _appel():
        nonlocal en_vol, max_vu
        async with _pool._call_guard(entry, "alice"):
            en_vol += 1
            max_vu = max(max_vu, en_vol)
            await libere.wait()
            en_vol -= 1

    taches = [asyncio.create_task(_appel()) for _ in range(8)]
    await asyncio.sleep(0.05)
    assert max_vu <= 4, (
        f"alice tient {max_vu} places sur 8 — les autres utilisateurs du "
        f"worker attendent derrière elle")
    libere.set()
    await asyncio.gather(*taches)


async def test_deux_utilisateurs_avancent_en_parallele():
    entry = _pool._PoolEntry(key="local", client=object(), max_concurrency=8,
                             call_sem=asyncio.Semaphore(8))
    actifs = set()
    libere = asyncio.Event()

    async def _appel(user):
        async with _pool._call_guard(entry, user):
            actifs.add(user)
            await libere.wait()

    taches = [asyncio.create_task(_appel("alice")) for _ in range(6)]
    taches += [asyncio.create_task(_appel("bob")) for _ in range(2)]
    await asyncio.sleep(0.05)
    assert actifs == {"alice", "bob"}, (
        "bob n'a pas pu passer pendant qu'alice occupait l'entrée partagée")
    libere.set()
    await asyncio.gather(*taches)
