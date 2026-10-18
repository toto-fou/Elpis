// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/skills.ts — skills (mémoire procédurale) : inventaire, lecture, écriture, promotion, import ; l'export zip n'est pas du JSON. */
import { z } from "zod";

import { dictionnaire, entier } from "./commun";

export const schemaPorteeSkill = z.enum(["user", "learned", "global"]);
export type PorteeSkill = z.infer<typeof schemaPorteeSkill>;

export const schemaResumeSkill = z.object({
  name: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  source: z.string(),
  domain: z.string(),
  path: z.string().nullable(),
  body_preview: z.string(),
  body_length: entier,
  is_folder: z.boolean(),
  skill_dir: z.string().nullable(),
  files: z.array(z.string()),
  license: z.string(),
  compatibility: z.string(),
  metadata: dictionnaire,
  allowed_tools: z.string(),
  id: z.string(),
  parent_id: z.string().nullable(),
  depth: entier,
});
export type ResumeSkill = z.infer<typeof schemaResumeSkill>;
export const schemaReponseListeSkills = z.object({ skills: z.array(schemaResumeSkill), count: entier });
export const schemaSkill = schemaResumeSkill.extend({ body: z.string() });
export type Skill = z.infer<typeof schemaSkill>;

export const schemaReponseFichierSkill = z.object({ id: z.string(), path: z.string(), content: z.string() });

/** Soit `name` et `body`, soit un markdown complet `raw_md` (nom et description lus dans son frontmatter). */
export const schemaCorpsSkill = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  body: z.string().optional(),
  tags: z.union([z.array(z.string()), z.string()]).optional(),
  domain: z.string().optional(),
  scope: schemaPorteeSkill.optional(),
  raw_md: z.string().optional(),
  filename: z.string().optional(),
});
export const schemaReponseEcritureSkill = z.object({
  ok: z.literal(true),
  name: z.string(),
  path: z.string(),
  source: schemaPorteeSkill,
});
export const schemaCorpsPromotionSkill = z.object({ name: z.string() });
export const schemaReponsePromotionSkill = z.object({
  ok: z.literal(true),
  name: z.string(),
  path: z.string(),
  source: z.literal("global"),
});
export const schemaReponseSuppressionSkill = z.object({
  ok: z.literal(true),
  name: z.string(),
  scope: schemaPorteeSkill,
  deleted: z.literal(true),
});
export const schemaReponseImportSkills = z.object({
  ok: z.literal(true),
  imported: z.array(z.string()),
  count: entier,
  name: z.string(),
  scope: schemaPorteeSkill,
});
/** 409 d'un import sans `overwrite` : `{detail}` accompagné des skills déjà présents, pour que l'interface confirme. */
export const schemaConflitImportSkills = z.object({
  detail: z.string(),
  name: z.string(),
  names: z.array(z.string()),
  scope: schemaPorteeSkill,
});
