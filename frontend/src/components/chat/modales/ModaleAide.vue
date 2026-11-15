<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/modales/ModaleAide.vue — guide utilisateur rendu en Markdown purifié, par morceaux (features/reglages/aide-rendu.ts). -->
<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";

import { domaineModales } from "../../../features/chat/modales/domaine";
import { monterGuide } from "../../../features/reglages/aide-rendu";
import type { GuideMonte } from "../../../features/reglages/aide-rendu";

const m = domaineModales();
const defilement = ref<HTMLElement | null>(null);
const corps = ref<HTMLElement | null>(null);
let guide: GuideMonte | null = null;

// Guide posé hors du gabarit, par morceaux, à l'ouverture et à chaque nouveau texte.
watch(
  [corps, () => m.readmeContent],
  ([el, texte]) => {
    guide?.detacher();
    guide = el && defilement.value && texte ? monterGuide(el, defilement.value, texte) : null;
  },
  { flush: "post" },
);
onBeforeUnmount(() => guide?.detacher());

// Lien vers un titre : le guide est posé jusqu'au morceau de sa cible avant que le clic la cherche.
function clic(ev: MouseEvent): void {
  const href = ev.target instanceof Element ? ev.target.closest("a")?.getAttribute("href") : null;
  if (href?.startsWith("#") && href.length > 1) guide?.poserJusqua(href);
  m.handleMarkdownClick(ev);
}
</script>

<template>
  <Transition name="modal">
    <div
      v-if="m.showHelpModal"
      data-a11y-modal
      role="dialog"
      aria-modal="true"
      aria-label="Aide"
      class="fixed inset-0 z-[6000] flex items-center justify-center bg-slate-900/80 p-4"
      @click.self="m.showHelpModal = false"
    >
      <div
        class="bg-slate-50 rounded-2xl shadow-2xl ring-1 ring-slate-200 w-full max-w-5xl max-h-[90vh] overflow-hidden flex flex-col"
      >
        <div class="p-5 border-b border-slate-200 flex justify-between items-center gap-3 bg-white shrink-0">
          <h2 class="text-lg font-bold text-slate-800 flex items-center gap-2 min-w-0">
            <div
              class="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center text-blue-600 shrink-0"
            >
              <i class="ph ph-book-open text-lg"></i>
            </div>
            <span class="truncate">Aide</span>
          </h2>
          <div class="flex items-center gap-3 shrink-0">
            <button
              aria-label="Fermer"
              class="w-8 h-8 rounded-lg hover:bg-slate-100 text-slate-500 transition-colors flex items-center justify-center"
              @click="m.showHelpModal = false"
            >
              <i class="ph ph-x text-lg"></i>
            </button>
          </div>
        </div>
        <div ref="defilement" class="flex-1 overflow-y-auto p-6 md:p-10 bg-white custom-scrollbar relative">
          <div
            v-if="m.isLoadingReadme"
            class="absolute inset-0 flex flex-col items-center justify-center bg-white z-10 text-slate-400"
          >
            <i class="ph ph-spinner-gap animate-spin text-4xl mb-3"></i>
            <p class="font-medium text-sm">Chargement...</p>
          </div>
          <div ref="corps" class="markdown-body max-w-4xl mx-auto" @click="clic"></div>
        </div>
      </div>
    </div>
  </Transition>
</template>
