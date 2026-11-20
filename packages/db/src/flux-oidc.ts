// SPDX-License-Identifier: MIT
/** packages/db/src/flux-oidc.ts — migration 0036_flux_oidc : flux de connexion SSO, sessions du fournisseur et résultat de l'essai à blanc, posés par le schéma. */
import type { Migration } from "./migration";

/** 0036 : rien à convertir, les tables et leurs index sont créés avec le schéma. */
export const MIGRATION_FLUX_OIDC: Migration = {
  name: "0036_flux_oidc",
  tables: [],
  async migrer() {},
};
