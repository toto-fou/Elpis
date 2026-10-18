// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/bac-instantanes.ts — bac du compte relayé par l'hôte d'outils : état et cycle de vie (`/api/sandbox/me`), instantanés (liste, flux NDJSON de création et de restauration), jeton d'aperçu servi par main. */
import { z } from "zod";

import { schemaProfilReseau } from "./admin-comptes";
import { dictionnaire, entier, horodatage } from "./commun";

export const schemaReponseJetonApercu = z.object({ token: z.string(), expires: entier });

/** État du chargement de l'image du bac (`elapsed_s` en cours, `duration_s` une fois fini). */
export const schemaEtatImageBac = z.object({
  status: z.string(),
  image: z.string().nullable(),
  archive_path: z.string().nullable(),
  progress_msg: z.string(),
  error: z.string().optional(),
  elapsed_s: horodatage.optional(),
  duration_s: horodatage.optional(),
});

/** Conteneur du compte : existant, en attente (image ou démarrage), ou en erreur. */
export const schemaConteneurBacMoi = z.object({
  exists: z.boolean().optional(),
  running: z.boolean().optional(),
  container_id: z.string().nullable().optional(),
  container_name: z.string().optional(),
  image: z.string().nullable().optional(),
  started_at: z.string().nullable().optional(),
  pending: z.string().optional(),
  error: z.string().optional(),
});

export const schemaReponseBacMoi = z.object({
  user_mode: z.literal("docker"),
  effective_mode: z.literal("docker"),
  force_admin: z.boolean(),
  image: z.string(),
  limits: z.object({
    memory_mb: entier,
    cpu_quota_pct: entier,
    pids_max: entier,
    timeout_s: entier,
  }),
  idle_kill_hours: z.number(),
  image_status: schemaEtatImageBac,
  network_profile_id: z.string(),
  network_profiles: z.array(schemaProfilReseau),
  network_profile_locked: z.boolean(),
  daemon_ok: z.boolean(),
  daemon_info: z.string(),
  container: schemaConteneurBacMoi,
  stats: dictionnaire.optional(),
});

export const schemaCorpsBacMoi = z.object({
  mode: z.string().optional(),
  network_profile_id: z.string().optional(),
});
export const schemaReponseChoixBac = z.object({
  ok: z.literal(true),
  mode: z.string(),
  network_profile_id: z.string(),
  bootstrap: z.object({
    image_status: schemaEtatImageBac.optional(),
    container: schemaConteneurBacMoi.extend({
      profile_id: z.string().optional(),
      logs: z.string().optional(),
    }),
  }),
});
export const schemaReponseRedemarrageBac = z.object({
  ok: z.literal(true),
  container: schemaConteneurBacMoi,
});

export const schemaInstantane = z.object({
  id: z.string(),
  name: z.string(),
  ts: entier,
  duration_sec: horodatage,
  file_count: entier,
  src_bytes: entier,
  archive_bytes: entier,
});
export type Instantane = z.infer<typeof schemaInstantane>;
export const schemaReponseInstantanes = z.object({
  items: z.array(schemaInstantane),
  max: entier,
  /** Marqueur d'une restauration interrompue ; `{}` si le marqueur est illisible. */
  last_restore_incomplete: z.object({ snap_id: z.string().optional(), ts: horodatage.optional() }).nullable(),
});
export const schemaCorpsCreerInstantane = z.object({ name: z.string().optional() });
export const schemaReponseSupprimerInstantane = z.object({ ok: z.literal(true), id: z.string() });

/** Événements NDJSON de création et de restauration d'un instantané (une ligne JSON chacun). */
export const schemaEvenementInstantane = z.discriminatedUnion("event", [
  z.object({ event: z.literal("preparing"), phase: z.enum(["snapshot", "restore"]) }),
  z.object({
    event: z.literal("start"),
    phase: z.enum(["snapshot", "restore"]),
    total_files: entier,
    total_bytes: entier,
  }),
  z.object({
    event: z.literal("progress"),
    phase: z.enum(["snapshot", "extract"]),
    files_done: entier.optional(),
    total_files: entier.optional(),
    bytes_done: entier.optional(),
    total_bytes: entier.optional(),
    pct: z.number(),
    current_file: z.string().optional(),
  }),
  z.object({ event: z.literal("phase"), phase: z.string() }),
  z.object({
    event: z.literal("done"),
    phase: z.enum(["snapshot", "restore"]),
    snapshot: schemaInstantane.extend({ pruned: entier.optional() }).optional(),
    files_restored: entier.optional(),
    bytes_restored: entier.optional(),
    conflicts: entier.optional(),
    conflict_paths: z.array(z.string()).optional(),
  }),
  z.object({ event: z.literal("error"), message: z.string() }),
]);
export type EvenementInstantane = z.infer<typeof schemaEvenementInstantane>;
