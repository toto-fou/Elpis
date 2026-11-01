// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/jobs.ts — tâches de fond (`shell_job`, sous-agents en fond) : liste et arrêt, file de réveil du compte, interrupteur « Ne pas me réveiller », résumé d'un réveil. */
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

/** État d'un sous-agent lancé en fond (`kind: "agent"`), tenu par le core : progression, consommation, issue. */
export const schemaAgentFond = z.object({
  child_id: z.string(),
  agent: z.string(),
  call_id: z.string().optional(),
  label: z.string().optional(),
  /** `running`, puis l'état du run (`completed`, `failed`, `incomplete`, `cancelled`, `timeout`) ou `lost` (redémarrage). */
  state: z.string(),
  /** Statut du bloc du harnais une fois fini. */
  status: z.string().optional(),
  step: entier.optional(),
  max_steps: entier.optional(),
  tool_calls: entier.optional(),
  last_tool: z.string().optional(),
  last_text: z.string().optional(),
  input_tokens: entier.optional(),
  output_tokens: entier.optional(),
  cache_tokens: entier.optional(),
  think_tokens: entier.optional(),
  context_tokens: entier.optional(),
  /** Départ réel (s, epoch) : place obtenue au moteur ; absent tant qu'il attend. */
  started_at: z.number().optional(),
  /** Attente avant la place au moteur (s), depuis l'appel `task` ; posée au départ, puis à la fin. */
  queued_s: z.number().optional(),
  duration_s: z.number().optional(),
  /** Bloc du harnais (`<task_meta>`) une fois fini, relu par l'interface avec `schemaBilanTache`. */
  harness: z.record(z.string(), z.unknown()).optional(),
  /** Début du rapport (2 000 caractères au plus), secrets masqués. */
  result: z.string().optional(),
});
export type AgentFond = z.infer<typeof schemaAgentFond>;

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
  /** Sous-agent lancé en fond (`task(background=true)`) ; absent : commande de l'hôte d'outils. */
  kind: z.literal("agent").optional(),
  agent: schemaAgentFond.optional(),
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
