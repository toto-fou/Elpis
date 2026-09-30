# SPDX-License-Identifier: MIT
"""shared_infra/mcp/delegation.py — jeton de délégation du relais MCP (EXT.2).

Le relais public ``/api/mcp-bridge`` authentifie le client (jeton personnel
aujourd'hui, OAuth demain) puis appelle le service d'outils pour lui. La
spécification MCP interdit de retransmettre le jeton du client (« token
passthrough ») : le relais présente à la place ``Bearer dlg_<enveloppe>``,
une enveloppe HMAC signée avec le jeton de SERVICE, d'audience ``elpis-mcp``,
horodatée (±60 s), qui porte :

* ``sub`` — le compte (username), ``uid`` — son id ;
* ``kind`` — le type de client (``opencode``, ``tools``…) ;
* ``families`` — les familles d'outils permises (jetons d'outils).

Le service en tire exactement les restrictions qu'aurait eues le jeton du
client — jamais la confiance du service. Un service qui ne connaît pas le
préfixe ``dlg_`` répond 401 : un déploiement où l'hôte d'outils serait plus
ancien que l'app échoue fermé, sans jamais prêter les droits du service.
"""
from __future__ import annotations

from typing import Any, Dict, Optional

from shared_infra.accounts import identity as _ident

DELEGATION_TOKEN_PREFIX = "dlg_"


def delegation_token(client: Dict[str, Any], service_token: str, *,
                     now: Optional[float] = None) -> str:
    """Jeton ``dlg_`` pour ``client`` = ``{username, user_id, kind, families}``."""
    claims = {"sub": str(client.get("username") or ""), "uid": int(client.get("user_id") or 0),
              "kind": str(client.get("kind") or ""),
              "families": [str(f) for f in client.get("families") or []]}
    return DELEGATION_TOKEN_PREFIX + _ident.sign_claims(
        claims, service_token, aud=_ident.DELEGATION_AUDIENCE, now=now)


def verify_delegation(token: str, service_token: str, *,
                      now: Optional[float] = None) -> Optional[Dict[str, Any]]:
    """Revendications d'un jeton ``dlg_`` valide (signature, audience,
    horodatage, compte non vide), sinon ``None``."""
    if not token or not token.startswith(DELEGATION_TOKEN_PREFIX) or not service_token:
        return None
    claims = _ident.verify_claims(token[len(DELEGATION_TOKEN_PREFIX):], service_token,
                                  aud=_ident.DELEGATION_AUDIENCE, now=now)
    if not claims or not str(claims.get("sub") or "").strip():
        return None
    return claims


__all__ = ["DELEGATION_TOKEN_PREFIX", "delegation_token", "verify_delegation"]
