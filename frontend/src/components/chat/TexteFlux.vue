<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/TexteFlux.vue — texte brut d'un flux dans un `pre` (réflexion) : pendant le flux, lu sur la référence du porteur du message, seul ce composant se met à jour à chaque image. -->
<script setup lang="ts">
import { computed } from "vue";

/** Référence du porteur (réflexion en cours). */
interface TexteVivant {
  readonly value: string;
}

const props = defineProps<{ texte?: string | null; flux?: TexteVivant | null }>();
const affiche = computed(() => (props.flux ? props.flux.value : (props.texte ?? "")));
</script>

<template>
  <pre>{{ affiche }}</pre>
</template>
