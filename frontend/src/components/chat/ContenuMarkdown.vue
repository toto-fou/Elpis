<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/ContenuMarkdown.vue — corps Markdown d'un message : blocs figés et bloc actif pendant le flux et après (aucune reconstruction à la fin), rendu complet en cache pour les messages sans blocs, enrichi (code, graphiques, Mermaid, SVG) par ce composant seul. -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, onUpdated, useTemplateRef, watch } from "vue";

import { planifierColoration } from "../../features/chat/rendu/coloration";
import {
  ATTRIBUT_COMPOSANT,
  annulerEnrichissement,
  balayerGraphiques,
  enrichirBloc,
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
  /** Texte que les blocs rendent : le message garde ses blocs tant que son contenu lui est égal. */
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

const texte = computed(() => props.msg.displayContent || props.msg.content || "");
const enBlocs = computed(
  () =>
    !!props.msg.isStreaming || (!!props.msg._mdBlocks?.length && props.msg._mdFlux?.source === texte.value),
);
const actif = computed(() => props.msg._mdActiveHtml ?? "");
// Blocs affichés : figés puis actif ; la recherche surligne chaque bloc une fois le flux fini.
const liste = computed(() => {
  const l = listerBlocs(props.msg._mdBlocks ?? [], actif.value);
  const q = props.recherche;
  return q && !props.msg.isStreaming ? l.map((b) => ({ i: b.i, html: moteur.surlignerHtml(b.html, q) })) : l;
});
const caretSeul = computed(
  () => !!props.msg.isStreaming && !!props.msg.content && !actif.value && !props.msg._mdBlocks?.length,
);
const html = computed(() =>
  props.recherche
    ? moteur.renderMarkdownHighlight(texte.value, props.recherche)
    : moteur.renderMarkdown(texte.value),
);
const racine = useTemplateRef<HTMLElement>("racine");
const racineFlux = useTemplateRef<HTMLElement>("racineFlux");
const proprietaire = { [ATTRIBUT_COMPOSANT]: "" };
// Un `pre` sans habillage (bloc spécial) ou une référence `!id` de graphique : le seul HTML qui demande un parcours du DOM.
const A_ENRICHIR = /<pre(?![^>]*data-cb-done)|![0-9a-fA-F]{12}\b/;

let enrichi: { el: HTMLElement; html: string } | null = null;
let hoteVu: HTMLElement | null = null;
const vus: { colores: string[]; enrichis: string[]; pastilles: string[] } = {
  colores: [],
  enrichis: [],
  pastilles: [],
};

/** Rangs des blocs figés dont le HTML affiché a changé depuis le dernier passage de `vus` (un nouvel hôte repart de zéro). */
function nouveauxRangs(cle: keyof typeof vus): number[] {
  const el = racineFlux.value;
  if (el !== hoteVu) {
    hoteVu = el;
    for (const k of Object.keys(vus) as (keyof typeof vus)[]) vus[k] = [];
  }
  const l = liste.value;
  const n = l.length - (actif.value ? 1 : 0);
  const connus = vus[cle];
  const rangs: number[] = [];
  for (let i = 0; i < n; i++) {
    const h = l[i]?.html;
    if (h !== undefined && connus[i] !== h) {
      rangs.push(i);
      connus[i] = h;
    }
  }
  connus.length = n;
  return rangs;
}

/** Enrichit un corps rendu en bloc ; un nouveau rendu à HTML et racine égaux le laisse tel quel (Vue n'a pas réécrit le DOM). */
function enrichirComplet(): void {
  const el = racine.value;
  if (!el) return;
  if (enrichi && enrichi.el === el && enrichi.html === html.value) return;
  enrichi = { el, html: html.value };
  enrichirBlocs(el);
}

/** Enrichit en place les blocs dont le HTML vient de changer : seuls ceux qui portent un bloc spécial ou une référence de graphique sont parcourus, les autres vont à la coloration. */
function enrichirFlux(): void {
  const el = racineFlux.value;
  if (!el) return;
  const rangs = nouveauxRangs("enrichis");
  for (const i of rangs) {
    const bloc = el.children[i];
    const h = liste.value[i]?.html ?? "";
    if (!bloc) continue;
    if (A_ENRICHIR.test(h)) {
      balayerGraphiques();
      enrichirBloc(bloc);
    } else if (h.includes("code-wrapper")) planifierColoration(bloc);
  }
}

function enrichir(): void {
  if (props.msg.isStreaming) return;
  if (enBlocs.value) enrichirFlux();
  else enrichirComplet();
}

/** Confie à la coloration les blocs qui viennent d'être figés (ou réécrits) ; le corps entier n'est jamais parcouru. */
function colorerFiges(): void {
  const el = props.msg.isStreaming ? racineFlux.value : null;
  if (!el) return;
  for (const i of nouveauxRangs("colores")) {
    const bloc = el.children[i];
    if (bloc) planifierColoration(bloc);
  }
}

/** Pastilles des renvois [n] : pendant le flux, seulement les blocs qui viennent d'être figés et le bloc actif ; sinon (ou si `tout`) le corps entier. */
function poser(tout = false): void {
  const r = props.renvois;
  const flux = racineFlux.value;
  const el = racine.value ?? flux;
  if (!el || !r) return;
  if (flux && props.msg.isStreaming && !tout) {
    for (const i of nouveauxRangs("pastilles")) {
      const bloc = flux.children[i];
      if (bloc) poserPastilles(bloc as HTMLElement, r.resoudre);
    }
    const dernier = actif.value ? flux.children[liste.value.length - 1] : null;
    if (dernier) poserPastilles(dernier as HTMLElement, r.resoudre);
  } else poserPastilles(el, r.resoudre);
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
watch(
  () => [props.msg.rag_sources, props.renvois],
  () => poser(true),
  { flush: "post" },
);
watch(() => props.renvois?.courante() ?? null, marquer, { flush: "post" });
onUnmounted(() => {
  annulerEnrichissement(enrichir);
  balayerGraphiques();
});
</script>

<!-- eslint-disable vue/no-v-html -- HTML produit par le moteur Markdown : purifié (crochet de marked) ou échappé. -->
<template>
  <div
    v-if="enBlocs"
    ref="racineFlux"
    v-bind="proprietaire"
    :aria-busy="props.msg.isStreaming ? 'true' : undefined"
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
    <span v-if="caretSeul" class="elpis-stream-caret"></span>
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
