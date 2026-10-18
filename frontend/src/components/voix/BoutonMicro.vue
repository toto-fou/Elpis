<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/voix/BoutonMicro.vue — bouton de dictée du composeur : état du micro, vumètre (largeur posée dans le DOM par la dictée) et indicateur de transcription. -->
<script setup lang="ts">
defineProps<{ etat: string; occupe: boolean }>();
defineEmits<{ basculer: [] }>();
</script>

<template>
  <button
    :title="etat === 'arrete' ? 'Dicter (Échap pour arrêter)' : 'Arrêter la dictée'"
    :aria-label="etat === 'arrete' ? 'Activer la dictée' : 'Arrêter la dictée'"
    :aria-pressed="etat !== 'arrete'"
    class="w-8 h-8 flex items-center justify-center rounded-lg transition-colors relative"
    :class="
      etat === 'arrete'
        ? 'text-slate-400 hover:text-blue-600 hover:bg-slate-100'
        : 'text-red-600 bg-red-50 hover:bg-red-100'
    "
    @click.prevent="$emit('basculer')"
  >
    <i
      class="ph text-lg"
      :class="
        etat === 'arrete' ? 'ph-microphone' : etat === 'suspendu' ? 'ph-microphone-slash' : 'ph-microphone'
      "
    ></i>
    <span
      v-if="etat === 'parole' || etat === 'ecoute'"
      id="voice-vu"
      class="absolute bottom-1 left-1/2 -translate-x-1/2 h-1 rounded-full bg-red-500 transition-all duration-150"
      style="width: 2px"
      aria-hidden="true"
    ></span>
    <span
      v-if="etat === 'demarrage' || etat === 'calibrage'"
      class="absolute bottom-1 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-red-400 animate-pulse"
      aria-hidden="true"
    ></span>
    <span
      v-if="occupe"
      class="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-blue-500"
      aria-hidden="true"
    ></span>
  </button>
</template>
