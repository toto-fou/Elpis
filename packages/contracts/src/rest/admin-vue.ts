// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/admin-vue.ts — console : vue d'ensemble, état du redémarrage, journaux récents, terminaux. */
import { z } from "zod";

import { entier, horodatage } from "./commun";

export const schemaAlerteConsole = z.object({
  id: z.string(),
  level: z.enum(["info", "warn", "danger"]),
  title: z.string(),
  detail: z.string(),
  /** Absente de l'alerte « Redémarrage nécessaire », qui porte `paths` à la place. */
  page: z.string().optional(),
  /** Réglages en attente de redémarrage (alerte `restart`). */
  paths: z.array(z.string()).optional(),
  /** Vide pour un modérateur ; sinon `page`, `backup` ou `restart`. */
  action: z.string(),
});
export const schemaServiceConsole = z.object({
  id: z.string(),
  label: z.string(),
  target: z.string(),
  state: z.enum(["ok", "warn", "down", "off", "unknown"]),
  detail: z.string(),
  page: z.string(),
  /** Motif d'une panne (RAG injoignable). */
  hint: z.string().optional(),
  /** Service dont l'état est hérité du moteur local (compression). */
  inherited: z.boolean().optional(),
});
export const schemaEtapeInstallation = z.object({
  id: z.string(),
  label: z.string(),
  done: z.boolean(),
  page: z.string(),
});

export const schemaReponseVueEnsemble = z.object({
  generated_at: horodatage,
  alerts: z.array(schemaAlerteConsole),
  services: z.array(schemaServiceConsole),
  kpis: z.object({
    users: entier,
    turns: entier,
    tokens: entier,
    failures: entier,
    tool_calls: entier,
    tool_failures: entier,
  }),
  backup: z.object({ at: horodatage.nullable(), remote_enabled: z.boolean() }),
  setup: z.array(schemaEtapeInstallation),
  restart: z.object({ pending: z.array(z.string()) }),
  role: z.enum(["admin", "moderator"]),
});
export type ReponseVueEnsemble = z.infer<typeof schemaReponseVueEnsemble>;

/** `paths` : réglages qui exigent un redémarrage ; `pending` : ceux modifiés depuis le démarrage. */
export const schemaReponseEtatRedemarrage = z.object({
  paths: z.array(z.string()),
  pending: z.array(z.string()),
});

export const schemaLigneJournalRecent = z.object({ id: horodatage, message: z.string(), level: z.string() });
/** Événements du journal commun : champs libres (`ts`, `service`, `level`, `category`…). */
export const schemaReponseJournauxRecents = z.object({
  logs: z.array(schemaLigneJournalRecent),
  events: z.array(z.looseObject({})),
  filters_applied: z.object({
    limit: entier,
    services: z.array(z.string()).nullable(),
    levels: z.array(z.string()).nullable(),
    categories: z.array(z.string()).nullable(),
    since_ts: horodatage.nullable(),
  }),
  available_services: z.array(z.string()),
  available_levels: z.array(z.string()),
  available_categories: z.array(z.string()),
});

/** Le process admin n'héberge aucun terminal : `sessions` est toujours vide. */
export const schemaReponseTerminauxConsole = z.object({
  worker_pid: entier,
  count: entier,
  idle_timeout_sec: entier,
  max_sessions_per_user: entier,
  sessions: z.array(z.unknown()),
});
