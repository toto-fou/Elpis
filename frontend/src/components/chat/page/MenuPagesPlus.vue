<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/page/MenuPagesPlus.vue — entrée « Plus » du volet latéral (rail réduit ou vue déployée) et son sous-menu à droite du volet : RAG, Studio, Remote code ; flèches, Échap par la cascade de la racine, clic extérieur, retour du focus. -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useTemplateRef, watch } from "vue";

import { CLE_BARRE, domaine } from "../../../features/chat/page/domaines";
import {
  ecouterFermeture,
  elementActif,
  focusPerdu,
  pagePlusActive,
  pagesPlus,
  placerPlus,
} from "../../../features/chat/page/menu-pages-plus";
import type { PagePlus } from "../../../features/chat/page/menu-pages-plus";

const props = defineProps<{ compact: boolean }>();
const b = domaine(CLE_BARRE);
const declencheur = useTemplateRef<HTMLButtonElement>("declencheur");
const menu = useTemplateRef<HTMLElement>("menu");
const position = ref({ left: 0, top: 0 });
const idMenu = props.compact ? "elpis-menu-plus-rail" : "elpis-menu-plus";

const pages = computed(() => pagesPlus({ rag: b.ragAllowed, opencode: !!b.features.opencode }));
const active = computed(() => pagePlusActive(b.currentView, pages.value));
// Les deux vues du volet restent montées : seule celle qui est affichée ouvre son sous-menu.
const ouvert = computed(() => b.menuPagesOuvert && props.compact === !b.showSidebar);
const titre = computed(() => "Plus — " + pages.value.map((p) => p.libelle).join(", "));
const ouvrirPage: Record<PagePlus["vue"], () => unknown> = {
  rag: () => b.openRagPage(),
  studio: () => b.openStudio(),
  code: () => b.openCodePage(),
};

/** Entrées du sous-menu ouvert. */
function entrees(): HTMLElement[] {
  return menu.value ? [...menu.value.querySelectorAll<HTMLElement>('[role="menuitem"]')] : [];
}

/** Flèche droite ou bas sur le déclencheur : ouvre le sous-menu. */
function surDeclencheur(e: KeyboardEvent): void {
  if ((e.key !== "ArrowRight" && e.key !== "ArrowDown") || ouvert.value) return;
  e.preventDefault();
  b.menuPagesOuvert = true;
}

/** Flèches, Début et Fin entre les pages ; flèche gauche et Tab referment. */
function surClavier(e: KeyboardEvent): void {
  const liste = entrees();
  const i = liste.indexOf(elementActif() as HTMLElement);
  const aller = (n: number): void => {
    e.preventDefault();
    liste[(n + liste.length) % liste.length]?.focus();
  };
  if (e.key === "ArrowDown") aller(i + 1);
  else if (e.key === "ArrowUp") aller(i < 0 ? -1 : i - 1);
  else if (e.key === "Home") aller(0);
  else if (e.key === "End") aller(-1);
  else if (e.key === "ArrowLeft" || e.key === "Tab") {
    if (e.key === "ArrowLeft") e.preventDefault();
    b.menuPagesOuvert = false;
  }
}

/** Ouvre la page choisie et referme le sous-menu. */
function choisir(p: PagePlus): void {
  b.menuPagesOuvert = false;
  void ouvrirPage[p.vue]();
}

/** Appui hors du déclencheur et du sous-menu : referme. */
function dehors(e: Event): void {
  const cible = e.target as Node;
  if (!declencheur.value?.contains(cible) && !menu.value?.contains(cible)) b.menuPagesOuvert = false;
}

/** Fenêtre redimensionnée : le sous-menu ancré se referme plutôt que de flotter. */
function fermer(): void {
  b.menuPagesOuvert = false;
}

/** Place le sous-menu à droite du volet, à la hauteur du déclencheur. */
function placer(): void {
  if (declencheur.value) position.value = placerPlus(declencheur.value, menu.value?.offsetHeight ?? 0);
}

