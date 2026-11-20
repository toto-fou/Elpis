// SPDX-License-Identifier: MIT
/** packages/db/src/connexion-entreprise.ts — migration 0032_connexion_entreprise : colonnes et tables de la connexion d'entreprise posées par le schéma, ancien index des révocations retiré. */
import type { Executeur } from "./base";
import type { Migration } from "./migration";

/** 0032 : rien à convertir (colonnes, tables et index sont créés avec le schéma) ; l'index sur `revoked_at`, plus lu par la purge, est retiré. */
export const MIGRATION_CONNEXION_ENTREPRISE: Migration = {
  name: "0032_connexion_entreprise",
  tables: [],
  async migrer(x: Executeur) {
    await x.run("DROP INDEX IF EXISTS idx_revoked_sessions_at");
  },
};
