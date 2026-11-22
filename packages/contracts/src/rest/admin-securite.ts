// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/admin-securite.ts — console : sessions (révocations), HTTPS et mode d'écoute. */
import { z } from "zod";

import { entier, horodatage } from "./commun";

export const schemaReponseSessionsConsole = z.object({
  session_cfg: z.object({
    max_age_sec: entier,
    idle_timeout_sec: entier,
    cookie_name: z.string(),
    same_site: z.string(),
    https_only: z.boolean(),
    global_min_ts: horodatage,
  }),
  revoked_user_count: entier,
  revoked_users: z.array(z.object({ user_id: entier, username: z.string(), session_min_ts: horodatage })),
});
export const schemaReponseRevocationGlobale = z.object({ ok: z.literal(true), global_min_ts: horodatage });
export const schemaReponseRevocationCompte = z.object({
  ok: z.literal(true),
  user_id: entier,
  session_min_ts: horodatage,
  username: z.string(),
});

const schemaPortsHttps = z.record(z.string(), z.unknown());
/** Comptes des services sous les unités systemd : séparés, compte unique choisi, compte unique de repli (racine non atteignable) ; absent : sans unités. */
export const MODES_COMPTES_SERVICES = ["separes", "unique", "repli"] as const;
export const schemaReponseEtatHttps = z.object({
  enabled: z.boolean(),
  ports: schemaPortsHttps,
  caddy: z.object({ main: z.boolean(), admin: z.boolean() }),
  current_scheme: z.enum(["http", "https"]),
  urls: z.record(z.string(), z.unknown()),
  listen: z.string(),
  client_local: z.boolean(),
  service_accounts: z.enum(MODES_COMPTES_SERVICES).optional(),
});
export type ReponseEtatHttps = z.infer<typeof schemaReponseEtatHttps>;
export const schemaCorpsHttps = z.object({ enabled: z.boolean() });
/** `main_restarted` faux : le redémarrage n'a pas pu être lancé depuis ce process. */
export const schemaReponseBasculeHttps = z.object({
  ok: z.boolean(),
  enabled: z.boolean(),
  urls: z.record(z.string(), z.unknown()),
  main_restarted: z.boolean(),
});
export const schemaCorpsEcoute = z.object({ listen: z.enum(["local", "lan"]) });
export const schemaReponseEcoute = z.object({
  ok: z.boolean(),
  listen: z.enum(["local", "lan"]),
  main_restarted: z.boolean(),
});
