// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/ax.ts — mémoire AX des sites (`/api/ax/*`) : sites appris, arbres, purges. */
import { z } from "zod";

import { entier } from "./commun";

export const schemaSiteAx = z.object({
  site: z.string(),
  elements: entier,
  regions: entier,
  paths: entier,
  transitions: entier,
  last_activity: z.number().nullable(),
});
export const schemaReponseSitesAx = z.object({ sites: z.array(schemaSiteAx), count: entier });

export const schemaReponseStatsSiteAx = z.object({
  site: z.string(),
  elements_ok: entier,
  elements_stale: entier,
  regions: entier,
  paths: entier,
  transitions: entier,
  selectors: entier,
  first_activity: z.number().nullable(),
  last_activity: z.number().nullable(),
});

/** Nœud de l'arbre : sélecteurs et enfants récursifs, détaillés au besoin par l'appelant. */
export const schemaNoeudAx = z.object({
  id: entier,
  role: z.string(),
  name: z.string(),
  node_type: z.string(),
  region_tag: z.string().nullable(),
  verified_count: entier,
  stale: z.boolean(),
  selectors: z.array(
    z.object({ strategy: z.string(), value: z.string(), success_count: entier, failure_count: entier }),
  ),
  children: z.array(z.unknown()),
});
export const schemaReponseArbreAx = z.object({
  site: z.string(),
  paths: z.array(z.object({ path: z.string(), roots: z.array(schemaNoeudAx) })),
});
export const schemaReponseArbreAsciiAx = z.object({ site: z.string(), ascii: z.string() });

export const schemaSuppressionsAx = z.object({
  nodes: entier,
  selectors: entier,
  transitions: entier,
});
export const schemaReponseSuppressionSiteAx = z.object({ deleted: schemaSuppressionsAx });
export const schemaReponseSuppressionLotAx = z.object({
  deleted: schemaSuppressionsAx.extend({ sites_processed: entier }),
});
export const schemaReponsePerimeAx = z.object({ marked: entier });
export const schemaReponsePerimeLotAx = z.object({ marked: entier, sites_processed: entier });
export const schemaCorpsLotAx = z.object({ sites: z.array(z.string()) });
