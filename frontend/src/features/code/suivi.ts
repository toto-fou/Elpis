// SPDX-License-Identifier: MIT
/** frontend/src/features/code/suivi.ts — état d'interface du transcript opencode : repli des réflexions et des outils par part, horloge du statut « en cours » armée seulement pendant la génération. */
import { reactive, ref } from "vue";

import { fmtElapsedMs } from "../../utils/utils-purs";
import { etapes, formaterValeur, libelleOutil } from "./rendu";

export function creerSuiviRendu() {
  // `think` : replié par défaut (jamais d'auto-ouverture) ; le libellé animé signale l'activité.
  const codeUi = reactive<{ think: Record<string, boolean>; tool: Record<string, boolean> }>({
    think: {},
    tool: {},
  });
  function resetCodeUi(): void {
    codeUi.think = {};
    codeUi.tool = {};
  }
  /** Nouvel objet à chaque bascule : les lignes mémoïsées (v-memo) dépendent de l'identité de `codeUi.tool`. */
  function codeToggleTool(id: string): void {
    codeUi.tool = Object.assign({}, codeUi.tool, { [id]: !codeUi.tool[id] });
  }

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
    codeUi,
    resetCodeUi,
    codeToggleTool,
    codeSteps: etapes,
    codeFmtVal: formaterValeur,
    codeToolLabel: libelleOutil,
    codeElapsed,
    codeClock,
    codeNow,
  };
}

export type SuiviRendu = ReturnType<typeof creerSuiviRendu>;
