<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/page/PuceQuestionnaire.vue — puce « Reprendre le questionnaire · n sur N » au-dessus du composeur, tant qu'un questionnaire fermé attend. -->
<script setup lang="ts">
import { CLE_COMPOSEUR, domaine } from "../../../features/chat/page/domaines";

const comp = domaine(CLE_COMPOSEUR);
</script>

<template>
  <div v-if="comp.askUserPanel && !comp.askUserPanel.ouvert" class="flex mb-2">
    <button type="button" class="elpis-ask-reprendre" @click="comp.rouvrirAskUser">
      <i class="ph ph-list-checks" aria-hidden="true"></i>
      Reprendre le questionnaire · {{ comp.askUserRepondues }} sur {{ comp.askUserPanel.items.length }}
    </button>
  </div>
</template>
