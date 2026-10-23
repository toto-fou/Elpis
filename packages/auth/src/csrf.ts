// SPDX-License-Identifier: MIT
/** packages/auth/src/csrf.ts — garde CSRF globale (security/csrf.py) : requête mutante et cross-site portant le cookie de session → 403. */
import { isIP } from "node:net";

import { stripPy } from "@elpis/commun";

const SITES_PERMIS = new Set(["same-origin", "none"]);
const CARACTERES_SCHEMA = /^[A-Za-z0-9+\-.]+$/u;
export const METHODES_MUTANTES = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export type Entetes = Readonly<Record<string, string | string[] | undefined>>;

export function entete(e: Entetes, nom: string): string {
  const v = e[nom];
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

function hoteCrochets(hote: string): void {
  if (hote.startsWith("v")) {
    if (!/^v[a-fA-F0-9]+\..+$/su.test(hote)) throw new Error("IPvFuture address is invalid");
    return;
  }
  if (isIP(hote) !== 6)
    throw new Error(isIP(hote) === 4 ? "An IPv4 address cannot be in brackets" : "Invalid IPv6 URL");
}

/** `urlsplit(url).netloc` de CPython 3.13 ; lève comme lui sur des crochets invalides. */
export function netlocUrl(url: string): string {
  let debut = 0;
  while (debut < url.length && url.charCodeAt(debut) <= 0x20) debut++;
  let reste = url.slice(debut).replace(/[\t\r\n]/gu, "");
  const i = reste.indexOf(":");
  if (i > 0 && /^[A-Za-z]/u.test(reste) && CARACTERES_SCHEMA.test(reste.slice(0, i)))
    reste = reste.slice(i + 1);
  if (!reste.startsWith("//")) return "";
  let fin = reste.length;
  for (const c of "/?#") {
    const j = reste.indexOf(c, 2);
    if (j >= 0) fin = Math.min(fin, j);
  }
  const netloc = reste.slice(2, fin);
  const ouvre = netloc.includes("[");
  const ferme = netloc.includes("]");
  if (ouvre !== ferme) throw new Error("Invalid IPv6 URL");
  if (ouvre) {
    const hotePort = netloc.slice(netloc.lastIndexOf("@") + 1);
    const crochet = hotePort.indexOf("[");
    if (crochet > 0) throw new Error("Invalid IPv6 URL");
    if (crochet === 0) {
      const dedans = hotePort.slice(1);
      const f = dedans.indexOf("]");
      const port = f >= 0 ? dedans.slice(f + 1) : "";
      if (port && !port.startsWith(":")) throw new Error("Invalid IPv6 URL");
      hoteCrochets(f >= 0 ? dedans.slice(0, f) : dedans);
    } else {
      hoteCrochets(hotePort.split(":")[0] ?? "");
    }
  }
  return netloc;
}

/** `is_cross_site` : Sec-Fetch-Site d'abord, Origin (`null` ou hôte ≠ Host) en repli ; ni l'un ni l'autre = client non navigateur, toléré. */
export function estInterSite(e: Entetes, hoteParDefaut = ""): boolean {
  const site = stripPy(entete(e, "sec-fetch-site")).toLowerCase();
  if (site) return !SITES_PERMIS.has(site);
  const origine = stripPy(entete(e, "origin"));
  if (origine.toLowerCase() === "null") return true;
  if (origine) {
    let hoteOrigine: string;
    try {
      hoteOrigine = netlocUrl(origine).toLowerCase();
    } catch {
      hoteOrigine = "";
    }
    const hote = stripPy(entete(e, "host") || hoteParDefaut).toLowerCase();
    if (!hoteOrigine || hoteOrigine !== hote) return true;
  }
  return false;
}

/** Préfixes laissés libres (webhooks signés appelables cross-origin). */
export const PREFIXES_EXEMPTES_CSRF: readonly string[] = ["/api/webhooks/"];

/** Routes qui ouvrent une session : contrôlées même sans cookie (CSRF de connexion). */
export const CHEMINS_CSRF_SANS_COOKIE: ReadonlySet<string> = new Set(["/api/login-lite"]);
