<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/NarrationVivante.vue — narration en cours d'un tour à outils : Markdown incrémental (blocs figés et bloc actif, lus sur le porteur du message pendant le flux), repli en texte brut. -->
<script setup lang="ts">
import { computed } from "vue";

import { vBlocHtml } from "../../features/chat/rendu/bloc-html";
import { ATTRIBUT_COMPOSANT } from "../../features/chat/rendu/enrichissement";
import { listerBlocs } from "../../features/chat/rendu/flux-blocs";
import type { AffichageBlocs, PorteurFlux } from "../../features/chat/rendu/porteur-flux";

import type { BlocRendu } from "./ContenuMarkdown.vue";

export interface MessageNarration {
  _ppBlocks?: readonly BlocRendu[] | null;
  _ppActiveHtml?: string | null;
  _pendingPreContent?: string | null;
  _pendingToolThinking?: string | null;
  _flux?: Pick<PorteurFlux, "narration"> | null;
}

const props = defineProps<{ msg: MessageNarration }>();
const emit = defineEmits<{ "click-markdown": [evenement: MouseEvent] }>();

const vue = computed<AffichageBlocs>(
  () =>
    props.msg._flux?.narration.value ?? {
      blocs: props.msg._ppBlocks ?? null,
      actif: props.msg._ppActiveHtml ?? "",
    },
);
const actif = computed(() => vue.value.actif);
const liste = computed(() => listerBlocs(vue.value.blocs ?? [], actif.value));
const proprietaire = { [ATTRIBUT_COMPOSANT]: "" };
const brut = computed(() => props.msg._pendingPreContent || props.msg._pendingToolThinking || "");
</script>

<!-- HTML produit par le moteur Markdown, purifié (crochet de marked) ou échappé, posé par `v-bloc-html`. -->
<template>
  <div
    data-live-narration
    v-bind="proprietaire"
    aria-busy="true"
    class="markdown-body markdown-body--worklog bg-transparent mb-2"
    @click="emit('click-markdown', $event)"
  >
    <template v-if="vue.blocs || actif">
      <template v-for="blk in liste" :key="'pp' + blk.i">
        <div v-bloc-html="blk.html" style="display: contents"></div>
      </template>
    </template>
    <span v-else class="whitespace-pre-wrap break-words">{{ brut }}</span>
  </div>
</template>
