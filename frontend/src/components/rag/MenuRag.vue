<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/rag/MenuRag.vue — menu déroulant de la page RAG : déclencheur, flèches, Échap par la cascade de la racine, clic extérieur, retour du focus. -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, useTemplateRef, watch } from "vue";

import type { ItemMenuRag } from "../../features/rag/base";
import { domaineRag } from "../../features/rag/domaine";
import { elementActif, focusPerdu, surPointeurPage } from "../../features/rag/dom";

const props = defineProps<{
  id: string;
  libelle: string;
  items: readonly ItemMenuRag[];
  icone?: string;
  texte?: string;
  gauche?: boolean;
}>();
const emit = defineEmits<{ choisir: [id: string] }>();

const rg = domaineRag();
const ouvert = computed(() => rg.menuOuvert === props.id);
const racine = useTemplateRef<HTMLElement>("racine");
const declencheur = useTemplateRef<HTMLButtonElement>("declencheur");
const menu = useTemplateRef<HTMLElement>("menu");

function entrees(): HTMLElement[] {
  return menu.value ? [...menu.value.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)')] : [];
}

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
  else if (e.key === "Tab") rg.menuOuvert = null;
}

function surDeclencheur(e: KeyboardEvent): void {
  if (e.key !== "ArrowDown" || ouvert.value) return;
  e.preventDefault();
  rg.basculerMenu(props.id);
}

function choisir(item: ItemMenuRag): void {
  rg.menuOuvert = null;
  emit("choisir", item.id);
}

function dehors(e: Event): void {
  if (ouvert.value && racine.value && !racine.value.contains(e.target as Node)) rg.menuOuvert = null;
}

let retirer: (() => void) | null = null;
onMounted(() => {
  retirer = surPointeurPage(dehors);
});
onBeforeUnmount(() => retirer?.());

// À l'ouverture le focus va au premier choix, ou au choix coché ; à la fermeture au clavier il revient au déclencheur.
watch(ouvert, async (o) => {
  await nextTick();
  if (o) (menu.value?.querySelector<HTMLElement>('[aria-checked="true"]') ?? entrees()[0])?.focus();
  else if (racine.value && (focusPerdu() || racine.value.contains(elementActif())))
    declencheur.value?.focus();
});
</script>

<template>
  <span ref="racine" class="rag-anchor">
    <button
      ref="declencheur"
      type="button"
      class="rag-btn"
      :class="props.texte ? '' : 'rag-btn--icon'"
      :aria-label="props.texte ? undefined : props.libelle"
      :title="props.libelle"
      aria-haspopup="menu"
      :aria-expanded="ouvert ? 'true' : 'false'"
      @click="rg.basculerMenu(props.id)"
      @keydown="surDeclencheur"
    >
      <i v-if="props.icone" class="ph" :class="props.icone" aria-hidden="true"></i>{{ props.texte }}
      <i v-if="props.texte" class="ph ph-caret-down" aria-hidden="true"></i>
    </button>
    <div
      v-if="ouvert"
      ref="menu"
      class="rag-menu shadow-2xl"
      :class="{ 'rag-menu--left': props.gauche }"
      role="menu"
      :aria-label="props.libelle"
      @keydown="surClavier"
    >
      <template v-for="it in props.items" :key="it.id">
        <div v-if="it.separateurAvant" class="rag-menu__sep" role="separator"></div>
        <button
          type="button"
          class="rag-menu__item"
          :class="{ 'is-on': it.actif === true, 'is-danger': it.danger }"
          :role="it.actif === undefined ? 'menuitem' : 'menuitemradio'"
          :aria-checked="it.actif === undefined ? undefined : it.actif ? 'true' : 'false'"
          :disabled="it.desactive"
          @click="choisir(it)"
        >
          <i v-if="it.icone" class="ph" :class="it.icone" aria-hidden="true"></i>{{ it.libelle }}
        </button>
      </template>
    </div>
  </span>
</template>
