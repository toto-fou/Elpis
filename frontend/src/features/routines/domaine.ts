// SPDX-License-Identifier: MIT
/** frontend/src/features/routines/domaine.ts — domaine des routines injecté dans leurs composants SFC : surface du module plus les clés de la racine historique (app.js) que les gabarits lisent. */
import { inject, onMounted, provide } from "vue";
import type { InjectionKey, ShallowUnwrapRef } from "vue";

import { journal } from "../../platform/journal";
import type { CategorieMcp, SurfaceRoutines } from "./routines";

export interface AgentPerso {
  name: string;
  description?: string;
  [cle: string]: unknown;
}

export interface ConnecteurChoix {
  id: number | string;
  label?: string;
  name?: string;
  [cle: string]: unknown;
}

export interface ServeurEpingle {
  id: number | string;
  name?: string;
  type?: string;
  shared?: boolean;
  [cle: string]: unknown;
}

/** Clés de la racine (chat, réglages) lues par les gabarits des routines. */
export interface RacineRoutines {
  currentView: string;
  mcpUserCategories: CategorieMcp[];
  pinnedServers: ServeurEpingle[];
  pickerConnectors: ConnecteurChoix[];
  builtinAllowed: Record<string, boolean>;
  features: { agents?: boolean; [cle: string]: unknown } | null;
  settings: { custom_agents?: AgentPerso[]; [cle: string]: unknown };
  renderMarkdown(source: string): string;
  ouvrirAssistant(id: string, pre?: Record<string, string>): void;
}

export type DomaineRoutines = ShallowUnwrapRef<Omit<SurfaceRoutines, `_${string}`>> & RacineRoutines;

export const CLE_ROUTINES: InjectionKey<DomaineRoutines> = Symbol("elpis:routines");

/** Clés de la racine, complètes à la compilation ; `routines` témoigne de la surface du module. */
const CLES: Readonly<Record<keyof RacineRoutines | "routines", true>> = {
  currentView: true,
  mcpUserCategories: true,
  pinnedServers: true,
  pickerConnectors: true,
  builtinAllowed: true,
  features: true,
  settings: true,
  renderMarkdown: true,
  ouvrirAssistant: true,
  routines: true,
};

export function domaineRoutines(): DomaineRoutines {
  const valeur = inject(CLE_ROUTINES, null);
  if (valeur === null) throw new Error("domaine des routines non fourni");
  return valeur;
}

export function clesAbsentesRoutines(racine: object): string[] {
  return Object.keys(CLES).filter((k) => !(k in racine));
}

/** Fournit le domaine depuis la racine historique ; à appeler dans son `setup`. */
export function fournirDomaineRoutines(racine: object): void {
  provide(CLE_ROUTINES, racine as DomaineRoutines);
  onMounted(() => {
    const absentes = clesAbsentesRoutines(racine);
    if (absentes.length) journal.avertir(`[routines] domaine : absent de la racine : ${absentes.join(", ")}`);
  });
}
