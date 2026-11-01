<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/agents/LigneOutil.vue — ligne cochable d'un onglet Outils (catégorie ou serveur MCP) : case cochée écrite, détail en infobulle. -->
<script setup lang="ts">
defineProps<{ libelle: string; coche: boolean; icone?: string; aide?: string }>();
defineEmits<{ bascule: [] }>();
</script>

<template>
  <label
    class="relative flex items-center gap-2.5 min-h-11 px-3 py-1.5 rounded-lg border border-slate-200 bg-white cursor-pointer hover:bg-slate-50 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-blue-500"
    :title="aide"
  >
    <input type="checkbox" class="sr-only peer" :checked="coche" @change="$emit('bascule')" />
    <span
      class="w-4 h-4 rounded border flex items-center justify-center shrink-0"
      :class="coche ? 'bg-blue-600 border-blue-600 text-white' : 'border-slate-300 bg-white'"
      aria-hidden="true"
    >
      <i v-if="coche" class="ph ph-check text-[11px]"></i>
    </span>
    <i v-if="icone" class="ph text-base text-slate-500 shrink-0" :class="icone" aria-hidden="true"></i>
    <span class="min-w-0 truncate text-[13.5px] font-semibold text-slate-800">{{ libelle }}</span>
  </label>
</template>
