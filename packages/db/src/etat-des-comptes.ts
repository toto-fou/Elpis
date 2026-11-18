// SPDX-License-Identifier: MIT
/** packages/db/src/etat-des-comptes.ts — migration 0032_etat_des_comptes : colonnes d'état de `users` (suspension, dernière connexion) ajoutées par le schéma, valeurs nulles des lignes existantes ramenées à « actif ». */
import type { Executeur } from "./base";
import type { Migration } from "./migration";

/** 0032 : les colonnes sont posées avec le schéma ; les lignes d'avant restent actives et sans connexion connue. */
export const MIGRATION_ETAT_DES_COMPTES: Migration = {
  name: "0032_etat_des_comptes",
  tables: [],
  async migrer(x: Executeur) {
    await x.run("UPDATE users SET suspended_at = 0 WHERE suspended_at IS NULL");
    await x.run("UPDATE users SET last_login_at = 0 WHERE last_login_at IS NULL");
  },
};
