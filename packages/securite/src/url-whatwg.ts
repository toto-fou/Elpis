// SPDX-License-Identifier: MIT
/** packages/securite/src/url-whatwg.ts — accord urlsplit/WHATWG (E40) : une URL http(s) n'est suivie que si le client réseau (WHATWG) lit le même hôte et le même port que la garde (urlsplit). */
import { domainToASCII } from "node:url";

import { adresseIpOuNul, hostname, port, urlsplit } from "@elpis/commun";

// Caractères qui terminent ou interdisent un hôte pour WHATWG (avec les contrôles, l'espace et DEL) : `domainToASCII` couperait le nom sans le dire.
const DELIMITEURS_HOTE: ReadonlySet<string> = new Set("#%/:<>?@[\\]^|");

function aDelimiteur(h: string): boolean {
  for (const c of h) {
    const n = c.codePointAt(0) ?? 0;
    if (n <= 0x20 || n === 0x7f || DELIMITEURS_HOTE.has(c)) return true;
  }
  return false;
}

/** Même hôte pour `urlsplit` et WHATWG : IP de même valeur, nom identique, ou nom Unicode sans délimiteur dont la forme IDNA est celle de WHATWG. */
function memeHote(h: string, hw: string): boolean {
  const a = adresseIpOuNul(h);
  const b = adresseIpOuNul(hw);
  if (a !== null || b !== null)
    return a !== null && b !== null && a.version === b.version && a.valeur === b.valeur;
  return hw === h || (!aDelimiteur(h) && domainToASCII(h) === hw);
}

/** URL http(s) lue par WHATWG, si elle désigne le même hôte et le même port que `urlsplit`, sinon `null` ; lève comme `urlsplit` et `p.port` sur une URL illisible. */
export function cibleNonAmbigue(url: string): URL | null {
  const p = urlsplit(url);
  if (p.scheme !== "http" && p.scheme !== "https") return null;
  const w = URL.canParse(url) ? new URL(url) : null;
  if (w === null) return null;
  const hw = w.hostname.startsWith("[") ? w.hostname.slice(1, -1) : w.hostname;
  const defaut = p.scheme === "https" ? 443 : 80;
  return memeHote(hostname(p) ?? "", hw) && (port(p) ?? defaut) === (w.port ? Number(w.port) : defaut)
    ? w
    : null;
}

/** URL http(s) dont WHATWG lit le même hôte et le même port que `urlsplit`. */
export function urlNonAmbigue(url: string): boolean {
  try {
    return cibleNonAmbigue(url) !== null;
  } catch {
    return false;
  }
}
