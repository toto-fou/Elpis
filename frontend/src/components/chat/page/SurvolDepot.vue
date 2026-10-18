<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/page/SurvolDepot.vue — voile de dépôt de fichiers sur la colonne du chat. -->
<script setup lang="ts">
import { CLE_CONVERSATION, domaine } from "../../../features/chat/page/domaines";

const conv = domaine(CLE_CONVERSATION);
</script>

<template>
  <div
    v-if="conv.chatDragOver"
    class="elpis-dragover absolute inset-0 z-[100] pointer-events-none flex items-center justify-center"
    style="background: color-mix(in srgb, var(--accent) 8%, transparent); backdrop-filter: blur(2px)"
  >
    <div
      class="bg-white rounded-2xl shadow-2xl border-2 border-dashed border-blue-500 px-8 py-6 flex flex-col items-center gap-3 max-w-md"
    >
      <div class="w-14 h-14 rounded-full bg-blue-50 flex items-center justify-center">
        <i class="ph ph-upload-simple text-3xl text-blue-600"></i>
      </div>
      <div class="text-center">
        <div class="font-semibold text-slate-800 text-base">Déposer les fichiers ici</div>
        <div class="text-xs text-slate-500 mt-1">Ils seront joints à votre message (max 10)</div>
      </div>
    </div>
  </div>
</template>
