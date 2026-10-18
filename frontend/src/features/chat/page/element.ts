// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/page/element.ts — publie au parent historique l'élément d'une référence de gabarit (défilement, focus, mesures), puis null au démontage. */
import { onBeforeUnmount, watch } from "vue";
import type { ShallowRef } from "vue";

export function publierElement<T extends Element>(
  cible: Readonly<ShallowRef<T | null>>,
  publier: (el: T | null) => void,
): void {
  watch(cible, (el) => publier(el), { flush: "sync" });
  onBeforeUnmount(() => publier(null));
}
