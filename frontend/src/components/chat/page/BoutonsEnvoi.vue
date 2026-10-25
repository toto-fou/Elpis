<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/page/BoutonsEnvoi.vue — bouton Arrêter, Générer ou Envoyer du composeur ; Suivant / Envoyer les réponses pendant le questionnaire. -->
<script setup lang="ts">
import { computed } from "vue";

import { CLE_COMPOSEUR, domaine } from "../../../features/chat/page/domaines";

const comp = domaine(CLE_COMPOSEUR);
// Questionnaire ouvert : ce bouton devient « Suivant » ou « Envoyer les réponses ».
const questionnaire = computed(() => !!comp.askUserPanel?.ouvert);
const derniere = computed(
  () => !!comp.askUserPanel && comp.askUserPanel.idx >= comp.askUserPanel.items.length - 1,
);
</script>

<template>
  <div class="shrink-0 flex items-center gap-2">
    <button
      v-if="questionnaire && comp.isStreaming"
      title="Arrêter la génération"
      aria-label="Arrêter la génération"
      class="h-8 w-8 flex items-center justify-center bg-red-50 text-red-600 rounded-lg hover:bg-red-600 hover:text-white transition-colors border border-red-200"
      @click="comp.stopGeneration"
    >
      <i class="ph ph-stop-circle text-lg"></i>
    </button>
    <button
      v-if="questionnaire"
      type="button"
      class="elpis-ask-btn elpis-ask-btn-p"
      :disabled="derniere && comp.isStreaming"
      @click="comp.askUserNext"
    >
      {{ derniere ? "Envoyer les réponses" : "Suivant" }}
      <i class="ph ph-arrow-elbow-down-left" aria-hidden="true"></i>
    </button>
    <button
      v-else-if="comp.isStreaming"
      title="Arrêter la génération"
      aria-label="Arrêter la génération"
      class="h-8 w-8 flex items-center justify-center bg-red-50 text-red-600 rounded-lg hover:bg-red-600 hover:text-white transition-colors border border-red-200"
      @click="comp.stopGeneration"
    >
      <i class="ph ph-stop-circle text-lg"></i>
    </button>
    <button
      v-else-if="comp.imageMode"
      :disabled="!comp.inputMessage.trim()"
      title="Générer"
      aria-label="Générer l’image"
      data-image-send
      class="h-8 w-8 flex items-center justify-center rounded-lg transition-colors bg-blue-600 text-white hover:bg-blue-700 disabled:bg-slate-100 disabled:text-slate-400 disabled:cursor-not-allowed"
      @click="comp.sendMessage"
    >
      <i class="ph ph-image text-sm" aria-hidden="true"></i>
    </button>
    <button
      v-else
      :disabled="comp.noEngineAllowed || (!comp.inputMessage.trim() && comp.attachedFiles.length === 0)"
      :title="comp.noEngineAllowed ? 'Aucun serveur autorisé' : 'Envoyer le message'"
      aria-label="Envoyer le message"
      class="h-8 w-8 flex items-center justify-center rounded-lg transition-colors bg-blue-600 text-white hover:bg-blue-700 disabled:bg-slate-100 disabled:text-slate-400 disabled:cursor-not-allowed"
      @click="comp.sendMessage"
    >
      <i class="ph ph-paper-plane-right text-sm"></i>
    </button>
  </div>
</template>
