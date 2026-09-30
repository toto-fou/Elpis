# SPDX-License-Identifier: MIT
"""
shared_infra/mcp/bridge.py — le service MCP partagé, servi sous l'origine
de l'app.

POURQUOI (régression 2026-09-04, signalée en direct) : un opencode installé sur
une AUTRE machine recevait dans son ``opencode.json`` des URL MCP du type
``http://127.0.0.1:8765/mcp/git``. Sur le poste distant, ``127.0.0.1`` désigne
CE poste — pas le serveur : les trois entrées ``elpis-*`` apparaissaient dans le
TUI et aucune ne répondait. Le cas « LAN » et le cas « HTTPS/Caddy » échouaient
tous les deux, pour deux raisons distinctes :

  • bind par défaut ``LOCAL_MCP_HOST=127.0.0.1`` : le service n'écoute QUE sur
    le loopback du serveur, donc rien à joindre depuis le LAN ;
  • même en le liant à ``0.0.0.0``, l'URL publiée restait ``http://<hôte>:8765``
    — un SECOND port à ouvrir, en clair, hors du frontal TLS. Derrière Caddy,
    l'app est en https/443 et le MCP en http/8765 : deux surfaces réseau à
    aligner pour un même service.

CORRECTIF : le client parle au MCP par l'ORIGINE QU'IL JOINT DÉJÀ — celle de
l'app. Ce module relaie ``/api/mcp-bridge[/<famille>]`` vers ``LOCAL_MCP_URL``
en loopback. Le poste distant n'a donc RIEN de plus à joindre que l'app elle-même :
même hôte, même port, même TLS, même règle de pare-feu. Le service MCP peut
rester lié au loopback (sa position la plus sûre).

SÉCURITÉ — ce relais n'élargit AUCUN droit :

  • il exige un client AUTHENTIFIÉ par l'un des vérificateurs de
    ``CLIENT_VERIFIERS`` — aujourd'hui les jetons personnels opencode
    (``pcr_…``) et d'outils (``ept_…``, EXT.1), demain OAuth (EXT.4) ;
  • (EXT.2) il ne retransmet JAMAIS le jeton du client (« token passthrough »,
    interdit par la spécification MCP) : il présente au service un jeton de
    DÉLÉGATION ``dlg_…`` — enveloppe signée avec le jeton de service, courte,
    qui dit pour QUEL compte il agit, avec quel type de client et quelles
    familles. Le service en tire exactement les restrictions qu'aurait eues le
    jeton du client (``client_kind=opencode`` → familles opencode ;
    ``client_kind=tools`` → familles cochées), jamais la confiance de l'app
    (``trusted_meta``). Un service qui ne connaît pas ``dlg_`` le refuse
    (401) : pas de repli possible sur les droits du service ;
  • ``Origin`` contrôlé (anti-rebinding DNS) et ``MCP-Protocol-Version``
    inconnue refusée (400) avant tout appel au service ;
  • la cible est ``LOCAL_MCP_URL`` (config serveur), jamais une URL du client :
    aucun SSRF possible ;
  • le cookie de session n'est PAS accepté : ce chemin est réservé aux clients
    MCP porteurs d'un jeton, pas à un navigateur authentifié (pas de CSRF).

TRANSPORT : le MCP « HTTP streamable » utilise POST (corps JSON-RPC, réponse
JSON *ou* flux SSE), GET (flux d'événements serveur, longue durée) et DELETE
(fin de session). Le relais est donc bidirectionnel et NON tamponné, et
retransmet ``Mcp-Session-Id`` (l'identité de session du protocole) ainsi que
``Last-Event-ID`` (reprise d'un flux coupé). Sans eux, chaque requête ouvrirait
une session neuve et le client boucherait sur « session not found ».
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Callable, Dict, List, Optional

from fastapi import HTTPException, Request
from fastapi.responses import StreamingResponse

from shared_infra.routes._state import router

logger = logging.getLogger(__name__)

# Préfixe public. ``/api/`` est déjà la surface applicative (le frontal la route
# vers l'app), donc rien à ajouter côté Caddy.
#
# ⚠ PAS ``/api/mcp`` : ce préfixe est DÉJÀ occupé par le panneau d'outils
# (``/api/mcp/categories``, ``/api/mcp/test``, ``/api/mcp/upload``…). Une route
# ``/api/mcp/{family}`` les capturerait dès qu'elle serait déclarée avant elles
# — et l'ordre ne dépend que de l'ordre des imports, donc d'un détail. Le
# panneau d'outils cesserait alors de se peupler, sans la moindre erreur : très
# exactement le genre de panne muette qu'on cherche à éliminer.
# ``tests/shared_infra/test_mcp_bridge.py`` verrouille l'absence de recouvrement.
MCP_PROXY_PREFIX = "/api/mcp-bridge"

# En-têtes que le relais ne doit jamais recopier (négociés saut par saut).
_HOP_BY_HOP = frozenset({
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade", "host", "content-length",
})

# Requête → amont : liste BLANCHE. Tout le reste (Cookie inclus) est écarté.
_FWD_REQ_HEADERS = (
    "accept", "content-type", "mcp-session-id", "mcp-protocol-version",
    "last-event-id", "accept-encoding", "user-agent",
)

# Un flux SSE MCP reste ouvert aussi longtemps que la session : aucun timeout de
# LECTURE (seule la connexion est bornée). Un `read` fini couperait le flux
# d'événements au bout de N secondes, ce que le client lit comme une panne.
_CONNECT_TIMEOUT_S = 5.0


def _upstream_base() -> Optional[str]:
    """Base du service MCP à relayer (``…/mcp``), ou ``None`` s'il n'y en a pas.

    Source UNIQUE : ``shared_infra.mcp.local_registry.service_upstream`` — qui
    résout l'URL (env → config → dérivée du descripteur intégré) et le jeton
    (env → config → FICHIER persistant). C'est cette résolution durable qui
    corrige la disparition du bloc ``mcp`` au redémarrage (2026-09-05) : URL et
    jeton ne dépendent plus des variables d'env du script de lancement.

    ⚠ INVARIANT DE SÉCURITÉ conservé dans ``service_upstream`` : sans jeton de
    SERVICE, il n'y a rien à relayer (le service tournerait sans vérificateur,
    donc sans masquage fs/shell) → ``None``, route 404."""
    from shared_infra.mcp.local_registry import service_upstream
    url, _token = service_upstream()
    return url or None


async def _is_initialize(request: Request) -> bool:
    """Requête POST JSON-RPC ``initialize`` (le corps est mis en cache par
    Starlette : le relais le relit ensuite)."""
    if request.method != "POST":
        return False
    try:
        msg = json.loads(await request.body() or b"{}")
    except ValueError:
        return False
    return isinstance(msg, dict) and msg.get("method") == "initialize"


def _caller_token(request: Request) -> str:
    """Jeton personnel de l'appelant, ou "" — ``Authorization: Bearer …``
    (clients MCP, opencode) ou ``x-elpis-token`` (ce qu'envoie le plugin)."""
    auth = (request.headers.get("authorization") or "").strip()
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    from shared_infra.env_compat import token_header
    return token_header(request.headers)


# Deux routes, DEUX fonctions : empiler les décorateurs sur une seule aurait
# fait de ``family`` un paramètre de REQUÊTE pour la route sans segment
# (``…/mcp-bridge?family=fs``), c'est-à-dire un second chemin, non documenté,
# pour choisir la famille. Le segment d'URL doit rester le seul.
@router.api_route(MCP_PROXY_PREFIX, methods=["GET", "POST", "DELETE"])
async def mcp_proxy_all(request: Request):
    """Endpoint « toutes familles » (ce que le client voit reste borné par son
    jeton : un client opencode n'y verra jamais ``fs``/``shell``)."""
    return await _relay_to_mcp(request, "")


@router.api_route(MCP_PROXY_PREFIX + "/{family}", methods=["GET", "POST", "DELETE"])
async def mcp_proxy_family(request: Request, family: str):
    """Endpoint d'UNE famille — une entrée MCP par famille côté opencode."""
    return await _relay_to_mcp(request, family)


def _resolve_token(token: str):
    """Jeton opencode ou d'outils valide → dict du jeton, sinon ``None``."""
    from shared_infra.accounts import tokens as _tokens
    return _tokens.resolve(token, kinds=("opencode", "tools"))


def _personal_token_client(token: str) -> Optional[Dict[str, Any]]:
    """Vérificateur des jetons personnels (EXT.1)."""
    d = _resolve_token(token)
    if not d:
        return None
    return {"user_id": int(d.get("user_id") or 0), "username": str(d.get("username") or ""),
            "kind": str(d.get("kind") or ""), "families": list(d.get("families") or [])}


def _oauth_client(token: str) -> Optional[Dict[str, Any]]:
    """Vérificateur des jetons d'accès OAuth (EXT.4) : ``kind="oauth"``,
    familles accordées au consentement ∩ politique courante."""
    if not token.startswith("eoa_"):
        return None
    from shared_infra.mcp.oauth import verify_access_token
    return verify_access_token(token)


# Vérificateurs de client du relais, essayés dans l'ordre : ``jeton → client``
# ``{user_id, username, kind, families}`` ou ``None``. Le jeton de délégation
# porte le même client, quel que soit le vérificateur qui l'a reconnu.
ClientVerifier = Callable[[str], Optional[Dict[str, Any]]]
CLIENT_VERIFIERS: List[ClientVerifier] = [_personal_token_client, _oauth_client]


def verify_client(token: str) -> Optional[Dict[str, Any]]:
    """Client authentifié par l'un des vérificateurs, sinon ``None``."""
    for v in CLIENT_VERIFIERS:
        try:
            c = v(token)
        except Exception:                                        # noqa: BLE001
            logger.warning("[mcp-proxy] vérificateur de client en échec", exc_info=True)
            c = None
        if c and c.get("username"):
            return c
    return None


def _service_token() -> str:
    from shared_infra.mcp.local_registry import service_upstream
    return str(service_upstream()[1] or "")


# Période de revérification du jeton sur les flux GET longs (cf. _relay).
_TOKEN_RECHECK_S = 60.0


async def _relay_to_mcp(request: Request, family: str):
    """Relais streaming vers le service MCP partagé, sous l'origine de l'app."""
    import httpx

    base = _upstream_base()
    if not base:
        raise HTTPException(404, "Service MCP partagé non configuré.")

    # (EXT.2) Origine : un navigateur d'une autre origine n'a rien à faire ici
    # (anti-rebinding DNS) ; les clients natifs n'envoient pas d'Origin.
    from shared_infra.mcp.origins import origin_allowed
    if not origin_allowed(request.headers.get("origin")):
        raise HTTPException(403, "Origine non autorisée.")
    # Version de protocole annoncée par le client après ``initialize`` :
    # inconnue → 400 (absente : la version par défaut de la spécification).
    # ``initialize`` lui-même négocie la version dans son corps : pas de
    # contrôle d'en-tête (comme le SDK côté serveur).
    pv = request.headers.get("mcp-protocol-version")
    if pv is not None and not await _is_initialize(request):
        from mcp.shared.version import SUPPORTED_PROTOCOL_VERSIONS
        if pv not in SUPPORTED_PROTOCOL_VERSIONS:
            raise HTTPException(400, "Version de protocole MCP non prise en charge : "
                                f"{pv[:40]} (connues : {', '.join(SUPPORTED_PROTOCOL_VERSIONS)}).")

    fam = (family or "").strip().strip("/")
    # (EXT.4) Le défi dit où découvrir l'autorisation (RFC 9728) et quelle
    # portée demander : un client MCP n'a besoin que de l'URL du relais.
    from shared_infra.mcp.routes_oauth import www_authenticate
    token = _caller_token(request)
    if not token:
        # 401 + WWW-Authenticate : c'est ce que la découverte MCP attend quand
        # un client se présente sans jeton (il sait alors qu'il doit en fournir
        # un, au lieu de conclure que l'URL est morte).
        raise HTTPException(401, "Jeton requis (Paramètres › Connexions).",
                            headers={"WWW-Authenticate": www_authenticate(request, fam)})
    # Lecture de la base : hors de la boucle d'événements.
    client_ident = await asyncio.to_thread(verify_client, token)
    if client_ident is None:
        raise HTTPException(401, "Jeton invalide, expiré ou révoqué.",
                            headers={"WWW-Authenticate": www_authenticate(request, fam, error="invalid_token")})
    if (client_ident.get("kind") == "oauth" and fam
            and fam not in (client_ident.get("families") or [])):
        # Famille non accordée : le client peut redemander cette portée.
        raise HTTPException(403, "Famille d'outils non autorisée pour ce jeton.",
                            headers={"WWW-Authenticate": www_authenticate(
                                request, fam, error="insufficient_scope")})
    service_token = _service_token()
    if not service_token:
        raise HTTPException(404, "Service MCP partagé non configuré.")

    # Famille : segment d'URL contrôlé (le service refuse déjà l'inconnue par un
    # 404, cf. FamilyScopeASGI). On borne quand même la forme ici pour ne jamais
    # laisser un segment fabriqué s'échapper de ``…/mcp/`` (traversée de chemin).
    from shared_infra.mcp.families import is_family_name
    if fam and not is_family_name(fam):
        raise HTTPException(404, "Famille d'outils inconnue.")
    url = f"{base}/{fam}" if fam else base
    if request.url.query:
        url += f"?{request.url.query}"

    fwd = {h: request.headers[h] for h in _FWD_REQ_HEADERS if h in request.headers}
    # (EXT.2) Jamais le jeton du client : un jeton de DÉLÉGATION, signé avec le
    # jeton de service, qui porte le compte, le type de client et ses familles.
    from shared_infra.mcp.delegation import delegation_token
    fwd["authorization"] = f"Bearer {delegation_token(client_ident, service_token)}"

    body = await request.body() if request.method == "POST" else b""

    client = httpx.AsyncClient(
        timeout=httpx.Timeout(None, connect=_CONNECT_TIMEOUT_S),
        follow_redirects=False,
    )
    try:
        upstream = await client.send(
            client.build_request(request.method, url, headers=fwd, content=body),
            stream=True,
        )
    except httpx.RequestError as exc:
        await client.aclose()
        logger.warning("[mcp-proxy] service MCP injoignable (%s) : %r", url, exc)
        raise HTTPException(
            502,
            "Le service MCP partagé ne répond pas. Vérifiez qu'il tourne "
            "(./elpis start) et que LOCAL_MCP_URL pointe dessus.",
        )

    # ── Compat opencode / MCP SDK sur le flux SSE (GET) ─────────────────────
    # (2026-09-05) Le transport ``StreamableHTTPClientTransport`` du SDK MCP
    # (celui d'opencode) TOLÈRE un GET qui répond 405 (``if status===405 return``)
    # mais LÈVE « Failed to open SSE stream » sur tout autre non-2xx (400/404).
    # Or, au REDÉMARRAGE du service, le flux SSE de fond se rouvre avec l'ancien
    # ``Mcp-Session-Id`` → le nouveau service répond 404 (session inconnue) →
    # le client jette et marque le serveur déconnecté, sans plus pouvoir se
    # reconnecter. Les APPELS d'outils (POST), eux, se rétablissent seuls
    # (404 → ``_recoverSession`` → ré-``initialize``). On neutralise donc la
    # SEULE cause de rupture : un GET de flux dont la session manque/est périmée
    # (400/404) est renvoyé en 405 — « pas de flux serveur→client pour l'instant »
    # — que le SDK ignore proprement ; il ré-initialise au POST suivant. Un GET
    # à session VALIDE (200, flux ouvert) passe tel quel.
    if request.method == "GET" and upstream.status_code in (400, 404):
        await upstream.aclose()
        await client.aclose()
        from fastapi.responses import Response as _Resp
        return _Resp(status_code=405, headers={"Allow": "POST", "Cache-Control": "no-store"})

    # Jeton du CLIENT déjà validé ici : un 401/403 de l'amont vise la
    # délégation (horloge d'un hôte d'outils distant, version ancienne, jeton
    # de service désaligné). Le renvoyer tel quel ferait croire au client que
    # SON jeton est mauvais (un client OAuth relancerait l'autorisation).
    if upstream.status_code in (401, 403):
        await upstream.aclose()
        await client.aclose()
        logger.warning("[mcp-proxy] délégation refusée par le service d'outils (%s, HTTP %s) : "
                       "vérifier l'horloge, la version et le jeton de service", url, upstream.status_code)
        raise HTTPException(502, "Le service d'outils a refusé la délégation du relais "
                                 "(horloge, version ou jeton de service).")

    resp_headers = {k: v for k, v in upstream.headers.items()
                    if k.lower() not in _HOP_BY_HOP}
    # Un intermédiaire qui tamponne casse le flux d'événements : on le dit aux
    # proxys (Caddy respecte X-Accel-Buffering comme nginx).
    resp_headers["Cache-Control"] = "no-store"
    resp_headers["X-Accel-Buffering"] = "no"

    # AUDIT moteur d'événements 2026-09-25 (B11) — le jeton n'était vérifié
    # qu'à l'ouverture, et le flux GET (serveur → client) n'a pas de délai de
    # lecture : un jeton RÉVOQUÉ gardait ses notifications en direct aussi
    # longtemps que le client restait branché. Un veilleur revérifie le jeton
    # toutes les ``_TOKEN_RECHECK_S`` et ferme l'amont s'il ne vaut plus rien.
    revoked = {"v": False}

    async def _watch_token():
        while True:
            await asyncio.sleep(_TOKEN_RECHECK_S)
            try:
                ok = await asyncio.to_thread(verify_client, token) is not None
            except Exception:
                ok = True                      # transitoire → fail-open
            if not ok:
                revoked["v"] = True
                logger.info("[mcp-proxy] jeton révoqué : flux %s fermé", url)
                await upstream.aclose()
                return

    async def _relay():
        watcher = (asyncio.create_task(_watch_token())
                   if request.method == "GET" else None)
        try:
            if upstream.is_stream_consumed:
                yield upstream.content          # transport de test (MockTransport)
            else:
                async for chunk in upstream.aiter_raw():
                    yield chunk
        except (httpx.HTTPError, OSError) as exc:
            # Les en-têtes sont partis : on ne peut plus changer le statut. On
            # termine proprement (le client MCP reconnecte avec Last-Event-ID)
            # et on trace la cause.
            logger.info("[mcp-proxy] flux amont interrompu (%s) : %r", url, exc)
        except Exception:
            if not revoked["v"]:
                raise
            # Fermeture provoquée par le veilleur : fin propre ; la
            # reconnexion du client prendra un 401.
        finally:
            if watcher is not None:
                watcher.cancel()
            await upstream.aclose()
            await client.aclose()

    return StreamingResponse(_relay(), status_code=upstream.status_code,
                             headers=resp_headers)


__all__ = ["CLIENT_VERIFIERS", "MCP_PROXY_PREFIX", "verify_client"]
