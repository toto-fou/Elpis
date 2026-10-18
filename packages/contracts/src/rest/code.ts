// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/code.ts — page Code (`/api/code/*`) : santé, jetons, appairage, sessions opencode, commandes en file ; les données d'opencode restent opaques. */
import { z } from "zod";

import { dictionnaire, entier } from "./commun";

export const schemaReponseSanteCode = z.object({
  available: z.boolean(),
  connected: z.boolean(),
  sessions: entier,
  plugin_version: entier,
  plugin_current: entier,
});
export const schemaReponseConfigCode = z.object({
  app_url: z.string(),
  plugin_url: z.string(),
  tokens: entier,
});
export const schemaCorpsJetonCode = z.object({ name: z.string().optional() });
export const schemaReponseJetonCode = z.object({ token: z.string() });
export const schemaReponseBonjourCode = z.object({ ok: z.literal(true), user: z.string() });

export const schemaReponseAppairageCode = z.object({
  id: z.string(),
  code: z.string(),
  expires_in: z.number(),
  interval: z.number(),
});
export const schemaReponseSondeAppairageCode = z.object({
  status: z.enum(["pending", "expired", "ok"]),
  token: z.string().optional(),
});
export const schemaCorpsConfirmationAppairageCode = z.object({ code: z.string() });

export const schemaReponseSessionsCode = z.array(dictionnaire);
export const schemaReponseMessagesCode = z.array(dictionnaire);
export const schemaReponseCommandesCode = z.array(z.unknown());
export const schemaReponseModelesCode = z.object({ providers: z.array(z.unknown()), default: dictionnaire });
export const schemaReponseAgentsCode = z.object({ agents: z.array(z.unknown()), default: z.string() });
export const schemaClientCode = z.object({ id: z.string(), directory: z.unknown(), plugin_version: entier });
export const schemaReponseClientsCode = z.array(schemaClientCode);
export const schemaReponsePermissionsCode = z.array(dictionnaire);
export const schemaReponseQuestionsCode = z.array(dictionnaire);

/** Accusé d'une commande mise en file pour la CLI ; `client` s'ajoute pour `new`, `disconnect` et `exit`. */
export const schemaReponseCommandeCode = z.object({
  ok: z.literal(true),
  queued: z.literal(true),
  client: z.string().optional(),
});

export const schemaCorpsPromptCode = z.object({
  text: z.string(),
  model: z.object({ providerID: z.string(), modelID: z.string() }).optional(),
  agent: z.string().optional(),
});
export const schemaCorpsCommandeCode = z.object({ command: z.string(), arguments: z.string().optional() });
export const schemaCorpsActionCode = z.object({ action: z.string() });
export const schemaCorpsNouvelleSessionCode = z.object({ client: z.string().optional() });
export const schemaCorpsRenommerCode = z.object({ title: z.string() });
export const schemaCorpsPermissionCode = z.object({ response: z.enum(["once", "always", "reject"]) });
export const schemaCorpsReponseQuestionCode = z.object({
  answers: z.array(z.union([z.string(), z.array(z.string())])).optional(),
  reject: z.boolean().optional(),
});

/** Côté CLI (jeton) : envoi d'événements par lots. */
export const schemaCorpsIngestionCode = z.object({
  client: z.string(),
  directory: z.string().optional(),
  plugin: z.number().optional(),
  events: z.array(dictionnaire).optional(),
});
export const schemaReponseIngestionCode = z.object({ ok: z.literal(true), applied: entier });
export const schemaReponseTirageCode = z.object({
  commands: z.array(dictionnaire),
  epoch: z.number(),
  plugin_current: entier,
});
export const schemaCorpsAuRevoirCode = z.object({ client: z.string() });
