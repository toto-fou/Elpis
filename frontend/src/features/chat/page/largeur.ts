// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/page/largeur.ts — largeur observée d'un élément monté : vrai sous un seuil (composeur étroit). */
import { onBeforeUnmount, onMounted, ref } from "vue";
import type { Ref, ShallowRef } from "vue";

export function suivreEtroit(el: Readonly<ShallowRef<HTMLElement | null>>, seuil: number): Ref<boolean> {
  const etroit = ref(false);
  let observateur: ResizeObserver | null = null;
  onMounted(() => {
    const cible = el.value;
    if (!cible || typeof ResizeObserver === "undefined") return;
    observateur = new ResizeObserver((entrees) => {
      const largeur = entrees[0]?.contentRect.width ?? cible.clientWidth;
      etroit.value = largeur > 0 && largeur < seuil;
    });
    observateur.observe(cible);
  });
  onBeforeUnmount(() => observateur?.disconnect());
  return etroit;
}
