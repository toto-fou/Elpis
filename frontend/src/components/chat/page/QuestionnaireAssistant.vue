<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/page/QuestionnaireAssistant.vue — questionnaire de l'outil ask_user : une question à la fois, options, envoi groupé. -->
<script setup lang="ts">
import { CLE_COMPOSEUR, domaine } from "../../../features/chat/page/domaines";

const comp = domaine(CLE_COMPOSEUR);
</script>

<template>
  <div
    v-if="comp.askUserPanel && comp.askUserCurrent"
    class="mb-2 bg-white/95 backdrop-blur-xl rounded-2xl shadow-xl border border-blue-200 overflow-hidden"
    role="form"
    aria-label="Questionnaire de l'assistant"
  >
    <div class="flex items-center justify-between px-4 pt-3">
      <div class="text-[11px] font-semibold text-blue-700 flex items-center gap-1.5">
        <i class="ph ph-list-checks"></i> Questionnaire
        <span class="font-normal text-slate-400"
          >— question {{ comp.askUserPanel.idx + 1 }} / {{ comp.askUserPanel.items.length }}</span
        >
      </div>
      <button
        type="button"
        title="Fermer (répondre librement dans la barre de saisie)"
        class="w-6 h-6 rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-600 flex items-center justify-center transition-colors"
        @click="comp.dismissAskUser"
      >
        <i class="ph ph-x text-sm"></i>
      </button>
    </div>
    <div class="flex gap-1 px-4 pt-2" aria-hidden="true">
      <div
        v-for="(qq, qi) in comp.askUserPanel.items"
        :key="qi"
        class="h-1 flex-1 rounded-full transition-colors"
        :class="
          qi < comp.askUserPanel.idx
            ? 'bg-blue-400'
            : qi === comp.askUserPanel.idx
              ? 'bg-blue-600'
              : 'bg-slate-200'
        "
      ></div>
    </div>
    <div class="px-4 py-3 space-y-2.5">
      <div class="text-sm font-medium text-slate-800">{{ comp.askUserCurrent.q }}</div>
      <div v-if="(comp.askUserCurrent.options || []).length" class="flex flex-wrap gap-1.5">
        <button
          v-for="opt in comp.askUserCurrent.options"
          :key="opt"
          type="button"
          :aria-pressed="comp.isAskOptionOn(opt) ? 'true' : 'false'"
          class="text-xs px-2.5 py-1.5 rounded-lg border transition-colors"
          :class="
            comp.isAskOptionOn(opt)
              ? 'bg-blue-600 border-blue-600 text-white'
              : 'bg-white border-slate-200 text-slate-600 hover:border-blue-300'
          "
          @click="comp.toggleAskOption(opt)"
        >
          {{ opt }}
        </button>
      </div>
      <input
        v-model="comp.askUserCurrent._free"
        :placeholder="
          (comp.askUserCurrent.options || []).length ? 'Autre / précision (optionnel)' : 'Votre réponse…'
        "
        class="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400 bg-white"
        @keydown.enter.prevent="comp.askUserNext"
      />
    </div>
    <div class="flex items-center justify-between px-4 pb-3">
      <button
        v-if="comp.askUserPanel.idx > 0"
        type="button"
        class="text-xs px-3 py-1.5 rounded-md bg-white border border-slate-200 hover:bg-slate-50 text-slate-600 transition-colors flex items-center gap-1"
        @click="comp.askUserPrev"
      >
        <i class="ph ph-caret-left text-[11px]"></i> Précédent
      </button>
      <span v-else></span>
      <button
        type="button"
        :disabled="comp.isStreaming"
        class="text-xs px-3 py-1.5 rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors flex items-center gap-1.5"
        @click="comp.askUserNext"
      >
        <template v-if="comp.askUserPanel.idx < comp.askUserPanel.items.length - 1">
          Suivant <i class="ph ph-caret-right text-[11px]"></i>
        </template>
        <template v-else><i class="ph ph-paper-plane-tilt"></i> Envoyer les réponses</template>
      </button>
    </div>
  </div>
</template>
