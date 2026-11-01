<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/agents/BoutonChoix.vue — bouton-choix à libellé seul (détail en infobulle) : coche écrite quand il est retenu. -->
<script setup lang="ts">
defineProps<{ libelle: string; actif: boolean; aide?: string; desactive?: boolean }>();
defineEmits<{ choisir: [] }>();
</script>

<template>
  <button
    type="button"
    class="inline-flex items-center justify-center gap-1.5 min-h-10 px-4 rounded-lg border text-[13.5px] font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-70"
    :class="
      actif
        ? 'border-blue-500 bg-blue-50 text-blue-700'
        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
    "
    :aria-pressed="actif ? 'true' : 'false'"
    :title="aide"
    :disabled="desactive"
    @click="$emit('choisir')"
  >
    <i v-if="actif" class="ph ph-check text-sm" aria-hidden="true"></i>{{ libelle }}
  </button>
</template>
