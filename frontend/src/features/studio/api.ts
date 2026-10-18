// SPDX-License-Identifier: MIT
/** frontend/src/features/studio/api.ts — réponses `/api/desktop/*` du Studio : JSON de succès validé par les schémas C2, corps d'erreur rendu tel quel. */
import {
  schemaReponseActionBureau,
  schemaReponseCaptureBureau,
  schemaReponseCibleActive,
  schemaReponseCiblesBureau,
  schemaReponseChoixEcran,
  schemaReponseEcransBureau,
  schemaReponseEtatExecutionBureau,
  schemaReponseExecutionBureau,
  schemaReponseLancementBureau,
  schemaReponseLectureBureau,
  schemaReponseMatriceBureau,
} from "@elpis/contracts";

const SCHEMAS = {
  cibles: schemaReponseCiblesBureau,
  cibleActive: schemaReponseCibleActive,
  capture: schemaReponseCaptureBureau,
  ecrans: schemaReponseEcransBureau,
  choixEcran: schemaReponseChoixEcran,
  lecture: schemaReponseLectureBureau,
  action: schemaReponseActionBureau,
  lancement: schemaReponseLancementBureau,
  execution: schemaReponseExecutionBureau,
  etat: schemaReponseEtatExecutionBureau,
  matrice: schemaReponseMatriceBureau,
} as const;

export type CleBureau = keyof typeof SCHEMAS;
/** Corps JSON d'une réponse (`{}` sans réponse) ; un succès hors contrat devient un échec `reponse_invalide`. */
export type LecteurBureau = (r: Response | null, cle: CleBureau) => Promise<Record<string, unknown>>;

export const lireJsonBureau: LecteurBureau = async (r, cle) => {
  if (!r) return {};
  const brut = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (r.ok && !SCHEMAS[cle].safeParse(brut).success)
    return { ok: false, error: "reponse_invalide", message: "Réponse du serveur invalide" };
  return brut;
};
