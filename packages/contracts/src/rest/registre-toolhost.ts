// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/registre-toolhost.ts — registre des routes REST servies par l'hôte d'outils (`/api/sandbox/*`, `/api/terminal/*`) : méthode, chemin, corps, réponse de succès ; hors main, donc registre à part. */
import type { z } from "zod";

import * as fichiers from "./bac-fichiers";
import * as git from "./bac-git";
import * as instantanes from "./bac-instantanes";
import * as office from "./bac-office";
import * as terminal from "./bac-terminal";
import { schemaOk } from "./commun";
import { c, motif } from "./registre";
import type { ContratRoute, Methode } from "./registre";

/** Route de l'hôte : `flux` décrit chaque ligne d'une réponse NDJSON (la réponse JSON est alors nulle). */
export interface ContratToolhost extends ContratRoute {
  readonly flux?: z.ZodType;
}

function t(
  domaine: string,
  methode: Methode,
  chemin: string,
  reponse: z.ZodType | null,
  corps?: z.ZodType,
): ContratToolhost {
  return c(domaine, methode, chemin, reponse, corps);
}

function flux(domaine: string, chemin: string, evenements: z.ZodType, corps?: z.ZodType): ContratToolhost {
  return { ...c(domaine, "POST", chemin, null, corps), flux: evenements };
}

const G = "/api/sandbox/git";

