<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/rag/TexteSurligne.vue — un extrait dont les mots de la question sont surlignés (<mark>), sans HTML brut. -->
<script setup lang="ts">
import { computed } from "vue";

import { surlignerTexte } from "../../features/rag/format";

const props = defineProps<{ texte: string; requete?: string | null }>();
const segments = computed(() => surlignerTexte(props.texte, props.requete ?? ""));
</script>

<template>
  <template v-for="(seg, i) in segments" :key="i">
    <mark v-if="seg.marque">{{ seg.texte }}</mark>
    <span v-else>{{ seg.texte }}</span>
  </template>
</template>
