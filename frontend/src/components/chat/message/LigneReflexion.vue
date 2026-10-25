<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/message/LigneReflexion.vue — réflexion d'un tour à sa place dans le fil : « Réflexion · 3 s », dépliable ; verrouillée par le réglage qui masque le raisonnement ; « Répondre maintenant » pendant qu'elle s'écrit. -->
<script setup lang="ts">
import { onUpdated, useId, useTemplateRef } from "vue";

import { fmtDuree } from "../../../features/chat/outils/format";

const props = defineProps<{
  texte: string;
  ms: number | null;
  vivante: boolean;
  ouvert: boolean;
  verrouillee: boolean;
  repondre: boolean;
}>();
const emit = defineEmits<{ basculer: []; repondre: [] }>();
const id = useId();
const pre = useTemplateRef<HTMLPreElement>("pre");

// Ouverte pendant qu'elle s'écrit, elle suit son dernier mot.
onUpdated(() => {
  if (props.vivante && pre.value) pre.value.scrollTop = pre.value.scrollHeight;
});
</script>

<template>
  <div class="mb-1" data-reflexion>
    <div class="flex items-center gap-2">
      <button
        type="button"
        class="flex items-center gap-2 px-1.5 py-1 -mx-1.5 rounded-md text-left text-[13px] text-slate-500 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        :class="verrouillee ? 'cursor-default' : 'hover:bg-slate-100 hover:text-slate-700'"
        :aria-expanded="verrouillee ? undefined : ouvert ? 'true' : 'false'"
        :aria-controls="verrouillee ? undefined : id"
        :aria-disabled="verrouillee ? 'true' : undefined"
        :title="verrouillee ? 'Affichage du raisonnement désactivé (Paramètres)' : undefined"
        @click="verrouillee || emit('basculer')"
      >
        <i class="ph ph-brain shrink-0 text-[14px]" aria-hidden="true"></i>
        <span :class="vivante ? 'mem-wave' : ''"
          >{{ vivante ? "Réflexion…" : "Réflexion"
          }}<template v-if="ms !== null && !vivante"> · {{ fmtDuree(ms) }}</template></span
        >
        <i v-if="verrouillee" class="ph ph-lock-simple text-[11px] text-slate-400" aria-hidden="true"></i>
        <i
          v-else
          class="ph ph-caret-down text-[11px] text-slate-400 transition-transform"
          :class="ouvert ? 'rotate-180' : ''"
          aria-hidden="true"
        ></i>
      </button>
      <button
        v-if="repondre"
        type="button"
        class="min-h-6 inline-flex items-center gap-1 px-2 rounded-md text-[12px] text-slate-500 hover:text-slate-700 hover:bg-slate-100 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        title="Interrompre le raisonnement et passer directement à la réponse"
        @click="emit('repondre')"
      >
        <i class="ph ph-fast-forward text-[11px]" aria-hidden="true"></i> Répondre maintenant
      </button>
    </div>
    <pre
      v-if="ouvert && !verrouillee"
      :id="id"
      ref="pre"
      class="mt-0.5 ml-1.5 pl-3 border-l-2 border-slate-200 text-[12px] text-slate-600 leading-relaxed whitespace-pre-wrap break-words font-mono max-h-52 overflow-y-auto custom-scrollbar m-0 bg-transparent"
      >{{ texte }}</pre>
  </div>
</template>
