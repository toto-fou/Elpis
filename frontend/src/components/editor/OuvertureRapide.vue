<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/editor/OuvertureRapide.vue — palette « Ouvrir un fichier » (Ctrl+P) : saisie, résultats, fichiers récents. -->
<script setup lang="ts">
import { domaineEditeur } from "../../features/editor/domaine";

const ed = domaineEditeur();
</script>

<template>
  <div
    v-if="ed.quickOpenVisible"
    class="fixed inset-0 z-[1000] flex items-start justify-center pt-24 px-4"
    @click.self="ed.closeQuickOpen"
  >
    <div class="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"></div>
    <div
      class="relative w-full max-w-xl bg-white border border-slate-200 rounded-xl shadow-2xl overflow-hidden"
    >
      <div class="flex items-center gap-2 px-4 py-3 border-b border-slate-200">
        <i class="ph ph-magnifying-glass text-slate-400"></i>
        <input
          id="elpis-quickopen-input"
          v-model="ed.quickOpenQuery"
          type="text"
          placeholder="Ouvrir un fichier... (tapez quelques lettres du nom)"
          class="flex-1 bg-transparent text-sm text-slate-800 placeholder-slate-400 outline-none"
          autocomplete="off"
          @keydown="ed.quickOpenKeyDown"
        />
        <kbd class="text-[10px] text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded border border-slate-200"
          >Esc</kbd
        >
      </div>
      <div class="max-h-80 overflow-y-auto custom-scrollbar">
        <div v-if="ed.quickOpenResults.length === 0" class="px-4 py-6 text-center text-xs text-slate-400">
          <i class="ph ph-file-x text-2xl block mb-1"></i>
          Aucun fichier ne correspond
        </div>
        <div
          v-for="(p, i) in ed.quickOpenResults"
          :key="p"
          class="flex items-center gap-2 px-4 py-1.5 cursor-pointer text-xs transition-colors"
          :class="
            i === ed.quickOpenSelectedIdx ? 'bg-blue-50 text-blue-700' : 'hover:bg-slate-50 text-slate-700'
          "
          @click="ed.quickOpenSelect(p)"
          @mouseenter="ed.quickOpenSelectedIdx = i"
        >
          <i class="ph ph-file text-slate-400 shrink-0"></i>
          <span class="font-medium truncate">{{ p.split("/").pop() }}</span>
          <span v-if="p.includes('/')" class="text-slate-400 truncate flex-1 ml-2">{{
            p.substring(0, p.lastIndexOf("/"))
          }}</span>
          <span v-else class="flex-1"></span>
          <span v-if="ed.quickOpenRecent.has(p)" class="shrink-0 text-[10px] text-slate-400">récent</span>
        </div>
      </div>
      <div
        class="flex items-center justify-between px-4 py-2 border-t border-slate-200 text-[10px] text-slate-400 bg-slate-50"
      >
        <span
          ><kbd class="bg-white px-1.5 py-0.5 rounded border border-slate-200">↑↓</kbd> naviguer •
          <kbd class="bg-white px-1.5 py-0.5 rounded border border-slate-200">Entrée</kbd> ouvrir</span
        >
        <span>{{ ed.quickOpenResults.length }} résultat{{ ed.quickOpenResults.length > 1 ? "s" : "" }}</span>
      </div>
    </div>
  </div>
</template>
