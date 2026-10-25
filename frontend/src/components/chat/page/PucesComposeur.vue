<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/page/PucesComposeur.vue — puces d'état au-dessus de la saisie (interface nouvelle) : mode plan, tâches de la session, mode Images, contexte ; elles passent à la ligne. -->
<script setup lang="ts">
import { computed } from "vue";

import { CLE_MODELES, CLE_PAGE, domaine } from "../../../features/chat/page/domaines";
import { compteTaches, puceContexte, SEUIL_CONTEXTE } from "../../../features/chat/page/puces";
import BarreImage from "./BarreImage.vue";

const p = domaine(CLE_PAGE);
const mod = domaine(CLE_MODELES);

const contexte = computed(() => (mod.imageMode ? null : puceContexte(mod.liveGen, mod.ctxUsage)));
const taches = computed(() => compteTaches(p.todoList ?? []));
const visible = computed(() => p.planMode || taches.value.total > 0 || p.imageMode || !!contexte.value);
const PUCE =
  "inline-flex items-center gap-1 h-7 px-2 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-600";
</script>

<template>
  <div v-if="visible" class="flex flex-wrap items-center gap-1.5 px-1.5 pt-1" data-puces-composeur>
    <span
      v-if="p.planMode"
      data-plan-chip
      :class="PUCE"
      title="Mode plan : outils d'écriture retirés jusqu'à la réponse ; se coupe seul une fois le plan rendu."
    >
      <i class="ph ph-binoculars text-sm" aria-hidden="true"></i>
      <span>Mode plan</span>
      <button
        type="button"
        title="Désactiver"
        aria-label="Désactiver le mode plan"
        class="-mr-1 w-6 h-6 rounded-md flex items-center justify-center text-slate-500 hover:text-slate-800 hover:bg-slate-100"
        @click="p.setPlanMode(false)"
      >
        <i class="ph ph-x text-xs" aria-hidden="true"></i>
      </button>
    </span>

    <div v-if="taches.total" class="relative" data-todo-flyout>
      <button
        type="button"
        :class="[PUCE, p.todoPanelOpen ? 'bg-slate-100 text-slate-800' : 'hover:bg-slate-100']"
        :title="taches.enCours || 'Tâches de la session'"
        :aria-expanded="p.todoPanelOpen ? 'true' : 'false'"
        aria-haspopup="true"
        data-puce-taches
        @click="p.todoPanelOpen = !p.todoPanelOpen"
      >
        <i class="ph ph-list-checks text-sm" aria-hidden="true"></i>
        <span>Tâches {{ taches.faites }}/{{ taches.total }}</span>
        <span
          v-if="taches.enCours"
          class="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse motion-reduce:animate-none"
          aria-hidden="true"
        ></span>
      </button>
      <Transition name="popover-up">
        <div
          v-if="p.todoPanelOpen"
          class="absolute bottom-full left-0 mb-2 w-80 max-w-[calc(100vw-2rem)] bg-white border border-slate-200 rounded-xl shadow-2xl z-[100] overflow-hidden"
        >
          <div class="px-3 py-2 flex items-center gap-2 border-b border-slate-100 bg-slate-50">
            <span class="text-xs font-semibold text-slate-800">Tâches de la session</span>
            <span class="text-xs text-slate-500 tabular-nums">{{ taches.faites }}/{{ taches.total }}</span>
            <button
              type="button"
              title="Fermer"
              aria-label="Fermer"
              class="ml-auto w-6 h-6 rounded-md flex items-center justify-center text-slate-500 hover:text-slate-800 hover:bg-slate-100"
              @click.stop="p.todoPanelOpen = false"
            >
              <i class="ph ph-x text-sm" aria-hidden="true"></i>
            </button>
          </div>
          <ul class="px-3 py-2 space-y-1.5 max-h-64 overflow-y-auto text-xs">
            <li v-for="(t, i) in p.todoList" :key="i" class="flex items-start gap-2">
              <i
                class="ph text-sm mt-0.5 shrink-0"
                :class="{
                  'ph-circle text-slate-400': t.status === 'pending',
                  'ph-circle-notch text-blue-600 animate-spin motion-reduce:animate-none':
                    t.status === 'in_progress',
                  'ph-check text-emerald-600': t.status === 'completed',
                  'ph-x text-slate-400': t.status === 'cancelled',
                }"
                aria-hidden="true"
              ></i>
              <span
                class="min-w-0 break-words"
                :class="{
                  'text-slate-700': t.status === 'pending',
                  'text-slate-900 font-medium': t.status === 'in_progress',
                  'text-slate-500 line-through': t.status === 'completed' || t.status === 'cancelled',
                }"
                >{{ t.content }}</span
              >
            </li>
          </ul>
        </div>
      </Transition>
    </div>

    <BarreImage />

    <span v-if="contexte" :class="PUCE" :title="contexte.titre" data-puce-contexte>
      <i
        v-if="contexte.pct >= SEUIL_CONTEXTE"
        class="ph ph-warning text-sm text-amber-600"
        aria-hidden="true"
      ></i>
      <span>Contexte {{ contexte.pct }} %</span>
    </span>
  </div>
</template>
