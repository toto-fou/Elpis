// SPDX-License-Identifier: MIT
/** packages/mcp/src/delegation.ts — jeton de délégation `dlg_` du relais MCP : enveloppe HMAC signée avec le jeton de service, jamais le jeton du client. */
import { intPy, strPy, stripPy, veritePy } from "@elpis/commun";
import { DELEGATION_AUDIENCE, signClaims, verifyClaims } from "@elpis/securite";

import { iterer, lire } from "./outils";

export const DELEGATION_TOKEN_PREFIX = "dlg_";

/** Client délégué : compte, type de client et familles d'outils permises. */
export interface ClientDelegue {
  username?: unknown;
  user_id?: unknown;
  kind?: unknown;
  families?: unknown;
}

function ou(v: unknown, defaut: unknown): unknown {
  return veritePy(v) ? v : defaut;
}

/** Jeton `dlg_` pour `client` = `{username, user_id, kind, families}`. */
export function delegationToken(
  client: ClientDelegue,
  serviceToken: string,
  options: { now?: number } = {},
): string {
  const claims = {
    sub: strPy(ou(lire(client, "username"), "")),
    uid: intPy(ou(lire(client, "user_id"), 0)),
    kind: strPy(ou(lire(client, "kind"), "")),
    families: iterer(ou(lire(client, "families"), [])).map((f) => strPy(f)),
  };
  return (
    DELEGATION_TOKEN_PREFIX +
    signClaims(claims, serviceToken, {
      aud: DELEGATION_AUDIENCE,
      ...(options.now === undefined ? {} : { now: options.now }),
    })
  );
}

/** Revendications d'un jeton `dlg_` valide (signature, audience, horodatage, compte non vide), sinon `null`. */
export function verifyDelegation(
  token: string | null | undefined,
  serviceToken: string | null | undefined,
  options: { now?: number } = {},
): Record<string, unknown> | null {
  if (!token || !token.startsWith(DELEGATION_TOKEN_PREFIX) || !serviceToken) return null;
  const claims = verifyClaims(token.slice(DELEGATION_TOKEN_PREFIX.length), serviceToken, {
    aud: DELEGATION_AUDIENCE,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  if (claims === null || !stripPy(strPy(ou(lire(claims, "sub"), "")))) return null;
  return claims;
}
