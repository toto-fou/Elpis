<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/communs/LibelleVivant.vue — libellé d'activité : le texte, balayé par un éclat tant que le travail dure (deux transform opposés, joués par le compositeur). -->
<script setup lang="ts">
withDefaults(defineProps<{ texte: string; vivant?: boolean }>(), { vivant: true });
</script>

<template>
  <span v-if="vivant" class="mem-wave"
    >{{ texte
    }}<span class="mem-wave-fenetre" aria-hidden="true"
      ><span class="mem-wave-copie" :data-texte="texte"></span></span
  ></span>
  <span v-else>{{ texte }}</span>
</template>
