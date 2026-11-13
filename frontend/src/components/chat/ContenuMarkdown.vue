<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/ContenuMarkdown.vue — corps Markdown d'un message : blocs figés et bloc actif pendant le flux, rendu complet en cache ensuite, enrichi (code, graphiques, Mermaid, SVG) par ce composant seul. -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, onUpdated, useTemplateRef, watch } from "vue";

import { planifierColoration } from "../../features/chat/rendu/coloration";
import {
  ATTRIBUT_COMPOSANT,
  annulerEnrichissement,
  balayerGraphiques,
  enrichirBlocs,
  planifierEnrichissement,
} from "../../features/chat/rendu/enrichissement";
import { listerBlocs } from "../../features/chat/rendu/flux-blocs";
import { moteurMarkdown } from "../../features/chat/rendu/instance";
import { pastilleDe, poserPastilles } from "../../features/rag/renvois";
import type { RenvoisMessage } from "../../features/rag/renvois";

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
  /** Texte que les blocs rendent. */
  _mdFlux?: { source: string } | null;
  rag_sources?: readonly unknown[] | null;
}

const props = defineProps<{
  msg: MessageMarkdown;
  recherche?: string | null;
  /** Renvois [n] d'une réponse du RAG : pastilles posées après le rendu ; absent hors RAG. */
  renvois?: RenvoisMessage | null;
}>();
const emit = defineEmits<{ "click-markdown": [evenement: MouseEvent] }>();
const moteur = moteurMarkdown();

const actif = computed(() => props.msg._mdActiveHtml ?? "");
// Blocs figés puis bloc actif, sous la clé du prochain bloc figé : son nœud devient celui du bloc figé.
const liste = computed(() => listerBlocs(props.msg._mdBlocks ?? [], actif.value));
const html = computed(() => {
  const texte = props.msg.displayContent || props.msg.content || "";
  return props.recherche
    ? moteur.renderMarkdownHighlight(texte, props.recherche)
    : moteur.renderMarkdown(texte);
});
const racine = useTemplateRef<HTMLElement>("racine");
const racineFlux = useTemplateRef<HTMLElement>("racineFlux");
const proprietaire = { [ATTRIBUT_COMPOSANT]: "" };

let enrichi: { el: HTMLElement; html: string } | null = null;
let figesVus = 0;
let dernierHtml = "";

/** Enrichit le corps rendu ; un nouveau rendu à HTML et racine égaux le laisse tel quel (Vue n'a pas réécrit le DOM). */
function enrichir(): void {
  const el = racine.value;
  if (props.msg.isStreaming || !el) return;
  if (enrichi && enrichi.el === el && enrichi.html === html.value) return;
  enrichi = { el, html: html.value };
  enrichirBlocs(el);
}

/** Confie à la coloration les blocs qui viennent d'être figés, et le dernier déjà vu dont le HTML a été réécrit ; le corps entier n'est jamais parcouru. */
function colorerFiges(): void {
  const el = props.msg.isStreaming ? racineFlux.value : null;
  const b = el ? (props.msg._mdBlocks ?? []) : [];
  const n = b.length;
  const dernier = b[n - 1]?.html ?? "";
  if (n === figesVus && dernier === dernierHtml) return;
  for (let i = Math.max(0, Math.min(n, figesVus) - 1); i < n; i++) {
    const bloc = el?.children[i];
    if (bloc) planifierColoration(bloc);
  }
  figesVus = n;
  dernierHtml = dernier;
}

/** Pastilles des renvois [n] (pendant le flux comme à la fin) et marque celle dont la bulle ou la visionneuse est ouverte. */
function poser(): void {
  const el = racine.value ?? racineFlux.value;
  const r = props.renvois;
  if (!el || !r) return;
  poserPastilles(el, r.resoudre);
  marquer();
}

function marquer(): void {
  const el = racine.value ?? racineFlux.value;
  if (!el || !props.renvois) return;
  const n = props.renvois.courante();
  for (const p of el.querySelectorAll<HTMLElement>("[data-rag-n]"))
    p.classList.toggle("is-on", n !== null && p.dataset["ragN"] === String(n));
}

function surSurvol(e: Event): void {
  const p = pastilleDe(e.target);
  if (p && props.renvois) props.renvois.survol(p.n, p.el);
}

function surSortie(e: Event): void {
  if (pastilleDe(e.target) && props.renvois) props.renvois.sortie();
}

function surClic(e: MouseEvent): void {
  const p = pastilleDe(e.target);
  if (p && props.renvois) {
    e.preventDefault();
    props.renvois.ouvrir(p.n, p.el);
    return;
  }
  emit("click-markdown", e);
}

onMounted(() => {
  planifierEnrichissement(enrichir);
  colorerFiges();
  poser();
});
onUpdated(() => {
  enrichir();
  colorerFiges();
  poser();
});
watch(() => [props.msg.rag_sources, props.renvois], poser, { flush: "post" });
watch(() => props.renvois?.courante() ?? null, marquer, { flush: "post" });
onUnmounted(() => {
  annulerEnrichissement(enrichir);
  balayerGraphiques();
});
</script>

<!-- eslint-disable vue/no-v-html -- HTML produit par le moteur Markdown : purifié (crochet de marked) ou échappé. -->
<template>
  <div
    v-if="props.msg.isStreaming"
    ref="racineFlux"
    v-bind="proprietaire"
    aria-busy="true"
    class="markdown-body bg-transparent"
    @mouseover="surSurvol"
    @mouseout="surSortie"
    @focusin="surSurvol"
    @focusout="surSortie"
    @click="surClic"
  >
    <template v-for="blk in liste" :key="blk.i">
      <div style="display: contents" v-html="blk.html"></div>
    </template>
    <span
      v-if="props.msg.content && !actif && !props.msg._mdBlocks?.length"
      class="elpis-stream-caret"
    ></span>
  </div>
  <div
    v-else
    ref="racine"
    v-bind="proprietaire"
    class="markdown-body bg-transparent"
    @mouseover="surSurvol"
    @mouseout="surSortie"
    @focusin="surSurvol"
    @focusout="surSortie"
    @click="surClic"
    v-html="html"
  ></div>
</template>
