// SPDX-License-Identifier: MIT
/** frontend/src/features/code/suivi.ts — état d'interface du transcript opencode : horloge du statut « en cours » armée seulement pendant la génération, libellés des parts. */
import { ref } from "vue";

import { fmtElapsedMs } from "../../utils/utils-purs";
import { etapes, formaterValeur, libelleOutil } from "./rendu";

export function creerSuiviRendu() {
  const codeNow = ref(Date.now());
  let horloge: ReturnType<typeof setInterval> | null = null;
  function codeClock(on: boolean): void {
    if (on) {
      if (horloge) return;
      codeNow.value = Date.now();
      horloge = setInterval(() => {
        codeNow.value = Date.now();
      }, 1000);
    } else if (horloge) {
      clearInterval(horloge);
      horloge = null;
    }
  }
  function codeElapsed(depuis: number | null | undefined): string {
    if (!depuis) return "";
    return fmtElapsedMs(Math.max(0, codeNow.value - depuis), { live: true });
  }

  return {
    codeSteps: etapes,
    codeFmtVal: formaterValeur,
    codeToolLabel: libelleOutil,
    codeElapsed,
    codeClock,
    codeNow,
  };
}
