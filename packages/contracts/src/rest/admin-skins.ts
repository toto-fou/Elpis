// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/admin-skins.ts — console : skins (activation, défaut, éditeur, import zip, détail) ; l'export zip n'est pas du JSON. */
import { z } from "zod";

import { schemaSkin } from "./apparence";
import { dictionnaire } from "./commun";

export const schemaSkinConsole = schemaSkin.extend({
  enabled: z.boolean(),
  source: z.enum(["builtin", "plugin"]),
  is_default: z.boolean(),
  locked: z.boolean(),
  enabled_by_default: z.boolean(),
  version: z.string(),
  author: z.string(),
  license: z.string(),
});
export type SkinConsole = z.infer<typeof schemaSkinConsole>;

export const schemaReponseSkinsConsole = z.object({ skins: z.array(schemaSkinConsole), default: z.string() });
export type ReponseSkinsConsole = z.infer<typeof schemaReponseSkinsConsole>;
/** Réponse d'une écriture : la liste complète est rendue avec le skin touché. */
export const schemaReponseSkinEcrit = schemaReponseSkinsConsole.extend({
  ok: z.literal(true),
  skin: schemaSkinConsole,
});
export const schemaReponseSkinSupprime = schemaReponseSkinsConsole.extend({ ok: z.literal(true) });

/** `enabled` : objet `{id: booléen}` ; un champ absent reste inchangé. */
export const schemaCorpsEtatSkins = z.object({
  enabled: z.record(z.string(), z.boolean()).optional(),
  default: z.string().optional(),
});

export const schemaJetonsSkin = z.object({
  light: z.record(z.string(), z.string()),
  dark: z.record(z.string(), z.string()).optional(),
});
/** `update` vrai modifie un skin existant ; `css` vide supprime la feuille de style. */
export const schemaCorpsSkinEditeur = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  version: z.string().optional(),
  author: z.string().optional(),
  license: z.string().optional(),
  darkBase: z.boolean().optional(),
  swatch: z.array(z.string()),
  tokens: schemaJetonsSkin,
  brand: dictionnaire.optional(),
  css: z.string().optional(),
  update: z.boolean().optional(),
});
export const schemaDetailSkin = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string(),
  version: z.string(),
  author: z.string(),
  license: z.string(),
  darkBase: z.boolean(),
  swatch: z.array(z.string()),
  tokens: schemaJetonsSkin,
  brand: dictionnaire,
  css: z.string(),
  assets: z.array(z.string()),
});
export type DetailSkin = z.infer<typeof schemaDetailSkin>;
