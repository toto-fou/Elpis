<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/outils/PuceTaches.vue — puce Tâches (outil todowrite) de la barre de prompt et son volet ; la fermeture au clic extérieur suit [data-todo-flyout]. -->
<script setup lang="ts">
import { computed } from "vue";

import type { TacheSession } from "../../../features/chat/outils/types";

const props = defineProps<{ taches: readonly TacheSession[]; ouvert: boolean }>();
const emit = defineEmits<{ basculer: [ouvert: boolean] }>();

const faites = computed(() => props.taches.filter((t) => t.status === "completed").length);
const enCours = computed(() => props.taches.some((t) => t.status === "in_progress"));
const titre = computed(
  () => props.taches.find((t) => t.status === "in_progress")?.content || "Tâches de la session",
);
</script>

<template>
  <div class="relative shrink-0 flex items-center" data-todo-flyout>
    <button
      :aria-expanded="props.ouvert ? 'true' : 'false'"
      aria-haspopup="true"
      :title="titre"
      class="flex items-center gap-1 px-1.5 py-1 rounded-lg text-xs font-medium transition-colors"
      :class="
        props.ouvert
          ? 'bg-slate-100 text-slate-700'
          : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100'
      "
      @click="emit('basculer', !props.ouvert)"
    >
      <i class="ph ph-list-checks text-base"></i>
      <span class="font-mono tabular-nums">{{ faites }}/{{ props.taches.length }}</span>
      <span
        v-if="enCours"
        class="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse motion-reduce:animate-none"
        aria-hidden="true"
      ></span>
    </button>

    <Transition name="popover-up">
      <div
        v-if="props.ouvert"
        class="absolute bottom-full left-0 mb-2 w-80 bg-white border border-slate-200 rounded-xl shadow-2xl z-[100] overflow-hidden"
      >
        <div class="px-3 py-2 flex items-center gap-2 border-b border-slate-100 bg-slate-50">
          <i class="ph ph-list-checks text-slate-500 text-base"></i>
          <span class="text-xs font-bold text-slate-800">Tâches de la session</span>
          <span class="text-xs text-slate-500 tabular-nums"> {{ faites }}/{{ props.taches.length }} </span>
          <button
            class="ml-auto text-slate-400 hover:text-slate-800 p-0.5 rounded hover:bg-slate-100"
            title="Fermer"
            @click.stop="emit('basculer', false)"
          >
            <i class="ph ph-x text-sm"></i>
          </button>
        </div>
        <ul class="px-3 py-2 space-y-1.5 max-h-64 overflow-y-auto custom-scrollbar text-xs">
          <li v-for="(t, ti) in props.taches" :key="ti" class="flex items-start gap-2">
            <i
              class="ph text-sm mt-0.5 shrink-0"
              :class="{
                'ph-circle text-slate-300': t.status === 'pending',
                'ph-circle-notch text-blue-600 animate-spin motion-reduce:animate-none':
                  t.status === 'in_progress',
                'ph-check-circle text-emerald-600': t.status === 'completed',
                'ph-x-circle text-slate-400': t.status === 'cancelled',
              }"
            ></i>
            <span
              class="min-w-0 break-words"
              :class="{
                'text-slate-700': t.status === 'pending',
                'text-slate-900 font-medium': t.status === 'in_progress',
                'text-slate-400 line-through': t.status === 'completed' || t.status === 'cancelled',
              }"
              >{{ t.content }}</span
            >
            <span
              v-if="t.priority === 'high' && t.status !== 'completed' && t.status !== 'cancelled'"
              class="ml-auto shrink-0 text-[11px] text-amber-600 font-semibold"
              >haute</span
            >
          </li>
        </ul>
      </div>
    </Transition>
  </div>
</template>
