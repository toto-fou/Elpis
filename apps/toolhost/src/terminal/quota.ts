// SPDX-License-Identifier: MIT
/** apps/toolhost/src/terminal/quota.ts — base des sessions (celle de l'hôte), port de la jauge d'occupation du bac et plafond de quota du compte (réglages, puis config.json). */
import { estDict, getPy, intPy, pyJsonLoads } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { configView } from "@elpis/config";
import type { Base } from "@elpis/db";

import { baseHote } from "../base-hote";

export const QUOTA_DEFAUT_MO = 5120;
const MIO = 1024 * 1024;

/** `sandbox_usage_bytes(uid, racine, quota_bytes=…)` : occupation du dossier de travail, recalculée exactement près du plafond. */
export type MesureUsage = (uid: number, racine: string, quotaOctets: number) => Promise<number>;

let mesure: MesureUsage | null = null;

/** Mesure branchée (avertissement au démarrage sinon). */
export function usageBranchee(): boolean {
  return mesure !== null;
}

/** Base de l'hôte ouverte au démarrage (`baseHote()`) ; absente (init_db en échec) : erreur, route en 500 et WebSocket nommée en 1011 comme une base injoignable en Python. */
export function baseDuTerminal(): Promise<Base> {
  const b = baseHote();
  return b === null
    ? Promise.reject(new Error("base de l'hôte indisponible (init_db en échec)"))
    : Promise.resolve(b);
}

/** Port de la jauge de quota (routes de fichiers, B2-03b) ; absent, la sonde ne mesure rien (échec de lecture = shell laissé ouvert, comme le Python). */
export function installerUsageTerminal(f: MesureUsage | null): void {
  mesure = f;
}

/** Occupation du bac ; lève si la mesure n'est pas branchée ou échoue (l'appelant laisse alors le shell ouvert). */
export async function usageBac(uid: number, racine: string, quotaOctets: number): Promise<number> {
  if (mesure === null) throw new Error("mesure d'occupation non branchée");
  return mesure(uid, racine, quotaOctets);
}

/** `get_user_settings` sur la base de l'hôte : `{}` sans ligne, colonne vide ou illisible. */
async function reglagesDuCompte(base: Base, uid: number): Promise<Dict> {
  const r = await base.get<{ settings_json: unknown }>("SELECT settings_json FROM users WHERE id=?", [uid]);
  const brut = r?.settings_json;
  if (typeof brut !== "string" || !brut) return {};
  try {
    const v = pyJsonLoads(brut);
    return estDict(v) ? v : {};
  } catch {
    return {};
  }
}

/** Plafond en octets : réglage du compte, sinon `app.sandbox_quota_mb` de config.json, sinon 5 120 Mio ; toute erreur : 5 120 Mio. */
export async function quotaOctets(base: () => Promise<Base>, uid: number): Promise<number> {
  try {
    const qs = await reglagesDuCompte(await base(), uid);
    const defaut = getPy(getPy(configView(), "app", {}), "sandbox_quota_mb", QUOTA_DEFAUT_MO);
    return intPy(getPy(qs, "sandbox_quota_mb", defaut)) * MIO;
  } catch {
    return QUOTA_DEFAUT_MO * MIO;
  }
}
