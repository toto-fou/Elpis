// SPDX-License-Identifier: MIT
/** apps/toolhost/src/fichiers/commun.ts — socle des routes de fichiers, Git et Office de l'hôte (routes_files.py, routes_git.py, routes_office.py) : bac et agent du compte, chemins de l'éditeur, refus de l'agent. */
import { bacDuCompte } from "@elpis/bac";
import { comparePointsDeCode, ErreurPython, getPy, intPy, lowerPy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { AgentClient, AgentError, parAgent as parAgentFichiers } from "@elpis/fichiers";
import type { SourceGit } from "@elpis/fichiers";
import type { FastifyReply } from "fastify";

import { BAC_DU_COMPTE } from "../apercu-fichiers";
import type { BacDuCompte } from "../apercu-fichiers";
import type { Journal } from "../journal";

export { uidDe } from "../bac/routes-me";
export { mtimeS, relEditeur, statUn } from "../reponse-agent";
export { reponseJson } from "../socle";

/** Bac du compte vu des routes d'écriture : celui de l'aperçu, avec le client complet de l'agent (écritures, git, archives). */
export interface BacFichiers extends BacDuCompte {
  agent(uid: number): Promise<AgentClient>;
}

/** Bac du registre de @elpis/bac (conteneur Docker du compte, agent posé par la composition). */
export const BAC_REGISTRE: BacFichiers = {
  racine: BAC_DU_COMPTE.racine,
  async agent(uid) {
    const a = (await bacDuCompte(uid)).agent;
    if (!(a instanceof AgentClient)) throw new AgentError("agent_unavailable", "client de fichiers absent");
    return a;
  },
};

/** Rappels vers le core (`/api/internal/*`) dont ont besoin ces routes ; `ClientRappel` les fournit. */
export interface RappelFichiers extends SourceGit {
  /** `sandbox_quota_mb` des réglages du compte, `null` sans surcharge ; `undefined` : inconnu (core injoignable). */
  quotaCompte(uid: number): Promise<number | null | undefined>;
  /** `save_git_credential` pour le compte de l'enveloppe : identifiant saisi au clone enregistré pour l'hôte du dépôt ; vrai s'il l'a été. */
  enregistrerIdentifiantGit(
    compte: { readonly user_id: number; readonly username: string },
    cible: string,
    utilisateur: string,
    jeton: string,
    typeFournisseur: string,
  ): Promise<boolean>;
  /** `import_legacy_git_credentials` : connecteurs créés, `-1` si l'import a échoué, `IMPORT_GARDE` si des hôtes ont été refusés (fichier gardé). */
  importAncien(
    compte: { readonly user_id: number; readonly username: string },
    donnees: Buffer,
  ): Promise<number>;
}

/** Sans core joignable : comme une base sans compte (`{}`), rien d'enregistré ni d'importé. */
export const RAPPEL_ABSENT: RappelFichiers = {
  quotaCompte: () => Promise.resolve(null),
  enregistrerIdentifiantGit: () => Promise.resolve(false),
  importAncien: () => Promise.resolve(-1),
  gitCredential: () => Promise.resolve(null),
  connectorHosts: () => Promise.resolve([]),
};

export interface ContexteFichiers {
  readonly bac: BacFichiers;
  readonly rappel: RappelFichiers;
  readonly journal: Journal;
  /** Arrêt du process : flux en cours fermés, boucles d'entretien arrêtées. */
  readonly arret?: AbortSignal;
}

/** `await op` ; un refus de l'agent en erreur HTTP de l'éditeur (`agent_http(ex, libelle)`). */
export function parAgent<T>(libelle: string, op: () => Promise<T>): Promise<T> {
  return parAgentFichiers(undefined, libelle, op);
}

/** `(e,) = await agent.stat([rel], …)` : une entrée exactement (sinon ValueError de Python, panne 500). */
export function une(entrees: readonly Dict[]): Dict {
  const [e] = entrees;
  if (entrees.length !== 1 || e === undefined)
    throw new ErreurPython(
      "ValueError",
      entrees.length > 1
        ? "too many values to unpack (expected 1)"
        : `not enough values to unpack (expected 1, got ${entrees.length})`,
    );
  return e;
}

/** `TREE_MAX_ENTRIES` (`SANDBOX_TREE_MAX_ENTRIES`, 20 000 par défaut), lu au chargement comme le Python. */
export const TREE_MAX_ENTRIES = intPy(process.env["SANDBOX_TREE_MAX_ENTRIES"] ?? "20000");

/** `int(e.get(cle) or 0)` d'une entrée de l'agent. */
export function entierDe(e: Dict, cle: string): number {
  const v = getPy(e, cle);
  return v === null || v === undefined || v === false || v === 0 || v === "" ? 0 : Number(intPy(v));
}

/** `_no_cache` : en-têtes posés sur la réponse. */
export function sansCache(reponse: FastifyReply): FastifyReply {
  return reponse.headers({
    "cache-control": "no-cache, no-store, must-revalidate",
    pragma: "no-cache",
    expires: "0",
  });
}

/** Nœud de l'arbre de l'explorateur (`_arbre`). */
export interface Noeud {
  name: string;
  path: string;
  type: "folder" | "file";
  children?: Noeud[];
  size?: number;
}

/** `_arbre` : arbre de l'explorateur depuis la liste de l'agent (liens ni listés ni suivis), dossiers d'abord puis noms sans casse. */
export function arbre(entrees: readonly Dict[]): Noeud[] {
  const noeuds = new Map<string, Noeud>();
  for (const e of entrees) {
    const kind = getPy(e, "kind");
    if (kind === "link") continue;
    const chemin = String(e["path"]);
    const i = chemin.lastIndexOf("/");
    const item: Noeud = { name: chemin.slice(i + 1), path: chemin, type: kind === "dir" ? "folder" : "file" };
    if (kind === "dir") item.children = [];
    else item.size = entierDe(e, "size");
    noeuds.set(chemin, item);
  }
  const racine: Noeud[] = [];
  for (const [chemin, item] of noeuds) {
    const i = chemin.lastIndexOf("/");
    const parent = i >= 0 ? chemin.slice(0, i) : "";
    if (!parent) racine.push(item);
    else noeuds.get(parent)?.children?.push(item);
  }
  const trier = (items: Noeud[]): void => {
    items.sort(
      (a, b) =>
        Number(a.type !== "folder") - Number(b.type !== "folder") ||
        comparePointsDeCode(lowerPy(a.name), lowerPy(b.name)) ||
        comparePointsDeCode(a.name, b.name),
    );
    for (const i of items) if (i.children) trier(i.children);
  };
  trier(racine);
  return racine;
}
