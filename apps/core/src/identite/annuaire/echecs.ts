// SPDX-License-Identifier: MIT
/** apps/core/src/identite/annuaire/echecs.ts — compteur d'essais de liaison par entrée d'annuaire (fournisseur, clé stable), seau à fuite continue en base : commun aux deux processus et à toutes les adresses. */
import { createHash } from "node:crypto";

import type { Base } from "@elpis/db";

import type { FournisseurLdap } from "../reglages";
import { dnNormalise } from "./dn";

const TOLERANCE = 1e-9;

/** Compte l'essai dans un seau qui se vide en continu (`niveau = max(0, niveau − Δt × max / fenêtre)`, niveau gardé dans `window_start`, plafonné à `max`) ; vrai, sans rien ajouter, si l'essai porterait le niveau au-delà de `max` : l'annuaire n'est alors pas contacté, et le blocage cesse au plus tard après `fenêtre / max`. */
export async function compterEssai(
  base: Base,
  f: FournisseurLdap,
  sujet: string,
  maintenant: number,
): Promise<boolean> {
  return base.ecriture(async (x) => {
    const l = await x.get<{ window_start: number; last_at: number }>(
      "SELECT window_start, last_at FROM auth_failures WHERE provider_id=? AND subject=?",
      [f.id, sujet],
    );
    const debit = f.max_failures / f.failure_window_sec;
    const avant =
      l === undefined
        ? 0
        : Math.max(0, Number(l.window_start) - Math.max(0, maintenant - Number(l.last_at)) * debit);
    const refuse = avant + 1 > f.max_failures + TOLERANCE;
    const apres = refuse ? Math.min(avant, f.max_failures) : avant + 1;
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
    return refuse;
  });
}

/** Compteur de l'entrée remis à zéro (liaison réussie). */
export async function oublierEssais(base: Base, f: FournisseurLdap, sujet: string): Promise<void> {
  await base.run("DELETE FROM auth_failures WHERE provider_id=? AND subject=?", [f.id, sujet]);
}

/** Échecs de liaison du compte de service pendant un test : au plus 5 par DN visé et par fenêtre de 15 minutes. */
export const TEST_ECHECS_MAX = 5;
export const TEST_FENETRE_S = 900;
const CLE_TEST = "_test_bind";

const sujetDeTest = (dn: string): string =>
  createHash("sha256").update(dnNormalise(dn), "utf8").digest("hex").slice(0, 40);

/** Vrai si ce DN a déjà échoué 5 fois dans la fenêtre de 15 minutes en cours (`count` et `window_start` de la ligne) : le test est refusé sans contacter l'annuaire. */
export async function liaisonDeTestRefusee(base: Base, dn: string, maintenant: number): Promise<boolean> {
  const l = await base.get<{ count: number; window_start: number }>(
    "SELECT count, window_start FROM auth_failures WHERE provider_id=? AND subject=?",
    [CLE_TEST, sujetDeTest(dn)],
  );
  return (
    l !== undefined &&
    Number(l.count) >= TEST_ECHECS_MAX &&
    maintenant - Number(l.window_start) < TEST_FENETRE_S
  );
}

/** Compte un échec de liaison du compte de service pendant un test, pour ce DN ; une fenêtre échue repart à un. */
export async function noterEchecLiaisonDeTest(base: Base, dn: string, maintenant: number): Promise<void> {
  const sujet = sujetDeTest(dn);
  await base.ecriture(async (x) => {
    const l = await x.get<{ count: number; window_start: number }>(
      "SELECT count, window_start FROM auth_failures WHERE provider_id=? AND subject=?",
      [CLE_TEST, sujet],
    );
    if (l === undefined)
      await x.run(
        "INSERT INTO auth_failures(provider_id, subject, count, window_start, last_at) VALUES(?,?,?,?,?)",
        [CLE_TEST, sujet, 1, maintenant, maintenant],
      );
    else if (maintenant - Number(l.window_start) >= TEST_FENETRE_S)
      await x.run(
        "UPDATE auth_failures SET count=1, window_start=?, last_at=? WHERE provider_id=? AND subject=?",
        [maintenant, maintenant, CLE_TEST, sujet],
      );
    else
      await x.run("UPDATE auth_failures SET count=count+1, last_at=? WHERE provider_id=? AND subject=?", [
        maintenant,
        CLE_TEST,
        sujet,
      ]);
  });
}

/** Compteur de ce DN remis à zéro (liaison de test réussie). */
export async function oublierEchecsLiaisonDeTest(base: Base, dn: string): Promise<void> {
  await base.run("DELETE FROM auth_failures WHERE provider_id=? AND subject=?", [CLE_TEST, sujetDeTest(dn)]);
}
