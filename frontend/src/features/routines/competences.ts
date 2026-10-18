// SPDX-License-Identifier: MIT
/** frontend/src/features/routines/competences.ts — skills attachables à une routine : arbre du sélecteur, ids connus ou orphelins, libellés. */
import type { ResumeSkill } from "@elpis/contracts";

/** Miroir du plafond du serveur. */
export const MAX_SKILLS_ROUTINE = 12;

export interface NoeudSkill {
  skill: ResumeSkill;
  children: ResumeSkill[];
}

const idDe = (s: ResumeSkill): string => s.id || s.name;

export function idsConnus(liste: readonly ResumeSkill[]): Set<string> {
  const connus = new Set<string>();
  for (const s of liste) {
    connus.add(idDe(s));
    if (s.name) connus.add(s.name);
  }
  return connus;
}

/** Racines dépliables avec leurs descendants (préfixe d'id qualifié) ; les orphelins restent à plat. */
export function arbreSkills(liste: readonly ResumeSkill[]): NoeudSkill[] {
  const racines = liste.filter((s) => !s.parent_id);
  const reclames = new Set(racines.map(idDe));
  const noeuds = racines.map((r) => {
    const rid = idDe(r);
    const children = liste.filter((s) => s.parent_id && (s.id || "").indexOf(`${rid}/`) === 0);
    children.forEach((c) => reclames.add(idDe(c)));
    return { skill: r, children };
  });
  for (const s of liste) if (!reclames.has(idDe(s))) noeuds.push({ skill: s, children: [] });
  return noeuds;
}

/** Retire les ids inconnus (le serveur les refuserait) ; liste non chargée : tout est gardé. */
export function elaguerSkills(
  ids: readonly unknown[] | null | undefined,
  charges: boolean,
  liste: readonly ResumeSkill[],
): string[] {
  const propres = (ids || []).filter((id): id is string => typeof id === "string" && id.trim() !== "");
  if (!charges) return propres;
  const connus = idsConnus(liste);
  return propres.filter((id) => connus.has(id));
}

export function libelleFeuille(enfant: ResumeSkill, racine: ResumeSkill): string {
  const cid = idDe(enfant);
  const rid = idDe(racine);
  return cid.indexOf(`${rid}/`) === 0 ? cid.slice(rid.length + 1) : cid;
}

export function nombreDescendants(id: string, charges: boolean, liste: readonly ResumeSkill[]): number {
  if (!charges) return 0;
  const prefixe = `${id}/`;
  return liste.filter((s) => (s.id || "").indexOf(prefixe) === 0).length;
}

/** Badge de domaine, vide quand l'id affiché le montre déjà. */
export function badgeDomaine(s: Pick<ResumeSkill, "domain" | "id" | "name"> | null | undefined): string {
  const dom = s?.domain || "";
  if (!dom) return "";
  const affiche = s?.id || s?.name || "";
  if (affiche === dom || affiche.indexOf(`${dom}/`) === 0) return "";
  return dom;
}

export function infobulleSkill(id: string, charges: boolean, liste: readonly ResumeSkill[]): string {
  const s = liste.find((x) => idDe(x) === id || x.name === id);
  if (s) return s.description || "";
  return charges ? "Skill introuvable (supprimé ou renommé ?)" : "";
}
