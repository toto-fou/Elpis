// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/bureau.ts — Studio : machines de bureau du compte, cible active, écrans ; actions relayées à l'agent de bureau (capture, lecture, action, lancement, automatisation) : schémas tirés du code du core, l'agent n'étant pas simulé par les tests. */
import { z } from "zod";

import { dictionnaire, entier } from "./commun";

export const schemaCibleBureau = z.object({ name: z.string(), os: z.string(), default: z.boolean() });
export const schemaReponseCiblesBureau = z.object({ targets: z.array(schemaCibleBureau), count: entier });
export type ReponseCiblesBureau = z.infer<typeof schemaReponseCiblesBureau>;

/** `target` vide : aucune machine choisie. */
export const schemaReponseCibleActive = z.object({ target: z.string().nullable() });
export const schemaCorpsCibleActive = z.object({ target: z.string() });
export const schemaReponseChoixCible = z.object({ ok: z.literal(true), target: z.string() });

export const schemaEcranBureau = z.looseObject({});
export const schemaReponseEcransBureau = z.object({
  ok: z.literal(true),
  monitors: z.array(schemaEcranBureau),
  selected: z.unknown(),
});
export const schemaCorpsChoixEcran = z.object({ target: z.string().optional(), monitor: entier.optional() });
export const schemaReponseChoixEcran = z.object({ ok: z.literal(true), selected: z.unknown() });
/** Refus (400) quand la machine ou l'agent ne répond pas : `error` est un code, `message` le détail éventuel. */
export const schemaErreurBureau = z.object({
  ok: z.literal(false),
  error: z.unknown(),
  message: z.unknown().optional(),
});

/** Boîte `[x1, y1, x2, y2]` en pixels de l'image. */
const boite = z.array(z.number());
/** Trame renvoyée après capture, action ou lancement : image servie par `/api/desktop/frame/:jeton`, signature d'écran. */
const trame = {
  image_url: z.string(),
  img_w: z.unknown(),
  img_h: z.unknown(),
  target: z.unknown(),
  sig: z.unknown(),
  ts: entier,
};
/** Éléments détectés et arbre d'accessibilité accompagnant une trame. */
const arbre = {
  boxes: z.array(z.unknown()).optional(),
  tree_nodes: z.number().optional(),
  tree_capped: z.boolean().optional(),
};

export const schemaCorpsCaptureBureau = z.object({
  target: z.string().optional(),
  prompt: z.string().optional(),
  raw: z.boolean().optional(),
  use_vision: z.boolean().optional(),
  use_tree: z.boolean().optional(),
  settle: z.boolean().optional(),
  settle_timeout_ms: entier.optional(),
  scope: z.enum(["focus", "monitor", "desktop"]).optional(),
  max_nodes: entier.optional(),
});
export const schemaReponseCaptureBureau = z.object({
  ok: z.literal(true),
  ...trame,
  boxes: z.array(z.unknown()),
  note: z.unknown(),
  tree_nodes: z.number(),
  tree_capped: z.boolean(),
});

export const schemaCorpsLectureBureau = z.object({
  target: z.string().optional(),
  query: z.string().optional(),
  element_id: z.string().optional(),
  region: z.array(z.number()).optional(),
});
export const schemaReponseLectureBureau = z.object({
  ok: z.literal(true),
  text: z.string(),
  region: z.unknown(),
  box: z.unknown(),
  chars: z.number(),
});

