// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/admin-sauvegarde.ts — console : restauration, sauvegarde distante (configuration, clé, mot de passe, test, envoi) ; le téléchargement de l'archive n'est pas du JSON. */
import { z } from "zod";

import { dictionnaire, entier, horodatage } from "./commun";

export const schemaPorteeSauvegarde = z.string();

export const schemaDernierEnvoi = z.object({
  at: horodatage,
  ok: z.boolean().nullable(),
  ok_at: horodatage,
  trigger: z.string(),
  filename: z.string(),
  error: z.string(),
});
export const schemaConfigSauvegardeDistante = z.object({
  enabled: z.boolean(),
  connector: z.string(),
  scope: z.string(),
  host: z.string(),
  port: entier,
  user: z.string(),
  remote_path: z.string(),
  dest_path: z.string(),
  strict_host_key_checking: z.boolean(),
  schedule_enabled: z.boolean(),
  schedule_every: entier,
  schedule_unit: z.string(),
  key_path: z.string(),
  known_hosts: z.string(),
  timeout_sec: entier,
  last_send: schemaDernierEnvoi,
  key_present: z.boolean(),
  password_present: z.boolean(),
});
/** La lecture ajoute la date du prochain envoi planifié ; l'enregistrement ne la renvoie pas. */
export const schemaReponseSauvegardeDistante = schemaConfigSauvegardeDistante.extend({
  next_run_at: horodatage.nullable(),
});
export const schemaCorpsSauvegardeDistante = schemaConfigSauvegardeDistante
  .omit({ key_path: true, known_hosts: true, last_send: true, key_present: true, password_present: true })
  .partial();
export const schemaReponseEnregistrementSauvegarde = z.object({
  ok: z.literal(true),
  config: schemaConfigSauvegardeDistante,
});

export const schemaCorpsCleSauvegarde = z.object({ key: z.string() });
export const schemaReponseCleSauvegarde = z.object({ ok: z.literal(true), fingerprint: z.unknown() });
export const schemaCorpsMotDePasseSauvegarde = z.object({ password: z.string() });
export const schemaReponseMotDePasseSauvegarde = z.object({
  ok: z.literal(true),
  password_present: z.boolean(),
});

/** Test ou envoi : toujours un 200, `ok` faux avec `error` si la configuration ou le transfert échoue. */
export const schemaReponseEssaiSauvegarde = z.looseObject({ ok: z.boolean(), error: z.string().optional() });
export const schemaCorpsEnvoiSauvegarde = z.object({ scope: schemaPorteeSauvegarde.optional() });

export const schemaReponseRestauration = z.object({
  ok: z.literal(true),
  scope: z.string(),
  restored: entier,
  errors: z.array(z.unknown()),
  restart_required: z.boolean(),
});
export const schemaDonneesRestauration = dictionnaire;
