<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/reglages/LigneGeneration.vue — ligne du panneau Génération : libellé français et identifiant, point et « Revenir à… » si la valeur est modifiée, raison affichée si le moteur l'ignore, note sous le réglage. -->
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
  note?: string;
}>();
defineEmits<{ retablir: [] }>();
</script>

<template>
  <div
    class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2.5 py-1.5 border-b border-slate-100"
    :title="aide || undefined"
    :data-reglage="identifiant || libelle"
    :data-modifie="modifie ? '' : undefined"
  >
    <label :for="pour" class="relative min-w-0 flex flex-col" :class="modifie ? 'pl-3' : ''">
      <span
        v-if="modifie"
        class="absolute left-0 top-[7px] w-1.5 h-1.5 rounded-full bg-blue-600"
        aria-hidden="true"
      ></span>
      <span class="text-[13px] truncate" :class="ignore ? 'text-slate-500' : 'text-slate-800'">{{
        libelle
      }}</span>
      <span v-if="ignore" class="flex items-center gap-1 text-xs text-slate-500" data-ignore>
        <i class="ph ph-info shrink-0" aria-hidden="true"></i>
        <span class="truncate">{{ ignore }}</span>
      </span>
      <span v-else-if="identifiant" class="font-mono text-xs text-slate-500 truncate">{{ identifiant }}</span>
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
    <span v-if="dessous" class="col-span-2 flex flex-col gap-2 mt-1"><slot></slot></span>
    <p v-if="note" class="col-span-2 mt-1 text-xs text-slate-500">{{ note }}</p>
  </div>
</template>
