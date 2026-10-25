// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/apparence.ts — skins visibles par l'utilisateur (`/api/skins`) ; la forme de la console en dérive. */
import { z } from "zod";

import { dictionnaire } from "./commun";
import { schemaMascotteCatalogue } from "./reglages";

/** `css_url` n'existe que pour un skin de plugin ; `brand` et `mascot` seulement s'ils sont définis. */
export const schemaSkin = z.object({
  id: z.string(),
  label: z.string(),
  desc: z.string(),
  darkBase: z.boolean(),
  sw: z.array(z.string()),
  builtin: z.boolean(),
  brand: dictionnaire.optional(),
  mascot: z.unknown().optional(),
  css_url: z.string().optional(),
  /** Habillage personnel du compte (id `perso:<id>`). */
  perso: z.boolean().optional(),
});
export type Skin = z.infer<typeof schemaSkin>;

export const schemaReponseSkins = z.object({
  skins: z.array(schemaSkin),
  default: z.string(),
  mascottes: z.array(schemaMascotteCatalogue),
});
export type ReponseSkins = z.infer<typeof schemaReponseSkins>;

const schemaJetonsPerso = z.record(z.string(), z.string());

/** Corps de `POST /api/skins/perso` et `/verifier` : un `skin.json` de jetons seuls (`overwrite` ignoré par `/verifier`). */
export const schemaCorpsPerso = z.object({
  id: z.string(),
  label: z.string(),
  desc: z.string().optional(),
  darkBase: z.boolean().optional(),
  tokens: z.object({ light: schemaJetonsPerso.optional(), dark: schemaJetonsPerso.optional() }),
  swatch: z.array(z.string()).optional(),
  overwrite: z.boolean().optional(),
});
export type CorpsPerso = z.infer<typeof schemaCorpsPerso>;

export const schemaContrastePerso = z.object({
  paire: z.string(),
  mode: z.enum(["light", "dark"]),
  ratio: z.number(),
  seuil: z.number(),
  ok: z.boolean(),
});

/** Rapport de vérification ; `css` est vide s'il reste une erreur de structure (clé, valeur, requis). */
export const schemaRapportPerso = z.object({
  ok: z.boolean(),
  erreurs: z.array(z.string()),
  avertissements: z.array(z.string()),
  contrastes: z.array(schemaContrastePerso),
  css: z.string(),
});
export type RapportPerso = z.infer<typeof schemaRapportPerso>;

/** Préfixe des ids d'habillage personnel (`perso:<id>`), commun au serveur et à l'interface. */
export const PREFIXE_PERSO = "perso:";

/** Habillage du compte : forme d'un skin de `/api/skins`, sans le préfixe `perso:` dans `id`. */
export const schemaSkinPerso = z.object({
  id: z.string(),
  label: z.string(),
  desc: z.string(),
  darkBase: z.boolean(),
  sw: z.array(z.string()),
  builtin: z.boolean(),
  perso: z.boolean(),
  css_url: z.string(),
});

export const schemaReponseListePerso = z.object({ skins: z.array(schemaSkinPerso), max: z.number().int() });
export const schemaReponseEnregistrementPerso = z.object({
  ok: z.boolean(),
  remplace: z.boolean(),
  skin: schemaSkinPerso,
  rapport: schemaRapportPerso,
});
