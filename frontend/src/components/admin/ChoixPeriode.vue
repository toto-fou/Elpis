<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/admin/ChoixPeriode.vue — sélecteur de période commun aux pages de la Supervision (24 h, 7 j, 30 j), avec un emplacement pour un bouton de plus. -->
<script setup lang="ts">
import { PERIODES } from "../../features/admin/periode";

defineProps<{ periode: number }>();
const emit = defineEmits<{ choisir: [heures: number] }>();
</script>

<template>
  <div class="adm-seg" role="group" aria-label="Période">
    <button
      v-for="p in PERIODES"
      :key="p.heures"
      type="button"
      :class="['adm-seg__btn', periode === p.heures ? 'is-active' : '']"
      :aria-pressed="periode === p.heures ? 'true' : 'false'"
      @click="emit('choisir', p.heures)"
    >
      {{ p.libelle }}
    </button>
    <slot />
  </div>
</template>
