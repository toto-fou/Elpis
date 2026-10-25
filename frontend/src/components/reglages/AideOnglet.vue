<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/reglages/AideOnglet.vue — titre d'un onglet des Paramètres avec son aide d'une ligne à la demande. -->
<script setup lang="ts">
import { ref, useId } from "vue";

defineProps<{ titre: string }>();
const ouvert = ref(false);
const idLigne = useId();
</script>

<template>
  <div>
    <div class="flex items-center gap-2">
      <h3 class="text-base font-semibold text-slate-800">{{ titre }}</h3>
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
    </div>
    <p v-show="ouvert" :id="idLigne" class="text-xs text-slate-500 mt-1" data-aide-ligne>
      <slot></slot>
    </p>
  </div>
</template>
