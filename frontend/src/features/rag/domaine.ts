// SPDX-License-Identifier: MIT
/** frontend/src/features/rag/domaine.ts — domaine de la page RAG injecté dans ses composants : la surface du module, refs déballées. */
import { inject, onMounted, provide } from "vue";
import type { InjectionKey, UnwrapNestedRefs } from "vue";

import { journal } from "../../platform/journal";
import type { SurfaceRag } from "./rag";

export type DomaineRag = UnwrapNestedRefs<SurfaceRag>;

export const CLE_RAG: InjectionKey<DomaineRag> = Symbol("elpis:rag");

export function domaineRag(): DomaineRag {
  const valeur = inject(CLE_RAG, null);
  if (valeur === null) throw new Error("domaine du RAG non fourni");
  return valeur;
}

/** Domaine du RAG pour les composants du chat : `null` quand le module n'est pas monté (les sources restent du texte). */
export function domaineRagOptionnel(): DomaineRag | null {
  return inject(CLE_RAG, null);
}

/** Fournit le domaine depuis la racine (`ragPage`) ; sans module monté, la page n'a rien à afficher. */
export function fournirDomaineRag(racine: { ragPage?: DomaineRag | null }): void {
  if (!racine.ragPage) {
    onMounted(() => journal.avertir("[rag] module absent : page RAG indisponible"));
    return;
  }
  provide(CLE_RAG, racine.ragPage);
}
