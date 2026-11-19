// SPDX-License-Identifier: MIT
/** packages/db/src/echecs-annuaire.ts — migration 0035_echecs_annuaire : table des échecs de liaison par entrée d'annuaire, posée par le schéma. */
import type { Migration } from "./migration";

/** 0035 : rien à convertir, la table et son index sont créés avec le schéma. */
export const MIGRATION_ECHECS_ANNUAIRE: Migration = {
  name: "0035_echecs_annuaire",
  tables: [],
  async migrer() {},
};
