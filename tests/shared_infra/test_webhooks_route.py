# SPDX-License-Identifier: MIT
"""
tests/shared_infra/test_webhooks_route.py — déclenchement des routines par
webhook Git (E2E sur le vrai routeur + vraie DB temp, launch_run stubbé).

Couvre : rotation du secret (jamais réexposé par les GET), signature HMAC
(Gitea nue + GitHub préfixée), réponses indifférenciées (pas d'oracle),
filtres event/branch/repo, dédup des livraisons, cron vide (webhook seul).
"""
from __future__ import annotations

import hashlib
import hmac
import json

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient


@pytest.fixture()
def env(tmp_path, monkeypatch):
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    from shared_infra.db._connection import db_conn
    with db_conn() as conn:
        conn.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT)")
        conn.executemany("INSERT INTO users(id, username) VALUES (?,?)",
                         [(1, "alice"), (2, "bob")])
        conn.commit()
    import shared_infra.scheduling.routines_store as routines
    routines.init_routines_db()

    import shared_infra.scheduling.routes_routines as rt

    def _fake_uid(request: Request):
        uid = request.headers.get("x-test-user")
        if not uid:
            raise HTTPException(401, "auth requise")
        return int(uid)

    monkeypatch.setattr(rt, "require_user_id", _fake_uid)

    # launch_run stubbé : capture (routine_id, trigger, context).
    import shared_infra.scheduling.routines_scheduler as sched
    launches = []

    async def _fake_launch(routine, *, trigger, context=None):
        launches.append({"routine_id": routine["id"], "trigger": trigger,
                         "context": context})
        return 999

    monkeypatch.setattr(sched, "launch_run", _fake_launch)

    # Rate-limit : bucket in-process réinitialisé par test.
    import shared_infra.scheduling.routes_webhooks as wh
    monkeypatch.setattr(wh, "_rl_buckets", {})

    from shared_infra.routes._state import router
    app = FastAPI()
    app.include_router(router)
    return TestClient(app), launches


def _alice():
    return {"x-test-user": "1"}


def _mk_routine(client, **over):
    body = {"name": "CI", "cron_expr": "0 9 * * *", "task_prompt": "analyse",
            "model": None, "system_prompt": "", "thinking_mode": False,
            "enabled": True, "mcp_servers": []}
    body.update(over)
    r = client.post("/api/routines", headers=_alice(), json=body)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _arm(client, rid):
    r = client.post(f"/api/routines/{rid}/webhook/rotate", headers=_alice())
    assert r.status_code == 200
    return r.json()["secret"]


_PUSH = {"ref": "refs/heads/main",
         "repository": {"full_name": "acme/app"},
         "head_commit": {"message": "fix: boom"},
         "pusher": {"login": "carol"}}


def _deliver(client, rid, secret, payload=_PUSH, event="push",
             delivery="d-1", sig_style="gitea", sig_override=None):
    raw = json.dumps(payload).encode("utf-8")
    sig = hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
    if sig_override is not None:
        sig = sig_override
    headers = {"content-type": "application/json"}
    if sig_style == "gitea":
        headers["x-gitea-signature"] = sig
        headers["x-gitea-event"] = event
        if delivery:
            headers["x-gitea-delivery"] = delivery
    else:
        headers["x-hub-signature-256"] = f"sha256={sig}"
        headers["x-github-event"] = event
        if delivery:
            headers["x-github-delivery"] = delivery
    return client.post(f"/api/webhooks/routines/{rid}", content=raw, headers=headers)


def test_happy_path_gitea_and_github(env):
    client, launches = env
    rid = _mk_routine(client)
    secret = _arm(client, rid)

    r = _deliver(client, rid, secret, delivery="d-1")
    assert r.status_code == 202 and r.json()["run_id"] == 999
    assert launches[-1]["trigger"] == "webhook"
    assert "acme/app" in launches[-1]["context"]
    assert "fix: boom" in launches[-1]["context"]

    r2 = _deliver(client, rid, secret, delivery="d-2", sig_style="github")
    assert r2.status_code == 202 and r2.json()["run_id"] == 999
    assert len(launches) == 2


