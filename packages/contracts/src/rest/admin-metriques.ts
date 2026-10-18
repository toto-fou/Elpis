// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/admin-metriques.ts — console › Supervision : tableau de bord dynamique, jeton de collecte Prometheus, purge des métriques, rapport quotidien, observabilité des outils (`/api/admin/stats-dynamic`, `metrics/*`, `report/daily*`, `observability/*`). */
import { z } from "zod";

import { dictionnaire, entier, horodatage } from "./commun";

/** Entrée de la mise en page : `purge` décrit le périmètre qu'un bouton « réinitialiser » vide, `null` sans purge possible. */
export const schemaWidgetTableauBord = z.object({
  id: z.string(),
  title: z.string(),
  type: z.string(),
  width: z.string(),
  category: z.string(),
  default: z.boolean(),
  purge: z
    .looseObject({
      target: z.string().optional(),
      event_types: z.array(z.string()).optional(),
      destructive: z.boolean().optional(),
    })
    .nullable(),
});
export type WidgetTableauBord = z.infer<typeof schemaWidgetTableauBord>;

/** Données d'un widget : valeur et unité (indicateur), séries (graphique) ou lignes (tableau) ; `error` quand le calcul a échoué. */
export const schemaDonneesWidget = z.looseObject({
  error: z.unknown().optional(),
  state: z.string().nullable().optional(),
  value: z.unknown().optional(),
  unit: z.string().optional(),
  icon: z.string().optional(),
  detail: z.string().optional(),
  labels: z.array(z.unknown()).optional(),
  datasets: z
    .array(z.looseObject({ label: z.string().optional(), data: z.array(z.unknown()).optional() }))
    .optional(),
  columns: z.array(z.looseObject({ key: z.string(), label: z.string() })).optional(),
  rows: z.array(dictionnaire).optional(),
  meta: z.looseObject({ timezone: z.string().optional(), granularity: z.string().optional() }).optional(),
});
export type DonneesWidget = z.infer<typeof schemaDonneesWidget>;

/** Tableau complet (mise en page et données) ou, avec `ids`, les seules données demandées. */
export const schemaReponseStatsDynamique = z.union([
  z.object({ layout: z.array(schemaWidgetTableauBord), data: z.record(z.string(), schemaDonneesWidget) }),
  z.object({ data: z.record(z.string(), schemaDonneesWidget), partial: z.literal(true) }),
]);

export const schemaReponseJetonScrape = z.object({ configured: z.boolean(), token: z.string().nullable() });
/** `generate` (défaut) crée un jeton, `revoke` le retire. */
export const schemaCorpsJetonScrape = z.object({ action: z.enum(["generate", "revoke"]).optional() });

export const schemaCorpsPurgeMetriques = z.object({
  targets: z.array(z.string()),
  dry_run: z.boolean().optional(),
  from: z.number().nullable().optional(),
  to: z.number().nullable().optional(),
  event_types: z.array(z.string()).nullable().optional(),
  sources: z.array(z.string()).nullable().optional(),
});
/** `counted` : lignes concernées par cible ; `deleted` : lignes supprimées (vide en simulation). */
export const schemaReponsePurgeMetriques = z.object({
  dry_run: z.boolean(),
  counted: z.record(z.string(), entier),
  deleted: z.record(z.string(), entier),
});

// ── Rapport quotidien ───────────────────────────────────────────────────────
export const schemaRapportQuotidien = z.looseObject({
  date: z.string(),
  generated_at: horodatage,
  scope_hours: entier,
  sections: z.array(z.object({ id: z.string(), label: z.string(), widgets: z.array(z.string()) })),
  titles: z.record(z.string(), z.string()),
  widgets: z.record(z.string(), schemaDonneesWidget),
});
export type RapportQuotidien = z.infer<typeof schemaRapportQuotidien>;
export const schemaReponseHistoriqueRapports = z.object({
  reports: z.array(z.object({ date: z.string(), created_at: horodatage })),
});
export const schemaReponseGenerationRapport = z.object({ ok: z.literal(true), date: z.string() });
export const schemaReponseRapportAuto = z.object({ enabled: z.boolean() });
export const schemaCorpsRapportAuto = z.object({ enabled: z.boolean().optional() });
export const schemaReponseRapportAutoEcrit = z.object({ ok: z.literal(true), enabled: z.boolean() });

// ── Observabilité des outils ────────────────────────────────────────────────
export const schemaErreurOutil = z.object({
  ts: horodatage,
  run_id: z.string().nullable(),
  user_id: entier.nullable(),
  pipeline_id: z.string().nullable(),
  node_id: z.string().nullable(),
  member_id: z.string().nullable(),
  tool_name: z.string(),
  server_name: z.string().nullable(),
  status: z.string(),
  duration_ms: entier.nullable(),
  error_short: z.string().nullable(),
});
export const schemaReponseErreursOutils = z.object({
  items: z.array(schemaErreurOutil),
  total: entier,
  hours: entier,
});
export const schemaReponseSyntheseOutils = z.object({
  totals: z.object({
    n: entier,
    total_ms: entier.optional(),
    n_error: entier.optional(),
    n_blocked: entier.optional(),
    n_timeout: entier.optional(),
  }),
  per_tool: z.array(
    z.object({ tool_name: z.string(), n: entier, total_ms: entier, n_failed: entier, avg_ms: entier }),
  ),
  hours: entier,
});
export const schemaReponseAuditRecent = z.object({
  items: z.array(z.looseObject({ action: z.string() })),
  total: entier,
  hours: entier,
});
