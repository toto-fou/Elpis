// SPDX-License-Identifier: MIT
/** frontend/src/features/editor/ecriture-modele.ts — écritures programmatiques dans un modèle Monaco par opérations d'édition (jamais `setValue`, qui vide l'historique d'annulation). */
import { compute } from "../../utils/minimal-edit";
import type { PlageEdition } from "../../utils/minimal-edit";

/** Sous-ensemble d'`ITextModel` utilisé ici (le type complet vit dans le chunk Monaco, chargé à la demande). */
export interface ModeleEditable {
  getValue(): string;
  getFullModelRange(): PlageEdition;
  pushEditOperations(
    selections: [],
    operations: Array<{ range: PlageEdition; text: string }>,
    curseur: () => null,
  ): unknown;
  isDisposed?(): boolean;
}

const normaliser = (t: string): string => t.replace(/\r\n?/g, "\n");

/** Remplace le contenu par l'édition minimale ; rend faux si le modèle est libéré ou refuse l'édition. */
export function remplacerContenu(modele: ModeleEditable, texte: string): boolean {
  if (modele.isDisposed?.()) return false;
  const ancien = modele.getValue();
  const edition = compute(ancien, texte);
  if (!edition) return true;
  const sansRetour = (): null => null;
  try {
    modele.pushEditOperations([], [{ range: edition.range, text: edition.text }], sansRetour);
  } catch {
    return false;
  }
  if (normaliser(modele.getValue()) === normaliser(texte)) return true;
  // Filet : l'édition minimale n'a pas donné le texte attendu, tout le contenu est remplacé en une opération.
  try {
    modele.pushEditOperations([], [{ range: modele.getFullModelRange(), text: texte }], sansRetour);
  } catch {
    return false;
  }
  return normaliser(modele.getValue()) === normaliser(texte);
}

/** Édition minimale de `ancien` vers `nouveau` ; plage modifiée (lignes du nouveau texte), ou null si rien ou si le remplacement complet a pris le relais. */
export function editionMinimale(
  modele: ModeleEditable,
  ancien: string,
  nouveau: string,
): { startLine: number; endLine: number; changed: number } | null {
  const edition = compute(ancien, nouveau);
  if (!edition) return null;
  try {
    modele.pushEditOperations([], [{ range: edition.range, text: edition.text }], () => null);
  } catch {
    remplacerContenu(modele, nouveau);
    return null;
  }
  // Filet : le tampon doit valoir le nouveau texte (fins de ligne près), sinon il serait enregistré faux.
  try {
    if (normaliser(modele.getValue()) !== normaliser(nouveau)) remplacerContenu(modele, nouveau);
  } catch {
    /* modèle libéré */
  }
  return { startLine: edition.startLine, endLine: edition.endLine, changed: edition.changed };
}
