<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/message/EffetsMessage.vue — effets du message hors conteneur : écritures en mémoire, dépliables (détail, annuler, gérer). -->
<script setup lang="ts">
import { computed } from "vue";

import { CLE_FIL, domaine } from "../../../features/chat/page/domaines";
import type { EntreeMessage } from "../../../features/chat/message/types";
import EffetMemoire from "./EffetMemoire.vue";

const props = defineProps<{ entry: EntreeMessage }>();
const fil = domaine(CLE_FIL);
const lignes = computed(() => fil.effectLinesFor(props.entry.msg, props.entry.idx));
</script>

<template>
  <div v-if="lignes.length" class="elpis-effects" data-effects aria-live="polite">
    <template v-for="line in lignes" :key="line.key">
      <EffetMemoire v-if="line.kind === 'memory'" :line="line" />
    </template>
  </div>
</template>
