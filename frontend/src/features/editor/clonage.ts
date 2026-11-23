// SPDX-License-Identifier: MIT
/** frontend/src/features/editor/clonage.ts — fenêtre « Cloner un dépôt » : ce que dit l'adresse saisie (hôte et dépôt lus, compte git que le serveur prendra, dossier créé, portées où ranger des identifiants saisis), compte dont les dépôts sont proposés, refus d'accès reconnu. */
import { rstripPy } from "@elpis/commun/python";

import {
  cheminPourType,
  cibleCompte,
  compteCouvrant,
  depotDeLUrl,
  hotePrive,
  niveauxPortee,
  porteeDesSaisis,
} from "../../utils/portee-git";

/** Ce que la fenêtre lit d'un compte git. */
export interface CompteClone {
  readonly id: string | number;
  readonly host: string;
  readonly path: string | null;
  readonly provider_type?: string | undefined;
  readonly api_base?: string | undefined;
  readonly label?: string | undefined;
  readonly has_token?: boolean | undefined;
  readonly to_verify?: boolean | undefined;
  readonly last_used?: unknown;
}

/** Accès au dépôt de l'adresse saisie : rien de saisi, adresse qui n'est pas http(s), compte git que le serveur prendra (utilisable, sans jeton, ou au jeton importé à vérifier : il n'en essaie pas d'autre), ou aucun compte ; `clair` : adresse en http, ce qui part n'est pas chiffré. */
export type AccesClone =
  | { readonly etat: "vide" }
  | { readonly etat: "invalide" }
  | {
      readonly etat: "compte" | "sans-jeton" | "a-verifier";
      readonly hote: string;
      readonly origine: string;
      readonly clair: boolean;
      readonly chemin: string | null;
      readonly compte: CompteClone;
    }
  | {
      readonly etat: "aucun";
      readonly hote: string;
      readonly origine: string;
      readonly clair: boolean;
      readonly chemin: string | null;
    };

/** Comptes qui ont une portée : ceux que le serveur considère pour un dépôt. */
function comptesBornes<C extends CompteClone>(comptes: readonly C[] | null | undefined): C[] {
  return (comptes ?? []).filter((c) => c.path !== null);
}

/** Comptes dont les dépôts peuvent être listés : une portée et un jeton lisible. */
export function comptesUtilisables<C extends CompteClone>(comptes: readonly C[] | null | undefined): C[] {
  return comptesBornes(comptes).filter((c) => c.has_token !== false);
}

/** Comptes dont la fenêtre propose les dépôts : utilisables, et d'un type qui sait les lister (`generic` n'a pas d'API). */
export function comptesListables<C extends CompteClone>(comptes: readonly C[] | null | undefined): C[] {
  return comptesUtilisables(comptes).filter((c) => c.provider_type !== "generic");
}

export function accesClone(url: string, comptes: readonly CompteClone[] | null | undefined): AccesClone {
  if (!url.trim()) return { etat: "vide" };
  const depot = depotDeLUrl(url);
  if (depot === null) return { etat: "invalide" };
  const commun = {
    hote: depot.host,
    origine: `${depot.schema}://${depot.host}`,
    clair: depot.schema === "http",
    chemin: depot.chemin,
  };
  // Dépôt à la racine de l'hôte : le serveur ne lui cherche aucun compte.
  const compte = depot.servi ? compteCouvrant(comptesBornes(comptes), depot.host, depot.chemin) : null;
  // En http, le serveur ne laisse partir un jeton enregistré que vers un hôte du réseau local, ou si l'API du compte est elle-même en http.
  const clairRefuse =
    commun.clair && !hotePrive(depot.host) && !(compte?.api_base ?? "").startsWith("http://");
  if (compte === null || clairRefuse) return { etat: "aucun", ...commun };
  const etat = compte.to_verify ? "a-verifier" : compte.has_token === false ? "sans-jeton" : "compte";
  return { etat, ...commun, compte };
}

/** Nom du compte tel qu'affiché : ce à quoi il s'applique, puis son libellé. */
export function nomCompte(c: CompteClone): string {
  return cibleCompte(c) + (c.label ? ` · ${c.label}` : "");
}

/** Segments qu'aucune adresse de dépôt ne porte (le serveur les refuse) : `.`, `..` et leurs formes encodées. */
const SEGMENT_REFUSE = /(^|\/)(\.|\.\.|%2e|%2e%2e|\.%2e|%2e\.)(\/|$)/iu;

/** Ce que la fenêtre lit de l'adresse saisie, comme le serveur l'acceptera ou non : rien, une adresse SSH (seul http(s) est joint), des identifiants dans l'adresse, une adresse qu'il refuse (autre schéma, hôte ou port mal formé, `?`, `#`, segment `.` ou espace dans le chemin), une adresse encore sans hôte ou sans dépôt, ou l'hôte et le dépôt. */
export type LectureAdresse =
  | { readonly etat: "vide" | "ssh" | "identifiants" | "invalide" | "incomplete" }
  | { readonly etat: "lue"; readonly hote: string; readonly depot: string };

