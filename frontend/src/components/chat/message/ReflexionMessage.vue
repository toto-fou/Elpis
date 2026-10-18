<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/message/ReflexionMessage.vue — bloc Réflexion en tête d'un message : replié par défaut, verrouillé sous hide_thinking, « Répondre maintenant » pendant le flux. -->
<script setup lang="ts">
import { onUpdated, useTemplateRef } from "vue";

import { CLE_FIL, domaine } from "../../../features/chat/page/domaines";

import { suivreReflexionOuverte } from "../../../utils/dom";
import type { EntreeMessage } from "../../../features/chat/message/types";

const props = defineProps<{ entry: EntreeMessage }>();
const fil = domaine(CLE_FIL);

function basculer(e: Event): void {
  const el = e.target as HTMLDetailsElement;
  fil.setMsgUi(props.entry, { thinkingOpen: el.open });
  suivreReflexionOuverte(el);
}

const bloc = useTemplateRef<HTMLDetailsElement>("bloc");

/** Pendant le flux, le raisonnement ouvert suit son dernier token. */
onUpdated(() => {
  if (!props.entry.msg.isStreaming || !fil.isStreaming) return;
  const pre = bloc.value?.open ? bloc.value.querySelector("pre") : null;
  if (pre) pre.scrollTop = pre.scrollHeight;
});

function bloquer(e: MouseEvent): void {
  if (fil.settings.hide_thinking && props.entry.msg.content) e.preventDefault();
}
</script>

<template>
  <div v-if="entry.msg.thinking" class="mb-2">
    <details
      ref="bloc"
      data-think
      :open="!(fil.settings.hide_thinking && entry.msg.content) && entry.msg.thinkingOpen"
      class="group/think"
      @toggle="basculer"
    >
      <summary
        class="list-none flex items-center gap-1.5 select-none w-fit py-0.5 text-slate-400 transition-colors"
        :class="
          fil.settings.hide_thinking && entry.msg.content
            ? 'cursor-default'
            : 'cursor-pointer hover:text-slate-600'
        "
        :aria-disabled="fil.settings.hide_thinking && entry.msg.content ? 'true' : undefined"
        :title="
          fil.settings.hide_thinking && entry.msg.content
            ? 'Affichage du raisonnement désactivé (Paramètres)'
            : undefined
        "
        @click="bloquer"
      >
        <i class="ph ph-brain text-slate-400/80" style="font-size: 11px"></i>
        <span
          class="text-[12.5px] font-semibold"
          :class="
            entry.msg.thinkingTruncated && !entry.msg.isStreaming
              ? 'text-amber-600'
              : !entry.msg.content && !entry.msg.isStreaming
                ? 'text-slate-700'
                : ''
          "
        >
          {{
            entry.msg.thinkingTruncated && !entry.msg.isStreaming
              ? "Réflexion interrompue"
              : !entry.msg.content && !entry.msg.isStreaming
                ? "Réponse"
                : "Réflexion…"
          }}
        </span>
        <span
          v-if="fil.fmtThinkingMeta(entry.msg)"
          class="text-[11px] font-mono text-slate-400 font-normal tabular-nums"
          >· {{ fil.fmtThinkingMeta(entry.msg) }}</span
        >
        <i
          v-if="!(fil.settings.hide_thinking && entry.msg.content)"
          class="ph ph-caret-right text-slate-300 transition-transform group-open/think:rotate-90"
          style="font-size: 9px"
        ></i>
        <i v-else class="ph ph-lock-simple text-slate-300" style="font-size: 9px"></i>

        <button
          v-if="
            entry.msg.isStreaming &&
            entry.idx === fil.lastAssistantIdx &&
            !entry.msg.content &&
            entry.msg.thinking
          "
          class="ml-2 inline-flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-700 hover:bg-slate-100/80 rounded px-1.5 py-0.5 transition-colors"
          title="Interrompre le raisonnement et passer directement à la réponse"
          @click.stop.prevent="fil.respondNow(entry.idx)"
        >
          <i class="ph ph-fast-forward text-[10px]"></i>
          Répondre maintenant
        </button>
      </summary>
      <div
        v-if="!(fil.settings.hide_thinking && entry.msg.content)"
        class="mt-1 pl-3 border-l-2 border-slate-200 ml-0.5"
      >
        <pre
          class="text-[11.5px] text-slate-600 leading-relaxed whitespace-pre-wrap break-words font-mono max-h-52 overflow-y-auto custom-scrollbar m-0 bg-transparent"
          >{{ entry.msg.thinking }}</pre>
      </div>
    </details>
  </div>
</template>
