<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/editor/MenuDeroulant.vue — menu déroulant de l'éditeur lié au skin : déclencheur fourni, flèches, Début/Fin, Échap rend le focus, clic dehors ou sur une entrée ferme. -->
<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from "vue";

import { elementActif, empilerCouche, garderDansCadre } from "../../features/editor/couches";

const props = withDefaults(
  defineProps<{ etiquette: string; cote?: "gauche" | "droite"; sens?: "bas" | "haut"; largeur?: string }>(),
  { cote: "gauche", sens: "bas", largeur: undefined },
);
const ouvert = defineModel<boolean>({ default: false });
const racine = ref<HTMLElement | null>(null);
const menu = ref<HTMLElement | null>(null);

function entrees(): HTMLElement[] {
  return menu.value
    ? Array.from(menu.value.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)'))
    : [];
}

// Ouvert, le menu est la couche du dessus pour Échap (cascade globale).
let retirer: (() => void) | null = null;
watch(ouvert, (o) => {
  retirer?.();
  retirer = o ? empilerCouche(() => fermer()) : null;
  if (o)
    void nextTick(() => {
      garderDansCadre(menu.value);
      premiere()?.focus();
    });
});

/** Entrée qui reçoit le focus : le choix coché d'un menu de choix seulement, sinon la première. */
function premiere(): HTMLElement | undefined {
  const l = entrees();
  const choix = l.every((x) => x.getAttribute("role") === "menuitemradio");
  return (choix ? l.find((x) => x.getAttribute("aria-checked") === "true") : undefined) ?? l[0];
}
onBeforeUnmount(() => retirer?.());

function fermer(rendreFocus = true): void {
  ouvert.value = false;
  if (rendreFocus) racine.value?.querySelector<HTMLElement>("[aria-haspopup]")?.focus();
}

function basculer(): void {
  ouvert.value = !ouvert.value;
}

function touche(e: KeyboardEvent): void {
  const l = entrees();
  const i = l.indexOf(elementActif() as HTMLElement);
  const aller = (j: number): void => {
    e.preventDefault();
    l[(j + l.length) % l.length]?.focus();
  };
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    fermer();
  } else if (e.key === "ArrowDown") aller(i + 1);
  else if (e.key === "ArrowUp") aller(i < 0 ? -1 : i - 1);
  else if (e.key === "Home") aller(0);
  else if (e.key === "End") aller(-1);
  else if (e.key === "Tab") fermer(false);
}

/** Une entrée choisie ferme le menu, sauf celles marquées `data-garder`. */
function surClic(e: MouseEvent): void {
  const cible = (e.target as HTMLElement | null)?.closest?.('[role^="menuitem"]');
  if (cible && !cible.hasAttribute("data-garder")) fermer(false);
}
</script>

<template>
  <div ref="racine" class="ed2-ancre">
    <slot name="declencheur" :ouvert="ouvert" :basculer="basculer"></slot>
    <template v-if="ouvert">
      <div class="ed2-capture" @click="fermer(false)" @contextmenu.prevent="fermer(false)"></div>
      <div
        ref="menu"
        role="menu"
        :aria-label="props.etiquette"
        class="ed2-menu"
        :class="['ed2-menu--' + props.cote, 'ed2-menu--' + props.sens]"
        :style="props.largeur ? { width: props.largeur } : undefined"
        @keydown="touche"
        @click="surClic"
      >
        <slot :fermer="fermer"></slot>
      </div>
    </template>
  </div>
</template>
