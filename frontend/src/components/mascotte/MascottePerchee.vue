<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/mascotte/MascottePerchee.vue — mascotte du perchoir : elle vient dormir sur la barre de saisie quand la conversation n'est pas vide. -->
<script setup lang="ts">
defineProps<{
  actif: boolean;
  perso: string;
  x: string;
  duree: string;
  anim: string;
  dort: boolean;
}>();
</script>

<template>
  <span
    v-if="actif"
    class="perchoir"
    aria-hidden="true"
    :style="{ left: x, transition: 'left ' + duree + ' linear' }"
  >
    <span
      class="socle-mascotte"
      style="width: 48px; height: 48px"
      :data-perso="perso"
      :data-etat="anim"
    ></span>
    <span v-if="dort" class="perchoir-zzz"> <i>z</i><i>z</i><i>z</i> </span>
  </span>
</template>
