// SPDX-License-Identifier: MIT
/** apps/core/src/identite/annuaire/echecs.ts — compteur d'essais de liaison par entrée d'annuaire (fournisseur, clé stable), en base : commun aux deux processus et à toutes les adresses. */
import type { Base } from "@elpis/db";

import type { FournisseurLdap } from "../reglages";

/** Compte l'essai avant que la liaison parte (fenêtre ouverte au premier essai, jamais prolongée) ; vrai si le seuil est dépassé : l'annuaire n'est alors pas contacté. */
export async function compterEssai(
  base: Base,
  f: FournisseurLdap,
  sujet: string,
  maintenant: number,
): Promise<boolean> {
  const compte = await base.ecriture(async (x) => {
    const l = await x.get<{ count: number; window_start: number }>(
      "SELECT count, window_start FROM auth_failures WHERE provider_id=? AND subject=?",
      [f.id, sujet],
    );
    if (l === undefined) {
      await x.run(
        "INSERT INTO auth_failures(provider_id, subject, count, window_start, last_at) VALUES(?,?,?,?,?)",
        [f.id, sujet, 1, maintenant, maintenant],
      );
      return 1;
    }
    const neuve = maintenant - Number(l.window_start) > f.failure_window_sec;
    const compte = neuve ? 1 : Number(l.count) + 1;
    await x.run(
      "UPDATE auth_failures SET count=?, window_start=?, last_at=? WHERE provider_id=? AND subject=?",
      [compte, neuve ? maintenant : Number(l.window_start), maintenant, f.id, sujet],
    );
    return compte;
  });
  return compte > f.max_failures;
}

/** Compteur de l'entrée remis à zéro (liaison réussie). */
export async function oublierEssais(base: Base, f: FournisseurLdap, sujet: string): Promise<void> {
  await base.run("DELETE FROM auth_failures WHERE provider_id=? AND subject=?", [f.id, sujet]);
}
