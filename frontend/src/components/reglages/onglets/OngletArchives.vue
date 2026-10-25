<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/reglages/onglets/OngletArchives.vue — onglet « archives » des Paramètres. -->
<script setup lang="ts">
import { domaineReglages } from "../../../features/reglages/domaine";

const rg = domaineReglages();
</script>

<template>
  <!-- eslint-disable vue/multiline-html-element-content-newline -->
  <div class="space-y-4 max-w-2xl">
    <div class="flex items-center justify-between">
      <div>
        <h3 class="text-base font-semibold text-slate-800 mb-0.5">Archives</h3>
        <p class="text-xs text-slate-500">
          {{ rg.archivesList.length }} conversation{{ rg.archivesList.length > 1 ? "s" : "" }} archivée{{
            rg.archivesList.length > 1 ? "s" : ""
          }}.
        </p>
      </div>
      <div class="flex gap-1.5">
        <button
          v-if="rg.archivesList.length > 0"
          class="text-xs px-2 py-1 rounded-md transition-colors"
          :class="rg.archiveSelectMode ? 'text-white bg-blue-600' : 'text-slate-500 hover:bg-slate-100'"
          @click="
            rg.archiveSelectMode = !rg.archiveSelectMode;
            rg.archiveSelected = [];
          "
        >
          <i class="ph" :class="rg.archiveSelectMode ? 'ph-x' : 'ph-check-square'"></i>
          {{ rg.archiveSelectMode ? "Annuler" : "Sélection" }}
        </button>
        <button
          v-if="rg.archiveSelectMode && rg.archiveSelected.length > 0"
          class="text-xs text-slate-600 bg-slate-100 hover:bg-slate-200 px-2 py-1 rounded-md transition-colors"
          title="Restaurer la sélection"
          aria-label="Restaurer la sélection"
          @click="rg.unarchiveSelectedArchives"
        >
          <i class="ph ph-arrow-u-up-left" aria-hidden="true"></i> Restaurer
          {{ rg.archiveSelected.length }}
        </button>
        <button
          v-if="rg.archiveSelectMode && rg.archiveSelected.length > 0"
          class="text-xs text-red-600 bg-red-50 hover:bg-red-100 px-2 py-1 rounded-md transition-colors"
          title="Supprimer la sélection"
          aria-label="Supprimer la sélection"
          @click="rg.deleteSelectedArchives"
        >
          <i class="ph ph-trash" aria-hidden="true"></i> Supprimer {{ rg.archiveSelected.length }}
        </button>
        <button
          aria-label="Rafraîchir les archives"
          class="text-xs text-slate-500 hover:text-slate-700 px-2 py-1 rounded-md hover:bg-slate-100 transition-colors"
          @click="rg.loadArchives"
        >
          <i class="ph ph-arrow-clockwise" aria-hidden="true"></i>
        </button>
      </div>
    </div>
    <div v-if="rg.archivesList.length === 0" class="text-center p-10 bg-slate-50 rounded-xl">
      <i class="ph ph-archive text-3xl text-slate-300 block mb-2"></i>
      <p class="text-sm text-slate-500">Aucune archive.</p>
    </div>
    <div v-else class="space-y-1.5">
      <div
        v-for="c in rg.archivesList"
        :key="c.id"
        class="bg-slate-50 hover:bg-white border rounded-lg p-3 flex items-center gap-3 group transition-colors"
        :class="
          rg.archiveSelected.includes(c.id)
            ? 'border-blue-300 bg-blue-50/50'
            : 'border-transparent hover:border-slate-200'
        "
      >
        <div
          v-if="rg.archiveSelectMode"
          class="shrink-0 cursor-pointer"
          @click="rg.toggleArchiveSelect(c.id)"
        >
          <div
            class="w-5 h-5 rounded border flex items-center justify-center transition-colors"
            :class="
              rg.archiveSelected.includes(c.id)
                ? 'bg-blue-600 border-blue-600'
                : 'border-slate-300 hover:border-blue-400'
            "
          >
            <i v-if="rg.archiveSelected.includes(c.id)" class="ph ph-check text-white text-xs"></i>
          </div>
        </div>
        <div class="min-w-0 flex-1">
          <div class="font-medium text-slate-800 text-sm truncate">{{ c.title }}</div>
          <div class="text-xs text-slate-500 mt-0.5">
            {{ new Date(c.updated_at * 1000).toLocaleString("fr-FR") }}
          </div>
        </div>
        <div
          v-if="!rg.archiveSelectMode"
          class="flex gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity"
        >
          <button
            title="Restaurer"
            aria-label="Restaurer la conversation"
            class="w-7 h-7 flex items-center justify-center bg-white border border-slate-200 hover:bg-slate-100 text-slate-600 rounded-md text-xs transition-colors"
            @click="rg.restoreArchive(c.id)"
          >
            <i class="ph ph-arrow-u-up-left" aria-hidden="true"></i>
          </button>
          <button
            title="Supprimer"
            aria-label="Supprimer la conversation"
            class="w-7 h-7 flex items-center justify-center bg-white border border-slate-200 hover:bg-red-50 hover:border-red-200 hover:text-red-600 text-slate-500 rounded-md text-xs transition-colors"
            @click="rg.deleteArchive(c.id, c.title)"
          >
            <i class="ph ph-trash" aria-hidden="true"></i>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
