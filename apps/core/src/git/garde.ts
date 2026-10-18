// SPDX-License-Identifier: MIT
/** apps/core/src/git/garde.ts — garde SSRF des appels git (`check_remote_url` de git/ssrf.py) : adresses validées réutilisées pour la connexion, boucle et lien locaux refusés même pour un hôte enregistré, hôte non résolu refusé. */
import { lookup } from "node:dns/promises";

import { adresseIpOuNul, hostname, port, texteIp, urlsplit } from "@elpis/commun";
import type { AdresseIp } from "@elpis/commun";
import { adresseCritique, blockRemoteUrlReason } from "@elpis/securite";
import type { Resolveur } from "@elpis/securite";

let interdite: (ip: AdresseIp) => boolean = adresseCritique;

/** Adresses refusées même pour un hôte enregistré ; `null` rétablit `adresseCritique` (réservé aux tests). */
export function brancherAdressesInterdites(politique: ((ip: AdresseIp) => boolean) | null): void {
  interdite = politique ?? adresseCritique;
}

async function resoudreSysteme(hote: string): Promise<string[]> {
  return (await lookup(hote, { all: true, order: "verbatim" })).map((r) => r.address);
}

export interface OptionsGardeGit {
  readonly allowSchemes: Iterable<string>;
  readonly allowHosts: Iterable<string>;
  /** `critical_only` : LAN permis, seules les adresses critiques refusées (outils de l'agent). */
  readonly criticalOnly?: boolean;
  readonly resoudre?: Resolveur;
}

export interface VerdictGit {
  readonly motif: string | null;
  /** Adresses validées du nom d'hôte, à réutiliser pour la connexion ; `null` pour une IP littérale ou un refus. */
  readonly adresses: readonly string[] | null;
}

const NON_RESOLU: VerdictGit = { motif: "unresolvable_host", adresses: null };

/** `block_remote_url_reason` puis boucle et lien local refusés pour tout hôte ; une seule résolution, retenue ; aucune adresse lisible : `unresolvable_host` (`check_remote_url`). */
export async function gardeGit(url: string, options: OptionsGardeGit): Promise<VerdictGit> {
  const resoudre: Resolveur = options.resoudre ?? ((h) => resoudreSysteme(h));
  const vues: { adresses: string[] | null } = { adresses: null };
  const motif = await blockRemoteUrlReason(url, {
    allowSchemes: options.allowSchemes,
    allowHosts: options.allowHosts,
    criticalOnly: options.criticalOnly === true,
    resoudre: async (h, p) => (vues.adresses = await resoudre(h, p)),
  });
  if (motif) return { motif, adresses: null };
  const p = urlsplit(url);
  const litterale = adresseIpOuNul((hostname(p) ?? "").toLowerCase());
  if (litterale !== null)
    return { motif: interdite(litterale) ? `blocked_ip (${texteIp(litterale)})` : null, adresses: null };
  if (vues.adresses === null) {
    try {
      vues.adresses = await resoudre((hostname(p) ?? "").toLowerCase(), port(p) || null);
    } catch {
      return NON_RESOLU;
    }
  }
  const adresses: string[] = [];
  for (const brute of vues.adresses) {
    const ip = adresseIpOuNul(brute);
    if (ip === null) continue;
    if (interdite(ip)) return { motif: `resolves_to_blocked (${texteIp(ip)})`, adresses: null };
    if (!adresses.includes(brute)) adresses.push(brute);
  }
  return adresses.length ? { motif: null, adresses } : NON_RESOLU;
}