export function lectureAdresse(url: string): LectureAdresse {
  const t = url.trim();
  if (!t) return { etat: "vide" };
  if (/^(?:ssh:\/\/|[\w.-]+@[\w.-]+:)/iu.test(t)) return { etat: "ssh" };
  if (!/^https?:\/\//iu.test(t)) {
    const debut = t.toLowerCase();
    return { etat: "https://".startsWith(debut) || "http://".startsWith(debut) ? "incomplete" : "invalide" };
  }
  const schema = t.slice(0, t.indexOf("://")).toLowerCase();
  const apres = t.slice(t.indexOf("://") + 3);
  const barre = apres.search(/[/?#]/u);
  const autorite = barre < 0 ? apres : apres.slice(0, barre);
  const suite = barre < 0 ? "" : apres.slice(barre);
  if (autorite.includes("@")) return { etat: "identifiants" };
  if (!autorite) return { etat: suite ? "invalide" : "incomplete" };
  // Hôte et port lus comme pour chercher le compte (le schéma seul peut être en majuscules).
  if (depotDeLUrl(`${schema}://${apres}`) === null || /[?#]/u.test(suite)) return { etat: "invalide" };
  const depot = rstripPy(suite.slice(1), "/").replace(/\.git$/u, "");
  if (!depot) return { etat: "incomplete" };
  if (SEGMENT_REFUSE.test(depot) || /[\\\0\r\n\t ]/u.test(depot)) return { etat: "invalide" };
  return { etat: "lue", hote: autorite.toLowerCase(), depot };
}

/** Adresse d'exemple du champ : sur l'hôte du dernier compte utilisé, dans son organisation s'il en a une ; sans compte, une forge fictive. */
export function exempleAdresse(comptes: readonly CompteClone[] | null | undefined): string {
  const c = dernierUtilise(comptesUtilisables(comptes));
  if (c === null) return "https://forge.exemple/organisation/depot.git";
  const schema = (c.api_base ?? "").startsWith("http://") ? "http" : "https";
  return `${schema}://${c.host}/${c.path ? c.path.split("/")[0] : "organisation"}/depot.git`;
}

/** Dossier que le clone crée d'après l'adresse (dernier segment sans `.git`, comme le serveur) ; `""` sans adresse lisible. */
export function dossierDuClone(url: string): string {
  return /\/([^/]+?)(?:\.git)?\/?$/u.exec(url.trim())?.[1] ?? "";
}

/** Portée où ranger des identifiants saisis : sa valeur, son libellé, le compte qu'elle mettrait à jour, et `fermee` quand ce compte attend d'être vérifié (le serveur n'y range rien). */
export interface ChoixPortee {
  readonly valeur: string;
  readonly libelle: string;
  readonly remplace: string | null;
  readonly fermee: boolean;
}

/** Portées où ranger des identifiants saisis pour ce dépôt, de tout l'hôte au dépôt, et celle que le serveur prendrait d'office ; `defaut` `null` : il n'enregistrerait rien (dépôt à l'adresse illisible, tout l'hôte déjà pris), les identifiants ne servent alors qu'à ce clone. */
export function porteesIdentifiants(
  acces: AccesClone,
  comptes: readonly CompteClone[] | null | undefined,
): { choix: ChoixPortee[]; defaut: string | null } {
  if (acces.etat === "vide" || acces.etat === "invalide") return { choix: [], defaut: null };
  const bornes = comptesBornes(comptes).filter((c) => c.host === acces.hote);
  const choix = niveauxPortee(acces.chemin).map((n) => {
    const existant = bornes.find((c) => c.path === cheminPourType(n, c.provider_type));
    return {
      valeur: n,
      libelle: cibleCompte({ host: acces.hote, path: n }),
      remplace: existant ? nomCompte(existant) : null,
      fermee: existant?.to_verify === true,
    };
  });
  const defaut = porteeDesSaisis(bornes, acces.hote, acces.chemin);
  // Portée d'office fermée (compte à vérifier) : la plus proche ouverte, plus précise d'abord.
  const rang = choix.findIndex((c) => c.valeur === defaut);
  if (defaut === null || rang < 0 || !choix[rang]?.fermee) return { choix, defaut };
  const ouverte = [...choix.slice(rang + 1), ...choix.slice(0, rang).reverse()].find((c) => !c.fermee);
  return { choix, defaut: ouverte?.valeur ?? null };
}

/** Dernier utilisé d'une liste de comptes ; `null` si elle est vide. */
function dernierUtilise<C extends CompteClone>(comptes: readonly C[]): C | null {
  const usage = (c: CompteClone): number => (typeof c.last_used === "number" ? c.last_used : 0);
  return comptes.reduce<C | null>((a, c) => (a === null || usage(c) > usage(a) ? c : a), null);
}

/** Compte dont les dépôts sont proposés à l'ouverture : le seul qui sait les lister, sinon le dernier utilisé ; `null` sans un tel compte. */
export function comptePropose<C extends CompteClone>(comptes: readonly C[] | null | undefined): C | null {
  return dernierUtilise(comptesListables(comptes));
}

/** Ce que git ou une forge écrit quand des identifiants manquent ou sont refusés (dans le bac, git ne peut pas les demander : « could not read Username »). */
const REFUS_ACCES: readonly RegExp[] = [
  /authentication failed/iu,
  /could not read (?:username|password)/iu,
  /terminal prompts disabled/iu,
  /(?:invalid|bad) credentials/iu,
  /invalid username or password/iu,
  /access denied/iu,
  /^remote: unauthori[sz]ed/iu,
  /(?:returned error:|\bHTTP(?:\/[\d.]+)?) 40[13]\b/iu,
];

/** Lignes d'erreur d'une sortie de git : ni la progression (« Enumerating objects: 403 »), ni un nom de dépôt introuvable ne disent un refus. */
function lignesDErreur(message: string): string[] {
  return message
    .split(/[\r\n]+/u)
    .map((l) => l.trim())
    .filter((l) => l && !/objects:|\d+%|not found/iu.test(l));
}

/** Échec dû à des identifiants absents ou refusés (pas un refus du relais, 409) : les saisir peut le lever. */
export function refusDAcces(statut: number, message: string): boolean {
  return statut !== 409 && lignesDErreur(message).some((l) => REFUS_ACCES.some((m) => m.test(l)));
}
