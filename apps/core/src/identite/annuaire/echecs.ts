// SPDX-License-Identifier: MIT
/** apps/core/src/identite/annuaire/echecs.ts — compteur d'essais de liaison par entrée d'annuaire (fournisseur, clé stable), seau à fuite continue en base : commun aux deux processus et à toutes les adresses. */
import type { Base } from "@elpis/db";

import type { FournisseurLdap } from "../reglages";

const TOLERANCE = 1e-9;

/** Compte l'essai dans un seau qui se vide en continu (`niveau = max(0, niveau − Δt × max / fenêtre) + 1`, niveau gardé dans `window_start`) ; vrai si `niveau > max` : l'annuaire n'est alors pas contacté. */
export async function compterEssai(
  base: Base,
  f: FournisseurLdap,
  sujet: string,
  maintenant: number,
): Promise<boolean> {
  const niveau = await base.ecriture(async (x) => {
    const l = await x.get<{ window_start: number; last_at: number }>(
      "SELECT window_start, last_at FROM auth_failures WHERE provider_id=? AND subject=?",
      [f.id, sujet],
    );
    const debit = f.max_failures / f.failure_window_sec;
    const avant =
      l === undefined
        ? 0
        : Math.max(0, Number(l.window_start) - Math.max(0, maintenant - Number(l.last_at)) * debit);
    const apres = Math.min(avant + 1, f.max_failures + 1);
    const compte = Math.ceil(apres - TOLERANCE);
    if (l === undefined)
      await x.run(
        "INSERT INTO auth_failures(provider_id, subject, count, window_start, last_at) VALUES(?,?,?,?,?)",
        [f.id, sujet, compte, apres, maintenant],
      );
    else
      await x.run(
        "UPDATE auth_failures SET count=?, window_start=?, last_at=? WHERE provider_id=? AND subject=?",
        [compte, apres, maintenant, f.id, sujet],
      );
    return apres;
  });
  return niveau > f.max_failures + TOLERANCE;
}

/** Compteur de l'entrée remis à zéro (liaison réussie). */
export async function oublierEssais(base: Base, f: FournisseurLdap, sujet: string): Promise<void> {
  await base.run("DELETE FROM auth_failures WHERE provider_id=? AND subject=?", [f.id, sujet]);
}
