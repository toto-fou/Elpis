<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/agents/PanneauInstructions.vue — onglet Instructions de la fiche : texte lu par l'agent (anglais), boutons Gabarit et Rétablir. -->
<script setup lang="ts">
import { domaineReglages } from "../../features/reglages/domaine";

const rg = domaineReglages();
const BOUTON =
  "inline-flex items-center gap-1.5 px-3 min-h-8 rounded-lg border border-slate-200 bg-white text-[13px] text-slate-700 hover:bg-slate-50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500";
</script>

<template>
  <div v-if="rg.agentForm" class="flex flex-col gap-2">
    <div class="flex items-center gap-2">
      <span
        class="flex-1 text-[13px] font-semibold text-slate-800"
        :title="
          rg.agentForm._template
            ? 'Texte lu par l\'agent, en anglais. Identique au livré : l\'agent suit les mises à jour du modèle.'
            : 'Texte lu par l\'agent, en anglais. Remplace le prompt de base pour cet agent.'
        "
        >Texte
        <span class="font-normal text-slate-500" data-agent-nb-car
          >{{ (rg.agentForm.prompt ?? "").length }} caractères</span
        ></span
      >
      <button
        v-if="rg.agentFormPromptDiffers"
        type="button"
        :class="BOUTON"
        title="Rendre le texte livré avec ce modèle"
        data-agent-prompt-restore
        @click="rg.restoreTemplatePrompt()"
      >
        <i class="ph ph-arrow-counter-clockwise text-[13px]" aria-hidden="true"></i> Rétablir
      </button>
      <button
        v-else-if="!(rg.agentForm.prompt || '').trim()"
        type="button"
        :class="BOUTON"
        title="Insère la structure des agents livrés : rôle, objectif, outils, méthode, effort, contraintes, rapport, exemples"
        data-agent-gabarit
        @click="rg.insertAgentTemplate()"
      >
        <i class="ph ph-file-text text-[13px]" aria-hidden="true"></i> Gabarit
      </button>
    </div>
    <textarea
      v-model="rg.agentForm.prompt"
      rows="14"
      aria-label="Instructions de l'agent"
      placeholder="You are a specialist in…"
      class="set-textarea font-mono w-full"
      data-agent-prompt
    ></textarea>
  </div>
</template>
