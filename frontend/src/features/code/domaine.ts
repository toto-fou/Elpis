// SPDX-License-Identifier: MIT
/** frontend/src/features/code/domaine.ts — domaine de la page Code injecté dans ses composants SFC : surface du module plus les clés de la racine historique que le gabarit lit. */
import { inject, onMounted, provide } from "vue";
import type { InjectionKey, ShallowUnwrapRef } from "vue";

import { journal } from "../../platform/journal";
import type { SurfaceCode } from "./code";

export interface RacineCode {
  currentView: string;
  settings: Record<string, unknown>;
  logoApp: string;
  user: { avatar?: string; [cle: string]: unknown } | null;
  renderMarkdown(source: string): string;
  renderMarkdownLive(source: string): string;
  showOpenCodeModal: boolean;
}

export type DomaineCode = ShallowUnwrapRef<SurfaceCode> & RacineCode;

export const CLE_CODE: InjectionKey<DomaineCode> = Symbol("elpis:code");

const CLES: Readonly<Record<keyof RacineCode | "codeSessions", true>> = {
  currentView: true,
  settings: true,
  logoApp: true,
  user: true,
  renderMarkdown: true,
  renderMarkdownLive: true,
  showOpenCodeModal: true,
  codeSessions: true,
};

export function domaineCode(): DomaineCode {
  const valeur = inject(CLE_CODE, null);
  if (valeur === null) throw new Error("domaine de la page Code non fourni");
  return valeur;
}

export function fournirDomaineCode(racine: object): void {
  provide(CLE_CODE, racine as DomaineCode);
  onMounted(() => {
    const absentes = Object.keys(CLES).filter((k) => !(k in racine));
    if (absentes.length) journal.avertir(`[code] domaine : absent de la racine : ${absentes.join(", ")}`);
  });
}
