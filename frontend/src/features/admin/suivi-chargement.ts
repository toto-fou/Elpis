// SPDX-License-Identifier: MIT
/** frontend/src/features/admin/suivi-chargement.ts — état des chargeurs de la console : échec (et de quoi réessayer) ou date du dernier succès, pour dire « chargement impossible » au lieu de « vide ». */
import { reactive } from "vue";

export interface EchecChargement {
  readonly nom: string;
  readonly message: string;
  readonly reessayer: () => unknown;
}

const echecs = reactive<Record<string, EchecChargement | undefined>>({});
const succes = reactive<Record<string, number | undefined>>({});

export function chargementReussi(nom: string): void {
  delete echecs[nom];
  succes[nom] = Date.now();
}

export function chargementEchoue(nom: string, message: string, reessayer: () => unknown): void {
  echecs[nom] = { nom, message, reessayer };
}

/** Exécute un chargeur : vrai = succès, faux ou exception = échec (le message dit pourquoi, à défaut « Réponse inattendue »). */
export async function suivreChargement(
  nom: string,
  charger: () => Promise<boolean>,
  relancer: () => unknown,
): Promise<boolean> {
  try {
    if (await charger()) {
      chargementReussi(nom);
      return true;
    }
    chargementEchoue(nom, "Réponse du serveur inattendue ou en échec.", relancer);
  } catch (err) {
    chargementEchoue(nom, err instanceof Error && err.message ? err.message : "Erreur réseau.", relancer);
  }
  return false;
}

export interface ChargementPage {
  readonly echecs: readonly EchecChargement[];
  /** Date (ms) des données affichées : le plus ancien succès parmi les chargeurs en échec, ou `null` s'il n'y en a jamais eu. */
  readonly fraicheur: number | null;
}

/** Échecs des chargeurs d'une page et fraîcheur des données qu'elle montre encore. */
export function chargementDe(chargeurs: readonly string[]): ChargementPage {
  const enEchec = chargeurs.flatMap((nom) => {
    const e = echecs[nom];
    return e ? [e] : [];
  });
  const dates = enEchec.flatMap((e) => {
    const d = succes[e.nom];
    return d === undefined ? [] : [d];
  });
  return { echecs: enEchec, fraicheur: dates.length === enEchec.length ? Math.min(...dates) : null };
}

export function reinitialiserSuiviChargement(): void {
  for (const k of Object.keys(echecs)) delete echecs[k];
  for (const k of Object.keys(succes)) delete succes[k];
}
