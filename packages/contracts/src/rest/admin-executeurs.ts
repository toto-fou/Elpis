// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/admin-executeurs.ts — console : exécuteurs (bacs Docker par compte), conteneurs, hôtes d'outils et placements. */
import { z } from "zod";

import { schemaProfilReseau } from "./admin-comptes";
import { dictionnaire, entier, horodatage } from "./commun";

/** Section `jobs` (tâches de fond `shell_job`) : neuf entiers bornés ; défauts servis si config.json n'en a pas. */
export const schemaReglagesJobs = z.object({
  max_per_chat: entier,
  max_per_user: entier,
  max_depth: entier,
  wakes_per_hour: entier,
  max_runtime_h: entier,
  event_max_bytes: entier,
  wake_max_bytes: entier,
  wake_concurrency: entier,
  retention_days: entier,
});
export type ReglagesJobs = z.infer<typeof schemaReglagesJobs>;
export const DEFAUTS_REGLAGES_JOBS: ReglagesJobs = {
  max_per_chat: 3,
  max_per_user: 5,
  max_depth: 5,
  wakes_per_hour: 12,
  max_runtime_h: 24,
  event_max_bytes: 3072,
  wake_max_bytes: 8192,
  wake_concurrency: 1,
  retention_days: 7,
};

/** Section `disk` (harnais N-08) : seuils d'alerte et de refus en pourcentage du quota du compte et du volume de /work. */
export const schemaSeuilsDisque = z.object({ warn_pct: entier, refuse_pct: entier });
export type SeuilsDisque = z.infer<typeof schemaSeuilsDisque>;
export const DEFAUTS_SEUILS_DISQUE: SeuilsDisque = { warn_pct: 85, refuse_pct: 97 };

export const schemaConfigExecuteurs = z.object({
  limits: dictionnaire,
  force_user_docker: z.boolean(),
  idle_kill_hours: entier,
  network_profiles: z.array(schemaProfilReseau),
  exec_user: z.string(),
  runtime: z.string(),
  extra_run_args: z.array(z.string()),
  jobs: schemaReglagesJobs.optional(),
  disk: schemaSeuilsDisque.optional(),
});
export type ConfigExecuteurs = z.infer<typeof schemaConfigExecuteurs>;
export const schemaReponseExecuteurs = z.object({ config: schemaConfigExecuteurs, image: z.string() });
export const schemaCorpsExecuteurs = z.object({ executors: dictionnaire });
/** `stale_containers` : conteneurs dont le profil réseau enregistré ne correspond plus au profil du compte. */
export const schemaReponseExecuteursEcrits = z.object({
  ok: z.literal(true),
  config: dictionnaire,
  warnings: z.array(z.string()),
  stale_containers: z.array(z.unknown()),
});

/** Daemon injoignable : `error` et `hint` ; sinon version, image et état de son chargement. */
export const schemaReponseSanteDocker = z.union([
  z.object({ daemon_ok: z.literal(false), error: z.string(), hint: z.string() }),
  z.object({
    daemon_ok: z.literal(true),
    server_version: z.unknown(),
    image: z.string(),
    image_loaded: z.boolean(),
    archive_available: z.boolean(),
    archive_path: z.string().nullable(),
    image_load_state: z.looseObject({ status: z.string() }),
  }),
]);

export const schemaConteneurBac = z.object({
  id: z.string(),
  name: z.string(),
  image: z.string(),
  state: z.string(),
  status: z.string(),
  created: z.string(),
  user_id: entier.nullable(),
  username: z.string().nullable(),
});
export const schemaReponseConteneurs = z.object({ containers: z.array(schemaConteneurBac), count: entier });
export const schemaReponseNettoyageBacs = z.object({ ok: z.literal(true), stopped: z.array(z.unknown()) });

export const schemaHoteOutils = z.object({
  id: z.string(),
  url: z.string(),
  has_token: z.boolean(),
  relay: z.unknown(),
  reachable: z.boolean().nullable(),
  health: z.looseObject({ families: z.array(z.string()).optional() }).nullable(),
  error: z.string().optional(),
  accounts: entier,
});
export const schemaPlacement = z.object({
  user_id: entier,
  host_id: z.string(),
  created_at: horodatage,
  updated_at: horodatage,
  username: z.string(),
});
export const schemaReponseHotesOutils = z.object({
  ok: z.literal(true),
  hosts: z.array(schemaHoteOutils),
  placement: dictionnaire,
  placements: z.array(schemaPlacement),
});
export type ReponseHotesOutils = z.infer<typeof schemaReponseHotesOutils>;
export const schemaCorpsPlacement = z.object({ host_id: z.string() });
export const schemaReponsePlacement = z.object({ ok: z.literal(true), user_id: entier, host_id: z.string() });
/** Bilan de la migration du bac vers l'hôte cible (champs libres). */
export const schemaReponseMigrationPlacement = z.looseObject({ ok: z.literal(true) });
