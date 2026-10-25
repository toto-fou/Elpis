// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/page/barres-defilement.ts — barres de défilement discrètes : la zone qui défile porte `.elpis-defile` une seconde (règles CSS en fin de style.css). */
import { onBeforeUnmount, onMounted } from "vue";

export const CLASSE_DEFILE = "elpis-defile";
const DUREE_MS = 1000;

/** Écoute les défilements du document (capture) tant que le composant est monté ; `actif` faux : rien n'est marqué. */
export function suivreDefilement(actif: () => boolean): void {
  const minuteries = new WeakMap<Element, ReturnType<typeof setTimeout>>();
  const surDefilement = (e: Event): void => {
    const el = e.target;
    if (!actif() || !(el instanceof Element)) return;
    el.classList.add(CLASSE_DEFILE);
    const avant = minuteries.get(el);
    if (avant) clearTimeout(avant);
    minuteries.set(
      el,
      setTimeout(() => {
        el.classList.remove(CLASSE_DEFILE);
        minuteries.delete(el);
      }, DUREE_MS),
    );
  };
  onMounted(() => document.addEventListener("scroll", surDefilement, { capture: true, passive: true }));
  onBeforeUnmount(() => document.removeEventListener("scroll", surDefilement, { capture: true }));
}
