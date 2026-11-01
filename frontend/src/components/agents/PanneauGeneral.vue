<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/agents/PanneauGeneral.vue — onglet Général de la fiche : nom (fixe pour un livré), description lue par l'assistant, budget d'appels d'outils. -->
<script setup lang="ts">
import { useId } from "vue";

import { domaineReglages } from "../../features/reglages/domaine";

const rg = domaineReglages();
const uid = useId();
</script>

<template>
  <div v-if="rg.agentForm" class="flex flex-col gap-4">
    <div class="flex flex-col gap-1.5">
      <label
        class="text-[13px] font-semibold text-slate-800"
        :for="uid + '-nom'"
        :title="
          rg.agentForm._template
            ? 'Fixe pour un agent livré : une variante se fait par Dupliquer.'
            : '1 à 32 caractères : a-z, 0-9, tirets. C\'est la valeur que le modèle passe à l\'outil task.'
        "
        >Nom</label
      >
      <input
        :id="uid + '-nom'"
        v-model="rg.agentForm.name"
        :readonly="rg.agentForm._template"
        :aria-readonly="rg.agentForm._template ? 'true' : undefined"
        placeholder="docs-writer"
        class="set-input font-mono max-w-xs"
        data-agent-nom
      />
    </div>
    <div class="flex flex-col gap-1.5">
      <label
        class="text-[13px] font-semibold text-slate-800"
        :for="uid + '-desc'"
        title="Une ligne lue par l'assistant pour choisir cet agent, en anglais."
        >Description</label
      >
      <input
        :id="uid + '-desc'"
        v-model="rg.agentForm.description"
        maxlength="200"
        :placeholder="
          rg.agentForm._template ? rg.agentForm._tplSummary || 'template description' : 'writes the repo docs'
        "
        class="set-input"
        data-agent-description
      />
    </div>
    <div class="flex items-center gap-2.5">
      <label
        class="text-[13px] font-semibold text-slate-800"
        :for="uid + '-budget'"
        title="Appels d'outils au plus ; vide : valeur par défaut."
        >Budget</label
      >
      <input
        :id="uid + '-budget'"
        v-model="rg.agentForm.max_iters"
        type="number"
        min="1"
        :max="rg.CUSTOM_ITERS_MAX"
        :placeholder="
          rg.agentForm._template && rg.agentForm._tplIters ? String(rg.agentForm._tplIters) : 'défaut'
        "
        class="set-input font-mono w-24 text-right"
        data-agent-budget
      />
      <span class="text-[13px] text-slate-600">appels d'outils</span>
    </div>
  </div>
</template>
