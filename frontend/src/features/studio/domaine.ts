// SPDX-License-Identifier: MIT
/** frontend/src/features/studio/domaine.ts — domaine du Studio injecté dans la page SFC : surfaces du menu, du mini-chat et de l'automatisation, plus la clé de la racine que le gabarit lit. */
import { inject, onMounted, provide } from "vue";
import type { InjectionKey, ShallowUnwrapRef } from "vue";

import { journal } from "../../platform/journal";
import type { SurfaceAutomatisationStudio } from "./automatisation";
import type { SurfaceDialogueStudio } from "./dialogue";
import type { SurfaceMenuStudio } from "./menu";

export interface RacineStudio {
  currentView: string;
}

export type DomaineStudio = ShallowUnwrapRef<SurfaceMenuStudio> &
  ShallowUnwrapRef<SurfaceDialogueStudio> &
  ShallowUnwrapRef<SurfaceAutomatisationStudio> &
  RacineStudio;

export const CLE_STUDIO: InjectionKey<DomaineStudio> = Symbol("elpis:studio");

const CLES: readonly string[] = ["currentView", "studioFrame", "studioTab", "autoCode"];

export function domaineStudio(): DomaineStudio {
  const valeur = inject(CLE_STUDIO, null);
  if (valeur === null) throw new Error("domaine du Studio non fourni");
  return valeur;
}

export function fournirDomaineStudio(racine: object): void {
  provide(CLE_STUDIO, racine as DomaineStudio);
  onMounted(() => {
    const absentes = CLES.filter((k) => !(k in racine));
    if (absentes.length) journal.avertir(`[studio] domaine : absent de la racine : ${absentes.join(", ")}`);
  });
}
