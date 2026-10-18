// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/jobs.ts — tâches de fond `shell_job` : liste et arrêt, file de réveil du compte, interrupteur « Ne pas me réveiller », résumé d'un réveil. */
import { z } from "zod";

import { entier, horodatage } from "./commun";

export const ETATS_JOB = ["starting", "running", "exited", "killed", "lost", "failed"] as const;
export const schemaEtatJob = z.enum(ETATS_JOB);
export type EtatJob = z.infer<typeof schemaEtatJob>;
/** États d'un job qui compte dans les limites (lancé ou en cours de lancement). */
export const ETATS_JOB_ACTIFS: readonly EtatJob[] = ["starting", "running"];

/** `killed` ne réveille jamais ; `max_runtime` : tué par le core au plafond de durée. */
export const DECLENCHEURS_JOB = [
  "exit",
  "match",
  "regex",
  "port",
  "file",
  "idle",
  "timeout",
  "lost",
  "killed",
  "max_runtime",
] as const;
export const schemaDeclencheurJob = z.enum(DECLENCHEURS_JOB);
export type DeclencheurJob = z.infer<typeof schemaDeclencheurJob>;

export const schemaResumeJob = z.object({
  id: z.string(),
  chat_id: z.string(),
  chat_title: z.string(),
  label: z.string(),
  command: z.string(),
  state: schemaEtatJob,
  wake_on: z.array(z.string()),
  wake: z.boolean(),
  pid: entier.nullable(),
  exit_code: entier.nullable(),
  signal: z.string().nullable(),
  created_at: horodatage,
  started_at: horodatage.nullable(),
  ended_at: horodatage.nullable(),
  last_line: z.string(),
  log: z.string(),
  /** Événements pas encore remis au modèle. */
  pending_events: entier,
});
export type ResumeJob = z.infer<typeof schemaResumeJob>;

/** Conversation qui attend son tour de réveil dans la file du compte (ordre d'arrivée). */
export const schemaReveilEnAttente = z.object({
  chat_id: z.string(),
  chat_title: z.string(),
  since: horodatage,
  events: entier,
});
export const schemaReveilEnCours = z.object({
  chat_id: z.string(),
  chat_title: z.string(),
  run_id: z.string(),
  started_at: horodatage,
});

/** `GET /api/jobs?chat_id=` (une conversation) ou `GET /api/jobs?scope=all` (tout le compte). */
export const schemaReponseJobs = z.object({
  jobs: z.array(schemaResumeJob),
  /** Jobs actifs de tout le compte (puce « Tâches de fond » dès le chargement). */
  active_total: entier.nonnegative(),
  max_per_chat: entier,
  max_per_user: entier,
  wake_queue: z.array(schemaReveilEnAttente),
  wake_running: z.array(schemaReveilEnCours),
  /** Valeur effective pour la conversation demandée (absente avec `scope=all`). */
  wake_disabled: z.boolean().optional(),
});
export type ReponseJobs = z.infer<typeof schemaReponseJobs>;

/** `POST /api/jobs/stop` : des jobs nommés, ceux d'une conversation, ou tous ceux du compte. */
export const schemaCorpsArretJobs = z.object({
  ids: z.array(z.string()).optional(),
  chat_id: z.string().optional(),
  all: z.boolean().optional(),
});
export const schemaReponseArretJobs = z.object({
  ok: z.literal(true),
  stopped: z.array(z.string()),
  not_found: z.array(z.string()),
});
export type ReponseArretJobs = z.infer<typeof schemaReponseArretJobs>;

/** `PUT /api/saved/chats/:chat_id/wake`. */
export const schemaCorpsReveilChat = z.object({ wake_disabled: z.boolean() });
export const schemaReponseReveilChat = z.object({ ok: z.literal(true), wake_disabled: z.boolean() });

export const schemaEvenementReveil = z.object({
  job_id: z.string(),
  label: z.string(),
  trigger: schemaDeclencheurJob,
  state: schemaEtatJob,
  exit_code: entier.nullable(),
  signal: z.string().nullable(),
  duration_s: z.number().nullable(),
});
export type EvenementReveil = z.infer<typeof schemaEvenementReveil>;

/** Réveil vu par l'interface (`run_started.wake`, champ `wake` du message `origin: "job_wake"`, `chat_wake`) ; `summary` en français. */
export const schemaResumeReveil = z.object({
  summary: z.string(),
  events: z.array(schemaEvenementReveil),
  depth: entier,
});
export type ResumeReveil = z.infer<typeof schemaResumeReveil>;

export const ORIGINES_TOUR = ["user", "job_wake"] as const;
export const schemaOrigineTour = z.enum(ORIGINES_TOUR);
