<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/page/OutilsSaisie.vue — « + » (catalogue) et micro (dictée) du composeur, partagés par la barre normale et le pied du questionnaire. -->
<script setup lang="ts">
import { CLE_PAGE, domaine } from "../../../features/chat/page/domaines";
import BoutonMicro from "../../voix/BoutonMicro.vue";
import CataloguePlus from "./CataloguePlus.vue";

const p = domaine(CLE_PAGE);
</script>

<template>
  <div class="shrink-0 flex items-center gap-0.5">
    <CataloguePlus @ancre="p.composerPlusRef = $event" />
    <BoutonMicro
      v-if="p.voiceCanDictate"
      :etat="p.voiceState"
      :occupe="p.voiceBusy"
      @basculer="p.toggleDictation"
    />
  </div>
</template>
