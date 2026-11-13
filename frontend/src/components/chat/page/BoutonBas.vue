<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/page/BoutonBas.vue — bouton « descendre » au-dessus du composeur : saut jusqu'à un écran du bas, puis glissé court (immédiat en mouvement réduit). -->
<script setup lang="ts">
import { nextTick, useTemplateRef } from "vue";

import { CLE_CONVERSATION, domaine } from "../../../features/chat/page/domaines";
import { mouvementReduit } from "../../../utils/dom";

const conv = domaine(CLE_CONVERSATION);
const bouton = useTemplateRef<HTMLButtonElement>("bouton");
const GESTES = ["wheel", "touchstart", "touchmove", "pointerdown", "keydown"] as const;
const TOUCHES_HAUT = new Set(["PageUp", "Home", "ArrowUp"]);
let interrompre: (() => void) | null = null;

// Glissé sur le dernier écran vers le bas réel (relu à chaque image) ; seule une intention de remonter l'interrompt.
function glisser(fil: HTMLElement, depart: number, fin: () => void): () => void {
  const g = globalThis;
  const duree =
    parseFloat(g.getComputedStyle(g.document.documentElement).getPropertyValue("--duree-longue")) || 260;
  const t0 = g.performance.now();
  let actif = true;
  let toucheY = 0;
  const lacher = (): void => {
    actif = false;
    for (const geste of GESTES) fil.removeEventListener(geste, surGeste);
  };
  // Mêmes intentions que le fil (app/racine/defilement.ts) ; interrompu près du bas, le suivi reprend quand même.
  const surGeste = (e: Event): void => {
    const y = (e as TouchEvent).touches?.[0]?.clientY ?? 0;
    if (e.type === "touchstart") toucheY = y;
    const remonte =
      (e.type === "wheel" && (e as WheelEvent).deltaY < 0) ||
      (e.type === "touchmove" && y - toucheY > 10) ||
      (e.type === "keydown" && TOUCHES_HAUT.has((e as KeyboardEvent).key)) ||
      (e.type === "pointerdown" && e.target === fil);
    if (!remonte) return;
    lacher();
    if (fil.scrollHeight - fil.scrollTop - fil.clientHeight <= 30) fin();
  };
  for (const geste of GESTES) fil.addEventListener(geste, surGeste, { passive: true });
  fil.scrollTop = depart;
  const pas = (t: number): void => {
    if (!actif) return;
    const u = Math.min(1, (t - t0) / duree);
    fil.scrollTop = depart + (fil.scrollHeight - fil.clientHeight - depart) * (1 - (1 - u) ** 3);
    if (u < 1) {
      g.requestAnimationFrame(pas);
      return;
    }
    lacher();
    fin();
  };
  g.requestAnimationFrame(pas);
  return lacher;
}

// Saut par scrollToBottom (queue montée, verrou posé), puis glissé suivi coupé : le battement du flux reprend à la fin.
async function descendre(): Promise<void> {
  interrompre?.();
  const fil = bouton.value?.closest("main")?.querySelector<HTMLElement>(".elpis-fil") ?? null;
  const avant = fil?.scrollTop ?? 0;
  conv.isUserScrolling = false;
  conv.scrollToBottom(true);
  if (!fil || mouvementReduit()) return;
  conv.isUserScrolling = true;
  await nextTick();
  const depart = Math.max(avant, fil.scrollHeight - 2 * fil.clientHeight);
  interrompre = glisser(fil, depart, () => (conv.isUserScrolling = false));
}
</script>

<template>
  <transition name="fade">
    <button
      v-if="conv.messages.length >= 3 && conv.chatAwayFromBottom"
      ref="bouton"
      type="button"
      title="Aller en bas"
      aria-label="Aller en bas"
      :style="{ bottom: conv.scrollBtnBottom + 'px' }"
      class="absolute left-1/2 -translate-x-1/2 z-30 w-9 h-9 bg-white border border-slate-200 rounded-full shadow-lg flex items-center justify-center text-slate-500 hover:text-blue-600 hover:border-blue-300 transition-all"
      @click="descendre"
    >
      <i class="ph ph-arrow-down text-base" aria-hidden="true"></i>
    </button>
  </transition>
</template>