export const CONTRATS_REST_TOOLHOST: readonly ContratToolhost[] = [
  t("bac-fichiers", "GET", "/api/sandbox/tree", fichiers.schemaReponseArbreBac),
  t("bac-fichiers", "GET", "/api/sandbox/quota", fichiers.schemaReponseQuotaFichiers),
  t("bac-fichiers", "GET", "/api/sandbox/search", fichiers.schemaReponseRechercheBac),
  t("bac-fichiers", "GET", "/api/sandbox/read-docx", fichiers.schemaReponseDocx),
  t(
    "bac-fichiers",
    "POST",
    "/api/sandbox/check-mtimes",
    fichiers.schemaReponseVerifierEtats,
    fichiers.schemaCorpsVerifierEtats,
  ),
  t("bac-fichiers", "GET", "/api/sandbox/history", fichiers.schemaReponseHistoriqueSession),
  t("bac-fichiers", "GET", "/api/sandbox/history/file", fichiers.schemaReponseHistoriqueFichier),
  t(
    "bac-fichiers",
    "POST",
    "/api/sandbox/save",
    fichiers.schemaReponseEnregistrement,
    fichiers.schemaCorpsEnregistrement,
  ),
  t("bac-fichiers", "DELETE", "/api/sandbox/delete", schemaOk, fichiers.schemaCorpsChemin),
  t("bac-fichiers", "POST", "/api/sandbox/clear", fichiers.schemaReponseViderBac),
  t("bac-fichiers", "POST", "/api/sandbox/mkdir", schemaOk, fichiers.schemaCorpsChemin),
  t("bac-fichiers", "POST", "/api/sandbox/rename", schemaOk, fichiers.schemaCorpsRenommerFichier),
  t("bac-fichiers", "POST", "/api/sandbox/copy", fichiers.schemaReponseCopieBac, fichiers.schemaCorpsCopie),
  t("bac-fichiers", "POST", "/api/sandbox/upload", fichiers.schemaReponseEnvoiBac),
  t("bac-fichiers", "POST", "/api/sandbox/upload-chunk", fichiers.schemaReponseMorceauBac),
  t("bac-fichiers", "DELETE", "/api/sandbox/upload-chunk", fichiers.schemaReponseAnnulerMorceauBac),
  t(
    "bac-fichiers",
    "POST",
    "/api/sandbox/upload-precheck",
    fichiers.schemaReponsePreControleEnvoi,
    fichiers.schemaCorpsPreControleEnvoi,
  ),
  t(
    "bac-fichiers",
    "POST",
    "/api/sandbox/grep",
    fichiers.schemaReponseRechercheContenu,
    fichiers.schemaCorpsRechercheContenu,
  ),
  t(
    "bac-fichiers",
    "POST",
    "/api/sandbox/replace",
    fichiers.schemaReponseRemplacement,
    fichiers.schemaCorpsRemplacement,
  ),
  t(
    "bac-fichiers",
    "POST",
    "/api/sandbox/lint",
    fichiers.schemaReponseDiagnostics,
    fichiers.schemaCorpsDiagnostics,
  ),
  t(
    "bac-fichiers",
    "POST",
    "/api/sandbox/format",
    fichiers.schemaReponseFormatage,
    fichiers.schemaCorpsDiagnostics,
  ),
  t("bac-fichiers", "POST", "/api/sandbox/import", fichiers.schemaReponseImportBac),
  t("bac-fichiers", "POST", "/api/sandbox/skills-mirror", fichiers.schemaReponseMiroirSkills),

  t("bac-instantanes", "GET", "/api/sandbox/me", instantanes.schemaReponseBacMoi),
  t(
    "bac-instantanes",
    "POST",
    "/api/sandbox/me",
    instantanes.schemaReponseChoixBac,
    instantanes.schemaCorpsBacMoi,
  ),
  t("bac-instantanes", "POST", "/api/sandbox/me/restart", instantanes.schemaReponseRedemarrageBac),
  t("bac-instantanes", "DELETE", "/api/sandbox/me", schemaOk),
  t("bac-instantanes", "GET", "/api/sandbox/snapshots", instantanes.schemaReponseInstantanes),
  flux(
    "bac-instantanes",
    "/api/sandbox/snapshots/create",
    instantanes.schemaEvenementInstantane,
    instantanes.schemaCorpsCreerInstantane,
  ),
  flux("bac-instantanes", "/api/sandbox/snapshots/:snap_id/restore", instantanes.schemaEvenementInstantane),
  t("bac-instantanes", "DELETE", "/api/sandbox/snapshots/restore-marker", schemaOk),
  t(
    "bac-instantanes",
    "DELETE",
    "/api/sandbox/snapshots/:snap_id",
    instantanes.schemaReponseSupprimerInstantane,
  ),

  t(
    "bac-office",
    "POST",
    "/api/sandbox/office/prepare",
    office.schemaReponsePreparerApercu,
    office.schemaCorpsPreparerApercu,
  ),

  t("bac-git", "GET", `${G}/repos`, git.schemaReponseDepotsBac),
  t("bac-git", "GET", `${G}/status`, git.schemaReponseStatutGit),
  t("bac-git", "GET", `${G}/branches`, git.schemaReponseBranchesGit),
  t("bac-git", "GET", `${G}/log`, git.schemaReponseJournalGit),
  t("bac-git", "GET", `${G}/diff`, git.schemaReponseDiffGit),
  t("bac-git", "GET", `${G}/commit-diff`, git.schemaReponseDiffCommitGit),
  t("bac-git", "GET", `${G}/show-file`, git.schemaReponseFichierGit),
  t("bac-git", "GET", `${G}/tree`, git.schemaReponseArbreGit),
  t("bac-git", "GET", `${G}/merge-preview`, git.schemaReponseApercuFusionGit),
  t("bac-git", "POST", `${G}/init`, git.schemaReponseInitGit, git.schemaCorpsInitGit),
  t("bac-git", "POST", `${G}/clone`, git.schemaReponseClonerGit, git.schemaCorpsClonerGit),
  t("bac-git", "POST", `${G}/stage`, schemaOk, git.schemaCorpsCheminsGit),
  t("bac-git", "POST", `${G}/unstage`, schemaOk, git.schemaCorpsCheminsGit),
  t("bac-git", "POST", `${G}/discard`, schemaOk, git.schemaCorpsCheminsGit),
  t("bac-git", "POST", `${G}/commit`, git.schemaReponseMessageGit, git.schemaCorpsCommitGit),
  t("bac-git", "POST", `${G}/checkout`, git.schemaReponseMessageGit, git.schemaCorpsBrancheGit),
  t("bac-git", "POST", `${G}/fetch`, git.schemaReponseRecupererGit, git.schemaCorpsDepotGit),
  t("bac-git", "POST", `${G}/pull`, git.schemaReponseMessageGit, git.schemaCorpsTirerGit),
  t("bac-git", "POST", `${G}/push`, git.schemaReponseMessageGit, git.schemaCorpsPousserGit),
  t("bac-git", "POST", `${G}/merge`, git.schemaReponseFusionGit, git.schemaCorpsFusionGit),
  t("bac-git", "POST", `${G}/merge-abort`, schemaOk, git.schemaCorpsDepotGit),
  t(
    "bac-git",
    "POST",
    `${G}/merge-resolve`,
    git.schemaReponseResoudreFusionGit,
    git.schemaCorpsResoudreFusionGit,
  ),
  t("bac-git", "POST", `${G}/rebase`, git.schemaReponseMessageGit, git.schemaCorpsRebaseGit),
  t("bac-git", "POST", `${G}/stash`, git.schemaReponseRemisageGit, git.schemaCorpsRemisageGit),
  t("bac-git", "POST", `${G}/remote`, schemaOk, git.schemaCorpsRemoteGit),
  t("bac-git", "POST", `${G}/config`, schemaOk, git.schemaCorpsConfigGit),
  t("bac-git", "POST", `${G}/revert-last`, git.schemaReponseMessageGit, git.schemaCorpsDepotGit),
  t(
    "bac-git",
    "POST",
    `${G}/restore-commit`,
    git.schemaReponseRestaurerCommitGit,
    git.schemaCorpsRestaurerCommitGit,
  ),

  t(
    "bac-terminal",
    "POST",
    "/api/terminal/input",
    terminal.schemaReponseSaisieTerminal,
    terminal.schemaCorpsSaisieTerminal,
  ),
  t("bac-terminal", "POST", "/api/terminal/resize", schemaOk, terminal.schemaCorpsTailleTerminal),
  t("bac-terminal", "POST", "/api/terminal/kill", schemaOk),
  t("bac-terminal", "GET", "/api/terminal/sessions", terminal.schemaReponseSessionsTerminal),
  t(
    "bac-terminal",
    "POST",
    "/api/terminal/sessions",
    terminal.schemaReponseCreerSessionTerminal,
    terminal.schemaCorpsCreerSessionTerminal,
  ),
  t(
    "bac-terminal",
    "PATCH",
    "/api/terminal/sessions/:sid",
    schemaOk,
    terminal.schemaCorpsRenommerSessionTerminal,
  ),
  t("bac-terminal", "DELETE", "/api/terminal/sessions/:sid", schemaOk),
];

const MOTIFS = CONTRATS_REST_TOOLHOST.map((r) => ({
  r,
  re: motif(r.chemin),
  statique: !r.chemin.includes(":"),
}));

/** Contrat d'une requête concrète de l'hôte (chaîne de requête ignorée) ; un chemin fixe l'emporte sur un chemin paramétré. */
export function contratToolhostDe(methode: string, url: string): ContratToolhost | undefined {
  const chemin = url.split("?")[0] ?? url;
  const candidats = MOTIFS.filter((m) => m.r.methode === methode && m.re.test(chemin));
  return (candidats.find((m) => m.statique) ?? candidats[0])?.r;
}