def test_bad_signature_401(env):
    """Secret faux : même 202 qu'une routine absente (pas d'oracle
    d'existence, audit 2026-09-22), et aucun run."""
    client, launches = env
    rid = _mk_routine(client)
    secret = _arm(client, rid)
    r = _deliver(client, rid, secret, sig_override="0" * 64)
    assert r.status_code == 202 and r.json() == {"ok": True}
    assert launches == []


def test_generic_emitter_token_and_signature(env):
    """Émetteur NON-Git (supervision, script curl…) : token simple en header
    ou en query, signature générique X-Webhook-Signature, événement via
    X-Webhook-Event ou champ ``event`` du JSON, payload joint au contexte."""
    client, launches = env
    rid = _mk_routine(client)
    secret = _arm(client, rid)
    payload = {"event": "alerte-disque", "host": "srv-42", "usage_pct": 93}
    raw = json.dumps(payload).encode()

    # 1) token en header — pas de signature, pas de header d'événement :
    #    l'event vient du champ JSON, le payload part dans le contexte.
    r1 = client.post(f"/api/webhooks/routines/{rid}", content=raw,
                     headers={"content-type": "application/json",
                              "x-webhook-token": secret,
                              "x-webhook-delivery": "g-1"})
    assert r1.status_code == 202 and r1.json()["run_id"] == 999
    assert launches[-1]["trigger"] == "webhook"
    assert "alerte-disque" in launches[-1]["context"]
    assert "srv-42" in launches[-1]["context"]      # payload générique joint

    # 2) token en query (?token=) — émetteur qui ne sait poser aucun header.
    r2 = client.post(f"/api/webhooks/routines/{rid}?token={secret}",
                     content=raw, headers={"content-type": "application/json",
                                           "x-webhook-delivery": "g-2"})
    assert r2.status_code == 202 and r2.json()["run_id"] == 999

    # 3) signature générique X-Webhook-Signature (les 2 formes acceptées).
    sig = hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
    r3 = client.post(f"/api/webhooks/routines/{rid}", content=raw,
                     headers={"content-type": "application/json",
                              "x-webhook-signature": f"sha256={sig}",
                              "x-webhook-event": "alerte-disque",
                              "x-webhook-delivery": "g-3"})
    assert r3.status_code == 202 and r3.json()["run_id"] == 999

    # 4) mauvais token → 202 indifférencié, sans run ; et une signature FAUSSE ne se rattrape pas par
    #    un bon token joint (pas de repli silencieux).
    r4 = client.post(f"/api/webhooks/routines/{rid}", content=raw,
                     headers={"content-type": "application/json",
                              "x-webhook-token": "nope"})
    assert r4.status_code == 202 and "run_id" not in r4.json()
    r5 = client.post(f"/api/webhooks/routines/{rid}", content=raw,
                     headers={"content-type": "application/json",
                              "x-webhook-signature": "0" * 64,
                              "x-webhook-token": secret})
    assert r5.status_code == 202 and "run_id" not in r5.json()
    assert len(launches) == 3


def test_generic_event_filter(env):
    """Filtre d'événements en noms LIBRES (pas de liste Git figée)."""
    client, launches = env
    rid = _mk_routine(client)
    secret = _arm(client, rid)
    r = client.post(f"/api/routines/{rid}/webhook/filter", headers=_alice(),
                    json={"events": ["alerte-disque", "deploiement.fini"]})
    assert r.status_code == 200

    def _post(event_field):
        raw = json.dumps({"event": event_field}).encode()
        return client.post(f"/api/webhooks/routines/{rid}", content=raw,
                           headers={"content-type": "application/json",
                                    "x-webhook-token": secret})

    assert _post("autre-chose").json().get("filtered") is True
    assert _post("alerte-disque").json().get("run_id") == 999
    assert len(launches) == 1
    # forme invalide toujours refusée côté filtre
    assert client.post(f"/api/routines/{rid}/webhook/filter", headers=_alice(),
                       json={"events": ["PAS VALIDE !"]}).status_code == 400


