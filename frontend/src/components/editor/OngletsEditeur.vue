<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/editor/OngletsEditeur.vue — barre d'onglets de l'éditeur : onglets (clavier, glisser-déposer, menu), badge « +X » des onglets hors de vue et sa liste ; possède l'observateur de taille de la barre. -->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, useTemplateRef } from "vue";

import { deplacerOnglet, partiesLibelle } from "../../features/editor/onglets";
import type { MetaFichier, OngletEditeur } from "../../features/editor/onglets";

const props = defineProps<{
  visible: boolean;
  onglets: OngletEditeur[];
  actif: string | null;
  modifies: ReadonlySet<string>;
  ongletDroit: string | null;
  indices: Readonly<Record<string, string>>;
  caches: number;
  debordement: boolean;
  metaFichier: (nom: string) => MetaFichier;
}>();
const emit = defineEmits<{
  activer: [chemin: string];
  basculer: [chemin: string];
  fermer: [chemin: string, e: Event];
  menu: [e: Event & { clientX: number; clientY: number }, chemin: string];
  reordonner: [onglets: OngletEditeur[]];
  choisir: [chemin: string];
  "update:caches": [n: number];
  "update:debordement": [ouvert: boolean];
}>();

const barre = useTemplateRef<HTMLDivElement>("barre");
const cibleDepot = ref("");
let source: string | null = null;
let observateur: ResizeObserver | null = null;

/** Compte les onglets entièrement hors de la fenêtre visible de la barre. */
function mesurer(): void {
  const el = barre.value;
  if (!el || el.clientWidth === 0) {
    if (props.caches !== 0) emit("update:caches", 0);
    return;
  }
  const boite = el.getBoundingClientRect();
  let n = 0;
  for (const enfant of el.children) {
    if (enfant.getAttribute("role") !== "tab") continue;
    const r = enfant.getBoundingClientRect();
    if (r.right <= boite.left + 1 || r.left >= boite.right - 1) n++;
  }
  if (n !== props.caches) emit("update:caches", n);
}

/** Ramène un onglet dans la vue par défilement horizontal seul (pas de scrollIntoView, qui déplace aussi les ancêtres). */
function defiler(chemin: string | null): void {
  const el = barre.value;
  if (!el || !chemin || el.clientWidth === 0) return;
  let onglet: Element | null;
  try {
    onglet = el.querySelector(
      `[data-path="${typeof CSS !== "undefined" && CSS.escape ? CSS.escape(chemin) : chemin}"]`,
    );
  } catch {
    return;
  }
  if (!onglet) return;
  const r = onglet.getBoundingClientRect();
  const b = el.getBoundingClientRect();
  if (r.left < b.left) el.scrollLeft += r.left - b.left;
  else if (r.right > b.right) el.scrollLeft += Math.min(r.right - b.right, r.left - b.left);
}

function cycler(sens: 1 | -1): void {
  const liste = props.onglets;
  if (!liste.length) return;
  const i = liste.findIndex((t) => t.path === props.actif);
  const suivant = liste[(i + sens + liste.length) % liste.length];
  if (suivant) emit("basculer", suivant.path);
}

function voisin(e: KeyboardEvent, sens: 1 | -1): void {
  const courant = e.currentTarget as HTMLElement;
  const v = sens === 1 ? courant.nextElementSibling : courant.previousElementSibling;
  if (!(v instanceof HTMLElement) || v.getAttribute("role") !== "tab") return;
  v.focus();
  emit("basculer", v.dataset["path"] ?? "");
}

function menuClavier(e: KeyboardEvent, chemin: string): void {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  emit("menu", Object.assign(e, { clientX: r.left, clientY: r.bottom }), chemin);
}

function debutGlisser(e: DragEvent, chemin: string): void {
  source = chemin;
  try {
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("application/x-elpis-tab", chemin);
    }
  } catch {
    /* dataTransfer indisponible */
  }
}
function survol(e: DragEvent, chemin: string): void {
  if (!source) return;
  e.preventDefault();
  cibleDepot.value = chemin;
}
function finGlisser(): void {
  source = null;
  cibleDepot.value = "";
}
function deposer(chemin: string): void {
  const src = source;
  finGlisser();
  const liste = src ? deplacerOnglet(props.onglets, src, chemin) : null;
  if (liste) emit("reordonner", liste);
}

function dossier(chemin: string): string {
  return chemin.includes("/") ? chemin.slice(0, chemin.lastIndexOf("/")) : "";
}

onMounted(() => {
  if (barre.value && typeof ResizeObserver !== "undefined") {
    observateur = new ResizeObserver(() => mesurer());
    observateur.observe(barre.value);
  }
  mesurer();
});
onBeforeUnmount(() => {
  observateur?.disconnect();
  observateur = null;
});

defineExpose({ mesurer, defiler });
</script>

