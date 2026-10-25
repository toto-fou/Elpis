<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/page/RechercheMessages.vue — barre de recherche dans la conversation : saisie, résultat précédent et suivant (Entrée, Maj+Entrée), fermeture (Échap ou bouton). -->
<script setup lang="ts">
import { computed, ref, watch } from "vue";

import { CLE_CONVERSATION, domaine } from "../../../features/chat/page/domaines";
import { positionVoisine, rangsTrouves } from "../../../features/chat/page/recherche-messages";

const conv = domaine(CLE_CONVERSATION);
const rangs = computed(() => rangsTrouves(conv.messages, conv.messageSearchQ));
const position = ref(-1);
watch(rangs, () => (position.value = -1));

const compteur = computed(() =>
  position.value >= 0
    ? `${position.value + 1} / ${rangs.value.length}`
    : `${conv.messageSearchCount} résultat(s)`,
);

function aller(sens: 1 | -1): void {
  const p = positionVoisine(position.value, rangs.value.length, sens);
  const rang = rangs.value[p];
  if (rang === undefined) return;
  position.value = p;
  conv.scrollToMessage(rang);
}

function fermer(): void {
  conv.messageSearchActive = false;
  conv.messageSearch = "";
}

function surEntree(e: KeyboardEvent): void {
  e.preventDefault();
  aller(e.shiftKey ? -1 : 1);
}
const BOUTON =
  "w-7 h-7 rounded-md flex items-center justify-center text-slate-500 hover:text-slate-800 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed";
</script>

<template>
  <div class="sticky top-0 z-10 mb-4">
    <div
      class="flex items-center gap-1 pl-3 pr-1.5 py-1 bg-white border border-blue-200 rounded-xl shadow-sm focus-within:ring-2 focus-within:ring-blue-400"
      role="search"
      aria-label="Rechercher dans la conversation"
    >
      <i class="ph ph-magnifying-glass text-slate-400 text-sm shrink-0" aria-hidden="true"></i>
      <input
        v-model="conv.messageSearch"
        type="text"
        placeholder="Rechercher dans la conversation..."
        aria-label="Rechercher dans la conversation"
        class="flex-1 min-w-0 px-1.5 py-1.5 bg-transparent text-sm outline-none"
        @keydown.escape="fermer"
        @keydown.enter="surEntree"
      />
      <span
        v-if="conv.messageSearchQ"
        class="shrink-0 px-1 text-[11px] text-blue-600 font-semibold tabular-nums"
        aria-live="polite"
        data-recherche-compteur
        >{{ compteur }}</span
      >
      <button
        type="button"
        :class="BOUTON"
        title="Résultat précédent (Maj+Entrée)"
        aria-label="Résultat précédent"
        :disabled="!rangs.length"
        data-recherche-precedent
        @click="aller(-1)"
      >
        <i class="ph ph-caret-up text-sm" aria-hidden="true"></i>
      </button>
      <button
        type="button"
        :class="BOUTON"
        title="Résultat suivant (Entrée)"
        aria-label="Résultat suivant"
        :disabled="!rangs.length"
        data-recherche-suivant
        @click="aller(1)"
      >
        <i class="ph ph-caret-down text-sm" aria-hidden="true"></i>
      </button>
      <button
        type="button"
        :class="BOUTON"
        title="Fermer la recherche (Échap)"
        aria-label="Fermer la recherche"
        data-recherche-fermer
        @click="fermer"
      >
        <i class="ph ph-x text-sm" aria-hidden="true"></i>
      </button>
    </div>
  </div>
</template>
