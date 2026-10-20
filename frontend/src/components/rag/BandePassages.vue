<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/rag/BandePassages.vue — bande de passages d'un document : une cellule par passage (regroupés au-delà de 24), vide en attente, animée pendant le traitement. -->
<script setup lang="ts">
import { computed } from "vue";

import { cellulesBande } from "../../features/rag/format";

const props = defineProps<{ passages: number; mode: "prete" | "attente" | "occupe" }>();

/** Document en attente ou en cours : longueur inconnue, douze cellules vides. */
const cellules = computed(() => (props.mode === "prete" ? cellulesBande(props.passages) : 12));
</script>

<template>
  <span class="rag-strip" :class="{ 'is-busy': props.mode === 'occupe' }" aria-hidden="true">
    <i v-for="n in cellules" :key="n" :class="{ 'is-todo': props.mode !== 'prete' }"></i>
  </span>
</template>
