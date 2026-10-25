<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/reglages/ModaleReglages.vue — gabarit migré de includes/modals/settings.html. -->
<script setup lang="ts">
import { domaineReglages } from "../../features/reglages/domaine";
import RecadrageImage from "../communs/RecadrageImage.vue";
import OngletSkills from "../skills/OngletSkills.vue";
import OngletAgents from "./onglets/OngletAgents.vue";
import OngletApparence from "./onglets/OngletApparence.vue";
import OngletArchives from "./onglets/OngletArchives.vue";
import OngletChat from "./onglets/OngletChat.vue";
import OngletCompaction from "./onglets/OngletCompaction.vue";
import OngletConnecteurs from "./onglets/OngletConnecteurs.vue";
import OngletConnexions from "./onglets/OngletConnexions.vue";
import OngletFonctionnalites from "./onglets/OngletFonctionnalites.vue";
import OngletMemoire from "./onglets/OngletMemoire.vue";
import OngletModelesIA from "./onglets/OngletModelesIA.vue";
import OngletProfil from "./onglets/OngletProfil.vue";
import OngletPrompts from "./onglets/OngletPrompts.vue";
import OngletSandbox from "./onglets/OngletSandbox.vue";
import OngletUtilisation from "./onglets/OngletUtilisation.vue";
import RailParametres from "./RailParametres.vue";

const rg = domaineReglages();
</script>

<template>
  <!-- eslint-disable vue/multiline-html-element-content-newline -->
  <Transition name="modal">
    <div
      v-if="rg.showSettingsModal"
      data-a11y-modal
      role="dialog"
      aria-modal="true"
      aria-label="Paramètres"
      class="fixed inset-0 z-[5000] flex items-center justify-center bg-slate-900/80 p-4"
      @click.self="rg.closeSettings()"
    >
      <div
        :ref="
          (el) => {
            rg.settingsDialogEl = el as typeof rg.settingsDialogEl;
          }
        "
        tabindex="-1"
        class="bg-white rounded-2xl shadow-2xl ring-1 ring-slate-200 w-full max-w-4xl overflow-hidden flex flex-col h-[85vh] max-h-[780px] focus:outline-none"
      >
        <div class="px-5 py-4 border-b border-slate-100 flex justify-between items-center shrink-0">
          <div class="flex items-center gap-2.5">
            <span
              class="w-7 h-7 rounded-lg bg-slate-100 flex items-center justify-center text-slate-600"
              aria-hidden="true"
            >
              <i class="ph ph-sliders text-base" aria-hidden="true"></i>
            </span>
            <h2 class="text-base font-semibold text-slate-800">Paramètres</h2>
          </div>
          <div class="flex items-center gap-3 min-w-0">
            <span role="status" class="text-xs text-slate-500 flex items-center gap-1.5" data-etat-parametres>
              <template v-if="rg.settingsDirty || rg.memoryDirty">
                <span class="w-1.5 h-1.5 rounded-full shrink-0 bg-amber-500" aria-hidden="true"></span>
                Modifications non enregistrées
              </template>
            </span>
            <button
              type="button"
              aria-label="Fermer les paramètres"
              title="Fermer"
              class="w-8 h-8 shrink-0 rounded-lg hover:bg-slate-100 text-slate-500 hover:text-slate-700 transition-colors flex items-center justify-center"
              @click="rg.closeSettings()"
            >
              <i class="ph ph-x text-lg" aria-hidden="true"></i>
            </button>
          </div>
        </div>

        <div class="flex flex-1 min-h-0 overflow-hidden flex-col md:flex-row">
          <RailParametres />

          <div
            class="flex-1 min-h-0 bg-white"
            :class="
              rg.settingsTab === 'skills'
                ? 'overflow-hidden flex flex-col'
                : 'overflow-y-auto custom-scrollbar p-6'
            "
          >
            <OngletSkills />

            <OngletMemoire v-if="rg.settingsTab === 'memory'" />

            <OngletAgents v-if="rg.settingsTab === 'agents'" />

            <OngletConnexions v-if="rg.settingsTab === 'connexions'" />

            <OngletConnecteurs v-if="rg.settingsTab === 'connectors'" />

            <OngletModelesIA v-if="rg.settingsTab === 'ai_models'" />

            <OngletProfil v-if="rg.settingsTab === 'profile'" />

            <OngletUtilisation v-if="rg.settingsTab === 'usage'" />

            <OngletChat v-if="rg.settingsTab === 'chat'" />

            <OngletCompaction v-if="rg.settingsTab === 'compaction'" />

            <OngletApparence v-if="rg.settingsTab === 'appearance'" />

            <OngletFonctionnalites v-if="rg.settingsTab === 'features'" />

            <OngletPrompts v-if="rg.settingsTab === 'prompts'" />

            <OngletArchives v-if="rg.settingsTab === 'archives'" />

            <OngletSandbox v-if="rg.settingsTab === 'sandbox'" />
          </div>
        </div>
      </div>
    </div>
  </Transition>
  <RecadrageImage
    :fichier="rg.avatarARecadrer"
    titre="Recadrer la photo de profil"
    forme="rond"
    nom-fichier="avatar"
    @valider="rg.envoyerAvatar"
    @annuler="rg.annulerRecadrageAvatar()"
    @erreur="rg.erreurRecadrageAvatar"
  />
</template>
