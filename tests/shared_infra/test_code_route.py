# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_code_route.py — page « Code » (push/ingest + pilotage).

Couvre : gate ``features.opencode``, token par-user (config/rotate), ingest
authentifié par token (lots + shape unitaire legacy → store per-user), snapshot
d'historique, hello, queue de commandes (prompt/abort) tirée par ``/pull``,
lecture sessions/messages, service du plugin. Pas de vrai opencode : on POST des
events comme le ferait le plugin ``elpis-remote``.
"""
from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient


class _BusRecorder:
    """Stub du bus pipeline_events : enregistre les broadcasts (pas d'I/O)."""

    def __init__(self):
        self.published = []

    async def broadcast_to_user(self, uid, msg):
        self.published.append((uid, msg))

    async def listen(self, uid):  # pragma: no cover — non utilisé par ces tests
        if False:
            yield ""


def _db_conn(store):
    """Connexion directe à la DB du store — pour vieillir artificiellement des
    lignes (TTL client/commande) sans attendre 40 s en test."""
    from shared_infra.db import _connection
    return _connection.db_conn()     # pool commun : vaut pour tous les moteurs


def _client(monkeypatch, tmp_path, enabled=True, uid=1):
    # La page Code passe par le pool commun (2026-09-26) : une seule base à
    # rediriger, celle de ``shared_infra.db._connection``.
    import shared_infra.config as _config
    import shared_infra.opencode.routes_cli as _cli
    import shared_infra.opencode.routes_code as code
    import shared_infra.opencode.store as cstore
    from shared_infra.db import _connection
    monkeypatch.setattr(_connection, "DB_PATH", str(tmp_path / "t.db"))
    monkeypatch.setattr(_config, "DB_PATH", str(tmp_path / "t.db"))
    monkeypatch.setattr(code, "require_user_id", lambda r: uid)
    monkeypatch.setattr(code, "feature_enabled", lambda name, default=True: enabled)
    # ``routes_code`` importe ``_base_url`` à l'appel : on patche son propriétaire.
    monkeypatch.setattr(_cli, "_base_url", lambda r: "http://lan.test:8000")
    monkeypatch.setattr(code, "pipeline_events", _BusRecorder())
    # Jetons en empreinte (EXT.1) : ``tokens.resolve`` exige un compte
    # existant et la fonction opencode active.
    import shared_infra.accounts.tokens as _tokens
    monkeypatch.setattr(_tokens, "_opencode_enabled", lambda: enabled)
    _connection.init_db()
    from shared_infra.accounts.users import create_user, get_user_by_id
    for n in range(1, max(3, int(uid)) + 1):
        if not get_user_by_id(n):
            create_user(f"user{n}", "pw")
    app = FastAPI()
    app.include_router(code.router)
    return TestClient(app), code


def test_gate_404_when_disabled(monkeypatch, tmp_path):
    client, _code = _client(monkeypatch, tmp_path, enabled=False)
    assert client.get("/api/code/health").status_code == 404
    assert client.get("/api/code/sessions").status_code == 404
    assert client.get("/api/code/config").status_code == 404


def test_config_sans_jeton_et_jeton_montre_une_fois(monkeypatch, tmp_path):
    # EXT.1 : la config ne rend plus de jeton ; POST /api/code/token en crée un
    # (montré une fois), le suivant est DIFFÉRENT (un jeton par poste).
    client, _code = _client(monkeypatch, tmp_path)
    d = client.get("/api/code/config").json()
    assert "token" not in d and d["tokens"] == 0
    assert d["app_url"] == "http://lan.test:8000"
    assert d["plugin_url"].endswith("/api/code/plugin.ts")
    t1 = client.post("/api/code/token", json={"name": "poste A"}).json()["token"]
    t2 = client.post("/api/code/token").json()["token"]
    assert t1.startswith("pcr_") and t2.startswith("pcr_") and t1 != t2
    assert client.get("/api/code/config").json()["tokens"] == 2
    assert _code._resolve_token(t1) == 1 and _code._resolve_token(t2) == 1


def test_token_rotate_changes(monkeypatch, tmp_path):
    client, code = _client(monkeypatch, tmp_path)
    t1 = client.post("/api/code/token").json()["token"]
    t2 = client.post("/api/code/token/rotate").json()["token"]
    assert t2.startswith("pcr_") and t2 != t1
    # rotation = TOUS les jetons opencode du compte révoqués, un nouveau créé
    assert code._resolve_token(t1) is None and code._resolve_token(t2) == 1
    assert client.get("/api/code/config").json()["tokens"] == 1


def test_plugin_ts_served(monkeypatch, tmp_path):
    # plugin canonique : TypeScript, chargé nativement par opencode (glob *.{ts,js})
    client, _code = _client(monkeypatch, tmp_path)
    r = client.get("/api/code/plugin.ts")
    assert r.status_code == 200
    assert "elpis-remote" in r.text and "x-elpis-token" in r.text and "/api/code/ingest" in r.text
    # commande /remote + URL de l'app bakée (plus de variables d'env)
    assert '"command.execute.before"' in r.text and "/api/code/pull" in r.text
    assert "http://lan.test:8000" in r.text and "__APP_URL__" not in r.text
    # /remote update se sert sur plugin.ts et purge l'ancien .js (jamais 2 plugins)
    assert "/api/code/plugin.ts" in r.text and "elpis-remote.js" in r.text


def test_plugin_js_serves_migration_shim(monkeypatch, tmp_path):
    # COMPAT ≤ v8 : « /remote update » écrase elpis-remote.js avec cette réponse →
    # elle DOIT rester du JS valide, marquée et versionnée comme un vrai plugin,
    # et son seul travail est d'installer le .ts puis de s'effacer.
    client, _code = _client(monkeypatch, tmp_path)
    r = client.get("/api/code/plugin.js")
    assert r.status_code == 200
    js = r.text
    assert js.startswith("// elpis-remote")            # garde-fou v8 : startsWith
    assert "const PLUGIN_VERSION = " in js             # garde-fou v8 : regex version
    assert "/api/code/plugin.ts" in js                 # télécharge le canonique
    assert "http://lan.test:8000" in js and "__APP_URL__" not in js
    # jamais de double chargement : le shim s'efface, et ne délègue PAS si le
    # .ts était déjà présent au chargement (opencode l'a déjà instancié)
    assert "rmQuiet(JS_PATH)" in js and "tsAlreadyThere" in js


def test_plugin_versions_coherent(monkeypatch, tmp_path):
    # source unique : _PLUGIN_CURRENT est PARSÉ du .ts et le shim doit suivre
    client, code = _client(monkeypatch, tmp_path)
    ts = client.get("/api/code/plugin.ts").text
    js = client.get("/api/code/plugin.js").text
    assert f"const PLUGIN_VERSION = {code._PLUGIN_CURRENT}" in ts
    assert f"const PLUGIN_VERSION = {code._PLUGIN_CURRENT}" in js
    assert code._PLUGIN_CURRENT >= 9


def test_plugin_ts_perf_invariants(monkeypatch, tmp_path):
    # v9 : AUCUN patch permanent de stdout/stderr — le filtre anti-dump est armé
    # autour de /remote puis RESTAURÉ ; le hook event ne bloque pas sur l'ingest.
    client, _code = _client(monkeypatch, tmp_path)
    ts = client.get("/api/code/plugin.ts").text
    assert "armSilentFilter" in ts and "disarmSilentFilter" in ts
    assert "FILTER_WINDOW_MS" in ts
    # l'ancien garde global (patch installé au chargement du module) a disparu
    assert "__elpisRemoteStderrFilter" not in ts
    # le hook event pousse via la chaîne SANS await (bus opencode jamais bloqué)
    assert "await enqueue(() => pushBatch" not in ts


def test_ingest_requires_valid_token(monkeypatch, tmp_path):
    client, _code = _client(monkeypatch, tmp_path)
    # pas de header
    assert client.post("/api/code/ingest", json={"type": "session.created"}).status_code == 401
    # header bidon
    assert client.post("/api/code/ingest", json={"type": "session.created"},
                       headers={"x-elpis-token": "pcr_nope"}).status_code == 401


def test_ingest_populates_store_and_lists(monkeypatch, tmp_path):
    client, _code = _client(monkeypatch, tmp_path)
    tok = client.post("/api/code/token").json()["token"]
    H = {"x-elpis-token": tok}
    # session.created (shape réelle du plugin : properties.info = la session)
    client.post("/api/code/ingest", headers=H, json={"type": "session.created",
        "properties": {"sessionID": "s1", "info": {"id": "s1", "title": "Refactor", "time": {"updated": 9}}}})
    # message user + part texte
    client.post("/api/code/ingest", headers=H, json={"type": "message.updated",
        "properties": {"info": {"id": "m1", "role": "user", "sessionID": "s1"}}})
    client.post("/api/code/ingest", headers=H, json={"type": "message.part.updated",
        "properties": {"part": {"id": "p1", "type": "text", "text": "hi", "messageID": "m1", "sessionID": "s1"}}})

    sessions = client.get("/api/code/sessions").json()
    assert [s["id"] for s in sessions] == ["s1"] and sessions[0]["title"] == "Refactor"

    msgs = client.get("/api/code/sessions/s1/messages").json()
    assert len(msgs) == 1 and msgs[0]["info"]["role"] == "user"
    assert msgs[0]["parts"][0]["text"] == "hi"


def test_ingest_unknown_type_skipped(monkeypatch, tmp_path):
    client, _code = _client(monkeypatch, tmp_path)
    tok = client.post("/api/code/token").json()["token"]
    r = client.post("/api/code/ingest", headers={"x-elpis-token": tok},
                    json={"type": "plugin.added", "properties": {"id": "x"}})
    assert r.status_code == 200 and r.json().get("applied") == 0
    assert client.get("/api/code/sessions").json() == []


def test_dismiss_session(monkeypatch, tmp_path):
    client, _code = _client(monkeypatch, tmp_path)
    tok = client.post("/api/code/token").json()["token"]
    client.post("/api/code/ingest", headers={"x-elpis-token": tok}, json={"type": "session.created",
        "properties": {"info": {"id": "s9", "title": "X"}}})
    assert len(client.get("/api/code/sessions").json()) == 1
    assert client.delete("/api/code/sessions/s9").status_code == 200
    assert client.get("/api/code/sessions").json() == []


def test_health_connected_after_ingest(monkeypatch, tmp_path):
    client, _code = _client(monkeypatch, tmp_path)
    assert client.get("/api/code/health").json()["connected"] is False
    tok = client.post("/api/code/token").json()["token"]
    client.post("/api/code/ingest", headers={"x-elpis-token": tok},
                json={"type": "session.created", "properties": {"info": {"id": "s1"}}})
    h = client.get("/api/code/health").json()
    assert h["connected"] is True and h["sessions"] == 1


def test_ingest_token_scopes_to_user(monkeypatch, tmp_path):
    # le token de l'user A ne remplit QUE le store de A
    clientA, code = _client(monkeypatch, tmp_path, uid=1)
    tokA = clientA.post("/api/code/token").json()["token"]
    clientA.post("/api/code/ingest", headers={"x-elpis-token": tokA},
                 json={"type": "session.created", "properties": {"info": {"id": "sa"}}})
    # user B (même app, require_user_id=2) ne voit pas la session de A
    monkeypatch.setattr(code, "require_user_id", lambda r: 2)
    assert clientA.get("/api/code/sessions").json() == []


def test_hello_validates_token(monkeypatch, tmp_path):
    client, _code = _client(monkeypatch, tmp_path)
    tok = client.post("/api/code/token").json()["token"]
    assert client.get("/api/code/hello").status_code == 401
    assert client.get("/api/code/hello", headers={"x-elpis-token": "pcr_nope"}).status_code == 401
    d = client.get("/api/code/hello", headers={"x-elpis-token": tok}).json()
    assert d["ok"] is True and d["user"]


def test_ingest_batch_applies_in_order(monkeypatch, tmp_path):
    client, _code = _client(monkeypatch, tmp_path)
    tok = client.post("/api/code/token").json()["token"]
    r = client.post("/api/code/ingest", headers={"x-elpis-token": tok}, json={
        "client": "c1", "directory": "/proj",
        "events": [
            {"type": "session.created", "properties": {"info": {"id": "s1", "title": "T"}}},
            {"type": "message.updated", "properties": {"info": {"id": "m1", "role": "user", "sessionID": "s1"}}},
            {"type": "message.part.updated", "properties": {"part": {"id": "p1", "type": "text", "text": "v1", "messageID": "m1", "sessionID": "s1"}}},
            {"type": "message.part.updated", "properties": {"part": {"id": "p1", "type": "text", "text": "v2", "messageID": "m1", "sessionID": "s1"}}},
            {"type": "plugin.added", "properties": {}},  # hors _FORWARD → ignoré
        ],
    })
    assert r.json()["applied"] == 4
    msgs = client.get("/api/code/sessions/s1/messages").json()
    assert msgs[0]["parts"][0]["text"] == "v2"  # dernière version de la part


def test_snapshot_replaces_history(monkeypatch, tmp_path):
    client, _code = _client(monkeypatch, tmp_path)
    tok = client.post("/api/code/token").json()["token"]
    H = {"x-elpis-token": tok}
    # état préalable partiel (un message orphelin qui sera écrasé)
    client.post("/api/code/ingest", headers=H, json={"type": "message.updated",
        "properties": {"info": {"id": "stale", "role": "user", "sessionID": "s1"}}})
    # snapshot complet (shape GET /session/{id}/message : [{info, parts:[…]}])
    client.post("/api/code/ingest", headers=H, json={"type": "session.snapshot", "properties": {
        "session": {"id": "s1", "title": "Historique", "time": {"updated": 5}},
        "messages": [
            {"info": {"id": "m1", "role": "user", "sessionID": "s1", "time": {"created": 1}},
             "parts": [{"id": "p1", "type": "text", "text": "salut"}]},
            {"info": {"id": "m2", "role": "assistant", "sessionID": "s1", "time": {"created": 2}},
             "parts": [{"id": "p2", "type": "text", "text": "bonjour"}]},
        ],
    }})
    sessions = client.get("/api/code/sessions").json()
    assert sessions[0]["title"] == "Historique"
    msgs = client.get("/api/code/sessions/s1/messages").json()
    assert [m["info"]["id"] for m in msgs] == ["m1", "m2"]  # stale écrasé
    assert msgs[1]["parts"][0]["text"] == "bonjour"


def test_messages_sort_with_real_part_time_shape(monkeypatch, tmp_path):
    # régression : chez opencode, part.time est un DICT {start,end} — le tri
    # plantait en 500 (comparaison dict < int)
    client, _code = _client(monkeypatch, tmp_path)
    tok = client.post("/api/code/token").json()["token"]
    H = {"x-elpis-token": tok}
    client.post("/api/code/ingest", headers=H, json={"events": [
        {"type": "message.updated", "properties": {"info": {"id": "m1", "role": "assistant", "sessionID": "s1", "time": {"created": 1}}}},
        {"type": "message.part.updated", "properties": {"part": {"id": "pb", "type": "text", "text": "2e", "messageID": "m1", "sessionID": "s1", "time": {"start": 20, "end": 21}}}},
        {"type": "message.part.updated", "properties": {"part": {"id": "pa", "type": "text", "text": "1re", "messageID": "m1", "sessionID": "s1", "time": {"start": 10}}}},
        {"type": "message.part.updated", "properties": {"part": {"id": "pc", "type": "step-start", "messageID": "m1", "sessionID": "s1"}}},  # sans time
    ]})
    r = client.get("/api/code/sessions/s1/messages")
    assert r.status_code == 200
    parts = r.json()[0]["parts"]
    texts = [p.get("text") for p in parts if p.get("type") == "text"]
    assert texts == ["1re", "2e"]  # ordonnées par time.start


def test_prompt_requires_connected_client(monkeypatch, tmp_path):
    client, _code = _client(monkeypatch, tmp_path)
    r = client.post("/api/code/sessions/s1/prompt", json={"text": "hello"})
    assert r.status_code == 409  # aucune CLI connectée


def test_prompt_queued_then_pulled(monkeypatch, tmp_path):
    client, _code = _client(monkeypatch, tmp_path)
    tok = client.post("/api/code/token").json()["token"]
    H = {"x-elpis-token": tok}
    # la CLI c1 se signale (ingest) et possède s1
    client.post("/api/code/ingest", headers=H, json={"client": "c1", "events": [
        {"type": "session.created", "properties": {"info": {"id": "s1"}}}]})
    # la page envoie un prompt + un abort
    assert client.post("/api/code/sessions/s1/prompt", json={"text": "fais X"}).json()["queued"] is True
    assert client.post("/api/code/sessions/s1/abort", json={}).json()["queued"] is True
    assert client.post("/api/code/sessions/s1/prompt", json={"text": " "}).status_code == 422
    # la CLI tire ses commandes
    d = client.get("/api/code/pull?client=c1&wait=0", headers=H).json()
    kinds = [(c["kind"], c["sid"]) for c in d["commands"]]
    assert ("prompt", "s1") in kinds and ("abort", "s1") in kinds
    assert d["commands"][0]["text"] == "fais X"
    # tirées = consommées
    assert client.get("/api/code/pull?client=c1&wait=0", headers=H).json()["commands"] == []


def test_commands_pushed_and_listed(monkeypatch, tmp_path):
    # le plugin pousse la liste des slash commands (client.commands) → autocomplétion «/»
    client, _code = _client(monkeypatch, tmp_path)
    assert client.get("/api/code/commands").json() == []
    tok = client.post("/api/code/token").json()["token"]
    client.post("/api/code/ingest", headers={"x-elpis-token": tok}, json={"client": "c1", "events": [
        {"type": "client.commands", "properties": {"commands": [
            {"name": "review", "description": "review changes"},
            {"name": "init", "description": "guided setup"},
            {"description": "sans nom → ignorée"},
        ]}}]})
    cmds = client.get("/api/code/commands").json()
    assert [c["name"] for c in cmds] == ["review", "init"]


def test_slash_command_queued_and_pulled(monkeypatch, tmp_path):
    client, _code = _client(monkeypatch, tmp_path)
    tok = client.post("/api/code/token").json()["token"]
    H = {"x-elpis-token": tok}
    client.post("/api/code/ingest", headers=H, json={"client": "c1", "events": [
        {"type": "session.created", "properties": {"info": {"id": "s1"}}}]})
    # /remote interdit depuis la page (couperait la remontée) ; vide → 422
    assert client.post("/api/code/sessions/s1/command", json={"command": "remote"}).status_code == 422
    assert client.post("/api/code/sessions/s1/command", json={"command": ""}).status_code == 422
    r = client.post("/api/code/sessions/s1/command", json={"command": "/review", "arguments": "HEAD~1"})
    assert r.json()["queued"] is True
    got = client.get("/api/code/pull?client=c1&wait=0", headers=H).json()["commands"]
    assert len(got) == 1 and got[0]["kind"] == "command"
    assert got[0]["command"] == "review" and got[0]["arguments"] == "HEAD~1"  # « / » strippé


def test_pull_routes_by_session_owner(monkeypatch, tmp_path):
    client, _code = _client(monkeypatch, tmp_path)
    tok = client.post("/api/code/token").json()["token"]
    H = {"x-elpis-token": tok}
    # deux CLIs actives : c1 possède s1, c2 possède s2
    client.post("/api/code/ingest", headers=H, json={"client": "c1", "events": [
        {"type": "session.created", "properties": {"info": {"id": "s1"}}}]})
    client.post("/api/code/ingest", headers=H, json={"client": "c2", "events": [
        {"type": "session.created", "properties": {"info": {"id": "s2"}}}]})
    client.post("/api/code/sessions/s1/prompt", json={"text": "pour c1"})
    # c2 ne doit PAS voler la commande de c1 (propriétaire vivant)
    assert client.get("/api/code/pull?client=c2&wait=0", headers=H).json()["commands"] == []
    got = client.get("/api/code/pull?client=c1&wait=0", headers=H).json()["commands"]
    assert len(got) == 1 and got[0]["text"] == "pour c1"


# ─────────────────────────────────────────────────────────────────────────────
#  Multi-worker : store SQLite partagé, claim atomique, epoch persisté, bus
# ─────────────────────────────────────────────────────────────────────────────
def _second_worker(code):
    """Deuxième « worker » : autre app FastAPI sur le MÊME module/DB."""
    app = FastAPI()
    app.include_router(code.router)
    return TestClient(app)


def test_cross_worker_ingest_then_read(monkeypatch, tmp_path):
    # le plugin pousse sur le worker A, la page lit depuis le worker B
    clientA, code = _client(monkeypatch, tmp_path)
    clientB = _second_worker(code)
    tok = clientA.post("/api/code/token").json()["token"]
    clientA.post("/api/code/ingest", headers={"x-elpis-token": tok}, json={"client": "c1", "events": [
        {"type": "session.created", "properties": {"info": {"id": "s1", "title": "X"}}},
        {"type": "message.updated", "properties": {"info": {"id": "m1", "role": "user", "sessionID": "s1"}}},
        {"type": "message.part.updated", "properties": {"part": {"id": "p1", "type": "text", "text": "hi", "messageID": "m1", "sessionID": "s1"}}},
    ]})
    assert [s["id"] for s in clientB.get("/api/code/sessions").json()] == ["s1"]
    assert clientB.get("/api/code/sessions/s1/messages").json()[0]["parts"][0]["text"] == "hi"
    assert clientB.get("/api/code/health").json()["connected"] is True


def test_cross_worker_prompt_then_pull(monkeypatch, tmp_path):
    # la page poste le prompt sur B, la CLI long-polle sur A
    clientA, code = _client(monkeypatch, tmp_path)
    clientB = _second_worker(code)
    tok = clientA.post("/api/code/token").json()["token"]
    H = {"x-elpis-token": tok}
    clientA.post("/api/code/ingest", headers=H, json={"client": "c1", "events": [
        {"type": "session.created", "properties": {"info": {"id": "s1"}}}]})
    assert clientB.post("/api/code/sessions/s1/prompt", json={"text": "go"}).json()["queued"] is True
    got = clientA.get("/api/code/pull?client=c1&wait=0", headers=H).json()["commands"]
    assert len(got) == 1 and got[0]["text"] == "go"


def test_claim_is_consumed_once(monkeypatch, tmp_path):
    client, code = _client(monkeypatch, tmp_path)
    tok = client.post("/api/code/token").json()["token"]
    H = {"x-elpis-token": tok}
    client.post("/api/code/ingest", headers=H, json={"client": "c1", "events": [
        {"type": "session.created", "properties": {"info": {"id": "s1"}}}]})
    client.post("/api/code/sessions/s1/prompt", json={"text": "unique"})
    import shared_infra.opencode.store as cstore
    first = cstore.claim_commands(1, "c1")
    second = cstore.claim_commands(1, "c1")
    assert len(first) == 1 and second == []


def test_busy_lifecycle(monkeypatch, tmp_path):
    client, _code = _client(monkeypatch, tmp_path)
    tok = client.post("/api/code/token").json()["token"]
    H = {"x-elpis-token": tok}
    # assistant en cours (pas de time.completed) → busy
    client.post("/api/code/ingest", headers=H, json={"client": "c1", "events": [
        {"type": "session.created", "properties": {"info": {"id": "s1"}}},
        {"type": "message.updated", "properties": {"info": {"id": "m1", "role": "assistant", "sessionID": "s1", "time": {"created": 1}}}},
    ]})
    assert client.get("/api/code/sessions").json()[0]["busy"] is True
    # session.idle → plus busy
    client.post("/api/code/ingest", headers=H, json={"client": "c1", "events": [
        {"type": "session.idle", "properties": {"sessionID": "s1"}}]})
    assert client.get("/api/code/sessions").json()[0]["busy"] is False
    # assistant terminé (time.completed) → pas busy
    client.post("/api/code/ingest", headers=H, json={"client": "c1", "events": [
        {"type": "message.updated", "properties": {"info": {"id": "m1", "role": "assistant", "sessionID": "s1", "time": {"created": 1, "completed": 2}}}}]})
    assert client.get("/api/code/sessions").json()[0]["busy"] is False


def test_epoch_persisted_and_stable(monkeypatch, tmp_path):
    clientA, code = _client(monkeypatch, tmp_path)
    clientB = _second_worker(code)
    tok = clientA.post("/api/code/token").json()["token"]
    H = {"x-elpis-token": tok}
    e1 = clientA.get("/api/code/pull?client=c1&wait=0", headers=H).json()["epoch"]
    e2 = clientB.get("/api/code/pull?client=c1&wait=0", headers=H).json()["epoch"]
    assert e1 and e1 == e2   # même epoch sur les deux « workers »
    # « redémarrage » : ré-init du schéma sur le même fichier → epoch inchangé
    import shared_infra.opencode.store as cstore
    cstore._initialized.clear()
    e3 = clientA.get("/api/code/pull?client=c1&wait=0", headers=H).json()["epoch"]
    assert e3 == e1


def test_prune_drops_stale_sessions(monkeypatch, tmp_path):
    client, _code = _client(monkeypatch, tmp_path)
    tok = client.post("/api/code/token").json()["token"]
    client.post("/api/code/ingest", headers={"x-elpis-token": tok}, json={"client": "c1", "events": [
        {"type": "session.created", "properties": {"info": {"id": "s1"}}}]})
    import shared_infra.opencode.store as cstore
    with cstore._db() as c:
        c.execute("UPDATE code_sessions SET updated_at=0")   # très vieille
        c.commit()
    cstore._last_prune = 0.0
    cstore.prune()
    assert client.get("/api/code/sessions").json() == []
    with cstore._db() as c:
        assert c.execute("SELECT COUNT(*) FROM code_messages").fetchone()[0] == 0


def test_plugin_fields_served(monkeypatch, tmp_path):
    client, _code = _client(monkeypatch, tmp_path)
    js = client.get("/api/code/plugin.ts").text
    # version SERVIE = version parsée du .ts (source unique, cf.
    # test_markers_and_versions_in_sync) — pas un littéral à re-figer ici.
    import shared_infra.opencode.routes_code as _code_module
    assert f"PLUGIN_VERSION = {_code_module._PLUGIN_CURRENT}" in js
    assert "has_args" in js and "$ARGUMENTS" in js
    assert '"plugin": PLUGIN_VERSION' in js or "plugin: PLUGIN_VERSION" in js
    # v3 : remontée des modèles + modèle forcé sur les prompts distants
    assert "client.models" in js and "config.providers" in js
    assert "body.model = c.model" in js
    # v4 : garde-fou modèle inconnu (ProviderModelNotFoundError tuait le TUI)
    assert "knownModels" in js
    # v4 : actions natives relayées sur les endpoints session (API 1.17.x vérifiée)
    for marker in ("session.revert", "session.unrevert", "session.summarize",
                   "session.share", "session.unshare", "session.init", "session.create",
                   'c.kind === "action"'):
        assert marker in js, marker
    # v5 : permissions interactives + renommage + déconnexion propre + limites ctx
    for marker in ("permission.updated", "permission.asked", "permission.replied",
                   "postSessionIdPermissionsPermissionId", 'c.kind === "rename"',
                   "session.update", "/api/code/bye", "m.limit"):
        assert marker in js, marker
    # v12 : modes plan/build + état honnête à la fermeture
    for marker in ("client.agents", "client.app.agents", "knownAgents",
                   "body.agent = c.agent", 'a.mode === "primary"', "!a.hidden"):
        assert marker in js, marker
    # le garde-fou de survie : un signal ABSORBÉ ne doit pas nous faire passer
    # pour morts auprès de l'app (page « déconnecté », CLI qui se croit active)
    assert "SURVIVE_MS" in js and "onFatalSignal" in js
    assert "process.once(sig, self)" in js       # jamais `process.on` : cf. re-raise
    # v13 : une session VIDE est publiée (sinon invisible jusqu'au 1er message),
    # et « Nouvelle session » la crée POUR DE VRAI avant d'y basculer le TUI
    assert "sessionExists" in js and "sessionHasMessages" not in js
    assert "client.session.create" in js and "selectSession" in js
    # v14 : questions de l'outil `question` (bloquantes côté CLI) remontées et
    # répondues depuis la page — via le client HTTP interne du SDK (le SDK v1
    # reçu par les plugins n'a PAS de ressource `question`)
    for marker in ("question.asked", "question.replied", "question.rejected",
                   'c.kind === "question"', "answerQuestion(", "client._client",
                   '"/question/{requestID}/" + verb'):
        assert marker in js, marker


def test_rich_commands_roundtrip_and_legacy(monkeypatch, tmp_path):
    client, _code = _client(monkeypatch, tmp_path)
    tok = client.post("/api/code/token").json()["token"]
    H = {"x-elpis-token": tok}
    # plugin v2 : champs riches → resservis à la page
    client.post("/api/code/ingest", headers=H, json={"client": "c1", "events": [
        {"type": "client.commands", "properties": {"commands": [
            {"name": "review", "description": "revue", "agent": "reviewer", "model": "gpt-x", "has_args": True},
            {"name": "init", "description": "setup"},   # shape legacy (v1) dans le même lot
        ]}}]})
    cmds = client.get("/api/code/commands").json()
    rich = next(c for c in cmds if c["name"] == "review")
    assert rich["agent"] == "reviewer" and rich["model"] == "gpt-x" and rich["has_args"] is True
    legacy = next(c for c in cmds if c["name"] == "init")
    assert "agent" not in legacy and "has_args" not in legacy


def test_health_reports_plugin_version(monkeypatch, tmp_path):
    client, _code = _client(monkeypatch, tmp_path)
    h = client.get("/api/code/health").json()
    assert h["plugin_current"] >= 2 and h["plugin_version"] == 0   # aucun client
    tok = client.post("/api/code/token").json()["token"]
    H = {"x-elpis-token": tok}
    # v2 déclaré à l'ingest ; un client legacy (sans champ plugin) compte pour v1
    client.post("/api/code/ingest", headers=H, json={"client": "c2", "plugin": 2, "events": []})
    assert client.get("/api/code/health").json()["plugin_version"] == 2
    client.post("/api/code/ingest", headers=H, json={"client": "c1", "events": []})
    assert client.get("/api/code/health").json()["plugin_version"] == 1


def test_new_requires_plugin_v13(monkeypatch, tmp_path):
    """Créer une session depuis la page exige le greffon v13.

    v7→v12 se contentaient du raccourci `session.new` du TUI, or opencode ne
    matérialise la session qu'au premier message : rien n'apparaissait — le
    « /new ne fait rien ». Mieux vaut un refus explicite qu'un faux succès.
    """
    import shared_infra.opencode.store as cstore
    client, _code = _client(monkeypatch, tmp_path)
    cstore.seen_client(1, "vieux", plugin_version=12, directory="/w")
    r = client.post("/api/code/new", json={"client": "vieux"})
    assert r.status_code == 409 and "v13" in r.json()["detail"]
    cstore.seen_client(1, "neuf", plugin_version=13, directory="/w")
    assert client.post("/api/code/new", json={"client": "neuf"}).status_code == 200


def test_empty_session_is_published(monkeypatch, tmp_path):
    """Une session SANS message doit apparaître dans la liste (greffon v13).

    Avant, le greffon retenait les sessions vides pour éviter des entrées
    fantômes : la page affichait « CLI connectée » au-dessus d'une liste vide, et
    il fallait envoyer un message pour voir la conversation.
    """
    client, _code = _client(monkeypatch, tmp_path)
    tok = client.post("/api/code/token").json()["token"]
    H = {"x-elpis-token": tok}
    client.post("/api/code/ingest", headers=H, json={"client": "c1", "events": [
        {"type": "session.snapshot", "properties": {
            "session": {"id": "s1", "title": "fraîche"}, "messages": []}}]})
    sessions = client.get("/api/code/sessions").json()
    assert [s["id"] for s in sessions] == ["s1"]
    assert sessions[0]["msg_count"] == 0
    assert sessions[0]["connected"] is True


def test_only_one_empty_session_per_cli(monkeypatch, tmp_path):
    """Garde-fou anti-fantômes : publier les sessions vides ne doit pas les empiler.

    Chaque redémarrage d'opencode en ouvre une nouvelle ; sans ce ménage on
    retrouverait le « ça me crée deux sessions » qui avait motivé l'ancienne
    rétention. Une session vide n'a aucun contenu à perdre.
    """
    client, _code = _client(monkeypatch, tmp_path)
    tok = client.post("/api/code/token").json()["token"]
    H = {"x-elpis-token": tok}
    for sid in ("s1", "s2", "s3"):
        client.post("/api/code/ingest", headers=H, json={"client": "c1", "events": [
            {"type": "session.snapshot", "properties": {
                "session": {"id": sid, "title": sid}, "messages": []}}]})
    assert [s["id"] for s in client.get("/api/code/sessions").json()] == ["s3"]


def test_empty_pruning_spares_sessions_with_content(monkeypatch, tmp_path):
    # Ce qui a du contenu (message OU trace de commande) n'est JAMAIS balayé,
    # et une session vide d'une AUTRE CLI non plus.
    client, _code = _client(monkeypatch, tmp_path)
    tok = client.post("/api/code/token").json()["token"]
    H = {"x-elpis-token": tok}
    client.post("/api/code/ingest", headers=H, json={"client": "c1", "events": [
        {"type": "session.snapshot", "properties": {
            "session": {"id": "avec", "title": "avec"},
            "messages": [{"info": {"id": "m1", "role": "user", "sessionID": "avec"}, "parts": []}]}}]})
    client.post("/api/code/ingest", headers=H, json={"client": "c2", "events": [
        {"type": "session.snapshot", "properties": {
            "session": {"id": "autre-cli"}, "messages": []}}]})
    client.post("/api/code/ingest", headers=H, json={"client": "c1", "events": [
        {"type": "session.snapshot", "properties": {"session": {"id": "vide"}, "messages": []}}]})
    ids = {s["id"] for s in client.get("/api/code/sessions").json()}
    assert ids == {"avec", "autre-cli", "vide"}
    # une 2e session vide de c1 remplace « vide », sans toucher aux deux autres
    client.post("/api/code/ingest", headers=H, json={"client": "c1", "events": [
        {"type": "session.snapshot", "properties": {"session": {"id": "vide2"}, "messages": []}}]})
    ids = {s["id"] for s in client.get("/api/code/sessions").json()}
    assert ids == {"avec", "autre-cli", "vide2"}


def test_health_reports_undeliverable_commands(monkeypatch, tmp_path):
    """CLI morte sans dire au revoir : l'envoi doit être DIT non délivré.

    Sans ce balayage, la page acceptait le prompt (le client paraît vivant
    pendant le TTL), la commande restait en file puis disparaissait en silence :
    « j'ai envoyé, il ne s'est rien passé ».
    """
    import time as _t
    client, code = _client(monkeypatch, tmp_path)
    store = code._cstore
    tok = client.post("/api/code/token").json()["token"]
    H = {"x-elpis-token": tok}
    client.post("/api/code/ingest", headers=H, json={"client": "c1", "events": [
        {"type": "session.created", "properties": {"info": {"id": "s1", "title": "T"}}}]})
    assert client.post("/api/code/sessions/s1/prompt", json={"text": "salut"}).status_code == 200
    # rien à balayer tant que la CLI répond
    assert store.sweep_undeliverable(1) == []
    # la CLI disparaît (plus aucun pull) et la commande dépasse le TTL client
    with _db_conn(store) as c:
        c.execute("UPDATE code_clients SET last_seen=?", (_t.time() - 999,))
        c.execute("UPDATE code_commands SET created_at=?", (_t.time() - 999,))
        c.commit()
    client.get("/api/code/health")
    msgs = client.get("/api/code/sessions/s1/messages").json()
    notes = [m["info"]["note"] for m in msgs if m["info"].get("role") == "note"]
    assert any(n["kind"] == "error" and "livr" in n["label"] for n in notes), notes
    # la commande est bien partie : pas de livraison fantôme si la CLI revient
    assert client.get("/api/code/pull?client=c1", headers=H).json()["commands"] == []


def test_sweep_spares_commands_a_live_cli_can_still_take(monkeypatch, tmp_path):
    # Une commande vieille mais dont le destinataire est VIVANT reste en file :
    # on ne doit jamais annuler un envoi qui va aboutir.
    import time as _t
    client, code = _client(monkeypatch, tmp_path)
    store = code._cstore
    tok = client.post("/api/code/token").json()["token"]
    H = {"x-elpis-token": tok}
    client.post("/api/code/ingest", headers=H, json={"client": "c1", "events": [
        {"type": "session.created", "properties": {"info": {"id": "s1"}}}]})
    client.post("/api/code/sessions/s1/prompt", json={"text": "salut"})
    with _db_conn(store) as c:
        c.execute("UPDATE code_commands SET created_at=?", (_t.time() - 60,))
        c.commit()
    assert store.sweep_undeliverable(1) == []
    assert len(client.get("/api/code/pull?client=c1", headers=H).json()["commands"]) == 1


def test_agents_pushed_and_listed(monkeypatch, tmp_path):
    """Modes plan/build : le plugin v12 pousse les agents PRIMAIRES de la CLI.

    Sans eux, la page n'affiche pas le sélecteur — mieux vaut rien qu'un choix
    qui ne serait pas appliqué (le plugin d'un poste non mis à jour ignore le
    champ `agent` du prompt).
    """
    client, _code = _client(monkeypatch, tmp_path)
    assert client.get("/api/code/agents").json() == {"agents": [], "default": ""}
    tok = client.post("/api/code/token").json()["token"]
    client.post("/api/code/ingest", headers={"x-elpis-token": tok}, json={"client": "c1", "events": [
        {"type": "client.agents", "properties": {
            "agents": [{"name": "build", "description": "edite"},
                       {"name": "plan", "description": "lecture seule"},
                       {"name": "", "description": "sans nom"},      # ignoré
                       "pas-un-objet"],                              # ignoré
            "default": "build"}}]})
    d = client.get("/api/code/agents").json()
    assert [a["name"] for a in d["agents"]] == ["build", "plan"]
    assert d["default"] == "build"


def test_agents_default_falls_back_to_a_real_agent(monkeypatch, tmp_path):
    # défaut incohérent (agent absent de la liste) → on retombe sur `build`,
    # jamais sur un nom que la CLI refuserait.
    client, _code = _client(monkeypatch, tmp_path)
    tok = client.post("/api/code/token").json()["token"]
    client.post("/api/code/ingest", headers={"x-elpis-token": tok}, json={"client": "c1", "events": [
        {"type": "client.agents", "properties": {
            "agents": [{"name": "plan"}, {"name": "build"}], "default": "fantome"}}]})
    assert client.get("/api/code/agents").json()["default"] == "build"


def test_prompt_carries_agent_and_rejects_unknown(monkeypatch, tmp_path):
    client, code = _client(monkeypatch, tmp_path)
    tok = client.post("/api/code/token").json()["token"]
    H = {"x-elpis-token": tok}
    client.post("/api/code/ingest", headers=H, json={"client": "c1", "events": [
        {"type": "client.agents", "properties": {
            "agents": [{"name": "build"}, {"name": "plan"}], "default": "build"}}]})
    # agent connu → transmis tel quel au plugin par le pull
    assert client.post("/api/code/sessions/s1/prompt",
                       json={"text": "salut", "agent": "plan"}).status_code == 200
    cmds = client.get("/api/code/pull?client=c1", headers=H).json()["commands"]
    assert [c["kind"] for c in cmds] == ["prompt"]
    assert cmds[0]["agent"] == "plan"
    # agent inconnu → refus NET (422) plutôt qu'un tour silencieusement dégradé
    r = client.post("/api/code/sessions/s1/prompt", json={"text": "salut", "agent": "root"})
    assert r.status_code == 422


def test_prompt_without_agent_stays_untouched(monkeypatch, tmp_path):
    # Aucun choix explicite dans la page ⇒ AUCUN champ `agent` : le mode courant
    # du TUI (touche tab) ne doit pas être écrasé par la page.
    client, code = _client(monkeypatch, tmp_path)
    tok = client.post("/api/code/token").json()["token"]
    H = {"x-elpis-token": tok}
    client.post("/api/code/ingest", headers=H, json={"client": "c1", "events": []})
    assert client.post("/api/code/sessions/s1/prompt", json={"text": "salut"}).status_code == 200
    cmds = client.get("/api/code/pull?client=c1", headers=H).json()["commands"]
    assert "agent" not in cmds[0]


def test_models_pushed_and_listed(monkeypatch, tmp_path):
    # le plugin v3+ pousse les modèles (client.models) → sélecteur /model de la page
    client, _code = _client(monkeypatch, tmp_path)
    assert client.get("/api/code/models").json() == {"providers": [], "default": {}}
    tok = client.post("/api/code/token").json()["token"]
    client.post("/api/code/ingest", headers={"x-elpis-token": tok}, json={"client": "c1", "events": [
        {"type": "client.models", "properties": {
            "providers": [
                {"id": "elpis", "name": "Elpis", "models": [
                    {"id": "qwen3-32b", "name": "Qwen3 32B"}, {"id": "glm-4.7"}]},
                # shape map id->model (opencode) tolérée aussi
                {"id": "anthropic", "models": {"claude-x": {"id": "claude-x", "name": "Claude X"}}},
                {"id": "vide", "models": []},   # sans modèles → ignoré
            ],
            "default": {"elpis": "qwen3-32b"},   # plugin v4
        }}]})
    d = client.get("/api/code/models").json()
    provs = d["providers"]
    assert [p["id"] for p in provs] == ["elpis", "anthropic"]
    assert provs[0]["models"][1] == {"id": "glm-4.7", "name": "glm-4.7"}
    assert provs[1]["models"] == [{"id": "claude-x", "name": "Claude X"}]
    assert d["default"] == {"elpis": "qwen3-32b"}


def test_action_queued_and_pulled(monkeypatch, tmp_path):
    # actions natives (undo/compact/share/…) → kind "action" tiré par le plugin
    client, _code = _client(monkeypatch, tmp_path)
    tok = client.post("/api/code/token").json()["token"]
    H = {"x-elpis-token": tok}
    client.post("/api/code/ingest", headers=H, json={"client": "c1", "events": [
        {"type": "session.created", "properties": {"info": {"id": "s1"}}}]})
    assert client.post("/api/code/sessions/s1/action", json={"action": "inconnu"}).status_code == 422
    assert client.post("/api/code/sessions/s1/action", json={}).status_code == 422
    for a in ("undo", "compact", "share"):
        assert client.post("/api/code/sessions/s1/action", json={"action": a}).json()["queued"] is True
    got = client.get("/api/code/pull?client=c1&wait=0", headers=H).json()["commands"]
    assert [(c["kind"], c["action"]) for c in got] == [
        ("action", "undo"), ("action", "compact"), ("action", "share")]


def test_prompt_model_passthrough(monkeypatch, tmp_path):
    # le sélecteur /model de la page force le modèle du prompt distant
    client, _code = _client(monkeypatch, tmp_path)
    tok = client.post("/api/code/token").json()["token"]
    H = {"x-elpis-token": tok}
    client.post("/api/code/ingest", headers=H, json={"client": "c1", "events": [
        {"type": "session.created", "properties": {"info": {"id": "s1"}}}]})
    client.post("/api/code/sessions/s1/prompt", json={
        "text": "go", "model": {"providerID": "elpis", "modelID": "qwen3-32b"}})
    client.post("/api/code/sessions/s1/prompt", json={
        "text": "sans modèle", "model": {"providerID": "x"}})   # incomplet → ignoré
    got = client.get("/api/code/pull?client=c1&wait=0", headers=H).json()["commands"]
    assert got[0]["model"] == {"providerID": "elpis", "modelID": "qwen3-32b"}
    assert "model" not in got[1]


def test_sessions_expose_connected_flag(monkeypatch, tmp_path):
    client, code = _client(monkeypatch, tmp_path)
    tok = client.post("/api/code/token").json()["token"]
    H = {"x-elpis-token": tok}
    client.post("/api/code/ingest", headers=H, json={"client": "c1", "events": [
        {"type": "session.created", "properties": {"info": {"id": "s1", "time": {"updated": 2}}}}]})
    client.post("/api/code/ingest", headers=H, json={"client": "c2", "events": [
        {"type": "session.created", "properties": {"info": {"id": "s2", "time": {"updated": 1}}}}]})
    assert [s["connected"] for s in client.get("/api/code/sessions").json()] == [True, True]
    # le client c2 meurt (last_seen trop vieux) → s2 passe « hors ligne », s1 reste
    import time as _t

    import shared_infra.opencode.store as cstore
    with cstore._db() as c:
        c.execute("UPDATE code_clients SET last_seen=? WHERE client_id='c2'",
                  (_t.time() - 10 * cstore.CLIENT_TTL,))
        c.commit()
    flags = {s["id"]: s["connected"] for s in client.get("/api/code/sessions").json()}
    assert flags == {"s1": True, "s2": False}


# ─────────────────────────────────────────────────────────────────────────────
#  v5 : limites ctx, déconnexion propre (bye), renommage, permissions, notes
# ─────────────────────────────────────────────────────────────────────────────
def test_models_limits_roundtrip(monkeypatch, tmp_path):
    # plugin v5 : limit.context/output conservés → jauge ctx de la page
    client, _code = _client(monkeypatch, tmp_path)
    tok = client.post("/api/code/token").json()["token"]
    client.post("/api/code/ingest", headers={"x-elpis-token": tok}, json={"client": "c1", "events": [
        {"type": "client.models", "properties": {"providers": [
            {"id": "elpis", "models": [
                {"id": "qwen3-32b", "limit": {"context": 128000, "output": 8000}},
                {"id": "sans-limite"},                       # plugin v4 / limite inconnue
                {"id": "limite-cassee", "limit": {"context": "nan"}},
            ]}]}}]})
    models = client.get("/api/code/models").json()["providers"][0]["models"]
    by_id = {m["id"]: m for m in models}
    assert by_id["qwen3-32b"]["limit"] == {"context": 128000, "output": 8000}
    assert "limit" not in by_id["sans-limite"]
    assert "limit" not in by_id["limite-cassee"]   # int() en échec → champ omis


def test_bye_marks_client_dead_immediately(monkeypatch, tmp_path):
    client, code = _client(monkeypatch, tmp_path)
    tok = client.post("/api/code/token").json()["token"]
    H = {"x-elpis-token": tok}
    client.post("/api/code/ingest", headers=H, json={"client": "c1", "events": [
        {"type": "session.created", "properties": {"info": {"id": "s1"}}}]})
    assert client.get("/api/code/health").json()["connected"] is True
    r = client.post("/api/code/bye", headers=H, json={"client": "c1"})
    assert r.status_code == 200
    # santé ET badge par-session basculent tout de suite (pas d'attente TTL)
    assert client.get("/api/code/health").json()["connected"] is False
    assert client.get("/api/code/sessions").json()[0]["connected"] is False
    # la page est prévenue en live (SSE client.disconnected)
    types = [m["data"]["type"] for _, m in code.pipeline_events.published]
    assert "client.disconnected" in types


def test_bye_tombstone_survives_late_pull(monkeypatch, tmp_path):
    # un long-poll /pull encore en vol après le bye ne ressuscite pas le client
    client, _code = _client(monkeypatch, tmp_path)
    tok = client.post("/api/code/token").json()["token"]
    H = {"x-elpis-token": tok}
    client.post("/api/code/ingest", headers=H, json={"client": "c1", "events": [
        {"type": "session.created", "properties": {"info": {"id": "s1"}}}]})
    client.post("/api/code/bye", headers=H, json={"client": "c1"})
    client.get("/api/code/pull?client=c1&wait=0", headers=H)   # seen_client tardif
    assert client.get("/api/code/health").json()["connected"] is False
    assert client.get("/api/code/sessions").json()[0]["connected"] is False


def test_bye_then_reingest_revives_client(monkeypatch, tmp_path):
    # /remote off → on (même process) : un INGEST lève le tombstone (revive),
    # contrairement au /pull tardif qui ne doit jamais ressusciter
    client, _code = _client(monkeypatch, tmp_path)
    tok = client.post("/api/code/token").json()["token"]
    H = {"x-elpis-token": tok}
    client.post("/api/code/ingest", headers=H, json={"client": "c1", "events": [
        {"type": "session.created", "properties": {"info": {"id": "s1"}}}]})
    client.post("/api/code/bye", headers=H, json={"client": "c1"})
    assert client.get("/api/code/sessions").json()[0]["connected"] is False
    # ré-annonce (ingest vide, comme le start() du plugin) → de nouveau connecté
    client.post("/api/code/ingest", headers=H, json={"client": "c1", "plugin": 5, "events": []})
    assert client.get("/api/code/health").json()["connected"] is True
    assert client.get("/api/code/sessions").json()[0]["connected"] is True


def test_bye_requires_token(monkeypatch, tmp_path):
    client, _code = _client(monkeypatch, tmp_path)
    assert client.post("/api/code/bye", json={"client": "c1"}).status_code == 401


def test_rename_queued_and_pulled(monkeypatch, tmp_path):
    client, _code = _client(monkeypatch, tmp_path)
    tok = client.post("/api/code/token").json()["token"]
    H = {"x-elpis-token": tok}
    client.post("/api/code/ingest", headers=H, json={"client": "c1", "plugin": 5, "events": [
        {"type": "session.created", "properties": {"info": {"id": "s1"}}}]})
    r = client.post("/api/code/sessions/s1/rename", json={"title": "  Refonte   auth  "})
    assert r.json()["queued"] is True
    got = client.get("/api/code/pull?client=c1&wait=0", headers=H).json()["commands"]
    assert len(got) == 1 and got[0]["kind"] == "rename"
    assert got[0]["title"] == "Refonte auth"   # espaces normalisés


def test_rename_rejects_plugin_v4(monkeypatch, tmp_path):
    # un plugin v4 ignorerait silencieusement le kind rename → 409 explicite
    client, _code = _client(monkeypatch, tmp_path)
    tok = client.post("/api/code/token").json()["token"]
    client.post("/api/code/ingest", headers={"x-elpis-token": tok},
                json={"client": "c1", "plugin": 4, "events": [
                    {"type": "session.created", "properties": {"info": {"id": "s1"}}}]})
    r = client.post("/api/code/sessions/s1/rename", json={"title": "X"})
    assert r.status_code == 409 and "v5" in r.json()["detail"]


def test_rename_validates_title(monkeypatch, tmp_path):
    client, _code = _client(monkeypatch, tmp_path)
    # aucune CLI connectée → 409
    assert client.post("/api/code/sessions/s1/rename", json={"title": "X"}).status_code == 409
    tok = client.post("/api/code/token").json()["token"]
    client.post("/api/code/ingest", headers={"x-elpis-token": tok},
                json={"client": "c1", "plugin": 5, "events": []})
    assert client.post("/api/code/sessions/s1/rename", json={"title": "  "}).status_code == 422
    assert client.post("/api/code/sessions/s1/rename", json={"title": "x" * 201}).status_code == 422


def test_permission_updated_stored_and_listed(monkeypatch, tmp_path):
    client, _code = _client(monkeypatch, tmp_path)
    tok = client.post("/api/code/token").json()["token"]
    H = {"x-elpis-token": tok}
    assert client.get("/api/code/sessions/s1/permissions").json() == []
    client.post("/api/code/ingest", headers=H, json={"client": "c1", "events": [
        {"type": "session.created", "properties": {"info": {"id": "s1"}}},
        {"type": "permission.updated", "properties": {
            "id": "perm1", "type": "bash", "pattern": "rm *", "sessionID": "s1",
            "messageID": "m1", "title": "Exécuter rm -rf ?", "metadata": {},
            "time": {"created": 1000}}},
    ]})
    perms = client.get("/api/code/sessions/s1/permissions").json()
    assert len(perms) == 1 and perms[0]["id"] == "perm1"
    assert perms[0]["title"] == "Exécuter rm -rf ?" and perms[0]["pattern"] == "rm *"


def test_permission_reply_queued_then_replied_clears(monkeypatch, tmp_path):
    client, _code = _client(monkeypatch, tmp_path)
    tok = client.post("/api/code/token").json()["token"]
    H = {"x-elpis-token": tok}
    client.post("/api/code/ingest", headers=H, json={"client": "c1", "events": [
        {"type": "session.created", "properties": {"info": {"id": "s1"}}},
        {"type": "permission.updated", "properties": {
            "id": "perm1", "type": "edit", "sessionID": "s1", "title": "Modifier x.py ?",
            "time": {"created": 1000}}},
    ]})
    # la page répond → commande kind permission tirée par le plugin
    r = client.post("/api/code/sessions/s1/permissions/perm1", json={"response": "always"})
    assert r.json()["queued"] is True
    got = client.get("/api/code/pull?client=c1&wait=0", headers=H).json()["commands"]
    assert got[0]["kind"] == "permission"
    assert got[0]["permissionID"] == "perm1" and got[0]["response"] == "always"
    # le round-trip permission.replied (page OU TUI) retire la demande
    client.post("/api/code/ingest", headers=H, json={"client": "c1", "events": [
        {"type": "permission.replied", "properties": {
            "sessionID": "s1", "permissionID": "perm1", "response": "always"}}]})
    assert client.get("/api/code/sessions/s1/permissions").json() == []


def test_permission_asked_v2_shape_normalized(monkeypatch, tmp_path):
    # shape v2 RÉELLE du binaire 1.17.7 : permission.asked {permission, patterns,
    # metadata, tool} sans title/time → normalisée (type/pattern/title) au store
    # et rediffusée en "permission.updated" normalisé sur le SSE
    client, code = _client(monkeypatch, tmp_path)
    tok = client.post("/api/code/token").json()["token"]
    H = {"x-elpis-token": tok}
    client.post("/api/code/ingest", headers=H, json={"client": "c1", "events": [
        {"type": "session.created", "properties": {"info": {"id": "s1"}}},
        {"type": "permission.asked", "properties": {
            "id": "per_1", "sessionID": "s1", "permission": "bash",
            "patterns": ["echo test"], "metadata": {"command": "echo test", "description": "d"},
            "tool": {"messageID": "m1", "callID": "call_1"}}},
    ]})
    perms = client.get("/api/code/sessions/s1/permissions").json()
    assert len(perms) == 1
    assert perms[0]["type"] == "bash" and perms[0]["pattern"] == "echo test"
    assert perms[0]["title"] == "echo test"
    # SSE : rediffusé sous le type unifié, normalisé
    pub = [m["data"] for _, m in code.pipeline_events.published
           if m["data"]["type"] == "permission.updated"]
    assert pub and pub[0]["properties"]["title"] == "echo test"
    # replied v2 : requestID/reply (pas permissionID/response)
    client.post("/api/code/ingest", headers=H, json={"client": "c1", "events": [
        {"type": "permission.replied", "properties": {
            "sessionID": "s1", "requestID": "per_1", "reply": "once"}}]})
    assert client.get("/api/code/sessions/s1/permissions").json() == []
    rep = [m["data"] for _, m in code.pipeline_events.published
           if m["data"]["type"] == "permission.replied"]
    assert rep and rep[0]["properties"]["permissionID"] == "per_1"


def test_permission_reply_validates_response(monkeypatch, tmp_path):
    client, _code = _client(monkeypatch, tmp_path)
    tok = client.post("/api/code/token").json()["token"]
    client.post("/api/code/ingest", headers={"x-elpis-token": tok},
                json={"client": "c1", "events": []})
    assert client.post("/api/code/sessions/s1/permissions/p1",
                       json={"response": "peut-être"}).status_code == 422
    assert client.post("/api/code/sessions/s1/permissions/p1", json={}).status_code == 422


def test_command_note_persisted_and_merged(monkeypatch, tmp_path):
    # trace « /commande » dans le transcript — et elle survit à un re-snapshot
    client, code = _client(monkeypatch, tmp_path)
    tok = client.post("/api/code/token").json()["token"]
    H = {"x-elpis-token": tok}
    client.post("/api/code/ingest", headers=H, json={"client": "c1", "events": [
        {"type": "session.snapshot", "properties": {
            "session": {"id": "s1", "time": {"updated": 5}},
            "messages": [{"info": {"id": "m1", "role": "user", "sessionID": "s1",
                                   "time": {"created": 1000}}, "parts": []}]}}]})
    client.post("/api/code/sessions/s1/command", json={"command": "review", "arguments": "HEAD~1"})
    msgs = client.get("/api/code/sessions/s1/messages").json()
    notes = [m for m in msgs if m["info"].get("role") == "note"]
    assert len(notes) == 1
    assert notes[0]["info"]["note"] == {"kind": "command", "label": "/review", "detail": "HEAD~1"}
    assert msgs[-1]["info"]["role"] == "note"   # created (ms, now) > 1000 → en dernier
    # SSE code.note émis pour la maj live
    assert any(m["data"]["type"] == "code.note" for _, m in code.pipeline_events.published)
    # re-snapshot (delete+réinsertion) : la note reste
    client.post("/api/code/ingest", headers=H, json={"client": "c1", "events": [
        {"type": "session.snapshot", "properties": {
            "session": {"id": "s1", "time": {"updated": 6}}, "messages": []}}]})
    msgs = client.get("/api/code/sessions/s1/messages").json()
    assert [m["info"].get("role") for m in msgs] == ["note"]


def test_action_note_persisted(monkeypatch, tmp_path):
    client, _code = _client(monkeypatch, tmp_path)
    tok = client.post("/api/code/token").json()["token"]
    client.post("/api/code/ingest", headers={"x-elpis-token": tok}, json={"client": "c1", "events": [
        {"type": "session.created", "properties": {"info": {"id": "s1"}}}]})
    client.post("/api/code/sessions/s1/action", json={"action": "undo"})
    msgs = client.get("/api/code/sessions/s1/messages").json()
    assert msgs and msgs[-1]["info"]["note"] == {"kind": "action", "label": "/undo", "detail": ""}


def test_dismiss_clears_notes_and_permissions(monkeypatch, tmp_path):
    client, _code = _client(monkeypatch, tmp_path)
    tok = client.post("/api/code/token").json()["token"]
    H = {"x-elpis-token": tok}
    client.post("/api/code/ingest", headers=H, json={"client": "c1", "events": [
        {"type": "session.created", "properties": {"info": {"id": "s1"}}},
        {"type": "permission.updated", "properties": {
            "id": "perm1", "type": "bash", "sessionID": "s1", "title": "?", "time": {"created": 1}}},
    ]})
    client.post("/api/code/sessions/s1/action", json={"action": "undo"})
    client.delete("/api/code/sessions/s1")
    import shared_infra.opencode.store as cstore
    with cstore._db() as c:
        assert c.execute("SELECT COUNT(*) FROM code_notes").fetchone()[0] == 0
        assert c.execute("SELECT COUNT(*) FROM code_permissions").fetchone()[0] == 0


def test_sessions_meta_aggregates(monkeypatch, tmp_path):
    # cartes de la landing : msg_count + last_model + preview + client
    client, _code = _client(monkeypatch, tmp_path)
    tok = client.post("/api/code/token").json()["token"]
    H = {"x-elpis-token": tok}
    client.post("/api/code/ingest", headers=H, json={"client": "c1", "events": [
        {"type": "session.created", "properties": {"info": {"id": "s1", "time": {"updated": 2}}}},
        {"type": "message.updated", "properties": {"info": {
            "id": "m1", "role": "user", "sessionID": "s1", "time": {"created": 1}}}},
        {"type": "message.part.updated", "properties": {"part": {
            "id": "p1", "type": "text", "text": "  Bonjour,\n\npeux-tu corriger le bug ? ",
            "messageID": "m1", "sessionID": "s1"}}},
        {"type": "message.updated", "properties": {"info": {
            "id": "m2", "role": "assistant", "sessionID": "s1", "time": {"created": 2, "completed": 3},
            "providerID": "elpis", "modelID": "qwen3-32b"}}},
        {"type": "message.part.updated", "properties": {"part": {
            "id": "p2", "type": "text", "text": "Corrigé.", "messageID": "m2", "sessionID": "s1"}}},
        # part synthétique : ne doit PAS écraser l'aperçu
        {"type": "message.part.updated", "properties": {"part": {
            "id": "p3", "type": "text", "text": "interne", "synthetic": True,
            "messageID": "m2", "sessionID": "s1"}}},
    ]})
    s = client.get("/api/code/sessions").json()[0]
    assert s["msg_count"] == 2 and s["client"] == "c1"
    assert s["last_model"] == "elpis/qwen3-32b"
    assert s["preview"] == "Corrigé."   # dernier texte non synthétique, aplati


def test_ingest_fans_out_on_bus(monkeypatch, tmp_path):
    client, code = _client(monkeypatch, tmp_path)
    tok = client.post("/api/code/token").json()["token"]
    client.post("/api/code/ingest", headers={"x-elpis-token": tok}, json={"client": "c1", "events": [
        {"type": "session.created", "properties": {"info": {"id": "s1"}}},
        {"type": "session.snapshot", "properties": {
            "session": {"id": "s1"},
            "messages": [{"info": {"id": "m1", "role": "user", "sessionID": "s1"}, "parts": []}]}},
    ]})
    pub = code.pipeline_events.published
    assert [u for u, _ in pub] == [1, 1]
    assert all(m["type"] == "code.event" for _, m in pub)
    assert pub[0][1]["data"]["type"] == "session.created"
    # snapshot : rediffusé SANS les messages (lourd) — la page recharge via GET
    snap = pub[1][1]["data"]
    assert snap["type"] == "session.snapshot"
    assert "messages" not in snap["properties"] and snap["properties"]["session"]["id"] == "s1"

# ── /new et /exit : ciblage STRICT d'une CLI ────────────────────────────────
# Sans cible, claim_commands route par propriétaire de session — et si celui-ci
# est inconnu ou hors ligne, N'IMPORTE QUELLE CLI connectée peut ramasser la
# commande. Avec deux opencode ouverts, la session naissait dans le mauvais.

def test_new_is_never_claimed_by_another_client(monkeypatch, tmp_path):
    client, code = _client(monkeypatch, tmp_path)
    import shared_infra.opencode.store as cstore
    for cid in ("cliA", "cliB"):
        cstore.seen_client(1, cid, plugin_version=13, directory="/w/" + cid)

    r = client.post("/api/code/new", json={"client": "cliA"})
    assert r.status_code == 200 and r.json()["client"] == "cliA"
    # la CLI NON ciblée ne doit rien recevoir…
    assert cstore.claim_commands(1, "cliB") == []
    # …et la cible reçoit bien la commande
    got = cstore.claim_commands(1, "cliA")
    assert [c["kind"] for c in got] == ["action"]
    assert got[0]["action"] == "new"


def test_new_requires_an_explicit_target_when_several_clients(monkeypatch, tmp_path):
    client, code = _client(monkeypatch, tmp_path)
    import shared_infra.opencode.store as cstore
    for cid in ("cliA", "cliB"):
        cstore.seen_client(1, cid, plugin_version=13, directory="/w/" + cid)
    r = client.post("/api/code/new", json={})
    assert r.status_code == 409
    assert "précisez" in r.json()["detail"]


def test_exit_targets_only_the_named_client(monkeypatch, tmp_path):
    client, code = _client(monkeypatch, tmp_path)
    import shared_infra.opencode.store as cstore
    for cid in ("cliA", "cliB"):
        cstore.seen_client(1, cid, plugin_version=13, directory="/w/" + cid)

    r = client.post("/api/code/clients/cliA/exit")
    assert r.status_code == 200
    assert cstore.claim_commands(1, "cliB") == []
    got = cstore.claim_commands(1, "cliA")
    assert [c["kind"] for c in got] == ["exit"]


# ─────────────────────────────────────────────────────────────────────────────
#  v14 : questions de l'outil `question` — bloquantes côté CLI, invisibles
#  depuis la page jusqu'ici. Shape 1.18.16 lue dans le binaire (QuestionRequest).
# ─────────────────────────────────────────────────────────────────────────────
_Q_ASKED = {"type": "question.asked", "properties": {
    "id": "que_1", "sessionID": "s1",
    "questions": [
        {"question": "Quelle base ?", "header": "Base",
         "options": [{"label": "Postgres", "description": "prod"},
                     {"label": "SQLite", "description": "dev"}]},
        {"question": "Options ?", "header": "Options", "multiple": True, "custom": False,
         "options": [{"label": "tests"}, {"label": "docs"}]},
    ],
    "tool": {"messageID": "m1", "callID": "call_1"}}}


def _q_client(monkeypatch, tmp_path, plugin=14):
    client, code = _client(monkeypatch, tmp_path)
    tok = client.post("/api/code/token").json()["token"]
    H = {"x-elpis-token": tok}
    client.post("/api/code/ingest", headers=H, json={"client": "c1", "plugin": plugin, "events": [
        {"type": "session.created", "properties": {"info": {"id": "s1"}}}, _Q_ASKED]})
    return client, code, H


def test_question_asked_stored_normalized_and_broadcast(monkeypatch, tmp_path):
    client, code, _H = _q_client(monkeypatch, tmp_path)
    qs = client.get("/api/code/sessions/s1/questions").json()
    assert len(qs) == 1 and qs[0]["id"] == "que_1" and qs[0]["sessionID"] == "s1"
    q0, q1 = qs[0]["questions"]
    assert q0["question"] == "Quelle base ?" and q0["header"] == "Base"
    assert [o["label"] for o in q0["options"]] == ["Postgres", "SQLite"]
    assert q0["options"][0]["description"] == "prod"
    # défauts opencode : choix unique, saisie libre AUTORISÉE sauf custom:false
    assert q0["multiple"] is False and q0["custom"] is True
    assert q1["multiple"] is True and q1["custom"] is False
    assert qs[0]["tool"] == {"messageID": "m1", "callID": "call_1"}
    # SSE : rediffusé normalisé (même shape que la liste)
    pub = [m["data"] for _, m in code.pipeline_events.published
           if m["data"]["type"] == "question.asked"]
    assert pub and pub[0]["properties"]["questions"][0]["options"][1]["label"] == "SQLite"
    # autre session : rien
    assert client.get("/api/code/sessions/s2/questions").json() == []


def test_question_reply_queued_then_replied_clears(monkeypatch, tmp_path):
    client, code, H = _q_client(monkeypatch, tmp_path)
    r = client.post("/api/code/sessions/s1/questions/que_1",
                    json={"answers": [["Postgres"], ["tests", "docs"]]})
    assert r.status_code == 200 and r.json()["queued"] is True
    got = client.get("/api/code/pull?client=c1&wait=0", headers=H).json()["commands"]
    assert len(got) == 1
    assert got[0]["kind"] == "question" and got[0]["sid"] == "s1"
    assert got[0]["questionID"] == "que_1"
    assert got[0]["answers"] == [["Postgres"], ["tests", "docs"]]
    assert "response" not in got[0]
    # la question reste listée tant que la CLI n'a pas confirmé (page : retrait optimiste)
    assert len(client.get("/api/code/sessions/s1/questions").json()) == 1
    # round-trip question.replied (shape binaire : requestID + answers)
    client.post("/api/code/ingest", headers=H, json={"client": "c1", "events": [
        {"type": "question.replied", "properties": {
            "sessionID": "s1", "requestID": "que_1", "answers": [["Postgres"], ["tests", "docs"]]}}]})
    assert client.get("/api/code/sessions/s1/questions").json() == []
    rep = [m["data"] for _, m in code.pipeline_events.published
           if m["data"]["type"] == "question.replied"]
    assert rep and rep[0]["properties"] == {"sessionID": "s1", "questionID": "que_1"}


def test_question_reject_queued_then_rejected_clears(monkeypatch, tmp_path):
    client, code, H = _q_client(monkeypatch, tmp_path)
    r = client.post("/api/code/sessions/s1/questions/que_1", json={"reject": True})
    assert r.status_code == 200
    got = client.get("/api/code/pull?client=c1&wait=0", headers=H).json()["commands"]
    assert got[0]["kind"] == "question" and got[0]["questionID"] == "que_1"
    assert got[0]["response"] == "reject" and "answers" not in got[0]
    # refusé côté TUI aussi possible : question.rejected retire la demande
    client.post("/api/code/ingest", headers=H, json={"client": "c1", "events": [
        {"type": "question.rejected", "properties": {"sessionID": "s1", "requestID": "que_1"}}]})
    assert client.get("/api/code/sessions/s1/questions").json() == []
    rej = [m["data"] for _, m in code.pipeline_events.published
           if m["data"]["type"] == "question.rejected"]
    assert rej and rej[0]["properties"]["questionID"] == "que_1"


def test_question_reply_validates_answers(monkeypatch, tmp_path):
    client, _code, H = _q_client(monkeypatch, tmp_path)
    url = "/api/code/sessions/s1/questions/que_1"
    assert client.post(url, json={}).status_code == 422
    assert client.post(url, json={"answers": []}).status_code == 422
    assert client.post(url, json={"answers": "Postgres"}).status_code == 422
    assert client.post(url, json={"answers": [[]]}).status_code == 422          # vide
    assert client.post(url, json={"answers": [["  "], []]}).status_code == 422  # blancs
    assert client.post(url, json={"answers": [[{"x": 1}]]}).status_code == 422
    assert client.post(url, json={"answers": [["a"] * 31]}).status_code == 422  # trop de libellés
    assert client.post(url, json={"answers": [["a"]] * 21}).status_code == 422  # trop de questions
    # tolérance : un libellé nu vaut une liste d'un libellé ; texte libre accepté tel quel
    assert client.post(url, json={"answers": ["Postgres", ["  ma réponse libre "]]}).status_code == 200
    got = client.get("/api/code/pull?client=c1&wait=0", headers=H).json()["commands"]
    assert got[0]["answers"] == [["Postgres"], ["ma réponse libre"]]


def test_question_reply_requires_plugin_v14(monkeypatch, tmp_path):
    # un greffon ≤ v13 ignorerait le kind en silence : la question resterait
    # bloquante côté CLI avec un faux succès côté page → 409 explicite
    client, _code, _H = _q_client(monkeypatch, tmp_path, plugin=13)
    r = client.post("/api/code/sessions/s1/questions/que_1", json={"answers": [["Postgres"]]})
    assert r.status_code == 409 and "v14" in r.json()["detail"]
    # aucune CLI connectée → 409 aussi (comme les permissions)
    (tmp_path / "other").mkdir()
    client2, _c2 = _client(monkeypatch, tmp_path / "other")
    assert client2.post("/api/code/sessions/s1/questions/que_1",
                        json={"answers": [["x"]]}).status_code == 409


def test_question_asked_garbage_is_ignored_or_bounded(monkeypatch, tmp_path):
    client, _code = _client(monkeypatch, tmp_path)
    tok = client.post("/api/code/token").json()["token"]
    H = {"x-elpis-token": tok}
    client.post("/api/code/ingest", headers=H, json={"client": "c1", "plugin": 14, "events": [
        {"type": "session.created", "properties": {"info": {"id": "s1"}}},
        # sans id → ignorée
        {"type": "question.asked", "properties": {"sessionID": "s1", "questions": [{"question": "x"}]}},
        # questions pas une liste → ignorée
        {"type": "question.asked", "properties": {"id": "que_bad", "sessionID": "s1", "questions": "x"}},
        # entrées inexploitables (ni texte ni option) → question entière ignorée
        {"type": "question.asked", "properties": {"id": "que_empty", "sessionID": "s1",
                                                   "questions": [{}, {"question": "", "options": []}]}},
        # bornée : 25 sous-questions → 20 ; 40 options → 30 ; option libellé nu tolérée
        {"type": "question.asked", "properties": {"id": "que_big", "sessionID": "s1",
            "questions": [{"question": f"q{i}", "options": ["a", "b"]} for i in range(25)]
                         + [{"question": "trop", "options": [{"label": f"o{i}"} for i in range(40)]}]}},
    ]})
    qs = client.get("/api/code/sessions/s1/questions").json()
    assert [q["id"] for q in qs] == ["que_big"]
    assert len(qs[0]["questions"]) == 20
    assert qs[0]["questions"][0]["options"] == [{"label": "a", "description": ""},
                                                {"label": "b", "description": ""}]
    assert "tool" not in qs[0]


def test_dismiss_clears_questions(monkeypatch, tmp_path):
    client, _code, _H = _q_client(monkeypatch, tmp_path)
    assert len(client.get("/api/code/sessions/s1/questions").json()) == 1
    client.delete("/api/code/sessions/s1")
    import shared_infra.opencode.store as cstore
    with cstore._db() as c:
        assert c.execute("SELECT COUNT(*) FROM code_questions").fetchone()[0] == 0
