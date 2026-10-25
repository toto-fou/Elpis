<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/reglages/AideLigne.vue — aide à la demande : un bouton « Aide » qui déplie une ligne. -->
<script setup lang="ts">
import { ref, useId } from "vue";

const ouvert = ref(false);
const idLigne = useId();
</script>

<template>
  <span class="inline-flex flex-col align-top">
    <button
      type="button"
      class="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 rounded px-1 py-0.5 min-h-6"
      :aria-expanded="ouvert ? 'true' : 'false'"
      :aria-controls="idLigne"
      title="Afficher l'aide"
      data-aide-bouton
      @click="ouvert = !ouvert"
    >
      <i class="ph ph-question text-sm" aria-hidden="true"></i>
      Aide
    </button>
    <span v-show="ouvert" :id="idLigne" class="text-xs text-slate-500 mt-0.5 max-w-prose" data-aide-ligne>
      <slot></slot>
    </span>
  </span>
</template>
