// SPDX-License-Identifier: MIT
/** packages/securite/src/ssrf.ts — garde SSRF des URL distantes (shared_infra/git/ssrf.py) : schéma, identifiants, hôtes internes, adresses résolues. */
import { lookup } from "node:dns/promises";

import {
  adresseIpOuNul,
  estBoucleIp,
  estGlobaleIp,
  estLienLocalIp,
  estMulticastIp,
  estNonSpecifieeIp,
  hostname,
  port,
  stripPy,
  texteIp,
  urlsplit,
} from "@elpis/commun";
import type { AdresseIp, UrlDecoupee } from "@elpis/commun";

const SUFFIXES_INTERNES = [".local", ".internal", ".lan", ".home", ".corp", ".intranet"];
const HOTES_BOUCLE: ReadonlySet<string> = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
]);

/** Schémas d'un remote git (clone, fetch, push, pull), source unique des routes et des outils. */
export const GIT_REMOTE_SCHEMES: ReadonlySet<string> = new Set(["http", "https", "git"]);

/** `socket.getaddrinfo(hote, port)` : adresses dans l'ordre du système ; lève si le nom ne se résout pas. */
export type Resolveur = (hote: string, port: number | null) => Promise<string[]>;

export interface OptionsGardeUrl {
  allowSchemes?: Iterable<string>;
  allowHosts?: Iterable<string>;
  criticalOnly?: boolean;
  resoudre?: Resolveur;
}

async function resoudreSysteme(hote: string): Promise<string[]> {
  return (await lookup(hote, { all: true, order: "verbatim" })).map((r) => r.address);
}

/** Boucle, lien local (métadonnées), non spécifiée ou multicast ; une IPv4 encapsulée est jugée par son IPv4 (prédicats de CPython 3.13). */
export function adresseCritique(ip: AdresseIp): boolean {
  return estBoucleIp(ip) || estLienLocalIp(ip) || estNonSpecifieeIp(ip) || estMulticastIp(ip);
}

/** Strict : tout ce qui n'est pas globalement routable ; `criticalOnly` : `adresseCritique`. */
function ipBloquee(ip: AdresseIp, critique: boolean): boolean {
  if (critique) return adresseCritique(ip);
  return !estGlobaleIp(ip);
}

/** `block_remote_url_reason` : motif de blocage, ou `null` si l'URL est sûre ; un port illisible lève comme `p.port`. */
export async function blockRemoteUrlReason(
  url: string,
  options: OptionsGardeUrl = {},
): Promise<string | null> {
  const u = stripPy(url || "");
  if (!u) return "empty_url";
  let p: UrlDecoupee;
  try {
    p = urlsplit(u);
  } catch {
    return "malformed_url";
  }
  const scheme = p.scheme.toLowerCase();
  if (p.netloc.includes("@")) return "credentials_in_url";
  let host: string;
  try {
    host = (hostname(p) ?? "").toLowerCase();
  } catch {
    return "malformed_url";
  }
  if (!host) return "no_host";
  const permis = new Set([...(options.allowHosts ?? [])].filter(Boolean).map((h) => h.toLowerCase()));
  const portUrl = port(p);
  const candidats = [host, ...(portUrl ? [`${host}:${portUrl}`] : [])];
  const autorise = candidats.some((c) => permis.has(c));
  const schemas = new Set([...(options.allowSchemes ?? ["https"])].map((s) => s.toLowerCase()));
  if (autorise) for (const s of GIT_REMOTE_SCHEMES) schemas.add(s);
  if (!schemas.has(scheme)) return `scheme_not_allowed (${scheme || "empty"})`;
  if (autorise) return null;
  const critique = options.criticalOnly === true;
  const litterale = adresseIpOuNul(host);
  if (litterale !== null) return ipBloquee(litterale, critique) ? `blocked_ip (${texteIp(litterale)})` : null;
  if (HOTES_BOUCLE.has(host)) return `blocked_host (${host})`;
  if (!critique) {
    for (const suffixe of SUFFIXES_INTERNES)
      if (host === suffixe.slice(1) || host.endsWith(suffixe)) return `internal_suffix (${suffixe})`;
  }
  let adresses: string[];
  try {
    adresses = await (options.resoudre ?? resoudreSysteme)(host, portUrl || null);
  } catch {
    return "unresolvable_host";
  }
  for (const brute of adresses) {
    const ip = adresseIpOuNul(brute);
    if (ip !== null && ipBloquee(ip, critique)) return `resolves_to_blocked (${texteIp(ip)})`;
  }
  return null;
}