export const schemaCorpsActionBureau = z.object({
  target: z.string().optional(),
  op: z.string(),
  settle_ms: entier.optional(),
  element_id: z.string().optional(),
  query: z.string().optional(),
  auto_id: z.string().optional(),
  name: z.string().optional(),
  control_type: z.string().optional(),
  x: entier.nullable().optional(),
  y: entier.nullable().optional(),
  x2: entier.nullable().optional(),
  y2: entier.nullable().optional(),
  text: z.string().optional(),
  keys: z.string().optional(),
  button: z.string().optional(),
  clicks: entier.optional(),
  dy: entier.optional(),
  modifiers: z.string().optional(),
  observe_after: z.boolean().optional(),
  scope: z.enum(["focus", "monitor", "desktop"]).optional(),
  expect_sig: z.string().optional(),
});
/** `warning: "type_no_effect"` : saisie sans effet visible, action tout de même acceptée. */
export const schemaReponseActionBureau = z.object({
  ok: z.literal(true),
  op: z.unknown(),
  point: z.unknown().optional(),
  text: z.unknown().optional(),
  method: z.unknown(),
  settle_ms: z.unknown().optional(),
  warning: z.string().optional(),
  message: z.unknown().optional(),
  ...trame,
  ...arbre,
});

export const schemaCorpsLancementBureau = z.object({
  target: z.string().optional(),
  app: z.string().optional(),
  path: z.string().optional(),
  args: z.string().optional(),
  timeout_ms: entier.optional(),
});
export const schemaReponseLancementBureau = z.object({
  ok: z.literal(true),
  launched: z.unknown(),
  found: z.boolean(),
  title: z.unknown(),
  auto_id: z.unknown(),
  interaction_state: z.unknown(),
  ...trame,
});

export const schemaCorpsAttenteFenetreBureau = z.object({
  target: z.string().optional(),
  title_re: z.string().optional(),
  auto_id: z.string().optional(),
  class_name: z.string().optional(),
  ready: z.boolean().optional(),
  timeout_ms: entier.optional(),
});
export const schemaReponseAttenteFenetreBureau = z.object({
  ok: z.literal(true),
  found: z.boolean(),
  interaction_state: z.unknown(),
  title: z.unknown(),
  auto_id: z.unknown(),
});

/** Bibliothèques et ressources jointes à une automatisation : nom de fichier vers contenu. */
const fichiersAuto = z.record(z.string(), z.unknown());
export const schemaCorpsExecutionBureau = z.object({
  name: z.string().optional(),
  code: z.string(),
  target: z.string().optional(),
  args: z.array(z.string()).optional(),
  dry_run: z.boolean().optional(),
  trace: z.boolean().optional(),
  repeat: entier.optional(),
  vision: z.boolean().optional(),
  libs: fichiersAuto.optional(),
  assets: fichiersAuto.optional(),
});
export const schemaReponseExecutionBureau = z.object({
  ok: z.literal(true),
  run_id: z.unknown(),
  target: z.unknown(),
  name: z.unknown(),
  push_errors: z.array(z.unknown()),
});
/** Document d'état renvoyé tel quel par l'agent de bureau. */
export const schemaReponseEtatExecutionBureau = dictionnaire;
export const schemaCorpsArretExecutionBureau = z.object({
  target: z.string().optional(),
  run_id: z.string().optional(),
});
export const schemaReponseArretExecutionBureau = dictionnaire;

export const schemaCorpsMatriceBureau = z.object({
  name: z.string().optional(),
  code: z.string(),
  targets: z.array(z.string()),
  dry_run: z.boolean().optional(),
  trace: z.boolean().optional(),
  timeout_s: entier.optional(),
  vision: z.boolean().optional(),
  libs: fichiersAuto.optional(),
  assets: fichiersAuto.optional(),
});
export const schemaReponseMatriceBureau = dictionnaire;

export const schemaCorpsPaquetAutomatisationBureau = z.object({
  name: z.string().optional(),
  code: z.string(),
  os: z.string().optional(),
  include_wheels: z.boolean().optional(),
  libs: fichiersAuto.optional(),
  assets: fichiersAuto.optional(),
});

export const schemaCorpsLocaliserBureau = z.object({ describe: z.string(), image_b64: z.string() });
export const schemaReponseLocaliserBureau = z.object({
  ok: z.literal(true),
  box: boite,
  confidence: z.number(),
  label: z.string(),
});
