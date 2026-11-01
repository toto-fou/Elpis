<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/agents/PageAgents.vue — page Agents plein écran (menu Plus) : en-tête (retour, interrupteur global, actions de l'agent ouvert ; création par la carte en pointillés), grille ou fiche. -->
<script setup lang="ts">
import { computed } from "vue";

import { rangeeDuFormulaire } from "../../features/agents/page";
import { domaineReglages } from "../../features/reglages/domaine";
import FicheAgent from "./FicheAgent.vue";
import GrilleAgents from "./GrilleAgents.vue";

const rg = domaineReglages();
const actifGlobal = computed(() => !!rg.features.agents && !!rg.settings.agents_enabled);
/** Interrupteur global : la case suit l'état effectif, un clic enregistre le choix du compte. */
function basculerGlobal(ev: Event): void {
  rg.settings.agents_enabled = (ev.target as HTMLInputElement).checked;
  void rg.persistAgentsEnabled();
}
const fiche = computed(() => rg.agentForm !== null);
const rangee = computed(() => rangeeDuFormulaire(rg.agentBank, rg.agentForm));
const cleFiche = computed(() => {
  const f = rg.agentForm;
  return !f ? "" : f._template ? "t:" + f.name : "c:" + f._idx;
});
const BOUTON =
  "inline-flex items-center gap-1.5 px-3 min-h-8 rounded-lg border border-slate-200 bg-white text-[13px] text-slate-700 hover:bg-slate-50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500";
const DANGER =
  "inline-flex items-center gap-1.5 px-3 min-h-8 rounded-lg border border-slate-200 bg-white text-[13px] text-red-700 hover:bg-red-50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500";
const PRIMAIRE =
  "inline-flex items-center gap-1.5 px-3.5 min-h-8 rounded-lg bg-blue-600 text-white text-[13px] font-semibold hover:bg-blue-700 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500";
</script>

<template>
  <div
    v-if="rg.currentView === 'agents'"
    role="region"
    aria-label="Gestion des agents"
    class="elpis-agents-page absolute inset-0 z-[45] bg-white flex flex-col"
  >
    <header
      class="min-h-16 shrink-0 flex flex-wrap items-center gap-3 px-4 py-2 bg-white border-b border-slate-200"
    >
      <button
        type="button"
        :title="fiche ? 'Retour aux agents' : 'Retour au chat'"
        :aria-label="fiche ? 'Retour aux agents' : 'Retour au chat'"
        class="w-9 h-9 rounded-lg text-slate-500 hover:bg-slate-50 hover:text-slate-700 flex items-center justify-center transition-colors shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        data-agents-retour
        @click="fiche ? rg.leaveAgentForm() : rg.closeAgentsPage()"
      >
        <i class="ph ph-arrow-left text-lg" aria-hidden="true"></i>
      </button>
      <i class="ph ph-robot text-blue-500 text-2xl shrink-0" aria-hidden="true"></i>
      <div class="flex-1 min-w-40">
        <template v-if="!fiche || !rg.agentForm">
          <h2 class="font-bold text-base text-slate-900 tracking-tight leading-tight">Agents</h2>
          <p class="text-xs text-slate-500 truncate">Sous-missions confiées par l'assistant</p>
        </template>
        <template v-else>
          <p class="text-xs text-slate-500" data-agents-chemin>
            Agents › {{ rg.agentForm._template ? "Livrés" : "Personnels" }}
          </p>
          <h2 class="font-bold text-base font-mono text-slate-900 tracking-tight leading-tight">
            {{ rg.agentForm.name.trim() || "Nouvel agent" }}
          </h2>
        </template>
      </div>

      <template v-if="!fiche">
        <label
          class="inline-flex items-center gap-2 h-8 text-[13px] text-slate-700 cursor-pointer"
          title="Désactivés par défaut. Activés, l'assistant peut déléguer une sous-mission (explorer, implémenter, vérifier, chercher sur le web, ouvrir une PR) via l'outil task."
        >
          <span>Sous-agents</span>
          <input
            :checked="actifGlobal"
            type="checkbox"
            role="switch"
            :disabled="!rg.features.agents"
            :aria-checked="actifGlobal ? 'true' : 'false'"
            class="sr-only peer"
            data-agents-global
            @change="basculerGlobal"
          />
          <span class="set-switch-track block peer-checked:bg-blue-600 peer-checked:border-blue-600"></span>
          <span class="text-slate-600" data-agents-global-etat>{{
            !rg.features.agents
              ? "Désactivés par l'administrateur"
              : rg.settings.agents_enabled
                ? "Activés"
                : "Désactivés"
          }}</span>
        </label>
      </template>
      <template v-else>
        <button
          v-if="rangee"
          type="button"
          :class="BOUTON"
          title="Crée un agent personnel pré-rempli de celui-ci"
          data-agent-dup
          @click="rg.duplicateAgent(rangee)"
        >
          <i class="ph ph-copy" aria-hidden="true"></i> Dupliquer
        </button>
        <button
          v-if="rangee && rangee.template && rangee.modified"
          type="button"
          :class="BOUTON"
          title="Reprend le modèle livré : prompt, outils et budget"
          data-agent-reset
          @click="rg.resetAgentToTemplate(rangee)"
        >
          <i class="ph ph-arrow-counter-clockwise" aria-hidden="true"></i> Réinitialiser
        </button>
        <button
          v-if="rangee && !rangee.template"
          type="button"
          :class="DANGER"
          data-agent-delete
          @click="rg.deleteCustomAgent(rangee)"
        >
          <i class="ph ph-trash" aria-hidden="true"></i> Supprimer
        </button>
        <button
          type="button"
          :class="PRIMAIRE"
          title="Enregistré pour votre compte seulement"
          data-agent-save
          @click="rg.saveAgentForm()"
        >
          Enregistrer
        </button>
      </template>
    </header>

    <FicheAgent v-if="fiche" :key="cleFiche" />
    <GrilleAgents v-else />
  </div>
</template>
