<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/studio/InspecteurStudio.vue — barre d'inspection de l'élément survolé ou choisi (fil d'ancêtres, qualité et cible du script, fiche) : le survol ne re-rend qu'elle. -->
<script setup lang="ts">
import { domaineStudio } from "../../features/studio/domaine";

const sd = domaineStudio();
</script>

<template>
  <div
    v-if="sd.studioInspectInfo && sd.studioStageMode === 'inspect'"
    class="absolute bottom-3 left-3 right-3 z-20 flex justify-center pointer-events-none"
  >
    <div
      class="pointer-events-auto max-w-full bg-white/95 backdrop-blur border border-slate-200 shadow-lg rounded-lg text-xs elpis-studio-inspector"
    >
      <div class="flex items-center gap-1 px-2.5 h-8 min-w-0">
        <template v-for="c in sd.studioInspectInfo.crumbs" :key="c.id">
          <button
            :title="'Sélectionner ' + (c.role || '') + ' — ' + sd.elementDisplay(c)"
            class="text-slate-500 hover:text-blue-700 truncate max-w-[120px] shrink-0"
            @click="sd.selectStudioElement(c.id, true)"
          >
            {{ sd.elementDisplay(c) }}
          </button>
          <i class="ph ph-caret-right text-slate-300 text-xs shrink-0"></i>
        </template>
        <span
          class="font-semibold text-slate-800 truncate max-w-[200px]"
          :title="sd.elementDisplay(sd.studioInspectInfo.el)"
          >{{ sd.elementDisplay(sd.studioInspectInfo.el) }}</span
        >
        <span class="text-slate-400 shrink-0">· {{ sd.studioInspectInfo.el.role || "vision" }}</span>
        <span class="w-px h-4 bg-slate-200 mx-1 shrink-0"></span>
        <span
          class="text-xs font-semibold px-1 rounded shrink-0"
          :class="sd.qualityClass(sd.studioInspectInfo.quality)"
          :title="'Qualité de la cible : ' + sd.qualityLabel(sd.studioInspectInfo.quality)"
          >{{ sd.qualityLabel(sd.studioInspectInfo.quality) }}</span
        >
        <code
          class="font-mono text-xs text-slate-700 truncate max-w-[380px]"
          :title="sd.studioInspectInfo.target"
          >{{ sd.studioInspectInfo.target || "—" }}</code
        >
        <button
          title="Copier la cible"
          class="w-6 h-6 rounded hover:bg-slate-100 text-slate-400 hover:text-slate-700 flex items-center justify-center shrink-0"
          @click="sd.copyStudioTarget()"
        >
          <i class="ph ph-copy"></i>
        </button>
        <button
          title="Fiche de l'élément"
          class="w-6 h-6 rounded flex items-center justify-center shrink-0"
          :class="
            sd.studioInspectOpen
              ? 'bg-blue-50 text-blue-700'
              : 'hover:bg-slate-100 text-slate-400 hover:text-slate-700'
          "
          @click="sd.studioInspectOpen = !sd.studioInspectOpen"
        >
          <i class="ph ph-info"></i>
        </button>
      </div>
      <div
        v-if="sd.studioInspectOpen"
        class="border-t border-slate-100 px-2.5 py-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 max-h-40 overflow-y-auto custom-scrollbar"
      >
        <template v-for="row in sd.studioInspectRows" :key="row.k">
          <span class="text-slate-400">{{ row.k }}</span>
          <span class="font-mono text-slate-700 truncate" :title="row.v">{{ row.v }}</span>
        </template>
      </div>
    </div>
  </div>
</template>
