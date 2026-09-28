# SPDX-License-Identifier: MIT
"""shared_infra.security.csrf — défense CSRF globale sur les requêtes mutantes.

Pourquoi ce module
------------------
L'app authentifie par cookie de session signé (Starlette ``SessionMiddleware``),
sans jeton anti-CSRF transverse. La seule barrière était donc l'attribut
``SameSite`` du cookie — dont la valeur par défaut est ``lax``.

``Lax`` ne bloque PAS le *same-site cross-origin* : un autre port de la même
machine (``localhost:3000`` → ``:8000``) ou un sous-domaine frère envoie le
cookie, avec ``Sec-Fetch-Site: same-site``. Une page hostile servie depuis une
telle origine pouvait donc déclencher, à l'insu d'un admin connecté :
``POST /api/admin/users/new`` (création d'un administrateur),
``POST /api/admin/executors`` (``exec_user`` accepte ``0:0`` → tous les
``docker exec`` en root), ``POST /api/admin/security/https`` (reboot + lockout).

Une garde correcte existait déjà — ``routes/settings.py:_reject_cross_site`` —
mais elle n'était appelée que par ``change-password`` : 1 route mutante sur ~33
(finding E9 de l'audit 2026-08-01). Elle est donc généralisée ici en middleware,
seule façon de ne pas en oublier au fil des ajouts de routes.

Modèle de menace et tolérances
------------------------------
* **Pas de cookie de session sur la requête ⇒ pas de CSRF possible** (rien
  d'ambiant à rejouer). On laisse passer : c'est ce qui préserve les clients
  non-navigateur qui s'authentifient autrement, et le login lui-même.
* ``Sec-Fetch-Site`` est posé par le navigateur et **non falsifiable** par une
  page tierce : c'est le signal primaire.
* ``Origin`` sert de repli pour les navigateurs sans Fetch-Metadata.
* Ni l'un ni l'autre (client non-navigateur : CLI, plugin) ⇒ toléré, comme dans
  la garde d'origine : ces appels ne passent pas par le navigateur de la
  victime, qui est le vecteur visé.
"""
from __future__ import annotations

import logging
from typing import Iterable, Optional
from urllib.parse import urlparse

from starlette.requests import Request
from starlette.responses import JSONResponse

logger = logging.getLogger("uvicorn.error")

# Méthodes à effet de bord. HEAD/GET/OPTIONS sont hors scope (et OPTIONS doit
# rester libre pour le préflight).
_MUTATING = frozenset({"POST", "PUT", "PATCH", "DELETE"})

# Valeurs de Sec-Fetch-Site acceptées : requête de même origine, ou navigation
# directe / saisie d'URL (``none``).
_ALLOWED_FETCH_SITE = frozenset({"same-origin", "none"})


def is_cross_site(request: Request) -> bool:
    """Vrai si la requête vient manifestement d'une AUTRE origine.

    Reprend exactement la logique de ``routes/settings.py:_reject_cross_site``.
    """
    sec_fetch_site = (request.headers.get("sec-fetch-site") or "").strip().lower()
    if sec_fetch_site:
        return sec_fetch_site not in _ALLOWED_FETCH_SITE

    origin = (request.headers.get("origin") or "").strip()
    # ``Origin: null`` = contexte opaque (iframe sandbox, aperçu de la
    # sandbox…) : jamais l'app elle-même (audit 2026-09-22).
    if origin.lower() == "null":
        return True
    if origin:
        try:
            origin_host = urlparse(origin).netloc.lower()
        except Exception:
            origin_host = ""
        host = (request.headers.get("host") or request.url.netloc or "").strip().lower()
        if not origin_host or origin_host != host:
            return True
    return False


def ws_is_cross_site(ws) -> bool:
    """Équivalent de ``is_cross_site`` pour un handshake WebSocket.

    AUDIT 2026-08-02 (E3) — ``CsrfGuardMiddleware`` est un ``BaseHTTPMiddleware``
    (scope ``http`` uniquement) : les handshakes ``/ws/terminal`` échappaient à
    TOUTE vérification d'origine. Le cookie de session étant ``SameSite=Lax``, un
    attaquant disposant d'un pied same-site cross-origin (autre port / sous-
    domaine frère) pouvait ouvrir un WS vers le terminal de la victime → shell
    interactif dans sa sandbox. Un navigateur envoie TOUJOURS ``Origin`` sur un
    WS : l'absence d'``Origin`` (client non-navigateur légitime, CLI) reste
    permise — l'attaque, elle, porte forcément une ``Origin`` cross-site.
    """
    sec_fetch_site = (ws.headers.get("sec-fetch-site") or "").strip().lower()
    if sec_fetch_site:
        return sec_fetch_site not in _ALLOWED_FETCH_SITE
    origin = (ws.headers.get("origin") or "").strip()
    if origin.lower() == "null":
        return True
    if origin:
        try:
            origin_host = urlparse(origin).netloc.lower()
        except Exception:
            origin_host = ""
        host = (ws.headers.get("host") or "").strip().lower()
        if not host:
            try:
                host = (ws.url.netloc or "").strip().lower()
            except Exception:
                host = ""
        if not origin_host or origin_host != host:
            return True
    return False


class CsrfGuardMiddleware:
    """Rejette en 403 toute requête mutante cross-site PORTEUSE d'un cookie de
    session.

    ``exempt_prefixes`` : préfixes de chemin laissés libres (proxys, webhooks
    ou intégrations qui doivent rester appelables cross-origin).

    Middleware ASGI **pur** — et non un ``BaseHTTPMiddleware``. Ce dernier
    enveloppe chaque requête dans un task group anyio et un memory-object-
    stream, que le corps de la réponse traverse morceau par morceau. Mesuré sur
    cette pile, pour les deux couches montées par l'app (CSRF + journalisation) :
    385 µs → 0,7 µs sur une réponse JSON, et 122 ms → 0,35 ms sur un flux NDJSON
    de 2 000 lignes — soit ~60 µs de pure plomberie par token streamé.

    La garde ne lit que des en-têtes et le cookie brut : elle n'a jamais eu
    besoin de l'objet ``Request`` complet.

    Le périmètre reste volontairement ``http`` seul, à l'identique. Les
    handshakes WebSocket sont couverts séparément par :func:`ws_is_cross_site`,
    câblé aux endpoints ; les unifier ici serait un changement de sécurité, pas
    de performance, et n'a rien à faire dans le même commit.
    """

    def __init__(self, app, *, cookie_name: str = "mcpwebui_session",
                 exempt_prefixes: Optional[Iterable[str]] = None):
        self.app = app
        self._cookie_name = cookie_name
        self._exempt = tuple(exempt_prefixes or ())

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope.get("method") not in _MUTATING:
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")
        if self._exempt and path.startswith(self._exempt):
            await self.app(scope, receive, send)
            return

        request = Request(scope, receive)

        # Sans cookie de session, aucune autorité ambiante à rejouer.
        if not request.cookies.get(self._cookie_name):
            await self.app(scope, receive, send)
            return

        if is_cross_site(request):
            logger.warning(
                "[csrf] %s %s refusée — origin=%r sec-fetch-site=%r",
                request.method, path,
                request.headers.get("origin"),
                request.headers.get("sec-fetch-site"),
            )
            response = JSONResponse({"detail": "Requête cross-site refusée."},
                                    status_code=403)
            await response(scope, receive, send)
            return

        await self.app(scope, receive, send)