def test_no_oracle_for_missing_disabled_unarmed(env):
    """Routine inexistante / webhook jamais activé / désactivé → MÊME réponse
    202 {ok: true}, sans run_id (pas d'énumération d'ids)."""
    client, launches = env
    r = _deliver(client, 424242, "whatever")
    assert r.status_code == 202 and "run_id" not in r.json()

    rid = _mk_routine(client)          # existe mais webhook jamais activé
    r2 = _deliver(client, rid, "whatever")
    assert r2.status_code == 202 and r2.json() == r.json()

    secret = _arm(client, rid)         # activé puis coupé
    assert client.post(f"/api/routines/{rid}/webhook/disable",
                       headers=_alice()).status_code == 200
    r3 = _deliver(client, rid, secret)
    assert r3.status_code == 202 and "run_id" not in r3.json()
    assert launches == []


def test_delivery_dedup(env):
    client, launches = env
    rid = _mk_routine(client)
    secret = _arm(client, rid)
    assert _deliver(client, rid, secret, delivery="same").json().get("run_id") == 999
    r = _deliver(client, rid, secret, delivery="same")
    assert r.status_code == 202 and r.json().get("duplicate") is True
    assert len(launches) == 1


def test_filters_event_branch_repo(env):
    client, launches = env
    rid = _mk_routine(client)
    secret = _arm(client, rid)
    r = client.post(f"/api/routines/{rid}/webhook/filter", headers=_alice(),
                    json={"events": ["pull_request"], "branch": "main",
                          "repo": "acme/app"})
    assert r.status_code == 200

    # push ≠ pull_request → filtré
    r1 = _deliver(client, rid, secret, delivery="f-1")
    assert r1.json().get("filtered") is True
    # PR sur la bonne base/repo → lancé
    pr = {"repository": {"full_name": "acme/app"}, "action": "opened",
          "pull_request": {"number": 7, "title": "Feat",
                           "base": {"ref": "main"}, "head": {"ref": "feat/x"}}}
    r2 = _deliver(client, rid, secret, payload=pr, event="pull_request",
                  delivery="f-2")
    assert r2.json().get("run_id") == 999
    assert "pull request #7" in launches[-1]["context"]
    # PR vers une autre base → filtré
    pr_dev = {**pr, "pull_request": {**pr["pull_request"], "base": {"ref": "dev"}}}
    r3 = _deliver(client, rid, secret, payload=pr_dev, event="pull_request",
                  delivery="f-3")
    assert r3.json().get("filtered") is True
    # autre dépôt → filtré
    pr_other = {**pr, "repository": {"full_name": "acme/other"}}
    r4 = _deliver(client, rid, secret, payload=pr_other, event="pull_request",
                  delivery="f-4")
    assert r4.json().get("filtered") is True
    assert len(launches) == 1


def test_filter_validation_400(env):
    """Noms d'événements LIBRES (émetteur pas forcément Git) — seule la FORME
    est bornée : minuscules/chiffres/._:-, 64 car. max, 16 events max."""
    client, _ = env
    rid = _mk_routine(client)
    ok = client.post(f"/api/routines/{rid}/webhook/filter", headers=_alice(),
                     json={"events": ["deploy_nuclear", "alerte.cpu:high", "MAJUSCULES"]})
    assert ok.status_code == 200            # noms libres acceptés (normalisés lower)
    assert "majuscules" in ok.json()["webhook_filter"]["events"]
    for bad in (["espace interdit"], ["é-accentué"], ["x" * 65]):
        r = client.post(f"/api/routines/{rid}/webhook/filter", headers=_alice(),
                        json={"events": bad})
        assert r.status_code == 400, bad
    too_many = [f"e{i}" for i in range(17)]
    assert client.post(f"/api/routines/{rid}/webhook/filter", headers=_alice(),
                       json={"events": too_many}).status_code == 400


def test_secret_never_exposed_by_gets(env):
    client, _ = env
    rid = _mk_routine(client)
    _arm(client, rid)
    detail = client.get(f"/api/routines/{rid}", headers=_alice()).json()
    assert detail["webhook_enabled"] is True
    assert detail["webhook_has_secret"] is True
    assert "webhook_secret" not in detail
    lst = client.get("/api/routines", headers=_alice()).json()["items"]
    assert all("webhook_secret" not in it for it in lst)


