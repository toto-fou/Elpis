// SPDX-License-Identifier: MIT
/** frontend/src/features/editor/clonage.ts — fenêtre « Cloner un dépôt » : ce que dit l'adresse saisie (compte git que le serveur prendra, dossier créé, portées où ranger des identifiants saisis), compte dont les dépôts sont proposés, refus d'accès reconnu. */
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

/** Compte dont les dépôts sont proposés à l'ouverture : le seul utilisable, sinon le dernier utilisé ; `null` sans compte. */
export function comptePropose<C extends CompteClone>(comptes: readonly C[] | null | undefined): C | null {
  const utilisables = comptesUtilisables(comptes);
  const usage = (c: CompteClone): number => (typeof c.last_used === "number" ? c.last_used : 0);
  return utilisables.reduce<C | null>((a, c) => (a === null || usage(c) > usage(a) ? c : a), null);
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
