// SPDX-License-Identifier: MIT
/** frontend/src/utils/url-sure.ts — garde des URL issues de données avant un lien ou une navigation : http(s) seulement (ni `javascript:`, ni `data:`, ni schéma inconnu). */

/** Vrai si la valeur, résolue contre la page (ou `base`), est une URL http ou https. */
export function estUrlHttp(valeur: unknown, base?: string): boolean {
  if (typeof valeur !== "string" || !valeur.trim()) return false;
  try {
    const u = new URL(valeur.trim(), base ?? window.location.href);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}
