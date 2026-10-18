// SPDX-License-Identifier: MIT
/** frontend/src/features/skills/domaine.ts — domaine des skills injecté dans l'onglet SFC : surface du module plus les clés de la racine historique que le gabarit lit. */
import { inject, onMounted, provide } from "vue";
import type { InjectionKey, ShallowUnwrapRef } from "vue";

import { journal } from "../../platform/journal";
import type { SurfaceSkills } from "./skills";

export interface RacineSkills {
  settingsTab: string;
  renderMarkdown(source: string): string;
  handleMarkdownClick(ev: MouseEvent): unknown;
  startSkillAssistantChat(): unknown;
}

export type DomaineSkills = ShallowUnwrapRef<SurfaceSkills> & RacineSkills;

export const CLE_SKILLS: InjectionKey<DomaineSkills> = Symbol("elpis:skills");

const CLES: Readonly<Record<keyof RacineSkills | "skillsByScope", true>> = {
  settingsTab: true,
  renderMarkdown: true,
  handleMarkdownClick: true,
  startSkillAssistantChat: true,
  skillsByScope: true,
};

export function domaineSkills(): DomaineSkills {
  const valeur = inject(CLE_SKILLS, null);
  if (valeur === null) throw new Error("domaine des skills non fourni");
  return valeur;
}

export function fournirDomaineSkills(racine: object): void {
  provide(CLE_SKILLS, racine as DomaineSkills);
  onMounted(() => {
    const absentes = Object.keys(CLES).filter((k) => !(k in racine));
    if (absentes.length) journal.avertir(`[skills] domaine : absent de la racine : ${absentes.join(", ")}`);
  });
}
