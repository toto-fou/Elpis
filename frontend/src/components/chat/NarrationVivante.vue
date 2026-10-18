<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/NarrationVivante.vue — narration en cours d'un tour à outils : Markdown incrémental (blocs figés et bloc actif), repli en texte brut. -->
<script setup lang="ts">
import { computed } from "vue";

import { ATTRIBUT_COMPOSANT } from "../../features/chat/rendu/enrichissement";

import type { BlocRendu } from "./ContenuMarkdown.vue";

export interface MessageNarration {
  _ppBlocks?: readonly BlocRendu[] | null;
  _ppActiveHtml?: string | null;
  _pendingPreContent?: string | null;
  _pendingToolThinking?: string | null;
}

const props = defineProps<{ msg: MessageNarration }>();
const emit = defineEmits<{ "click-markdown": [evenement: MouseEvent] }>();

const blocs = computed(() => props.msg._ppBlocks ?? []);
const actif = computed(() => props.msg._ppActiveHtml ?? "");
const proprietaire = { [ATTRIBUT_COMPOSANT]: "" };
const brut = computed(() => props.msg._pendingPreContent || props.msg._pendingToolThinking || "");
</script>

<!-- eslint-disable vue/no-v-html -- HTML produit par le moteur Markdown : purifié (crochet de marked) ou échappé. -->
<template>
  <div
    data-live-narration
    v-bind="proprietaire"
    aria-busy="true"
    class="markdown-body markdown-body--worklog bg-transparent mb-2"
    @click="emit('click-markdown', $event)"
  >
    <template v-if="props.msg._ppBlocks || actif">
      <template v-for="blk in blocs" :key="'pp' + blk.i">
        <div style="display: contents" v-html="blk.html"></div>
      </template>
      <div v-if="actif" style="display: contents" v-html="actif"></div>
    </template>
    <span v-else class="whitespace-pre-wrap break-words">{{ brut }}</span>
  </div>
</template>
