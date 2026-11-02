<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/reglages/LigneMcp.vue — rangée du volet gauche des serveurs MCP : icône, nom, état ou détail, épinglage au panneau. -->
<script setup lang="ts">
import { computed } from "vue";

import { domaineReglages } from "../../features/reglages/domaine";
import EtatMcp from "./EtatMcp.vue";

const props = defineProps<{
  cle: string;
  icone: string;
  nom: string;
  etatId?: string;
  sous?: string;
  epingle?: boolean;
  desactive?: boolean;
}>();
const rg = domaineReglages();
const actif = computed(() => rg.mcpSel === props.cle);
</script>

<template>
  <button
    type="button"
    data-mcp-ligne
    :aria-current="actif ? 'true' : undefined"
    class="w-full flex items-center gap-2.5 min-h-[48px] px-2.5 py-1.5 rounded-lg text-left transition-colors"
    :class="actif ? 'bg-blue-50' : 'hover:bg-slate-100'"
    @click="rg.mcpChoisir(cle)"
  >
    <span
      class="w-8 h-8 rounded-lg bg-white border border-slate-200 text-slate-600 flex items-center justify-center shrink-0"
    >
      <i class="ph text-base" :class="icone" aria-hidden="true"></i>
    </span>
    <span class="flex-1 min-w-0 flex flex-col">
      <span class="text-sm font-semibold text-slate-800 truncate">{{ nom }}</span>
      <EtatMcp v-if="etatId" :id="etatId" :desactive="desactive" />
      <span v-else class="text-xs text-slate-500 truncate">{{ sous }}</span>
    </span>
    <template v-if="epingle">
      <i
        class="ph ph-push-pin text-sm text-blue-600 shrink-0"
        title="Dans le panneau MCP"
        aria-hidden="true"
      ></i>
      <span class="sr-only">dans le panneau</span>
    </template>
  </button>
</template>
