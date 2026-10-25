<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/page/BarreComposeur.vue — rangée courte du composeur (interface nouvelle) : « + » (catalogue) et micro à gauche, modèle (réflexion et réglages dans son menu, nom abrégé sous 420 px) et Envoyer à droite. -->
<script setup lang="ts">
import { useTemplateRef } from "vue";

import { CLE_ENTETE, CLE_MODELES, CLE_PAGE, domaine } from "../../../features/chat/page/domaines";
import { suivreEtroit } from "../../../features/chat/page/largeur";
import { libelleEffort } from "../../../features/chat/page/puces";
import BoutonMicro from "../../voix/BoutonMicro.vue";
import BoutonsEnvoi from "./BoutonsEnvoi.vue";
import CataloguePlus from "./CataloguePlus.vue";
import ProgressionModele from "./ProgressionModele.vue";
import SelecteurModele from "./SelecteurModele.vue";

const p = domaine(CLE_PAGE);
const mod = domaine(CLE_MODELES);
const ent = domaine(CLE_ENTETE);
const etroit = suivreEtroit(useTemplateRef<HTMLDivElement>("rangee"), 420);

function ouvrirReglages(): void {
  mod.showModelManager = false;
  if (!ent.showSamplingPanel) ent.togglePanel("sampling");
}
const SEGMENT = "flex-1 px-1.5 py-1 rounded-md text-xs font-medium transition-colors";
</script>

<template>
  <div ref="rangee" class="flex items-center w-full gap-1" data-barre-composeur>
    <div class="shrink-0 flex items-center gap-0.5">
      <CataloguePlus @ancre="p.composerPlusRef = $event" />
      <BoutonMicro
        v-if="p.voiceCanDictate"
        :etat="p.voiceState"
        :occupe="p.voiceBusy"
        @basculer="p.toggleDictation"
      />
    </div>
    <div class="flex-1"></div>
    <ProgressionModele />
    <SelecteurModele :abrege="etroit" :a-droite="true">
      <template #pied>
        <div
          v-if="!mod.imageMode && mod.reasoningEffortValues.length"
          class="px-3 py-2 border-t border-slate-100"
          data-effort-menu
        >
          <div class="text-xs font-semibold text-slate-600 mb-1.5">Réflexion</div>
          <div role="group" aria-label="Réflexion" class="flex gap-1 p-0.5 rounded-lg bg-slate-100">
            <button
              type="button"
              :aria-pressed="!mod.samplingOverride.reasoning_effort ? 'true' : 'false'"
              :class="[
                SEGMENT,
                !mod.samplingOverride.reasoning_effort
                  ? 'bg-white text-slate-800 shadow-sm'
                  : 'text-slate-600 hover:text-slate-800',
              ]"
              @click="mod.pickReasoningEffort(null)"
            >
              Auto
            </button>
            <button
              v-for="v in mod.reasoningEffortValues"
              :key="v"
              type="button"
              :title="v"
              :aria-pressed="mod.samplingOverride.reasoning_effort === v ? 'true' : 'false'"
              :class="[
                SEGMENT,
                mod.samplingOverride.reasoning_effort === v
                  ? 'bg-white text-slate-800 shadow-sm'
                  : 'text-slate-600 hover:text-slate-800',
              ]"
              @click="mod.pickReasoningEffort(v)"
            >
              {{ libelleEffort(v) }}
            </button>
          </div>
        </div>
        <button
          type="button"
          class="w-full px-3 py-2 border-t border-slate-100 flex items-center gap-2 text-xs text-slate-700 hover:bg-slate-50"
          title="Température, top-p, réflexion avancée"
          data-reglages-generation
          @click="ouvrirReglages"
        >
          <i class="ph ph-sliders-horizontal text-sm text-slate-500" aria-hidden="true"></i>
          Réglages…
        </button>
      </template>
    </SelecteurModele>
    <BoutonsEnvoi />
  </div>
</template>
