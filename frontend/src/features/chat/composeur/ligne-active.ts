// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/composeur/ligne-active.ts — garde visible la ligne active d'une liste de suggestions (« @ », « / ») en ne faisant défiler que la liste, jamais la page. */
import { nextTick, watch } from "vue";
import type { ShallowRef } from "vue";

export function suivreLigneActive(
  liste: Readonly<ShallowRef<HTMLElement | null>>,
  index: () => number,
  selecteur: string,
): void {
  watch(index, async (i) => {
    await nextTick();
    const el = liste.value;
    const ligne = el?.querySelectorAll<HTMLElement>(selecteur)[i];
    if (!el || !ligne) return;
    const haut = el.scrollTop;
    const fin = ligne.offsetTop + ligne.offsetHeight;
    if (fin > haut + el.clientHeight) el.scrollTop = fin - el.clientHeight;
    else if (ligne.offsetTop < haut) el.scrollTop = ligne.offsetTop;
  });
}
