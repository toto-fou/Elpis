<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/ContenuMarkdown.vue — corps Markdown d'un message : blocs figés et bloc actif pendant le flux, rendu complet en cache ensuite, enrichi (code, graphiques, Mermaid, SVG) par ce composant seul. -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, onUpdated, useTemplateRef } from "vue";

import {
  ATTRIBUT_COMPOSANT,
  annulerEnrichissement,
  balayerGraphiques,
  enrichirBlocs,
  planifierEnrichissement,
} from "../../features/chat/rendu/enrichissement";
import { moteurMarkdown } from "../../features/chat/rendu/instance";

export interface BlocRendu {
  i: number;
  html: string;
}

export interface MessageMarkdown {
  content?: string | null;
  displayContent?: string | null;
  isStreaming?: boolean;
  _mdBlocks?: readonly BlocRendu[] | null;
  _mdActiveHtml?: string | null;
}

const props = defineProps<{ msg: MessageMarkdown; recherche?: string | null }>();
const emit = defineEmits<{ "click-markdown": [evenement: MouseEvent] }>();
const moteur = moteurMarkdown();

const blocs = computed(() => props.msg._mdBlocks ?? []);
const actif = computed(() => props.msg._mdActiveHtml ?? "");
const html = computed(() => {
  const texte = props.msg.displayContent || props.msg.content || "";
  return props.recherche
    ? moteur.renderMarkdownHighlight(texte, props.recherche)
    : moteur.renderMarkdown(texte);
});
const racine = useTemplateRef<HTMLElement>("racine");
const proprietaire = { [ATTRIBUT_COMPOSANT]: "" };

let enrichi: { el: HTMLElement; html: string } | null = null;

/** Enrichit le corps rendu ; un nouveau rendu à HTML et racine égaux le laisse tel quel (Vue n'a pas réécrit le DOM). */
function enrichir(): void {
  const el = racine.value;
  if (props.msg.isStreaming || !el) return;
  if (enrichi && enrichi.el === el && enrichi.html === html.value) return;
  enrichi = { el, html: html.value };
  enrichirBlocs(el);
}

onMounted(() => planifierEnrichissement(enrichir));
onUpdated(enrichir);
onUnmounted(() => {
  annulerEnrichissement(enrichir);
  balayerGraphiques();
});
</script>

<!-- eslint-disable vue/no-v-html -- HTML produit par le moteur Markdown : purifié (crochet de marked) ou échappé. -->
<template>
  <div
    v-if="props.msg.isStreaming"
    v-bind="proprietaire"
    aria-busy="true"
    class="markdown-body bg-transparent"
  >
    <template v-for="blk in blocs" :key="blk.i">
      <div style="display: contents" v-html="blk.html"></div>
    </template>
    <div v-if="actif" style="display: contents" v-html="actif"></div>
    <span v-if="props.msg.content && !actif" class="elpis-stream-caret"></span>
  </div>
  <div
    v-else
    ref="racine"
    v-bind="proprietaire"
    class="markdown-body bg-transparent"
    @click="emit('click-markdown', $event)"
    v-html="html"
  ></div>
</template>