let retirer: (() => void) | null = null;
// Ouvert : écoutes posées, focus sur la page affichée ou la première ; fermé au clavier : focus rendu au déclencheur.
watch(ouvert, async (o) => {
  retirer?.();
  retirer = null;
  if (!o) {
    await nextTick();
    if (focusPerdu()) declencheur.value?.focus();
    return;
  }
  retirer = ecouterFermeture(dehors, fermer);
  placer();
  await nextTick();
  placer();
  (menu.value?.querySelector<HTMLElement>('[aria-current="page"]') ?? entrees()[0])?.focus();
});
// Volet replié, déployé ou masqué par le plein écran de l'éditeur : le sous-menu n'a plus d'ancre.
watch([() => b.showSidebar, () => b.editorFullscreen], () => {
  if (b.menuPagesOuvert) b.menuPagesOuvert = false;
});
onBeforeUnmount(() => retirer?.());
</script>

<template>
  <button
    v-if="props.compact"
    ref="declencheur"
    type="button"
    data-menu-plus
    :title="active ? titre + ' (' + active.libelle + ' ouvert)' : titre"
    aria-label="Plus"
    aria-haspopup="menu"
    :aria-expanded="ouvert ? 'true' : 'false'"
    :aria-controls="ouvert ? idMenu : undefined"
    class="relative w-9 h-9 rounded-lg flex items-center justify-center transition-colors"
    :class="
      ouvert
        ? 'bg-white/[0.08] text-white'
        : active
          ? 'bg-blue-600/20 text-blue-300'
          : 'text-slate-400 hover:bg-white/10 hover:text-white'
    "
    @click="b.menuPagesOuvert = !ouvert"
    @keydown="surDeclencheur"
  >
    <i class="ph ph-dots-three-circle text-lg"></i>
  </button>
  <button
    v-else
    ref="declencheur"
    type="button"
    data-menu-plus
    :title="titre"
    aria-label="Plus"
    aria-haspopup="menu"
    :aria-expanded="ouvert ? 'true' : 'false'"
    :aria-controls="ouvert ? idMenu : undefined"
    class="w-full text-left px-3 h-8 rounded-lg flex items-center gap-2.5 text-[13.5px] font-medium transition-colors group"
    :class="
      ouvert
        ? 'bg-white/[0.08] text-white'
        : active
          ? 'bg-blue-600/20 text-white'
          : 'text-slate-300 hover:bg-white/[0.06] hover:text-white'
    "
    @click="b.menuPagesOuvert = !ouvert"
    @keydown="surDeclencheur"
  >
    <i
      class="ph ph-dots-three-circle text-base shrink-0 transition-colors"
      :class="active || ouvert ? 'text-blue-300' : 'text-slate-400 group-hover:text-slate-200'"
    ></i>
    <span class="flex-1 truncate">Plus</span>
    <span v-if="active" data-menu-plus-actif class="text-xs font-normal text-slate-400 truncate">{{
      active.libelle
    }}</span>
    <i class="ph ph-caret-right text-xs shrink-0 text-slate-400"></i>
  </button>
  <div
    v-if="ouvert"
    :id="idMenu"
    ref="menu"
    role="menu"
    aria-label="Plus"
    class="elpis-rail-flyout fixed z-[100] w-52 p-1 rounded-xl border shadow-2xl flex flex-col gap-0.5"
    :style="{ left: position.left + 'px', top: position.top + 'px' }"
    @keydown="surClavier"
  >
    <button
      v-for="p in pages"
      :key="p.vue"
      type="button"
      role="menuitem"
      :title="p.titre"
      :aria-current="p.vue === b.currentView ? 'page' : undefined"
      class="w-full text-left px-3 h-8 rounded-lg flex items-center gap-2.5 text-[13.5px] font-medium transition-colors group"
      :class="
        p.vue === b.currentView
          ? 'bg-blue-600/20 text-white'
          : 'text-slate-300 hover:bg-white/[0.06] hover:text-white'
      "
      @click="choisir(p)"
    >
      <i
        class="ph text-base shrink-0 transition-colors"
        :class="[
          p.icone,
          p.vue === b.currentView ? 'text-blue-300' : 'text-slate-400 group-hover:text-slate-200',
        ]"
      ></i>
      <span class="flex-1 truncate">{{ p.libelle }}</span>
    </button>
  </div>
</template>
