<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/message/LigneReveil.vue — ligne compacte d'un réveil par tâche de fond (message origin « job_wake ») : résumé, texte exact remis au modèle en dépliant (rendu en texte) ; seule dans le fil ou intégrée à la bulle de l'agent. -->
<script setup lang="ts">
import { computed, ref } from "vue";

import type { ResumeReveil } from "@elpis/contracts";

import { resumeReveil } from "../../../features/chat/jobs/format";

const props = defineProps<{ wake: ResumeReveil | null | undefined; content: string; integree?: boolean }>();
const ouvert = ref(false);
const resume = computed(() => resumeReveil(props.wake));
</script>

<template>
  <div class="flex gap-4 text-xs" data-wake-line :data-wake-integree="props.integree ? '' : undefined">
    <span v-if="!props.integree" class="w-9 shrink-0" aria-hidden="true"></span>
    <div class="min-w-0 flex-1">
      <button
        class="flex items-center gap-1.5 max-w-full text-slate-500 hover:text-slate-700"
        :aria-expanded="ouvert ? 'true' : 'false'"
        title="Afficher le texte remis au modèle"
        @click="ouvert = !ouvert"
      >
        <i class="ph ph-alarm text-sm shrink-0"></i>
        <span class="min-w-0 break-words text-left" data-wake-summary>{{ resume }}</span>
        <i class="ph text-sm shrink-0" :class="ouvert ? 'ph-caret-up' : 'ph-caret-down'"></i>
      </button>
      <pre
        v-if="ouvert"
        data-wake-text
        class="mt-1.5 p-2 rounded-lg bg-slate-50 border border-slate-100 text-slate-600 font-mono whitespace-pre-wrap break-words max-h-64 overflow-y-auto custom-scrollbar"
        >{{ props.content }}</pre>
    </div>
  </div>
</template>
