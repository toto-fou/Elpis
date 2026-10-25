<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/message/PiedMessage.vue — pied d'une réponse terminée : métriques, captures du navigateur (nouvelle interface) et actions (copier, détails, régénérer, lire) ; `texte` remplace le contenu copié ou lu (bulle regroupée). -->
<script setup lang="ts">
import { computed } from "vue";

import { capturesDuTour, visionneuseCaptures } from "../../../features/chat/message/captures-tour";
import { CLE_FIL, domaine } from "../../../features/chat/page/domaines";
import type { EntreeMessage } from "../../../features/chat/message/types";
import { interfaceApp } from "../../../features/reglages/interface";

const props = defineProps<{ entry: EntreeMessage; texte?: string }>();
const fil = domaine(CLE_FIL);
const ui = interfaceApp();
const captures = computed(() =>
  ui.classique || fil.settings.hide_web_screenshots
    ? []
    : visionneuseCaptures(capturesDuTour(props.entry.msg)).items,
);
</script>

<template>
  <div
    v-if="
      entry.msg.role === 'assistant' && !entry.msg.isStreaming && (!entry.msg.isError || !!entry.msg.content)
    "
    class="mt-2 flex items-center justify-between gap-3"
  >
    <div
      v-if="
        !fil.isImageMessage(entry.msg) &&
        entry.msg.metrics &&
        (entry.msg.metrics.model || entry.msg.metrics.duration || entry.msg.metrics.write_tps)
      "
      class="flex items-center gap-2 text-[11px] text-slate-400 font-mono select-none min-w-0"
      :title="fil.metricsTooltip(entry.msg.metrics)"
    >
      <i class="ph ph-gauge text-slate-300" style="font-size: 11px"></i>
      <span v-if="entry.msg.metrics.model" class="truncate max-w-[200px]">{{ entry.msg.metrics.model }}</span>
      <span
        v-if="entry.msg.metrics.model && (entry.msg.metrics.duration || entry.msg.metrics.write_tps)"
        class="text-slate-300"
        >·</span
      >
      <span v-if="entry.msg.metrics.duration" class="tabular-nums">{{
        fil.fmtElapsed(entry.msg.metrics.duration)
      }}</span>
      <span v-if="entry.msg.metrics.duration && entry.msg.metrics.read_tps" class="text-slate-300">·</span>
      <span v-if="entry.msg.metrics.read_tps" title="Vitesse de prefill"
        >↓ {{ entry.msg.metrics.read_tps }} jetons/s</span
      >
      <span v-if="entry.msg.metrics.read_tps && entry.msg.metrics.write_tps" class="text-slate-300">·</span>
      <span v-if="entry.msg.metrics.write_tps" title="Vitesse de génération"
        >↑ {{ entry.msg.metrics.write_tps }} jetons/s</span
      >
      <span v-if="fil.thinkingTokensOf(entry.msg.metrics)" class="text-slate-300">·</span>
      <span
        v-if="fil.thinkingTokensOf(entry.msg.metrics)"
        :title="
          'Raisonnement : ' +
          fil.fmtThinkingTokens(entry.msg.metrics) +
          ' jetons sur les ' +
          (entry.msg.metrics.output_tokens || 0).toLocaleString('fr-FR') +
          ' générés' +
          (entry.msg.metrics.thinking_tokens_estimated
            ? ' (estimé — tokenizer du modèle non accessible)'
            : '')
        "
        class="flex items-center gap-1"
      >
        <i class="ph ph-brain" style="font-size: 10px"></i>
        {{ fil.fmtThinkingTokens(entry.msg.metrics) }} tk
      </span>
      <span v-if="fil.cachePctOf(entry.msg.metrics)" class="text-slate-300">·</span>
      <span v-if="fil.cachePctOf(entry.msg.metrics)" :title="fil.cacheTitle(entry.msg.metrics)"
        >cache {{ fil.cachePctOf(entry.msg.metrics) }} %</span
      >
      <span v-if="entry.msg.metrics.kv_cache && entry.msg.metrics.kv_cache.total" class="text-slate-300"
        >·</span
      >
      <span
        v-if="entry.msg.metrics.kv_cache && entry.msg.metrics.kv_cache.total"
        :title="
          'Contexte au moment de la réponse : ' +
          entry.msg.metrics.kv_cache.used +
          ' / ' +
          entry.msg.metrics.kv_cache.total +
          ' jetons (' +
          entry.msg.metrics.kv_cache.pct +
          '%)'
        "
        class="flex items-center gap-1"
        :class="fil.kvDimClass(entry.msg.metrics.kv_cache.pct)"
      >
        <i class="ph ph-database" style="font-size: 10px"></i>
        {{ fil.fmtKvCache(entry.msg.metrics) }}
      </span>
    </div>
    <div v-else></div>

    <button
      v-if="captures.length"
      type="button"
      class="shrink-0 mr-auto flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-slate-500 hover:text-blue-600 hover:bg-slate-100 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
      data-voir-captures
      @click="fil.openImageViewer(captures, 0, { captures: true })"
    >
      <i class="ph ph-images text-[13px]" aria-hidden="true"></i
      >{{ captures.length > 1 ? captures.length + " captures" : "1 capture" }}
    </button>

    <div
      class="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity shrink-0"
    >
      <button
        v-if="!fil.isImageMessage(entry.msg)"
        title="Copier la réponse"
        class="text-slate-400 hover:text-blue-600 hover:bg-slate-100 rounded-md p-1 transition-colors"
        @click="fil.copyAssistantMessage(texte ?? entry.msg.content)"
      >
        <i class="ph ph-copy text-[14px]"></i>
      </button>
      <button
        v-if="entry.msg.run_ids && entry.msg.run_ids.length"
        title="Détails : chronologie de l'exécution (outils, modèle, durées)"
        aria-label="Détails de l'exécution"
        class="text-slate-400 hover:text-blue-600 hover:bg-slate-100 rounded-md p-1 transition-colors"
        @click="fil.openRunDetails(entry.msg)"
      >
        <i class="ph ph-list-magnifying-glass text-[14px]"></i>
      </button>
      <button
        v-if="!fil.isStreaming"
        :title="fil.isImageMessage(entry.msg) ? 'Régénérer les images' : 'Régénérer la réponse'"
        class="text-slate-400 hover:text-blue-600 hover:bg-slate-100 rounded-md p-1 transition-colors"
        @click="fil.retryGeneration(entry.idx)"
      >
        <i class="ph ph-arrow-clockwise text-[14px]"></i>
      </button>
      <button
        v-if="fil.voiceCanRead && !fil.isImageMessage(entry.msg)"
        :title="fil.voiceReadingIdx === entry.idx ? 'Arrêter la lecture' : 'Lire à voix haute'"
        :aria-label="
          fil.voiceReadingIdx === entry.idx ? 'Arrêter la lecture' : 'Lire la réponse à voix haute'
        "
        class="rounded-md p-1 transition-colors"
        :class="
          fil.voiceReadingIdx === entry.idx
            ? 'text-blue-600 bg-blue-50'
            : 'text-slate-400 hover:text-blue-600 hover:bg-slate-100'
        "
        @click="fil.speakMessage(entry.idx, texte ?? entry.msg.content)"
      >
        <i
          class="ph text-[14px]"
          :class="fil.voiceReadingIdx === entry.idx ? 'ph-stop' : 'ph-speaker-high'"
        ></i>
      </button>
    </div>
  </div>
</template>
