// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/bac-office.ts — aperçus Office du bac (`/api/sandbox/office/prepare`) : préparation d'un document, pages PDF ou grille xlsx par morceaux. */
import { z } from "zod";

import { entier, horodatage } from "./commun";

export const schemaCorpsPreparerApercu = z.object({
  path: z.string(),
  view: z.enum(["grid", "pages"]).nullable().optional(),
});

const schemaFeuilleGrille = z.object({
  name: z.string(),
  hidden: z.boolean(),
  rows: entier,
  cols: entier,
  chunks: entier,
  complete: z.boolean(),
  truncated: z.boolean(),
  widths: z.array(z.number()),
});
const schemaGrilleApercu = z.object({
  chunk: entier,
  sheets: z.array(schemaFeuilleGrille),
  truncated: z.boolean(),
});
const schemaPagesApercu = z.object({
  url: z.string(),
  count: entier.nullable(),
  truncated: z.boolean(),
  partial: z.boolean(),
});

/** Document préparé : la vue demandée est remplie (`pages` ou `grid`), l'autre reste nulle ; `has` dit celles déjà construites. */
export const schemaReponsePreparerApercu = z.object({
  kind: z.string(),
  key: z.string(),
  rel: z.string(),
  size: entier,
  mtime: horodatage,
  view: z.string(),
  pages: schemaPagesApercu.nullable(),
  grid: schemaGrilleApercu.nullable(),
  has: z.object({ pages: z.boolean(), grid: z.boolean() }),
});
