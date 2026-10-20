// SPDX-License-Identifier: MIT
/** frontend/src/features/rag/publication.ts — page RAG, boîte « Publier » : état de départ, comptes concernés, validation, corps envoyé, refus du serveur en clair. */
import { GROUPES_PUBLICATION_RAG_MAX } from "@elpis/contracts";
import type { CollectionVueRag, DemandePublicationRag, VisibiliteRag } from "@elpis/contracts";

export interface GroupePublication {
  id: number;
  name: string;
  members: number;
}

export interface ChoixPublication {
  visibility: VisibiliteRag;
  groupIds: number[];
  allowSourceOpen: boolean;
}

/** Choix de départ : la publication actuelle de la collection. */
export function choixInitial(
  c: Pick<CollectionVueRag, "visibility" | "groups" | "allow_source_open">,
): ChoixPublication {
  return {
    visibility: c.visibility,
    groupIds: c.groups.map((g) => g.id),
    allowSourceOpen: c.allow_source_open,
  };
}

/** Bascule un groupe dans le choix ; l'ordre d'ajout est gardé. */
export function basculerGroupe(ids: readonly number[], id: number): number[] {
  return ids.includes(id) ? ids.filter((i) => i !== id) : [...ids, id];
}

/** Comptes concernés : l'effectif de l'instance pour « Tous », la somme des effectifs des groupes (plafonnée) pour des groupes. */
export function comptesConcernes(
  choix: Pick<ChoixPublication, "visibility" | "groupIds">,
  groupes: readonly GroupePublication[],
  comptes: number,
): number {
  if (choix.visibility === "private") return 0;
  if (choix.visibility === "all") return comptes;
  const somme = groupes.filter((g) => choix.groupIds.includes(g.id)).reduce((n, g) => n + g.members, 0);
  return comptes > 0 ? Math.min(somme, comptes) : somme;
}

/** Phrase sous les options : « 17 comptes y auront accès… », « Jusqu'à 17 comptes… » quand des groupes peuvent se recouper. */
export function phraseComptes(
  choix: Pick<ChoixPublication, "visibility" | "groupIds">,
  groupes: readonly GroupePublication[],
  comptes: number,
): string {
  if (choix.visibility === "private") return "Seul votre compte y a accès.";
  const n = comptesConcernes(choix, groupes, comptes);
  if (n === 0) return "Aucun compte n’y aura accès pour l’instant.";
  const jusqua = choix.visibility === "groups" && choix.groupIds.length > 1 ? "Jusqu’à " : "";
  const sujet = n === 1 ? "1 compte y aura" : `${n} comptes y auront`;
  return `${jusqua}${sujet} accès. Vous pourrez la dépublier à tout moment.`;
}

/** Message de validation avant envoi, ou `null` si le choix est publiable. */
export function validerChoix(
  choix: ChoixPublication,
  groupes: readonly GroupePublication[],
  peutPublierTous: boolean,
): string | null {
  if (choix.visibility === "all" && !peutPublierTous)
    return "Seul un administrateur peut publier à tous les comptes.";
  if (choix.visibility !== "groups") return null;
  if (choix.groupIds.length === 0) return "Choisissez au moins un groupe.";
  if (choix.groupIds.length > GROUPES_PUBLICATION_RAG_MAX)
    return `Au plus ${GROUPES_PUBLICATION_RAG_MAX} groupes.`;
  const connus = new Set(groupes.map((g) => g.id));
  if (!peutPublierTous && choix.groupIds.some((id) => !connus.has(id)))
    return "Un des groupes choisis n’existe plus.";
  return null;
}

/** Corps de `PUT .../publication` : `group_ids` n'a de sens que pour des groupes. */
export function corpsPublication(choix: ChoixPublication): DemandePublicationRag {
  return {
    visibility: choix.visibility,
    group_ids: choix.visibility === "groups" ? choix.groupIds : [],
    allow_source_open: choix.visibility === "private" ? false : choix.allowSourceOpen,
  };
}

/** Le choix est identique à la publication actuelle (rien à envoyer). */
export function choixInchange(
  choix: ChoixPublication,
  c: Pick<CollectionVueRag, "visibility" | "groups" | "allow_source_open">,
): boolean {
  const a = corpsPublication(choix);
  const b = corpsPublication(choixInitial(c));
  return (
    a.visibility === b.visibility &&
    a.allow_source_open === b.allow_source_open &&
    a.group_ids.length === b.group_ids.length &&
    a.group_ids.every((id) => b.group_ids.includes(id))
  );
}

const REFUS: Readonly<Record<string, string>> = {
  groupe_non_membre: "Vous ne pouvez publier qu’aux groupes dont vous êtes membre.",
  tous_reserve_admin: "Seul un administrateur peut publier à tous les comptes.",
  groupes_requis: "Choisissez au moins un groupe.",
  groupe_inconnu: "Un des groupes choisis n’existe plus.",
  trop_de_groupes: `Au plus ${GROUPES_PUBLICATION_RAG_MAX} groupes.`,
  lecture_seule: "Seul l’auteur d’une collection peut la publier.",
  collection_introuvable: "Cette collection n’existe plus.",
  rag_interdit: "Vous n’avez pas accès au RAG.",
};

/** Refus du serveur en clair : le code d'abord, puis le message du serveur, puis une phrase générique. */
export function messageRefusPublication(code: string | null, detail: string | null): string {
  if (code !== null && REFUS[code] !== undefined) return REFUS[code];
  return detail ?? "La publication a échoué.";
}
