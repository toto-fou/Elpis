<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/page/RechercheMessages.vue — barre de recherche dans la conversation : saisie, Échap pour fermer, nombre de résultats. -->
<script setup lang="ts">
import { CLE_CONVERSATION, domaine } from "../../../features/chat/page/domaines";

const conv = domaine(CLE_CONVERSATION);
</script>

<template>
  <div class="sticky top-0 z-10 mb-4">
    <div class="relative">
      <i class="ph ph-magnifying-glass absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm"></i>
      <input
        v-model="conv.messageSearch"
        type="text"
        placeholder="Rechercher dans la conversation..."
        class="w-full pl-9 pr-10 py-2.5 bg-white border border-blue-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-blue-400 shadow-sm"
        @keydown.escape="
          conv.messageSearchActive = false;
          conv.messageSearch = '';
        "
      />
      <span
        v-if="conv.messageSearchQ"
        class="absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-blue-500 font-bold"
      >
        {{ conv.messageSearchCount }} résultat(s)
      </span>
    </div>
  </div>
</template>
