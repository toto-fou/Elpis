// SPDX-License-Identifier: MIT
/** packages/db/src/rattachements-prepares.ts — migration 0036_rattachements_prepares : table des rattachements préparés d'un compte à une identité attendue, posée par le schéma. */
import type { Migration } from "./migration";

/** 0036 : rien à convertir, la table et ses index sont créés avec le schéma. */
export const MIGRATION_RATTACHEMENTS_PREPARES: Migration = {
  name: "0036_rattachements_prepares",
  tables: [],
  async migrer() {},
};
