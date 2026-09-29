# SPDX-License-Identifier: MIT
"""
shared_infra.scheduling.routes_webhooks — endpoints PUBLICS (sans session) de déclenchement.

POST /api/webhooks/routines/{routine_id}
    Déclenche un run de routine depuis N'IMPORTE QUEL système : forge Git
    (Gitea/GitHub), CI, supervision, n8n, simple ``curl``… PAS de
    ``require_user_id`` : l'authentification est le secret per-routine
    (``POST /api/routines/{id}/webhook/rotate``), présenté au choix :

    - **Signature HMAC-SHA256 du CORPS BRUT** (le secret ne transite jamais) :
      ``X-Gitea-Signature`` (hexdigest nu), ``X-Hub-Signature-256``
      (``sha256=…``) ou le générique ``X-Webhook-Signature`` (les deux formes) ;
    - **Token simple** (émetteurs qui ne savent pas signer) : header
      ``X-Webhook-Token: <secret>`` ou query ``?token=<secret>`` — comparaison
      en temps constant. Le token transite : réservé au TLS/LAN (documenté).

    L'événement vient de ``X-Gitea-Event`` / ``X-GitHub-Event`` /
    ``X-Webhook-Event``, sinon du champ JSON ``event`` du payload.

Principes de sécurité :
    - réponses INDIFFÉRENCIÉES (202) pour routine inexistante / désactivée /
      webhook off — pas d'oracle d'énumération d'ids ;
    - 401 UNIQUEMENT sur secret invalide d'une routine armée (la livraison
      apparaît en échec côté émetteur → l'utilisateur peut déboguer son hook) ;
    - HMAC calculé sur les octets reçus, AVANT tout parse JSON ;
    - dédup des livraisons EN DB (``record_webhook_delivery``) : Gitea/GitHub
      retentent sur timeout/5xx, et le retry peut toucher un AUTRE worker. La
      marque est posée AVANT le lancement (c'est elle qui sérialise deux retries
      simultanés) mais RETIRÉE si le lancement échoue
      (``forget_webhook_delivery``, réponse 503) — sinon le retry tombait sur la
      dédup et le run était perdu sans trace ;
    - rate-limit léger par IP, in-process (best-effort PAR worker — assumé,
      cf. docs/routines-webhooks-design-2026-08-03.md) ;
    - le run part in-process sur CE worker (même contrat que run-now :
      admission cap atomique en DB + garde anti-chevauchement F10).
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import time
from typing import Any, Dict, Optional

from fastapi import Request
from fastapi.responses import JSONResponse

from shared_infra.routes._state import router

logger = logging.getLogger(__name__)

_MAX_BODY = 1024 * 1024          # 1 Mo — un payload Gitea réel fait < 100 Ko
_CTX_CAP = 2000                  # résumé d'événement joint au prompt (chars)

# Rate-limit in-process : fenêtre glissante grossière par IP. Par worker,
# donc la borne réelle est ×N workers — suffisant pour absorber une boucle
# de retries ou un scan, sans dépendance DB sur le chemin chaud.
_RL_WINDOW_S = 60.0
_RL_MAX_PER_WINDOW = 120
_rl_buckets: Dict[str, list] = {}


def _rate_limited(ip: str) -> bool:
    now = time.time()
    bucket = _rl_buckets.setdefault(ip, [])
    cutoff = now - _RL_WINDOW_S
    while bucket and bucket[0] < cutoff:
        bucket.pop(0)
    if len(bucket) >= _RL_MAX_PER_WINDOW:
        return True
    bucket.append(now)
    if len(_rl_buckets) > 1024:      # borne mémoire : purge les IPs inactives
        for k in [k for k, v in _rl_buckets.items() if not v or v[-1] < cutoff]:
            _rl_buckets.pop(k, None)
    return False


def _ok(**extra) -> JSONResponse:
    """202 indifférencié — même forme pour « lancé », « ignoré » et
    « inexistant » (les champs additionnels ne sortent que sur les chemins
    authentifiés par la signature)."""
    return JSONResponse({"ok": True, **extra}, status_code=202)


def _as_dict(v: Any) -> Dict[str, Any]:
    """Coercition défensive : le payload est du JSON ARBITRAIRE (tout détenteur
    du secret peut poster {"repository": "x"} ou {"ref": 42}). ``or {}`` ne
    protège que contre les falsy — une valeur truthy non-dict passait et
    crashait en AttributeError → 500 → boucle de retries de l'émetteur."""
    return v if isinstance(v, dict) else {}


