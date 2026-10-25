<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/page/AlerteContexte.vue — bannière de contexte presque plein : « Compacter » d'abord, « Nouveau chat » ensuite. -->
<script setup lang="ts">
import { computed } from "vue";

import { CLE_COMPOSEUR, domaine } from "../../../features/chat/page/domaines";

const comp = domaine(CLE_COMPOSEUR);
const compacterPossible = computed(() => !!comp.currentChatId && !comp.isStreaming);
</script>

<template>
  <div
    v-if="comp.conversationTooLong"
    role="status"
    class="mb-2 px-3 py-2 border rounded-xl text-xs flex flex-wrap items-center gap-2 shadow-sm bg-white border-slate-200"
    title="La conversation dépasse presque la fenêtre du modèle : compactez-la ou démarrez un nouveau chat."
    data-alerte-contexte
  >
    <i class="ph ph-warning text-amber-600 text-base shrink-0" aria-hidden="true"></i>
    <span class="flex-1 min-w-0 font-semibold text-slate-800"
      >Contexte presque plein · {{ comp.ctxRealPct }} %</span
    >
    <button
      type="button"
      class="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      :disabled="!compacterPossible"
      :title="compacterPossible ? 'Résumer l\'historique ancien (/compact)' : 'Possible hors génération'"
      data-alerte-compacter
      @click="comp.manualCompress()"
    >
      <i class="ph ph-arrows-in-simple text-xs" aria-hidden="true"></i> Compacter
    </button>
    <button
      type="button"
      class="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-slate-200 bg-white text-slate-700 text-xs font-medium hover:bg-slate-100 transition-colors"
      @click="comp.startNewChat"
    >
      <i class="ph ph-plus text-xs" aria-hidden="true"></i> Nouveau chat
    </button>
  </div>
</template>
