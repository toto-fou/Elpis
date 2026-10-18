<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/page/FileAttente.vue — attente d'un créneau du moteur : position, progression, annuler. -->
<script setup lang="ts">
import { CLE_COMPOSEUR, domaine } from "../../../features/chat/page/domaines";

const comp = domaine(CLE_COMPOSEUR);
</script>

<template>
  <Transition name="queue-widget">
    <div
      v-if="comp.queueStatus && comp.queueStatus.kind !== 'loading'"
      role="status"
      aria-live="polite"
      class="mb-2 px-3 py-2 border rounded-xl text-xs flex items-center gap-3 shadow-sm bg-blue-50 border-blue-200"
    >
      <i class="ph ph-queue text-blue-600 text-base"></i>
      <div class="flex-1 min-w-0">
        <div class="font-semibold truncate text-blue-900">
          {{ comp.queueStatus.active }} requête(s) en cours · vous êtes {{ comp.queueStatus.position
          }}<sup v-if="comp.queueStatus.position === 1">er</sup><sup v-else>e</sup>
        </div>
        <div class="h-1 mt-1 rounded-full overflow-hidden bg-blue-100">
          <div
            v-if="typeof comp.queueStatus.pct !== 'number'"
            class="h-full rounded-full queue-progress-bar bg-blue-500"
            :style="{ animationDuration: comp.queueStatus.est_ms + 'ms' }"
          ></div>
          <div
            v-else
            class="h-full rounded-full bg-blue-500"
            :style="{ width: comp.queueStatus.pct + '%', transition: 'width 200ms linear' }"
          ></div>
        </div>
      </div>
      <span class="font-mono tabular-nums shrink-0 text-blue-700">
        <template v-if="typeof comp.queueStatus.pct === 'number'"
          >{{ Math.round(comp.queueStatus.pct) }} %</template
        >
        <template v-else>~{{ Math.round(comp.queueStatus.est_ms / 1000) }}s</template>
      </span>
      <button
        v-if="comp.isStreaming"
        title="Annuler"
        class="shrink-0 w-6 h-6 flex items-center justify-center rounded-md text-blue-600 hover:bg-blue-100 hover:text-blue-800 transition-colors"
        @click="comp.stopGeneration"
      >
        <i class="ph ph-x text-sm"></i>
      </button>
    </div>
  </Transition>
</template>
