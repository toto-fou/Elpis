<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/AnnonceurA11y.vue — région sr-only unique des annonces aux lecteurs d'écran. -->
<script setup lang="ts">
const props = defineProps<{ texte: string; assertif: boolean }>();
</script>

<template>
  <div
    id="elpis-announcer"
    class="sr-only"
    :aria-live="props.assertif ? 'assertive' : 'polite'"
    aria-atomic="true"
    v-text="props.texte"
  ></div>
</template>
