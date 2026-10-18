// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/jobs/horloge.ts — horloge d'une seconde (en secondes d'époque) qui ne tourne que tant que le volet est ouvert. */
import { onBeforeUnmount, ref, watch } from "vue";
import type { Ref } from "vue";

export function utiliserHorloge(actif: () => boolean): Ref<number> {
  const maintenant = ref(Date.now() / 1000);
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
      maintenant.value = Date.now() / 1000;
      minuterie = setInterval(() => {
        maintenant.value = Date.now() / 1000;
      }, 1000);
    },
    { immediate: true },
  );
  onBeforeUnmount(arreter);
  return maintenant;
}
