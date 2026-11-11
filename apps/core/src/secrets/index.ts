// SPDX-License-Identifier: MIT
/** apps/core/src/secrets/index.ts — API du coffre « Secrets » pour le reste du core (connecteurs, outils, commandes). */
export { ErreurSecret, refusDeCle } from "./erreurs";
export { aadSecret, hoteExact, normaliserPortee, origineExacte, validerNom } from "./portee";
export type { ColonnesLiees } from "./portee";
export {
  aadLigne,
  creerSecret,
  listerSecrets,
  modifierSecret,
  rotation,
  supprimerSecret,
  verifierSecret,
} from "./stockage";
export type { Acteur, DonneesSecret, ModifSecret, Proprietaire } from "./stockage";
export { estAttache, lireSecretPourUsage, permisPourContexte } from "./usage";
export type { ContexteUsage, DemandeUsage, SecretResolu } from "./usage";
export { rechiffrerCoffre, secretsParCle } from "./cle";
export type { RapportRechiffrement } from "./cle";
