// SPDX-License-Identifier: MIT
/** packages/mcp/src/ports.ts — ce que le paquet attend de son hôte : journal, garde SSRF des URL (shared_infra/git/ssrf.py) et marque des configs de confiance. */
export { brancherJournal, journalDe } from "@elpis/commun";
export type { FabriqueJournal, Journal } from "@elpis/commun";

/** `block_remote_url_reason(url, allow_schemes=…)` : motif de refus, `null` si l'URL est sûre (la résolution DNS en fait partie). */
export type GardeUrl = (url: string, allowSchemes: readonly string[]) => Promise<string | null>;

let gardeUrl: GardeUrl | null = null;

/** Garde SSRF des URL de serveurs perso (`@elpis/securite`, `ssrf.ts`) ; tant qu'elle manque, les URL des serveurs perso des non-admins sont refusées. */
export function brancherGardeUrl(g: GardeUrl | null): void {
  gardeUrl = g;
}

export function gardeUrlBranchee(): GardeUrl | null {
  return gardeUrl;
}

const CONFIANCE: unique symbol = Symbol("elpis.mcp.confiance");

/** Marque (invisible au JSON et aux comparaisons) d'une config de confiance : bibliothèque partagée, manifeste, serveur perso d'un admin ; toute autre config réseau est connectée sous la garde stricte. */
export function marquerConfiance<T extends object>(cfg: T): T {
  Object.defineProperty(cfg, CONFIANCE, { value: true, enumerable: false, configurable: true });
  return cfg;
}

export function deConfiance(cfg: unknown): boolean {
  return typeof cfg === "object" && cfg !== null && Object.hasOwn(cfg, CONFIANCE);
}
