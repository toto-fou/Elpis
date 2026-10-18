// SPDX-License-Identifier: MIT
/** packages/securite/src/ports.ts — ce que le paquet attend de son hôte : journal, et comptes sur le core. */
export { brancherJournal, journalDe } from "@elpis/commun";
export type { FabriqueJournal, Journal } from "@elpis/commun";

/** Comptes en base, lus après l'identité et le registre ; profil : `resolve_network_profile_id` des réglages. */
export interface ComptesEnBase {
  getUsernameById(userId: number): Promise<string | null>;
  getUserIdByUsername(username: string): Promise<number | null>;
  getNetworkProfileId(userId: number): Promise<string>;
}

let comptes: ComptesEnBase | null = null;

/** Le core y branche ses lectures en base ; l'hôte d'outils n'en a pas (`null`). */
export function brancherComptes(c: ComptesEnBase | null): void {
  comptes = c;
}

export function comptesBranches(): ComptesEnBase | null {
  return comptes;
}
