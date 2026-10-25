<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/reglages/LigneGeneration.vue — ligne du panneau Génération : libellé français et identifiant, point et « Revenir à… » si la valeur est modifiée, grisée si le moteur l'ignore. -->
<script setup lang="ts">
defineProps<{
  libelle: string;
  identifiant?: string;
  pour?: string;
  modifie?: boolean;
  reference?: string;
  ignore?: string;
  aide?: string;
  dessous?: boolean;
}>();
defineEmits<{ retablir: [] }>();
</script>

<template>
  <div
    class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2.5 py-1.5 border-b border-slate-100"
    :class="ignore ? 'opacity-50' : ''"
    :title="ignore || aide || undefined"
    :data-reglage="identifiant || libelle"
    :data-modifie="modifie ? '' : undefined"
  >
    <label :for="pour" class="relative min-w-0 flex flex-col" :class="modifie ? 'pl-3' : ''">
      <span
        v-if="modifie"
        class="absolute left-0 top-[7px] w-1.5 h-1.5 rounded-full bg-blue-600"
        aria-hidden="true"
      ></span>
      <span class="text-[13px] text-slate-800 truncate">{{ libelle }}</span>
      <span v-if="identifiant" class="font-mono text-xs text-slate-500 truncate">{{ identifiant }}</span>
    </label>
    <span class="flex items-center justify-end gap-1.5">
      <button
        v-if="modifie && reference !== undefined"
        type="button"
        :aria-label="`Revenir à ${reference}`"
        :title="`Revenir à ${reference}`"
        class="w-6 h-6 flex items-center justify-center rounded-md text-slate-500 hover:text-slate-800 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        data-revenir
        @click="$emit('retablir')"
      >
        <i class="ph ph-arrow-counter-clockwise text-sm" aria-hidden="true"></i>
      </button>
      <slot v-if="!dessous"></slot>
    </span>
    <span v-if="dessous" class="col-span-2 flex mt-1"><slot></slot></span>
  </div>
</template>
