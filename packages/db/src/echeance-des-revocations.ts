// SPDX-License-Identifier: MIT
/** packages/db/src/echeance-des-revocations.ts — migration 0034_echeance_des_revocations : colonne `expires_at` de `revoked_sessions` posée par le schéma, lignes d'avant ramenées à « échéance inconnue ». */
import type { Executeur } from "./base";
import type { Migration } from "./migration";

/** 0034 : la colonne est posée avec le schéma ; une révocation d'avant garde la purge par ancienneté (échéance 0). */
export const MIGRATION_ECHEANCE_DES_REVOCATIONS: Migration = {
  name: "0034_echeance_des_revocations",
  tables: [],
  async migrer(x: Executeur) {
    await x.run("UPDATE revoked_sessions SET expires_at = 0 WHERE expires_at IS NULL");
  },
};