def _as_str(v: Any) -> str:
    return v if isinstance(v, str) else ""


def _looks_like_git(payload: Dict[str, Any]) -> bool:
    return any(k in payload for k in ("repository", "pull_request",
                                      "head_commit", "pusher", "ref"))


def _event_summary(event: str, payload: Dict[str, Any]) -> str:
    """Résumé COMPACT de l'événement pour le prompt du run (borné ``_CTX_CAP``).

    Payload Git (Gitea/GitHub) → champs choisis lisibles. Payload GÉNÉRIQUE
    (supervision, CI, script…) → le JSON lui-même, tronqué : c'est la donnée
    utile, une routine « alerte disque » a besoin des champs de l'alerte."""
    lines = [f"- type : {event or 'inconnu'}"]
    if not _looks_like_git(payload):
        if payload:
            # AUDIT 2026-09-01 (passe 5, B11) — avant : ``indent=2`` sur le
            # dict ENTIER (corps ≤ 1 Mo → chaîne de 2-4 Mo) pour n'en garder
            # que ~1 800 c. On sérialise COMPACT d'abord ; seul un payload qui
            # tient déjà dans le cap mérite le pretty-print de lisibilité.
            try:
                body = json.dumps(payload, ensure_ascii=False)
                if len(body) <= _CTX_CAP - 200:
                    body = json.dumps(payload, ensure_ascii=False, indent=2)
            except (TypeError, ValueError):
                body = str(payload)
            if len(body) > _CTX_CAP - 200:
                body = body[:_CTX_CAP - 200] + "\n… (payload tronqué)"
            lines.append("- payload :\n```json\n" + body + "\n```")
        return "\n".join(lines)[:_CTX_CAP]
    repo = _as_str(_as_dict(payload.get("repository")).get("full_name"))
    if repo:
        lines.append(f"- dépôt : {repo}")
    ref = _as_str(payload.get("ref"))
    if ref:
        lines.append(f"- ref : {ref}")
    pr = _as_dict(payload.get("pull_request"))
    if pr:
        base = _as_str(_as_dict(pr.get("base")).get("ref"))
        head = _as_str(_as_dict(pr.get("head")).get("ref"))
        lines.append(f"- pull request #{pr.get('number', '?')} : "
                     f"{_as_str(pr.get('title')).strip()[:200]}")
        if base or head:
            lines.append(f"- branches : {head} → {base}")
        if payload.get("action"):
            lines.append(f"- action : {payload['action']}")
    head_commit = _as_dict(payload.get("head_commit"))
    if head_commit.get("message"):
        lines.append("- dernier commit : "
                     + str(head_commit["message"]).strip().splitlines()[0][:200])
    pusher = _as_str(_as_dict(payload.get("pusher")).get("login")) or \
        _as_str(_as_dict(payload.get("sender")).get("login"))
    if pusher:
        lines.append(f"- auteur : {pusher}")
    return "\n".join(lines)[:_CTX_CAP]


def _branch_of(event: str, payload: Dict[str, Any]) -> Optional[str]:
    """Branche concernée par l'événement (pour le filtre) : push → ``ref``
    (refs/heads/x), PR → branche CIBLE (base)."""
    pr = _as_dict(payload.get("pull_request"))
    if pr:
        return _as_str(_as_dict(pr.get("base")).get("ref")) or None
    ref = _as_str(payload.get("ref"))
    if ref.startswith("refs/heads/"):
        return ref[len("refs/heads/"):]
    return ref or None


