# SPDX-License-Identifier: MIT
"""
backend.routes.events — Server-Sent-Events endpoints.

One SSE bus fans out to the browser:

- ``/api/system-events``         — global admin/log stream from
                                    ``system_events`` (in-process). Also
                                    serves as the lazy bootstrap for the
                                    cron scheduler and the model poller —
                                    those start the FIRST time any user
                                    opens an SSE session, so a fresh
                                    install with no clients connected
                                    incurs zero background work.

The bus instances (``system_events``, ``pipeline_events``), the cron
scheduler, and the model poller all live in ``_legacy`` for now —
extracting them is a separate refactor that should also pull out
``SystemEvents`` / ``PipelineEvents`` / ``PipelineEventsScope`` and
``_spawn_orchestration`` into a ``core/events.py`` + ``core/scheduler.py``.

SSE transport (v7.4+)
=====================

Préfère ``sse-starlette.EventSourceResponse`` sur ``StreamingResponse``
pour deux raisons :

  1. **Keepalive automatique** — sse-starlette envoie un ping comment-line
     (``:ping\\n\\n``) toutes les N secondes pour éviter que les proxies
     intermédiaires (nginx, Cloudflare, navigateur en arrière-plan)
     ferment la connexion par timeout d'inactivité. Sans ça, un agent qui
     thinking 60s+ peut faire timeout côté client sans que rien n'arrive.

  2. **Cleanup propre sur disconnect** — sse-starlette détecte le close
     côté client et annule proprement le generator. Avec StreamingResponse
     nu, le generator continue à produire jusqu'à ce qu'on essaie d'écrire
     sur une socket fermée → exception avalée → fuite des abonnés.

Compat : si sse-starlette n'est pas installé, fallback transparent sur
StreamingResponse. Le générateur ``listen()`` existant yield déjà des
strings SSE raw (``data: ...\\n\\n``), compatible avec les deux modes.
"""
from __future__ import annotations

from fastapi import Request
from fastapi.responses import StreamingResponse

from shared_infra.accounts.users import get_user_by_id
from shared_infra.observability.events_bus import _ensure_model_poller, start_cron_scheduler, system_events
from shared_infra.routes._state import router
from shared_infra.security.deps import require_user_id, stream_session_still_valid

# ── Sélection du response class SSE ──────────────────────────────────────
# sse-starlette > StreamingResponse pour les raisons documentées en haut
# du module. Lazy import + fallback pour garder le code fonctionnel sans
# la dépendance.
_SSE_STARLETTE_AVAILABLE = False
try:
    from sse_starlette.sse import EventSourceResponse  # type: ignore
    _SSE_STARLETTE_AVAILABLE = True
except ImportError:
    EventSourceResponse = None  # type: ignore


async def _sse_string_to_event_adapter(generator):
    """Adapte les strings SSE pré-formatées en dicts pour ``EventSourceResponse``.

    POURQUOI cet adapter (v7.4.1+) :
    ``_events_bus.py::listen()`` yield des strings au format SSE complet :
        - ``"data: {json}\\n\\n"`` pour les events
        - ``": ping\\n\\n"``        pour les heartbeats manuels

    ``EventSourceResponse`` re-wrappe TOUTE string passée comme étant le
    champ ``data`` d'un nouvel event. Donc si on yield ``"data: foo\\n\\n"``,
    on reçoit côté client ``"data: data: foo\\n\\n\\n\\n"`` (DOUBLE wrap).

    Conséquence du double-wrap : le frontend ``EventSource.onmessage``
    reçoit la string ``"data: foo"`` au lieu de ``"foo"``. ``JSON.parse``
    échoue silencieusement → tous les events sont droppés → animations
    cassées, viewer agentic figé, pas de progress.

    Cet adapter parse les strings SSE et yield des dicts ``{"data": payload}``
    que ``EventSourceResponse`` peut wrapper proprement une seule fois.
    Les commentaires (``": ping\\n\\n"``) sont skippés : sse-starlette
    génère son propre keepalive selon le param ``ping=N``.
    """
    async for chunk in generator:
        if not chunk:
            continue
        # Strip trailing \n\n qui est le délimiteur SSE — sse-starlette
        # le remettra. Ne pas strip plus large, car le payload JSON peut
        # contenir des espaces/newlines significatifs.
        s = chunk
        while s.endswith("\n"):
            s = s[:-1]
        if not s:
            continue
        # Commentaire SSE (": ping" ou autre) → skip
        if s.startswith(": "):
            continue
        # Événement de données : strip "data: " prefix
        if s.startswith("data: "):
            payload = s[6:]
            yield {"data": payload}
        else:
            # Format inconnu (event:, id:, retry:…) — passthrough en data.
            # En pratique nos generators ne produisent que data: et :, donc
            # ce branch est défensif.
            yield {"data": s}


