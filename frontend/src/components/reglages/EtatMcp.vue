<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/reglages/EtatMcp.vue — état du dernier test d'un serveur MCP : forme du point + texte, la couleur seule ne porte rien. -->
<script setup lang="ts">
import { computed } from "vue";

import { domaineReglages } from "../../features/reglages/domaine";
import { resumeTestMcp } from "../../features/reglages/mcp";

const props = defineProps<{ id: string; long?: boolean; pastille?: boolean; desactive?: boolean }>();
const rg = domaineReglages();
const etat = computed(() =>
  props.desactive
    ? { genre: "none" as const, texte: "Désactivé" }
    : resumeTestMcp(rg.mcpTests[props.id], props.long),
);
</script>

<template>
  <span
    class="inline-flex items-center gap-1.5 text-xs whitespace-nowrap"
    :class="[
      etat.genre === 'err' ? 'text-red-600' : etat.genre === 'busy' ? 'text-amber-700' : 'text-slate-500',
      pastille ? 'h-7 px-2.5 rounded-full bg-slate-50 border border-slate-200' : '',
    ]"
  >
    <span
      class="elpis-mcp-pt"
      :class="{
        'elpis-mcp-pt--ok': etat.genre === 'ok',
        'elpis-mcp-pt--err': etat.genre === 'err',
        'elpis-mcp-pt--busy': etat.genre === 'busy',
      }"
      aria-hidden="true"
    ></span>
    <span class="truncate">{{ etat.texte }}</span>
  </span>
</template>
