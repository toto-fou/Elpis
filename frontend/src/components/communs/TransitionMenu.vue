<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/communs/TransitionMenu.vue — ouverture et fermeture d'un menu flottant : « popover » vers le bas, « popover-up » s'il est ancré par le bas ; le menu qui sort est inerte et lâche le focus, comme s'il était déjà retiré. -->
<script setup lang="ts">
const props = defineProps<{ haut?: boolean }>();

/** Le menu qui part ne prend plus ni focus ni clavier ; le focus qu'il tenait retombe sur la page. */
function sortir(el: Element): void {
  el.setAttribute("inert", "");
  const actif = globalThis.document.activeElement;
  if (actif instanceof HTMLElement && el.contains(actif)) actif.blur();
}

/** Un menu rouvert (v-show) redevient actif. */
function entrer(el: Element): void {
  el.removeAttribute("inert");
}
</script>

<template>
  <Transition :name="props.haut ? 'popover-up' : 'popover'" @before-enter="entrer" @before-leave="sortir">
    <slot></slot>
  </Transition>
</template>
