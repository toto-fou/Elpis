<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/modales/FormulaireAssistantSkill.vue — cadrage de l'assistant de création de skill (sujet, objectif, domaine, scripts) avant l'ouverture du chat. -->
<script setup lang="ts">
import { domaineModales } from "../../../features/chat/modales/domaine";

const m = domaineModales();
</script>

<template>
  <!-- Cadrage de l'assistant de création de skill : les bases (sujet/objectif/
           domaine/scripts) sont posées AVANT d'ouvrir le chat — l'entretien LLM
           démarre informé. Déclenché depuis l'onglet Skills des Paramètres
           (startSkillAssistantChat, état dans features/chat/coeur). z-[6000] : passe
           AU-DESSUS de la modal Paramètres (z-[5000]) ; launchSkillAssistantChat
           ferme les Paramètres avant d'ouvrir le chat pré-configuré. Hors du
           <Transition> ci-dessus : ce cadrage n'a jamais été animé (v-if sec).
           PAS de data-a11y-modal : l'union _anyBigModalOpen fait un premier-match
           querySelector — l'ajouter ici casserait le focus-trap des Paramètres
           quand les deux sont ouvertes. -->
  <div
    v-if="m.skillAssistForm.open"
    role="dialog"
    aria-modal="true"
    aria-label="Créer un skill avec l'assistant"
    class="fixed inset-0 z-[6000] flex items-center justify-center bg-slate-900/80 p-4"
    @click.self="m.skillAssistForm.open = false"
  >
    <div class="bg-white rounded-xl shadow-xl w-full max-w-md p-5 space-y-3">
      <div class="flex items-center gap-2">
        <i class="ph ph-sparkle text-slate-400 text-xl"></i>
        <h3 class="font-semibold text-slate-900 text-sm">Créer un skill avec l'assistant</h3>
      </div>
      <p class="text-xs text-slate-500">
        Pose les bases ici — l'assistant complétera par des questionnaires interactifs dans le chat, puis
        rédigera et enregistrera le skill.
      </p>
      <div>
        <label class="text-[11px] font-medium text-slate-500 block mb-1"
          >Sujet <span class="text-red-400">*</span></label
        >
        <input
          v-model="m.skillAssistForm.sujet"
          placeholder="Déployer l'app sur le serveur de staging"
          class="set-input"
        />
      </div>
      <div>
        <label class="text-[11px] font-medium text-slate-500 block mb-1"
          >Objectif / résultat attendu <span class="text-slate-400">(optionnel)</span></label
        >
        <textarea
          v-model="m.skillAssistForm.objectif"
          rows="2"
          placeholder="À la fin, l'app tourne sur staging et le smoke-test passe."
          class="set-textarea"
          style="min-height: 3.5rem"
        ></textarea>
      </div>
      <div class="flex gap-3">
        <div class="flex-1">
          <label class="text-[11px] font-medium text-slate-500 block mb-1"
            >Domaine <span class="text-slate-400">(optionnel)</span></label
          >
          <input v-model="m.skillAssistForm.domaine" placeholder="jenkins, qdrant…" class="set-input" />
        </div>
        <div class="shrink-0">
          <label class="text-[11px] font-medium text-slate-500 block mb-1">Scripts à embarquer ?</label>
          <div class="flex gap-1">
            <button
              v-for="opt in ['oui', 'non', 'à voir']"
              :key="opt"
              type="button"
              class="text-[11px] px-2 py-1.5 rounded-md border transition-colors"
              :class="
                m.skillAssistForm.scripts === opt
                  ? 'bg-blue-600 border-blue-600 text-white'
                  : 'bg-white border-slate-200 text-slate-600 hover:border-blue-300'
              "
              @click="m.skillAssistForm.scripts = m.skillAssistForm.scripts === opt ? '' : opt"
            >
              {{ opt }}
            </button>
          </div>
        </div>
      </div>
      <div class="flex items-center justify-end gap-2 pt-1">
        <button class="skl-btn skl-btn--secondary" @click="m.skillAssistForm.open = false">Annuler</button>
        <button class="skl-btn bg-blue-600 text-white hover:bg-blue-700" @click="m.launchSkillAssistantChat">
          <i class="ph ph-sparkle"></i> Commencer l'entretien
        </button>
      </div>
    </div>
  </div>
</template>
