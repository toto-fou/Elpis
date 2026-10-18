// SPDX-License-Identifier: MIT
/** frontend/src/features/images/tuile.ts — chronomètre de la tuile « en cours » : temps écoulé relevé du serveur aux changements d'état, avancé à la seconde. */
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { ComputedRef } from "vue";

import type { ProgressionImage } from "./formats";

export function chronometreTuile(
  progression: () => ProgressionImage | null | undefined,
  enErreur: () => boolean,
): ComputedRef<number> {
  const maintenant = ref(Date.now());
  let base = { at: Date.now(), s: 0 };
  let horloge: number | null = null;

  function arreter(): void {
    if (horloge) {
      window.clearInterval(horloge);
      horloge = null;
    }
  }

  watch(
    () => [progression() ? progression()?.elapsed_s : null, !!progression() && !enErreur()] as const,
    ([s, actif]) => {
      base = { at: Date.now(), s: Number(s) || 0 };
      maintenant.value = Date.now();
      if (actif && !horloge) {
        horloge = window.setInterval(() => {
          maintenant.value = Date.now();
        }, 1000);
      }
      if (!actif) arreter();
    },
    { immediate: true },
  );
  onBeforeUnmount(arreter);
  return computed(() => base.s + Math.max(0, Math.round((maintenant.value - base.at) / 1000)));
}
