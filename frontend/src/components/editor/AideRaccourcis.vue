<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/editor/AideRaccourcis.vue — aide des raccourcis clavier de l'éditeur (Ctrl+/). -->
<script setup lang="ts">
import { domaineEditeur } from "../../features/editor/domaine";

const ed = domaineEditeur();
</script>

<template>
  <div
    v-if="ed.shortcutsModalVisible"
    class="fixed inset-0 z-[1001] flex items-center justify-center px-4"
    @click.self="ed.closeShortcutsModal"
    @keydown.esc="ed.closeShortcutsModal"
  >
    <div class="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"></div>
    <div
      class="relative w-full max-w-2xl bg-white border border-slate-200 rounded-xl shadow-2xl overflow-hidden max-h-[80vh] flex flex-col"
    >
      <div class="flex items-center gap-3 px-5 py-3 border-b border-slate-200 shrink-0">
        <i class="ph ph-keyboard text-blue-500 text-lg"></i>
        <h3 class="text-sm font-bold text-slate-800 flex-1">Raccourcis clavier</h3>
        <kbd class="text-[10px] text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded border border-slate-200"
          >Esc</kbd
        >
        <button
          class="text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded p-1 transition-colors"
          @click="ed.closeShortcutsModal"
        >
          <i class="ph ph-x text-sm"></i>
        </button>
      </div>

      <div class="flex-1 overflow-y-auto custom-scrollbar px-5 py-4">
        <div class="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-5">
          <div v-for="group in ed.shortcutGroups" :key="group.title">
            <h4 class="text-xs font-semibold text-slate-500 mb-2 flex items-center gap-1.5">
              <i
                class="ph text-xs"
                :class="
                  {
                    Navigation: 'ph-compass',
                    Édition: 'ph-pencil',
                    Affichage: 'ph-monitor',
                    Onglets: 'ph-tabs',
                    Arbre: 'ph-tree-structure',
                  }[group.title] || 'ph-circle-fill'
                "
              ></i>
              {{ group.title }}
            </h4>
            <ul class="space-y-1.5">
              <li
                v-for="item in group.items"
                :key="item.desc"
                class="flex items-center justify-between gap-3 text-[12px]"
              >
                <span class="text-slate-700 truncate">
                  {{ item.desc }}
                  <em v-if="item.note" class="text-[10px] text-slate-400 not-italic ml-1"
                    >({{ item.note }})</em
                  >
                </span>
                <span class="shrink-0 flex items-center gap-1">
                  <template v-for="(k, ki) in item.keys" :key="ki">
                    <kbd
                      class="text-[10px] font-mono bg-slate-100 text-slate-700 px-1.5 py-0.5 rounded border border-slate-200 shadow-sm"
                      >{{ k }}</kbd
                    >
                    <span v-if="ki < item.keys.length - 1" class="text-[10px] text-slate-400">+</span>
                  </template>
                </span>
              </li>
            </ul>
          </div>
        </div>
      </div>

      <div class="px-5 py-2 border-t border-slate-200 bg-slate-50 text-[10px] text-slate-500 shrink-0">
        Astuce : <kbd class="bg-white px-1.5 py-0.5 rounded border border-slate-200">Ctrl</kbd> +
        <kbd class="bg-white px-1.5 py-0.5 rounded border border-slate-200">/</kbd> rouvre cette aide à tout
        moment.
      </div>
    </div>
  </div>
</template>
