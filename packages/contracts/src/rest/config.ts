// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/config.ts — configuration du compte (`/api/config`, secrets masqués) et configuration publique de l'instance. */
import { z } from "zod";

import { dictionnaire, entier } from "./commun";

export const schemaReponseConfigCompte = z.object({
  mode: z.literal("user"),
  editable: z.literal(true),
  logged_in: z.literal(true),
  session_user_id: entier,
  db_user_found: z.literal(true),
  username: z.string(),
  session_keys: z.array(z.string()),
  config: dictionnaire,
});
export type ReponseConfigCompte = z.infer<typeof schemaReponseConfigCompte>;

export const schemaCorpsConfigCompte = z.object({ config: dictionnaire });
export const schemaReponseEcritureConfig = z.object({ ok: z.literal(true), path: z.string() });

/** Blocs libres venus de `config.json` (`welcome`, `app_info`, `login_page`) : les clés listées sont celles du défaut. */
export const schemaAccueilPublic = z.looseObject({
  type: z.string(),
  icon: z.string(),
  size: z.number(),
  width: z.number(),
  height: z.number(),
  image_b64: z.string(),
});
export const schemaInfosApplication = z.looseObject({
  name: z.string(),
  version: z.string(),
  team_name: z.string(),
  engine: z.string(),
  description: z.string(),
  icon_type: z.string(),
  icon: z.string(),
  icon_color: z.string(),
  icon_bg: z.string(),
  logo_b64: z.string(),
});
export const schemaPageConnexion = z.looseObject({
  title: z.string(),
  subtitle: z.string(),
  icon_type: z.string(),
  icon: z.string(),
  icon_color: z.string(),
  icon_bg: z.string(),
  logo_b64: z.string(),
  bg_color: z.string(),
  card_color: z.string(),
  text_color: z.string(),
  btn_color: z.string(),
});
export const schemaReponseConfigPublique = z.object({
  welcome: schemaAccueilPublic,
  app_info: schemaInfosApplication,
  /** Logo de l'application et avatar de l'assistant : `/api/app-logo?v=<empreinte>` si l'administrateur en a chargé un, sinon celui d'Elpis. */
  app_logo_url: z.string(),
  login_page: schemaPageConnexion,
  admin_url: z.string(),
  main_url: z.string(),
  app_mode: z.enum(["main", "admin"]),
  features: z.object({
    opencode: z.boolean(),
    agents: z.boolean(),
    office_preview: z.boolean(),
    voice_stt: z.boolean(),
    voice_tts: z.boolean(),
  }),
});
export type ReponseConfigPublique = z.infer<typeof schemaReponseConfigPublique>;