def _make_sse_response(generator):
    """Wrappe un générateur SSE-yielding-strings dans la meilleure response
    disponible.

    - sse-starlette installé → ``EventSourceResponse`` + adapter qui
      convertit nos strings format-SSE en dicts pour éviter le double-wrap.
    - sinon → ``StreamingResponse`` classique avec les strings telles
      quelles (comportement pré-v7.4).
    """
    if _SSE_STARLETTE_AVAILABLE and EventSourceResponse is not None:
        return EventSourceResponse(
            _sse_string_to_event_adapter(generator),
            # 15s : suffisant pour éviter timeout nginx (default 60s) /
            # Cloudflare (100s) et la majorité des navigateurs. Trop bas
            # = bruit dans les logs ; trop haut = risque de timeout.
            ping=15,
        )
    return StreamingResponse(
        generator,
        media_type="text/event-stream",
    )


# ─────────────────────────────────────────────────────────────────────────────
#  LAZY BOOTSTRAP FLAG
# ─────────────────────────────────────────────────────────────────────────────
# Whether this worker has already started its cron scheduler. Lives in this
# module (rather than ``_legacy``) so it's local to the route that needs
# it. Idempotent: the cron loop and model poller themselves no-op when
# called twice.
_cron_started = False


# ─────────────────────────────────────────────────────────────────────────────
#  ENDPOINTS
# ─────────────────────────────────────────────────────────────────────────────
@router.get("/api/system-events")
async def api_system_events(request: Request):
    """Open the global SSE channel and start scheduler/poller on first call.

    Accessible à tout utilisateur authentifié (le front en dépend pour
    model_status / restart / notification), MAIS les events ``type="log"``
    — relais de TOUS les logs du worker (access-logs uid/IP, traces) — ne
    sont poussés qu'aux sessions staff (cf. SystemEvents.broadcast).
    """
    global _cron_started
    # require_user_id : porte de validité unique (max-age, revoke-all,
    # revoke-user, idle-timeout, must_change_pwd) — un simple
    # request.session.get shunterait la révocation (flux staff type=log inclus).
    uid = require_user_id(request)
    me = get_user_by_id(int(uid))
    is_staff = bool(me and me["is_admin"] in (1, 2))
    if not _cron_started:
        _cron_started = True
        start_cron_scheduler()
    _ensure_model_poller()
    # AUDIT 2026-08-02 (S1) — revalidation périodique du flux : l'auth du
    # handshake ne suffit pas, une session qui expire (max_age) ou est
    # révoquée pendant que le flux est ouvert doit le fermer. On capture les
    # valeurs de session MAINTENANT (le scope SSE ne revoit jamais le
    # cookie) ; la closure est ré-exécutée toutes les ~60 s par listen().
    _login_ts = request.session.get("_login_ts")
    _sid = request.session.get("_sid")
    _uid_int = int(uid)

    def _still_valid() -> bool:
        if not stream_session_still_valid(_uid_int, _login_ts, _sid):
            return False
        # Flux staff (journaux du worker) : fermé si le compte a été
        # rétrogradé entre-temps (audit 2026-09-22) — le client se reconnecte
        # alors en flux ordinaire.
        if is_staff:
            row = get_user_by_id(_uid_int)
            return bool(row and row["is_admin"] in (1, 2))
        return True

    # user_id → routage per-destinataire des events ``type="notification"``
    # (cf. SystemEvents.broadcast) ; le filtre client reste en défense.
    return _make_sse_response(system_events.listen(
        is_staff=is_staff, user_id=_uid_int, validity_check=_still_valid))


