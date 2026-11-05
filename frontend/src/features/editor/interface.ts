// SPDX-License-Identifier: MIT
/** frontend/src/features/editor/interface.ts — éditeur choisi par le compte (selon le skin ou classique) : valeurs fermées, lecture normalisée, interface affichée, choix du réglage. */

export const INTERFACES_EDITEUR = ["skin", "classic"] as const;
export type InterfaceEditeur = (typeof INTERFACES_EDITEUR)[number];

/** Choix du compte ; absent ou inconnu : selon le skin. */
export function lireInterfaceEditeur(s: unknown): InterfaceEditeur {
  const v = s && typeof s === "object" ? (s as { editor_ui?: unknown }).editor_ui : undefined;
  return v === "classic" ? "classic" : "skin";
}

/** Interface affichée : le style du skin s'il a une feuille d'éditeur, sinon le classique. */
export function interfaceAffichee(s: unknown, feuille: string): InterfaceEditeur {
  return feuille && lireInterfaceEditeur(s) === "skin" ? "skin" : "classic";
}

export interface ChoixInterface {
  readonly valeur: InterfaceEditeur;
  readonly libelle: string;
  readonly aide: string;
}

/** Choix proposés dans Paramètres, dans cet ordre. */
export const CHOIX_INTERFACES_EDITEUR: readonly ChoixInterface[] = [
  { valeur: "skin", libelle: "Selon le skin", aide: "Le style d'éditeur fourni par le skin." },
  { valeur: "classic", libelle: "Classique", aide: "L'éditeur d'origine, quel que soit le skin." },
];

export const AIDE_SKIN_SANS_EDITEUR = "Ce skin n'a pas de style d'éditeur : éditeur classique.";
