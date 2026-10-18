<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/page/ProgressionModele.vue — barre de chargement du modèle à côté du sélecteur. -->
<script setup lang="ts">
import { CLE_MODELES, domaine } from "../../../features/chat/page/domaines";

const mod = domaine(CLE_MODELES);
</script>

<template>
  <Transition name="model-load">
    <div
      v-if="mod.modelLoadingId && typeof mod.modelLoadPct === 'number'"
      role="progressbar"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-valuenow="Math.round(mod.modelLoadPct)"
      :aria-label="'Chargement de ' + mod.modelLoadingId"
      :title="'Chargement de ' + mod.modelLoadingId + (mod.modelLoadStage ? ' · ' + mod.modelLoadStage : '')"
      class="flex items-center gap-1.5 shrink-0"
    >
      <div class="w-16 h-1 rounded-full overflow-hidden bg-slate-200">
        <div
          class="h-full rounded-full bg-blue-500"
          :style="{ width: mod.modelLoadPct + '%', transition: 'width 200ms linear' }"
        ></div>
      </div>
      <span class="font-mono tabular-nums text-[10px] text-slate-500"
        >{{ Math.round(mod.modelLoadPct) }}%</span
      >
    </div>
  </Transition>
</template>
