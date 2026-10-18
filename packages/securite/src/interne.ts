// SPDX-License-Identifier: MIT
/** packages/securite/src/interne.ts — jeton interne main ↔ admin, dérivé du secret de session partagé : le toolhost ne le connaît jamais. */
import { createHmac } from "node:crypto";

export const CONTEXTE_JETON_INTERNE = "elpis.interne.v1";

/** `HMAC-SHA256(secret, "elpis.interne.v1")` en hexadécimal ; un secret vide ne donne aucun jeton (refusé par la garde). */
export function jetonInterne(secret: string): string {
  if (secret === "") return "";
  return createHmac("sha256", Buffer.from(secret, "utf8"))
    .update(CONTEXTE_JETON_INTERNE, "utf8")
    .digest("hex");
}
