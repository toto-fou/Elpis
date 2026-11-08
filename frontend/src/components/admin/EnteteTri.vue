<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/admin/EnteteTri.vue — en-tête de colonne triable (aria-sort, bouton de tri). -->
<script setup lang="ts">
import { ariaSort } from "../../features/admin/pagination";
import type { Tri } from "../../features/admin/pagination";

defineProps<{ col: string; libelle: string; tri: Tri; droite?: boolean; titre?: string }>();
const emit = defineEmits<{ trier: [col: string] }>();
</script>

<template>
  <th :class="droite ? 'text-right' : 'text-left'" :aria-sort="ariaSort(tri, col)" :title="titre">
    <button type="button" class="sup-tri" @click="emit('trier', col)">
      {{ libelle }}
      <i
        class="ph"
        :class="tri.col === col ? (tri.dir === 'asc' ? 'ph-caret-up' : 'ph-caret-down') : 'ph-caret-up-down'"
        aria-hidden="true"
      ></i>
    </button>
  </th>
</template>
