// SPDX-License-Identifier: MIT
/** packages/contracts/src/erreurs.ts — formes des réponses d'erreur HTTP (`{"detail"}` de FastAPI, 422 de Pydantic). */
import { z } from "zod";

export const schemaEmplacement = z.enum(["body", "query", "path", "header", "cookie"]);
export type Emplacement = z.infer<typeof schemaEmplacement>;

/** Toute réponse d'erreur : `detail`, plus parfois d'autres champs (`paths`, `conflicts`, `errors`…). */
export const schemaErreurApi = z.looseObject({ detail: z.unknown() });
export type ErreurApi = z.infer<typeof schemaErreurApi>;

export const schemaErreurPydantic = z.strictObject({
  type: z.string(),
  loc: z.array(z.union([z.string(), z.number().int()])),
  msg: z.string(),
  input: z.unknown(),
  ctx: z.record(z.string(), z.unknown()).optional(),
});
export type ErreurPydantic = z.infer<typeof schemaErreurPydantic>;

/** 422 de validation Pydantic ; un `HTTPException(422, "texte")` reste une simple ErreurApi. */
export const schemaErreur422 = z.strictObject({ detail: z.array(schemaErreurPydantic) });
export type Erreur422 = z.infer<typeof schemaErreur422>;
