// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/jobs/horloge.ts — horloge d'une seconde (secondes d'époque à l'heure du serveur, comme les horodatages des tâches) qui ne tourne que tant que le volet est ouvert. */
import { onBeforeUnmount, ref, watch } from "vue";
import type { Ref } from "vue";

import { maintenantServeurS } from "../../../platform/horloge";

export function utiliserHorloge(actif: () => boolean): Ref<number> {
  const maintenant = ref(maintenantServeurS());
  let minuterie: ReturnType<typeof setInterval> | null = null;
  const arreter = (): void => {
    if (minuterie) clearInterval(minuterie);
    minuterie = null;
  };
  watch(
    actif,
    (v) => {
      arreter();
      if (!v) return;
      maintenant.value = maintenantServeurS();
      minuterie = setInterval(() => {
        maintenant.value = maintenantServeurS();
      }, 1000);
    },
    { immediate: true },
  );
  onBeforeUnmount(arreter);
  return maintenant;
}