def test_webhook_routes_owner_gated(env):
    client, _ = env
    rid = _mk_routine(client)
    bob = {"x-test-user": "2"}
    assert client.post(f"/api/routines/{rid}/webhook/rotate",
                       headers=bob).status_code == 404
    assert client.post(f"/api/routines/{rid}/webhook/disable",
                       headers=bob).status_code == 404
    assert client.post(f"/api/routines/{rid}/webhook/filter", headers=bob,
                       json={"events": []}).status_code == 404


def test_empty_cron_webhook_only(env):
    """cron_expr vide = « webhook/manuel seulement » : accepté à la création
    et au PUT ; _cron_matches('') est False (le scheduler ne tire jamais)."""
    client, _ = env
    rid = _mk_routine(client, cron_expr="")
    detail = client.get(f"/api/routines/{rid}", headers=_alice()).json()
    assert detail["cron_expr"] == ""
    import datetime

    from shared_infra.observability.events_bus import _cron_matches
    assert _cron_matches("", datetime.datetime.now()) is False
    # PUT peut aussi vider la planification…
    rid2 = _mk_routine(client, name="Autre")
    assert client.put(f"/api/routines/{rid2}", headers=_alice(),
                      json={"cron_expr": ""}).status_code == 200
    # …et un cron non vide reste validé strictement.
    assert client.put(f"/api/routines/{rid2}", headers=_alice(),
                      json={"cron_expr": "* *"}).status_code == 400


# ── Régressions audit 2026-08-04 ─────────────────────────────────────────────

def test_non_ascii_token_or_signature_401_not_500(env):
    """``compare_digest(str, str)`` lève TypeError sur du non-ASCII — or sig et
    token sont contrôlés par l'appelant : ``?token=é`` produisait un 500 (que
    l'émetteur retentait en boucle) au lieu du 401."""
    client, launches = env
    rid = _mk_routine(client)
    _arm(client, rid)
    r = client.post(f"/api/webhooks/routines/{rid}", params={"token": "é"},
                    json={"event": "x"})
    assert r.status_code == 202
    # httpx exige des bytes pour un header non-ASCII ; Starlette le décode en
    # latin-1 côté serveur → la route reçoit bien la str 'é'.
    r = client.post(f"/api/webhooks/routines/{rid}", json={"event": "x"},
                    headers={b"x-webhook-signature": "é".encode("latin-1")})
    assert r.status_code == 202
    assert launches == []


def test_malformed_payload_types_202_not_500(env):
    """Payload SIGNÉ mais mal typé (repository=str, ref=int, pull_request=str…) :
    coercition défensive partout — un 500 avant l'enregistrement de dédup
    faisait boucler les retries de l'émetteur, chaque retry re-crashant."""
    client, launches = env
    rid = _mk_routine(client)
    secret = _arm(client, rid)
    # Filtre repo actif + repository non-dict → chemin du crash historique
    # (AVANT la dédup) : désormais 202 « filtré », pas d'exception.
    assert client.post(f"/api/routines/{rid}/webhook/filter", headers=_alice(),
                       json={"events": [], "branch": "", "repo": "acme/app"}).status_code == 200
    r = _deliver(client, rid, secret, payload={"repository": "acme/app"}, delivery="m-1")
    assert r.status_code == 202
    assert launches == []
    # Filtre levé : types farfelus partout → résumé défensif, run lancé.
    assert client.post(f"/api/routines/{rid}/webhook/filter", headers=_alice(),
                       json={"events": [], "branch": "", "repo": ""}).status_code == 200
    r = _deliver(client, rid, secret,
                 payload={"ref": 42, "repository": 7, "pull_request": "x",
                          "head_commit": 3, "pusher": 1, "sender": []},
                 delivery="m-2")
    assert r.status_code == 202 and r.json().get("run_id") == 999
    assert len(launches) == 1
    # Filtre branche + pull_request non-dict (chemin _branch_of) : pas de 500.
    assert client.post(f"/api/routines/{rid}/webhook/filter", headers=_alice(),
                       json={"events": [], "branch": "main", "repo": ""}).status_code == 200
    r = _deliver(client, rid, secret, payload={"pull_request": "x"}, delivery="m-3")
    assert r.status_code == 202
    assert len(launches) == 1      # filtré (pas de branche extractible)


