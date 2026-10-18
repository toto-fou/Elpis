// SPDX-License-Identifier: MIT
/** frontend/src/features/editor/schemas-bac.ts — schémas des routes du bac de l'éditeur (`/api/sandbox/*`, connecteurs git) : ceux du registre `@elpis/contracts`, sous les noms de l'éditeur, plus la lecture JSON validée. */
import {
  schemaErreurApi,
  schemaEvenementInstantane as schemaEvenementInstantaneContrat,
  schemaNoeudArbre,
  schemaRefusEnregistrement as schemaRefusEnregistrementContrat,
  schemaReponseApercuFusionGit,
  schemaReponseArbreBac,
  schemaReponseArbreGit,
  schemaReponseBranchesGit,
  schemaReponseClonerGit,
  schemaReponseDepotsBac,
  schemaReponseDepotsGit,
  schemaReponseDiagnostics,
  schemaReponseDiffCommitGit,
  schemaReponseDiffGit,
  schemaReponseDocx,
  schemaReponseEnregistrement,
  schemaReponseFichierGit,
  schemaReponseFormatage,
  schemaReponseFusionGit,
  schemaReponseHistoriqueFichier,
  schemaReponseHistoriqueSession,
  schemaReponseInitGit,
  schemaReponseInstantanes,
  schemaReponseJournalGit,
  schemaReponseQuotaFichiers,
  schemaReponseRechercheBac,
  schemaReponseRechercheContenu,
  schemaReponseRemplacement,
  schemaReponseResoudreFusionGit,
  schemaReponseStatutGit,
  schemaReponseVerifierEtats,
} from "@elpis/contracts";
import type {
  CommitGitBac,
  EvenementInstantane as EvenementInstantaneContrat,
  FichierGitBac,
  Instantane,
  NoeudArbre as NoeudArbreContrat,
  schemaClicheHistorique,
} from "@elpis/contracts";
import { z } from "zod";

export type NoeudArbre = NoeudArbreContrat;
export const schemaNoeud = schemaNoeudArbre;
export const schemaArbre = schemaReponseArbreBac;
export const schemaQuota = schemaReponseQuotaFichiers;
export const schemaGrep = schemaReponseRechercheContenu;
export const schemaRechercheNoms = schemaReponseRechercheBac;
export const schemaRemplacement = schemaReponseRemplacement;
export type InstantaneBac = Instantane;
export const schemaInstantanes = schemaReponseInstantanes;
export const schemaEvenementInstantane = schemaEvenementInstantaneContrat;
export type EvenementInstantane = EvenementInstantaneContrat;
export const schemaErreur = schemaErreurApi;

/** Corps JSON validé, ou `null` si illisible ou hors forme (traité comme une réponse sans corps). */
export async function lireJson<S extends z.ZodType>(res: Response, schema: S): Promise<z.infer<S> | null> {
  let brut: unknown;
  try {
    brut = await res.json();
  } catch {
    return null;
  }
  const r = schema.safeParse(brut);
  return r.success ? r.data : null;
}

/** Message d'erreur lisible d'une réponse (`detail` texte ou objet `{message}`), sinon le repli. */
export async function detailErreur(res: Response | null, repli: string): Promise<string> {
  if (!res) return "Session expirée / erreur réseau";
  const d = await lireJson(res, schemaErreur);
  const det = d?.detail;
  if (typeof det === "string" && det) return det;
  if (det && typeof det === "object" && "message" in det && typeof det.message === "string" && det.message)
    return det.message;
  return repli;
}

export const schemaGitDepots = schemaReponseDepotsBac;
export type FichierGit = FichierGitBac;
/** État git vu de l'éditeur : hors dépôt (`is_repo` faux), les listes sont vides. */
export interface StatutGit {
  is_repo: boolean;
  repo?: string;
  branch?: string | null;
  ahead: number;
  behind: number;
  remote_url?: string | null;
  staged: FichierGit[];
  modified: FichierGit[];
  untracked: FichierGit[];
  conflicted: FichierGit[];
  truncated?: boolean;
}
export const schemaGitStatut = schemaReponseStatutGit.transform((s): StatutGit =>
  s.is_repo
    ? s
    : { is_repo: false, ahead: 0, behind: 0, staged: [], modified: [], untracked: [], conflicted: [] },
);
export const schemaGitBranches = schemaReponseBranchesGit;
export const schemaGitArbre = schemaReponseArbreGit;
export type CommitGit = CommitGitBac;
export const schemaGitJournal = schemaReponseJournalGit;
export const schemaGitDiffCommit = schemaReponseDiffCommitGit;
export const schemaGitFichier = schemaReponseFichierGit;
export const schemaGitDiff = schemaReponseDiffGit;
/** Création d'un dépôt : initialisé (`init`) ou cloné (`clone`). */
export const schemaGitDepotCree = z.union([schemaReponseInitGit, schemaReponseClonerGit]);
export const schemaGitFusion = schemaReponseFusionGit;
export const schemaGitResolution = schemaReponseResoudreFusionGit;
export const schemaGitApercuFusion = schemaReponseApercuFusionGit;
export const schemaGitDepotsConnecteur = schemaReponseDepotsGit;
/** Réponse brute du serveur de complétion (`/api/llm/infill`) : le texte produit. */
export const schemaCompletion = z.looseObject({ content: z.unknown() });

export const schemaDocx = schemaReponseDocx;
export const schemaEnregistrement = schemaReponseEnregistrement;
export const schemaRefusEnregistrement = schemaRefusEnregistrementContrat;
export const schemaFormatage = schemaReponseFormatage;
export const schemaLint = schemaReponseDiagnostics;

/** Onglet dont l'état disque diffère : un seul des drapeaux `missing`, `not_file`, `unreadable`, ou la nouvelle empreinte. */
export interface Perime {
  path: string;
  new_mtime?: number;
  size?: number;
  sha256?: string | null;
  missing?: boolean;
  not_file?: boolean;
  unreadable?: boolean;
}
export const schemaVerification = schemaReponseVerifierEtats.transform((r) => ({
  stale: r.stale as Perime[],
  truncated: r.truncated,
}));

/** Version d'un fichier de l'historique : cliché, avec l'instant et l'origine pour les versions (l'original n'en a pas). */
export type VersionHistorique = z.infer<typeof schemaClicheHistorique> & { ts?: number; source?: string };
export const schemaSessionHistorique = schemaReponseHistoriqueSession;
export type SessionHistorique = z.infer<typeof schemaSessionHistorique>;
export const schemaEntreeHistorique = schemaReponseHistoriqueFichier;
export type EntreeHistorique = z.infer<typeof schemaEntreeHistorique>;
