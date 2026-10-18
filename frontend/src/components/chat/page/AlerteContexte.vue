<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/page/AlerteContexte.vue — bannière de contexte presque plein. -->
<script setup lang="ts">
import { CLE_COMPOSEUR, domaine } from "../../../features/chat/page/domaines";

const comp = domaine(CLE_COMPOSEUR);
</script>

<template>
  <div
    v-if="comp.conversationTooLong"
    class="mb-2 px-3 py-2 border rounded-xl text-xs flex items-center gap-3 shadow-sm bg-amber-50 border-amber-200"
  >
    <i class="ph ph-warning text-amber-600 text-base shrink-0"></i>
    <div class="flex-1 min-w-0 text-amber-900">
      <span class="font-semibold">Contexte du modèle presque plein ({{ comp.ctxRealPct }} %).</span>
      <span class="text-amber-700">
        La conversation est trop longue pour la fenêtre du modèle — compactez-la (/compact) ou démarrez un
        nouveau chat.</span
      >
    </div>
    <button
      class="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-md bg-amber-600 text-white text-[11px] font-medium hover:bg-amber-700 transition-colors"
      @click="comp.startNewChat"
    >
      <i class="ph ph-plus text-[11px]"></i> Nouveau chat
    </button>
  </div>
</template>