def test_body_cap_413_before_buffering(env):
    """Cap de taille appliqué AVANT bufferisation (Content-Length) : la route
    publique chargeait le corps entier en mémoire avant de tester 1 Mo."""
    client, _ = env
    rid = _mk_routine(client)
    _arm(client, rid)
    import shared_infra.scheduling.routes_webhooks as wh
    r = client.post(f"/api/webhooks/routines/{rid}",
                    content=b"x" * (wh._MAX_BODY + 1),
                    headers={"content-type": "application/json"})
    assert r.status_code == 413


# ── Panne transitoire au lancement : la dédup ne doit PAS avaler le retry ─────
# Audit 2026-08-08. ``record_webhook_delivery`` marque la livraison AVANT
# ``launch_run`` (il le faut : c'est ce qui sérialise deux retries simultanés
# arrivant sur deux workers). Mais si le lancement échouait ensuite — panne
# transitoire, typiquement ``admit_and_insert_run`` dont le ``BEGIN IMMEDIATE``
# est refusé après le busy_timeout — l'émetteur recevait un 500, retentait avec
# le MÊME delivery_id, tombait sur la dédup, recevait 202 « duplicate » : le run
# était PERDU définitivement, sans trace au journal. La route compense
# désormais (``forget_webhook_delivery``) et répond 503.

def test_launch_failure_frees_the_delivery_so_the_retry_runs(env, monkeypatch):
    client, launches = env
    rid = _mk_routine(client)
    secret = _arm(client, rid)

    import shared_infra.scheduling.routines_scheduler as sched
    calls = {"n": 0}

    async def _flaky(routine, *, trigger, context=None):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("database is locked")   # panne transitoire
        launches.append({"routine_id": routine["id"], "trigger": trigger})
        return 4242

    monkeypatch.setattr(sched, "launch_run", _flaky)

    # 1re livraison : le lancement échoue → 503 explicite (et non un 500 nu),
    # pour que Gitea/GitHub retentent.
    r1 = _deliver(client, rid, secret, delivery="delivery-A")
    assert r1.status_code == 503, r1.text
    assert r1.json()["ok"] is False
    assert not launches, "aucun run n'aurait dû démarrer"

    # Retry du MÊME id : la marque a été retirée → la livraison repasse.
    r2 = _deliver(client, rid, secret, delivery="delivery-A")
    assert r2.status_code == 202, r2.text
    assert r2.json().get("duplicate") is not True, \
        "le retry a été avalé par la dédup — le run est perdu"
    assert r2.json().get("run_id") == 4242
    assert len(launches) == 1
    assert calls["n"] == 2


def test_dedup_still_holds_when_the_launch_succeeded(env):
    """Garde-fou du correctif : la compensation ne doit PAS désarmer la dédup
    du cas NOMINAL — deux livraisons identiques après un lancement réussi
    restent une seule exécution."""
    client, launches = env
    rid = _mk_routine(client)
    secret = _arm(client, rid)

    assert _deliver(client, rid, secret, delivery="delivery-B").json()["run_id"] == 999
    r = _deliver(client, rid, secret, delivery="delivery-B")
    assert r.status_code == 202 and r.json().get("duplicate") is True
    assert len(launches) == 1, "la dédup nominale a été cassée par le correctif"


def test_forget_webhook_delivery_is_scoped_and_best_effort(env):
    """``forget_webhook_delivery`` ne retire QUE la ligne (delivery, routine)
    visée — une autre routine ayant reçu le même id de livraison garde la
    sienne — et ne lève jamais (elle tourne sur un chemin d'erreur).

    ``env`` est requis : il redirige ``DB_PATH`` vers la base temporaire du
    test (sans lui, ces écritures partiraient dans la base réelle)."""
    from shared_infra.scheduling.routines_store import (
        forget_webhook_delivery,
        record_webhook_delivery,
    )
    assert record_webhook_delivery("shared-id", 1) is True
    assert record_webhook_delivery("shared-id", 2) is True

    assert forget_webhook_delivery("shared-id", 1) is True
    assert record_webhook_delivery("shared-id", 1) is True   # redevenue neuve
    assert record_webhook_delivery("shared-id", 2) is False  # routine 2 intacte

    # Livraison inconnue : False, pas d'exception.
    assert forget_webhook_delivery("jamais-vue", 99) is False