<template>
  <div
    v-show="props.visible"
    ref="barre"
    role="tablist"
    aria-label="Onglets ouverts"
    class="flex-1 flex overflow-x-auto custom-scrollbar no-scrollbar items-end h-full px-1"
    @scroll.passive="mesurer"
    @keydown.ctrl.page-down.prevent="cycler(1)"
    @keydown.ctrl.page-up.prevent="cycler(-1)"
  >
    <div
      v-for="tab in props.onglets"
      :key="tab.path"
      role="tab"
      :aria-selected="props.actif === tab.path ? 'true' : 'false'"
      :tabindex="props.actif === tab.path ? 0 : -1"
      :data-path="tab.path"
      draggable="true"
      class="elpis-editor-tab group flex items-center px-3 py-1 cursor-pointer select-none text-[12px] transition-colors border-r border-white/5 h-full outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-blue-500"
      :class="[
        props.actif === tab.path
          ? 'bg-[#1e1e1e] text-white border-t-2 border-t-blue-500'
          : 'text-slate-500 hover:bg-white/5',
        props.ongletDroit === tab.path ? 'border-b-2 border-b-blue-500' : '',
        cibleDepot === tab.path ? 'elpis-tab-drop' : '',
        tab.pinned ? 'is-pinned' : '',
      ]"
      :title="tab.path + (tab.pinned ? ' (épinglé)' : '')"
      @dragstart="debutGlisser($event, tab.path)"
      @dragover="survol($event, tab.path)"
      @drop.prevent="deposer(tab.path)"
      @dragend="finGlisser"
      @click="emit('activer', tab.path)"
      @contextmenu="emit('menu', $event, tab.path)"
      @mouseup.middle.prevent="emit('fermer', tab.path, $event)"
      @keydown.enter.prevent="emit('basculer', tab.path)"
      @keydown.space.prevent="emit('basculer', tab.path)"
      @keydown.right.prevent="voisin($event, 1)"
      @keydown.left.prevent="voisin($event, -1)"
      @keydown.delete.prevent="emit('fermer', tab.path, $event)"
      @keydown.f10.shift.prevent="menuClavier($event, tab.path)"
      @keydown.context-menu.prevent="menuClavier($event, tab.path)"
    >
      <i
        v-if="props.ongletDroit === tab.path"
        class="ph ph-columns text-blue-400 text-[10px] mr-1 shrink-0"
      ></i>
      <i
        v-if="tab.pinned"
        class="ph ph-push-pin-simple text-slate-400 text-[10px] mr-1 shrink-0"
        aria-label="Épinglé"
      ></i>
      <i
        class="ph text-[12px] mr-1.5 shrink-0"
        :class="[props.metaFichier(tab.name).icon, props.metaFichier(tab.name).color]"
      ></i>
      <span class="elpis-editor-tab-label"
        ><span class="elpis-editor-tab-head">{{ partiesLibelle(tab.name).head }}</span
        ><span class="elpis-editor-tab-tail">{{ partiesLibelle(tab.name).tail }}</span
        ><span
          v-if="props.indices[tab.path]"
          class="elpis-editor-tab-hint text-[10px] text-slate-500 font-mono"
          >{{ props.indices[tab.path] }}</span
        ></span
      >
      <span
        v-if="props.modifies.has(tab.path)"
        title="Modifications non sauvegardées"
        class="block w-2 h-2 rounded-full bg-amber-400 m-1 shrink-0 group-hover:hidden group-focus-within:hidden"
      ></span>
      <button
        tabindex="-1"
        :aria-label="'Fermer ' + tab.name"
        class="focus-visible:ring-1 focus-visible:ring-blue-500 hover:bg-white/20 rounded p-0.5"
        :class="
          props.modifies.has(tab.path)
            ? 'hidden group-hover:block group-focus-within:block'
            : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100'
        "
        @click.stop="emit('fermer', tab.path, $event)"
      >
        <i class="ph ph-x text-[10px]"></i>
      </button>
    </div>
  </div>
  <div
    v-show="props.visible && props.caches > 0"
    class="relative shrink-0 h-full flex items-center px-1 border-l border-white/5"
  >
    <button
      :title="props.caches + ' onglet(s) hors de vue — voir tous les onglets'"
      :aria-expanded="props.debordement ? 'true' : 'false'"
      aria-haspopup="menu"
      class="text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-white/10 text-slate-300 hover:bg-white/20 hover:text-white transition-colors"
      @click="emit('update:debordement', !props.debordement)"
      v-text="'+' + props.caches"
    ></button>
    <div v-if="props.debordement" class="fixed inset-0 z-40" @click="emit('update:debordement', false)"></div>
    <div
      v-if="props.debordement"
      role="menu"
      aria-label="Tous les onglets ouverts"
      class="absolute right-0 top-full mt-1 z-50 w-64 max-h-72 overflow-y-auto custom-scrollbar bg-[#252526] border border-white/10 rounded-lg shadow-2xl py-1"
    >
      <button
        v-for="tab in props.onglets"
        :key="'ovf-' + tab.path"
        role="menuitem"
        class="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 transition-colors"
        :class="props.actif === tab.path ? 'bg-white/10 text-white' : 'text-slate-300 hover:bg-white/5'"
        :title="tab.path"
        @click="emit('choisir', tab.path)"
      >
        <span
          class="w-1.5 h-1.5 rounded-full shrink-0"
          :class="props.modifies.has(tab.path) ? 'bg-amber-400' : 'bg-transparent'"
          :title="props.modifies.has(tab.path) ? 'Modifications non sauvegardées' : ''"
        ></span>
        <span class="truncate flex-1">{{ tab.name }}</span>
        <span class="text-[10px] text-slate-500 font-mono truncate max-w-[80px]">{{
          dossier(tab.path)
        }}</span>
      </button>
    </div>
  </div>
</template>
