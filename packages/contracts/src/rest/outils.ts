// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/outils.ts — extraction de texte d'un fichier envoyé (`/api/tools/extract-text`). */
import { z } from "zod";

import { entier } from "./commun";

export const schemaReponseExtractionTexte = z.object({
  ok: z.literal(true),
  filename: z.string(),
  content: z.string(),
  size: entier,
});
