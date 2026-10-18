// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/bac-git.ts — git du bac relayé par l'hôte d'outils (`/api/sandbox/git/*`) : dépôts, état, branches, journal, diffs, écritures, fusion, remisage. */
import { z } from "zod";

import { schemaNoeudArbre } from "./bac-fichiers";
import { entier } from "./commun";

export const schemaReponseDepotsBac = z.object({
  repos: z.array(z.object({ path: z.string(), name: z.string(), branch: z.string() })),
});

const schemaFichierGit = z.object({
  path: z.string(),
  status: z.string().optional(),
  add: entier.optional(),
  del: entier.optional(),
});
export type FichierGitBac = z.infer<typeof schemaFichierGit>;
/** Hors dépôt : `{is_repo: false}` seul. */
export const schemaReponseStatutGit = z.union([
  z.object({ is_repo: z.literal(false) }),
  z.object({
    is_repo: z.literal(true),
    repo: z.string(),
    branch: z.string(),
    ahead: entier,
    behind: entier,
    remote_url: z.string(),
    staged: z.array(schemaFichierGit),
    modified: z.array(schemaFichierGit),
    untracked: z.array(schemaFichierGit),
    conflicted: z.array(schemaFichierGit),
    truncated: z.boolean(),
  }),
]);
export type StatutGitBac = Extract<z.infer<typeof schemaReponseStatutGit>, { is_repo: true }>;
export const schemaReponseBranchesGit = z.object({
  current: z.string(),
  local: z.array(z.string()),
  remote: z.array(z.string()),
});
export const schemaCommitGitBac = z.object({
  hash: z.string(),
  short: z.string(),
  author: z.string(),
  email: z.string(),
  timestamp: entier,
  message: z.string(),
});
export type CommitGitBac = z.infer<typeof schemaCommitGitBac>;
export const schemaReponseJournalGit = z.object({ commits: z.array(schemaCommitGitBac) });
export const schemaReponseDiffGit = z.object({ diff: z.string(), truncated: z.boolean() });
export const schemaReponseDiffCommitGit = z.object({
  files: z.array(z.object({ status: z.string(), path: z.string() })),
  diff: z.string(),
  message: z.string(),
  author: z.string(),
  timestamp: entier,
  truncated: z.boolean(),
});
export const schemaReponseFichierGit = z.object({ content: z.string() });
export const schemaReponseArbreGit = z.object({ items: z.array(schemaNoeudArbre), truncated: z.boolean() });
export const schemaReponseApercuFusionGit = z.object({
  branch: z.string(),
  commits: z.array(z.object({ short: z.string(), message: z.string(), author: z.string() })),
  files: z.array(z.object({ path: z.string(), add: entier, del: entier })),
  total_add: entier,
  total_del: entier,
});

/** Champs communs : `repo` (dossier du dépôt, absent = racine du bac). */
const depot = { repo: z.string().optional() };
export const schemaCorpsInitGit = z.object({
  dir: z.string().optional(),
  user_name: z.string().optional(),
  user_email: z.string().optional(),
});
export const schemaCorpsClonerGit = z.object({
  url: z.string(),
  dir: z.string().optional(),
  cred_user: z.string().optional(),
  cred_token: z.string().optional(),
  provider_type: z.string().optional(),
});
export const schemaCorpsCheminsGit = z.object({ ...depot, paths: z.array(z.string()).optional() });
export const schemaCorpsCommitGit = z.object({ ...depot, message: z.string() });
export const schemaCorpsBrancheGit = z.object({
  ...depot,
  branch: z.string(),
  create: z.boolean().optional(),
});
export const schemaCorpsDepotGit = z.object({ ...depot });
export const schemaCorpsPousserGit = z.object({
  ...depot,
  remote: z.string().optional(),
  branch: z.string().optional(),
  force: z.boolean().optional(),
  cred_user: z.string().optional(),
  cred_token: z.string().optional(),
});
export const schemaCorpsTirerGit = z.object({
  ...depot,
  rebase: z.boolean().optional(),
  cred_user: z.string().optional(),
  cred_token: z.string().optional(),
});
export const schemaCorpsFusionGit = z.object({
  ...depot,
  branch: z.string(),
  strategy: z.enum(["", "ours", "theirs"]).optional(),
});
export const schemaCorpsResoudreFusionGit = z.object({
  ...depot,
  strategy: z.enum(["ours", "theirs"]).optional(),
  files: z.array(z.string()).optional(),
});
export const schemaCorpsRebaseGit = z.object({
  ...depot,
  branch: z.string().optional(),
  abort: z.boolean().optional(),
  continue: z.boolean().optional(),
});
export const schemaCorpsRemisageGit = z.object({
  ...depot,
  action: z.enum(["push", "pop", "list", "drop"]).optional(),
  message: z.string().optional(),
});
export const schemaCorpsRemoteGit = z.object({
  ...depot,
  url: z.string(),
  name: z.string().optional(),
});
export const schemaCorpsConfigGit = z.object({
  ...depot,
  "user.name": z.string().optional(),
  "user.email": z.string().optional(),
});
export const schemaCorpsRestaurerCommitGit = z.object({
  ...depot,
  hash: z.string(),
  force: z.boolean().optional(),
});

export const schemaReponseInitGit = z.object({ ok: z.literal(true), repo: z.string(), message: z.string() });
export const schemaReponseClonerGit = z.object({
  ok: z.literal(true),
  repo: z.string(),
  message: z.string(),
  credentials_saved: z.boolean(),
});
export const schemaReponseMessageGit = z.object({ ok: z.literal(true), message: z.string() });
export const schemaReponseRecupererGit = z.object({
  ok: z.literal(true),
  skipped: z.array(z.string()).optional(),
});
/** Fusion réussie, ou arrêtée sur des conflits (`ok: false`, fichiers listés). */
export const schemaReponseFusionGit = z.union([
  z.object({ ok: z.literal(true), conflicts: z.literal(false), message: z.string() }),
  z.object({
    ok: z.literal(false),
    conflicts: z.literal(true),
    conflicted_files: z.array(z.string()),
    message: z.string(),
  }),
]);
export const schemaReponseResoudreFusionGit = z.object({
  ok: z.literal(true),
  resolved: entier,
  all_resolved: z.boolean(),
});
/** Remisage : liste des remises (`action: "list"`) ou message de git. */
export const schemaReponseRemisageGit = z.union([
  z.object({ ok: z.literal(true), stashes: z.array(z.string()) }),
  schemaReponseMessageGit,
]);
export const schemaReponseRestaurerCommitGit = z.object({
  ok: z.literal(true),
  message: z.string(),
  previous_head: z.string(),
  backup_ref: z.string(),
});
