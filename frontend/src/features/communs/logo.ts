// SPDX-License-Identifier: MIT
/** frontend/src/features/communs/logo.ts — logo de l'application, avatar de l'assistant partout : celui que l'administrateur a chargé, sinon celui d'Elpis. */

export const LOGO_ELPIS = "static/elpis-256.png";

const ADRESSE_LOGO = /^\/api\/app-logo\?v=[0-9a-f]{16}$/;

/** Adresse lue dans `/api/public-config` (`app_logo_url`) : toute autre forme donne le logo d'Elpis. */
export function adresseLogo(brut: unknown): string {
  return typeof brut === "string" && ADRESSE_LOGO.test(brut) ? brut : LOGO_ELPIS;
}
