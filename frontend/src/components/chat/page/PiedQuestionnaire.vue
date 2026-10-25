<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/page/PiedQuestionnaire.vue — pied du composeur pendant le questionnaire : « + » et micro de la barre normale, aide clavier, Retour et bouton principal (celui d'envoi) ; le choix du modèle reste masqué. -->
<script setup lang="ts">
import { CLE_COMPOSEUR, domaine } from "../../../features/chat/page/domaines";
import BoutonsEnvoi from "./BoutonsEnvoi.vue";
import OutilsSaisie from "./OutilsSaisie.vue";

const comp = domaine(CLE_COMPOSEUR);
</script>

<template>
  <div data-ask-bloc class="elpis-ask-pied">
    <OutilsSaisie />
    <span class="elpis-ask-aide elpis-ask-aide-clavier"
      >Chiffres pour choisir · Entrée pour valider · Échap pour fermer</span
    >
    <span class="flex-1"></span>
    <button
      v-if="comp.askUserPanel && comp.askUserPanel.idx > 0"
      type="button"
      class="elpis-ask-btn elpis-ask-btn-g"
      @click="comp.askUserPrev"
    >
      Retour
    </button>
    <BoutonsEnvoi />
  </div>
</template>
