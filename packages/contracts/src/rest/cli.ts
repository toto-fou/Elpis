// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/cli.ts — installation de la CLI opencode (`/api/cli/*`) : familles MCP proposées et configuration générée ; installeurs et binaires sont du texte ou des fichiers hors contrat. */
import { z } from "zod";

import { dictionnaire } from "./commun";

export const schemaFamilleCli = z.object({
  name: z.string(),
  label: z.string(),
  server: z.string(),
  enabled: z.boolean(),
});
export const schemaReponseFamillesCli = z.object({ families: z.array(schemaFamilleCli) });
/** Configuration opencode : schéma et fournisseur propres à l'outil, section `mcp` ajoutée pour le compte identifié. */
export const schemaReponseConfigOpencode = dictionnaire;
