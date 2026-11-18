// SPDX-License-Identifier: MIT
/** packages/db/src/identites-externes.ts — migration 0033_identites_externes : tables des identités externes et de l'état des fournisseurs, posées par le schéma. */
import type { Migration } from "./migration";

/** 0033 : rien à convertir, les tables et leurs index sont créés avec le schéma. */
export const MIGRATION_IDENTITES_EXTERNES: Migration = {
  name: "0033_identites_externes",
  tables: [],
  async migrer() {},
};
