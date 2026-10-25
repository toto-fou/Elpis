<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/page/PucesComposeur.vue — puces d'état de la rangée du composeur (interface nouvelle) : mode plan, tâches de la session, mode Images, contexte (bloc « Contexte N % » qui se remplit pendant le tour) ; boutons discrets, abrégés quand la rangée est étroite. -->
<script setup lang="ts">
import { computed } from "vue";

import { CLE_MODELES, CLE_PAGE, domaine } from "../../../features/chat/page/domaines";
import { compteTaches, puceContexte, SEUIL_CONTEXTE } from "../../../features/chat/page/puces";
import BarreImage from "./BarreImage.vue";

// `etroit` : rangée sous 420 px, libellés abrégés (les noms accessibles restent entiers).
const props = defineProps<{ etroit?: boolean }>();
const p = domaine(CLE_PAGE);
const mod = domaine(CLE_MODELES);

const contexte = computed(() => (mod.imageMode ? null : puceContexte(mod.liveGen, mod.ctxUsage)));
// Remplissage de la pastille : visible dès qu'un jeton occupe la fenêtre.
const largeurJauge = computed(() => {
  const part = contexte.value?.part ?? 0;
  return part > 0 ? Math.max(6, part * 100) + "%" : "0%";
});
const taches = computed(() => compteTaches(p.todoList ?? []));
const visible = computed(() => p.planMode || taches.value.total > 0 || p.imageMode || !!contexte.value);
const PUCE =
  "inline-flex items-center gap-1 h-7 px-1.5 rounded-lg text-xs font-medium text-slate-500 transition-colors";
</script>

<template>
  <div v-if="visible" class="flex flex-wrap items-center gap-0.5 min-w-0" data-puces-composeur>
    <span v-if="p.planMode" data-plan-chip>
      <button
        type="button"
        :class="[PUCE, 'hover:text-slate-700 hover:bg-slate-100']"
        title="Mode plan : outils d'écriture retirés jusqu'à la réponse ; se coupe seul une fois le plan rendu. Cliquer pour le couper."
        aria-label="Désactiver le mode plan"
        @click="p.setPlanMode(false)"
      >
        <i class="ph ph-binoculars text-sm" aria-hidden="true"></i>
        <span v-if="!props.etroit">Mode plan</span>
        <i class="ph ph-x text-[11px]" aria-hidden="true"></i>
      </button>
    </span>

    <div v-if="taches.total" class="relative" data-todo-flyout>
      <button
        type="button"
        :class="[
          PUCE,
          p.todoPanelOpen ? 'bg-slate-100 text-slate-700' : 'hover:text-slate-700 hover:bg-slate-100',
        ]"
        :title="taches.enCours || 'Tâches de la session'"
        :aria-label="`Tâches ${taches.faites} sur ${taches.total}`"
        :aria-expanded="p.todoPanelOpen ? 'true' : 'false'"
        aria-haspopup="true"
        data-puce-taches
        @click="p.todoPanelOpen = !p.todoPanelOpen"
      >
        <i class="ph ph-list-checks text-sm" aria-hidden="true"></i>
        <span class="tabular-nums"
          >{{ props.etroit ? "" : "Tâches " }}{{ taches.faites }}/{{ taches.total }}</span
        >
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

    <span
      v-if="contexte"
      class="elpis-jauge-contexte relative inline-flex items-center gap-1 h-5 px-2 rounded border border-slate-200 text-xs font-medium tabular-nums text-slate-600 overflow-hidden select-none"
      :class="contexte.pct >= SEUIL_CONTEXTE ? 'is-alerte' : ''"
      :title="contexte.titre"
      role="meter"
      aria-label="Contexte"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-valuenow="contexte.pct"
      data-puce-contexte
    >
      <span
        class="elpis-jauge-contexte__plein absolute inset-y-0 left-0"
        :style="{ width: largeurJauge }"
        aria-hidden="true"
        data-jauge-contexte
      ></span>
      <i
        v-if="contexte.pct >= SEUIL_CONTEXTE"
        class="ph ph-warning relative text-[12px]"
        aria-hidden="true"
      ></i>
      <span :class="props.etroit ? 'sr-only' : 'relative'">Contexte </span>
      <span class="relative">{{ contexte.pct }} %</span>
    </span>
  </div>
</template>
