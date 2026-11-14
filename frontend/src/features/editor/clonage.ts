// SPDX-License-Identifier: MIT
/** frontend/src/features/editor/clonage.ts — fenêtre « Cloner un dépôt » : ce que dit l'adresse saisie (compte git que le serveur prendra, dossier créé, portées où ranger des identifiants saisis), compte dont les dépôts sont proposés, refus d'accès reconnu. */
import {
  cheminPourType,
  cibleCompte,
  compteCouvrant,
  depotDeLUrl,
  niveauxPortee,
  porteeDesSaisis,
} from "../../utils/portee-git";

/** Ce que la fenêtre lit d'un compte git. */
export interface CompteClone {
  readonly id: string | number;
  readonly host: string;
  readonly path: string | null;
  readonly provider_type?: string | undefined;
  readonly label?: string | undefined;
  readonly has_token?: boolean | undefined;
  readonly last_used?: unknown;
}

/** Accès au dépôt de l'adresse saisie : rien de saisi, adresse qui n'est pas http(s), compte git que le serveur prendra (avec ou sans jeton utilisable : il n'en essaie pas d'autre), ou aucun compte. */
export type AccesClone =
  | { readonly etat: "vide" }
  | { readonly etat: "invalide" }
  | {
      readonly etat: "compte" | "sans-jeton";
      readonly hote: string;
      readonly chemin: string | null;
      readonly compte: CompteClone;
    }
  | { readonly etat: "aucun"; readonly hote: string; readonly chemin: string | null };

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
  const compte = compteCouvrant(comptesBornes(comptes), depot.host, depot.chemin);
  if (compte === null) return { etat: "aucun", hote: depot.host, chemin: depot.chemin };
  const etat = compte.has_token === false ? "sans-jeton" : "compte";
  return { etat, hote: depot.host, chemin: depot.chemin, compte };
}

/** Nom du compte tel qu'affiché : ce à quoi il s'applique, puis son libellé. */
export function nomCompte(c: CompteClone): string {
  return cibleCompte(c) + (c.label ? ` · ${c.label}` : "");
}

/** Dossier que le clone crée d'après l'adresse (dernier segment sans `.git`, comme le serveur) ; `""` sans adresse lisible. */
export function dossierDuClone(url: string): string {
  return /\/([^/]+?)(?:\.git)?\/?$/u.exec(url.trim())?.[1] ?? "";
}

/** Portée où ranger des identifiants saisis : sa valeur, son libellé, et le compte dont elle remplacerait le jeton. */
export interface ChoixPortee {
  readonly valeur: string;
  readonly libelle: string;
  readonly remplace: string | null;
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
    };
  });
  return { choix, defaut: porteeDesSaisis(bornes, acces.hote, acces.chemin) };
}

/** Compte dont les dépôts sont proposés à l'ouverture : le seul utilisable, sinon le dernier utilisé ; `null` sans compte. */
export function comptePropose<C extends CompteClone>(comptes: readonly C[] | null | undefined): C | null {
  const utilisables = comptesUtilisables(comptes);
  const usage = (c: CompteClone): number => (typeof c.last_used === "number" ? c.last_used : 0);
  return utilisables.reduce<C | null>((a, c) => (a === null || usage(c) > usage(a) ? c : a), null);
}

/** Messages de git ou d'une forge qui disent des identifiants absents ou refusés (git ne peut pas les demander dans le bac : « could not read Username »). */
const REFUS_ACCES: readonly RegExp[] = [
  /authentication failed/iu,
  /could not read (?:username|password)/iu,
  /terminal prompts disabled/iu,
  /(?:invalid|bad) credentials/iu,
  /invalid username or password/iu,
  /access denied/iu,
  /unauthori[sz]ed/iu,
  /\b(?:401|403)\b/u,
];

/** Échec dû à des identifiants absents ou refusés (pas un refus du relais, 409) : les saisir peut le lever. */
export function refusDAcces(statut: number, message: string): boolean {
  return statut !== 409 && REFUS_ACCES.some((m) => m.test(message));
}
