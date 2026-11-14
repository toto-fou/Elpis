// SPDX-License-Identifier: MIT
/** frontend/src/features/editor/clonage.ts — fenêtre « Cloner un dépôt » : ce que dit l'adresse saisie (compte git qui servira, dossier créé, portées où ranger des identifiants saisis), compte dont les dépôts sont proposés, refus d'accès reconnu. */
import {
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

/** Accès au dépôt de l'adresse saisie : rien de saisi, adresse qui n'est pas http(s), compte git qui servira, ou aucun compte. */
export type AccesClone =
  | { readonly etat: "vide" }
  | { readonly etat: "invalide" }
  | {
      readonly etat: "compte";
      readonly hote: string;
      readonly chemin: string | null;
      readonly compte: CompteClone;
    }
  | { readonly etat: "aucun"; readonly hote: string; readonly chemin: string | null };

/** Comptes utilisables : une portée et un jeton lisible. */
export function comptesUtilisables<C extends CompteClone>(comptes: readonly C[] | null | undefined): C[] {
  return (comptes ?? []).filter((c) => c.path !== null && c.has_token !== false);
}

export function accesClone(url: string, comptes: readonly CompteClone[] | null | undefined): AccesClone {
  if (!url.trim()) return { etat: "vide" };
  const depot = depotDeLUrl(url);
  if (depot === null) return { etat: "invalide" };
  const compte = compteCouvrant(comptesUtilisables(comptes), depot.host, depot.chemin);
  return compte === null
    ? { etat: "aucun", hote: depot.host, chemin: depot.chemin }
    : { etat: "compte", hote: depot.host, chemin: depot.chemin, compte };
}

/** Nom du compte tel qu'affiché : ce à quoi il s'applique, puis son libellé. */
export function nomCompte(c: CompteClone): string {
  return cibleCompte(c) + (c.label ? ` · ${c.label}` : "");
}

/** Dossier que le clone crée d'après l'adresse (dernier segment sans `.git`, comme le serveur) ; `""` sans adresse lisible. */
export function dossierDuClone(url: string): string {
  return /\/([^/]+?)(?:\.git)?\/?$/u.exec(url.trim())?.[1] ?? "";
}

/** Portées où ranger des identifiants saisis pour ce dépôt, de tout l'hôte au dépôt, et celle proposée d'office (tout l'hôte quand le serveur n'en choisirait aucune : le choix affiché est alors celui de l'utilisateur). */
export function porteesIdentifiants(
  acces: AccesClone,
  comptes: readonly CompteClone[] | null | undefined,
): { choix: { valeur: string; libelle: string }[]; defaut: string } {
  if (acces.etat !== "compte" && acces.etat !== "aucun") return { choix: [], defaut: "" };
  const choix = niveauxPortee(acces.chemin).map((n) => ({
    valeur: n,
    libelle: cibleCompte({ host: acces.hote, path: n }),
  }));
  return { choix, defaut: porteeDesSaisis(comptesUtilisables(comptes), acces.hote, acces.chemin) ?? "" };
}

/** Compte dont les dépôts sont proposés à l'ouverture : le seul utilisable, sinon le dernier utilisé ; `null` sans compte. */
export function comptePropose<C extends CompteClone>(comptes: readonly C[] | null | undefined): C | null {
  const utilisables = comptesUtilisables(comptes);
  const usage = (c: CompteClone): number => (typeof c.last_used === "number" ? c.last_used : 0);
  return utilisables.reduce<C | null>((a, c) => (a === null || usage(c) > usage(a) ? c : a), null);
}

/** Échec dû à des identifiants absents ou refusés (pas un refus du relais, 409) : les saisir peut le lever. */
export function refusDAcces(statut: number, message: string): boolean {
  const bas = message.toLowerCase();
  return (
    statut !== 409 &&
    (bas.includes("auth") || bas.includes("credential") || message.includes("403") || message.includes("401"))
  );
}