@router.post("/api/webhooks/routines/{routine_id}")
async def api_webhook_routine(routine_id: int, request: Request):
    client_ip = (request.client.host if request.client else "?")
    if _rate_limited(client_ip):
        return JSONResponse({"ok": False, "error": "rate limited"},
                            status_code=429)
    # Cap AVANT bufferisation : route publique sans auth préalable —
    # ``request.body()`` chargeait des Go en mémoire avant de tester la
    # taille. Rejet sur Content-Length quand il est présent, et lecture en
    # flux bornée sinon (chunked) : la mémoire ne dépasse jamais ~_MAX_BODY.
    try:
        _clen = int(request.headers.get("content-length") or 0)
    except ValueError:
        _clen = 0
    if _clen > _MAX_BODY:
        return JSONResponse({"ok": False, "error": "payload trop volumineux"},
                            status_code=413)
    chunks: list = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > _MAX_BODY:
            return JSONResponse({"ok": False, "error": "payload trop volumineux"},
                                status_code=413)
        chunks.append(chunk)
    raw = b"".join(chunks)

    import asyncio as _asyncio

    from shared_infra.scheduling.routines_store import (
        get_routine_internal,
        get_routine_webhook_secret,
        record_webhook_delivery,
    )
    # AUDIT 2026-08-30 (S3b) — ``routine_id`` est typé ``int``, donc SANS borne
    # haute côté Python. Au-delà de 2**63 le driver SQLite lève
    # ``OverflowError: Python int too large to convert to SQLite INTEGER`` :
    # 500 sur une route PUBLIQUE (mesuré : 18 chiffres → 202, 19 → 500).
    #
    # Ce 500 cassait la garantie que ce module s'impose en tête de fichier —
    # « réponses INDIFFÉRENCIÉES (202) […] pas d'oracle d'énumération d'ids ».
    # D'où ``_ok()`` et non 400 : un id hors bornes est un id qui n'existe pas,
    # et il doit se répondre exactement comme tel. Un 422 posé par une
    # contrainte de validation FastAPI aurait rouvert le même oracle.
    if not (-2**63) <= routine_id < 2**63:
        return _ok()                            # indifférencié — pas d'oracle
    # Handler async (il lit le flux) → les appels DB synchrones partent dans
    # le threadpool pour ne pas bloquer la boucle du worker à chaque livraison.
    r = await _asyncio.to_thread(get_routine_internal, int(routine_id))
    secret = (await _asyncio.to_thread(get_routine_webhook_secret,
                                       int(routine_id))) if r else None
    if (not r or not r.get("enabled") or not r.get("webhook_enabled")
            or not secret):
        return _ok()                            # indifférencié — pas d'oracle

    # Deux présentations du secret : signature HMAC (préférée — le secret ne
    # transite pas) OU token simple (émetteurs incapables de signer : curl,
    # supervision…). Si une signature est PRÉSENTE elle fait foi — un token
    # joint en plus n'est pas consulté (pas de repli silencieux d'une
    # signature fausse vers un token).
    sig = (request.headers.get("x-gitea-signature")
           or request.headers.get("x-hub-signature-256")
           or request.headers.get("x-webhook-signature") or "")
    sig = sig.strip()
    if sig.lower().startswith("sha256="):
        sig = sig[len("sha256="):]
    token = (request.headers.get("x-webhook-token")
             or request.query_params.get("token") or "").strip()
    # Comparaisons sur BYTES : ``compare_digest(str, str)`` lève TypeError si
    # l'un des deux contient du non-ASCII — or sig/token viennent des headers
    # ou de la query (contrôlés par l'appelant) → ``?token=é`` produisait un
    # 500 au lieu du 401.
    if sig:
        expected = hmac.new(secret.encode("utf-8"), raw, hashlib.sha256).hexdigest()
        authed = hmac.compare_digest(expected.encode("ascii"),
                                     sig.lower().encode("utf-8", "replace"))
    elif token:
        authed = hmac.compare_digest(secret.encode("utf-8"),
                                     token.encode("utf-8", "replace"))
    else:
        authed = False
    if not authed:
        logger.warning("[webhooks] secret invalide routine=%s ip=%s (%s)",
                       routine_id, client_ip,
                       "signature" if sig else ("token" if token else "absent"))
        # Même 202 qu'une routine absente (audit 2026-09-22) : un 401 ici
        # révélait qu'une routine à webhook existait sous cet id. L'émetteur
        # légitime diagnostique par le journal (warning ci-dessus).
        return _ok()

    event = (request.headers.get("x-gitea-event")
             or request.headers.get("x-github-event")
             or request.headers.get("x-webhook-event") or "").strip().lower()
    try:
        payload = json.loads(raw.decode("utf-8", errors="replace")) or {}
        if not isinstance(payload, dict):
            payload = {}
    except ValueError:
        payload = {}
    # Émetteur générique sans header d'événement : champ ``event`` du JSON.
    if not event and isinstance(payload.get("event"), str):
        event = payload["event"].strip().lower()

    flt = r.get("webhook_filter") or {}
    events = [str(e).strip().lower() for e in (flt.get("events") or []) if str(e).strip()]
    if events and event not in events:
        return _ok(filtered=True, reason=f"event {event!r} hors filtre")
    want_branch = (flt.get("branch") or "").strip()
    if want_branch:
        got = _branch_of(event, payload)
        if got != want_branch:
            return _ok(filtered=True, reason="branche hors filtre")
    want_repo = (flt.get("repo") or "").strip().lower()
    if want_repo:
        got_repo = str(_as_dict(payload.get("repository")).get("full_name") or "").lower()
        if got_repo != want_repo:
            return _ok(filtered=True, reason="dépôt hors filtre")

    delivery = (request.headers.get("x-gitea-delivery")
                or request.headers.get("x-github-delivery")
                or request.headers.get("x-webhook-delivery") or "").strip()
    if delivery and not await _asyncio.to_thread(
            record_webhook_delivery, delivery, int(routine_id)):
        return _ok(duplicate=True)

    import asyncio as _aio

    from shared_infra.scheduling.routines_scheduler import launch_run
    # (passe 5, B11) — la sérialisation d'un corps jusqu'à 1 Mo part en thread.
    context = await _aio.to_thread(_event_summary, event, payload)
    try:
        run_id = await launch_run(r, trigger="webhook", context=context)
    except Exception as exc:                        # noqa: BLE001
        # La marque de dédup est DÉJÀ posée (elle doit l'être : c'est elle qui
        # sérialise deux retries simultanés sur deux workers). Une panne ici est
        # transitoire par nature — ``admit_and_insert_run`` prend un
        # ``BEGIN IMMEDIATE`` et lève quand le verrou d'écriture SQLite reste
        # pris au-delà du busy_timeout. Sans compensation, l'émetteur retentait
        # avec le même delivery_id, tombait sur la dédup, recevait 202
        # « duplicate » — et le run était perdu SILENCIEUSEMENT. On retire la
        # marque puis on renvoie un 503 explicite : Gitea/GitHub retentent, et
        # cette fois la livraison repasse pour de bon.
        if delivery:
            from shared_infra.scheduling.routines_store import forget_webhook_delivery
            await _asyncio.to_thread(forget_webhook_delivery, delivery,
                                     int(routine_id))
        logger.warning("[webhooks] routine=%s : lancement échoué (%r) — dédup "
                       "retirée, l'émetteur peut retenter", routine_id, exc)
        return JSONResponse(
            {"ok": False, "error": "lancement temporairement impossible, retentez"},
            status_code=503)
    if run_id is None:
        # cap atteint ou run déjà actif (anti-chevauchement) : la livraison est
        # ACQUITTÉE (202) — un 5xx ferait retenter Gitea en boucle.
        return _ok(skipped=True)
    logger.info("[webhooks] routine=%s run=%s event=%s ip=%s",
                routine_id, run_id, event or "?", client_ip)
    return _ok(run_id=run_id)
