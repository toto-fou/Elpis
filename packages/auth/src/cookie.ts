// SPDX-License-Identifier: MIT
/** packages/auth/src/cookie.ts — cookie de session au format TS : base64url(JSON) « . » base64url(HMAC-SHA256), attributs de Starlette. */
import { createHmac } from "node:crypto";

import { stripPy } from "@elpis/commun";
import type { AttributsCookie } from "@elpis/config";
import { egauxEnTempsConstant } from "@elpis/securite";

const CONTEXTE = "elpis.session.v1.";

function signature(secret: string, charge: string): string {
  return createHmac("sha256", secret)
    .update(CONTEXTE + charge)
    .digest("base64url");
}

export function signerSession(donnees: Record<string, unknown>, secret: string, maintenant: number): string {
  const charge = Buffer.from(JSON.stringify({ d: donnees, t: Math.floor(maintenant) })).toString("base64url");
  return `${charge}.${signature(secret, charge)}`;
}

/** Session du cookie, ou null si signature fausse, illisible, ou âge hors de [0, maxAge] (comme itsdangerous). */
export function lireSession(
  valeur: string,
  secret: string,
  maxAge: number,
  maintenant: number,
): Record<string, unknown> | null {
  const point = valeur.lastIndexOf(".");
  if (point <= 0) return null;
  const charge = valeur.slice(0, point);
  const attendue = Buffer.from(signature(secret, charge));
  const recue = Buffer.from(valeur.slice(point + 1));
  if (!egauxEnTempsConstant(attendue, recue)) return null;
  try {
    const { d, t } = JSON.parse(Buffer.from(charge, "base64url").toString("utf8")) as {
      d?: unknown;
      t?: unknown;
    };
    const age = Math.floor(maintenant) - Number(t);
    if (!Number.isFinite(age) || age < 0 || age > maxAge) return null;
    return d !== null && typeof d === "object" && !Array.isArray(d) ? (d as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function drapeaux(a: AttributsCookie): string {
  return `httponly; samesite=${a.same_site}${a.https_only ? "; secure" : ""}`;
}

export function enteteCookie(a: AttributsCookie, valeur: string): string {
  return `${a.cookie_name}=${valeur}; path=/; Max-Age=${a.max_age}; ${drapeaux(a)}`;
}

/** Effacement : mêmes Path, SameSite, Secure et HttpOnly que la pose ; `maintenant` (epoch) date l'expiration, sinon 1970. */
export function enteteEffacement(a: AttributsCookie, maintenant?: number): string {
  const date = new Date(maintenant === undefined ? 0 : Math.floor(maintenant) * 1000).toUTCString();
  return `${a.cookie_name}=""; path=/; expires=${date}; Max-Age=0; ${drapeaux(a)}`;
}

/** `http.cookies._unquote` : guillemets retirés, échappements `\ooo` et `\c` résolus. */
function deguillemeter(v: string): string {
  if (Array.from(v).length < 2 || !v.startsWith('"') || !v.endsWith('"')) return v;
  return v
    .slice(1, -1)
    .replace(/\\(?:([0-3][0-7][0-7])|([^\n]))/gu, (_m, oct?: string, c?: string) =>
      oct ? String.fromCharCode(parseInt(oct, 8)) : (c ?? ""),
    );
}

/** `cookie_parser(entete).get(nom)` de Starlette : le dernier cookie du nom l'emporte. */
export function valeurCookie(entete: string | undefined, nom: string): string | undefined {
  let trouvee: string | undefined;
  for (const morceau of (entete ?? "").split(";")) {
    const egal = morceau.indexOf("=");
    const cle = stripPy(egal >= 0 ? morceau.slice(0, egal) : "");
    const v = stripPy(egal >= 0 ? morceau.slice(egal + 1) : morceau);
    if ((cle || v) && cle === nom) trouvee = deguillemeter(v);
  }
  return trouvee;
}
