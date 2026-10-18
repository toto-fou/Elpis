<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/routines/ListeRoutines.vue — colonne de gauche : routines de l'utilisateur, pastille de la dernière exécution. -->
<script setup lang="ts">
import { domaineRoutines } from "../../features/routines/domaine";

const rt = domaineRoutines();
</script>

<template>
  <!-- LEFT: routines list — masquée pendant la création/édition -->
  <div v-if="!rt.routineIsEditing" class="w-80 shrink-0 border-r border-slate-200 flex flex-col min-h-0">
    <div class="flex-1 overflow-y-auto p-3 custom-scrollbar">
      <div v-if="rt.routinesLoading" class="text-center py-10">
        <i class="ph ph-spinner animate-spin text-slate-400 text-2xl"></i>
      </div>
      <div v-else-if="rt.routinesError" class="text-center py-10">
        <i class="ph ph-warning text-amber-400 text-2xl block mb-2"></i>
        <p class="text-sm text-slate-500">{{ rt.routinesError }}</p>
        <button
          class="mt-3 text-xs px-3 py-1.5 rounded-md bg-white border border-slate-200 hover:bg-slate-50 text-slate-600 transition-colors"
          @click="rt.loadRoutines"
        >
          Réessayer
        </button>
      </div>
      <div v-else-if="rt.routines.length === 0" class="text-center py-10 px-4">
        <i class="ph ph-clock-countdown text-slate-300 text-3xl block mb-2"></i>
        <p class="text-sm text-slate-500">Aucune routine.</p>
        <p class="text-xs text-slate-400 mt-1">Créez-en une avec « Nouvelle », en haut à droite.</p>
      </div>
      <template v-else>
        <button
          v-for="r in rt.routines"
          :key="r.id"
          :aria-current="rt.selectedRoutineId === r.id ? 'true' : undefined"
          class="w-full text-left px-2.5 py-2 rounded-lg mb-1 transition-colors group focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-500"
          :class="rt.selectedRoutineId === r.id ? 'bg-blue-50 ring-1 ring-blue-200' : 'hover:bg-slate-50'"
          @click="rt.viewRoutine(r)"
        >
          <div class="flex items-center gap-2">
            <span class="font-medium text-sm text-slate-800 truncate flex-1">{{ r.name }}</span>
            <span
              class="w-2 h-2 rounded-full shrink-0"
              :class="r.enabled ? 'bg-emerald-400' : 'bg-slate-300'"
              :title="r.enabled ? 'Active' : 'Désactivée'"
            ></span>
          </div>
          <p class="text-[11px] text-slate-500 mt-0.5 font-mono truncate">{{ r.cron_expr }}</p>
          <!-- Statut « d'un coup d'œil » de la dernière exécution (ou « en cours »). -->
          <div class="flex items-center gap-1.5 mt-1">
            <template v-if="r.running_count > 0">
              <span class="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse shrink-0"></span>
              <span class="text-[10px] font-medium text-blue-600">En cours…</span>
            </template>
            <template v-else-if="r.last_run">
              <span
                class="w-1.5 h-1.5 rounded-full shrink-0"
                :class="{
                  'bg-emerald-400': r.last_run.status === 'ok',
                  'bg-red-400': r.last_run.status === 'error' || r.last_run.status === 'orphaned',
                  'bg-slate-300': r.last_run.status === 'skipped',
                  'bg-slate-400': r.last_run.status === 'cancelled',
                }"
              ></span>
              <span class="text-[10px] text-slate-500 truncate"
                >{{ rt.runStatusLabel(r.last_run.status) }} · {{ rt.fmtRelTime(r.last_run.started_at) }}</span
              >
            </template>
            <template v-else>
              <span class="text-[10px] text-slate-400 italic">Jamais exécutée</span>
            </template>
          </div>
        </button>
      </template>
    </div>
  </div>
</template>
