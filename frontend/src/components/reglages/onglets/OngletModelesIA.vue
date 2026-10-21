<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/reglages/onglets/OngletModelesIA.vue — onglet « ai_models » des Paramètres. -->
<script setup lang="ts">
import { domaineReglages } from "../../../features/reglages/domaine";

const rg = domaineReglages();
</script>

<template>
  <!-- eslint-disable vue/multiline-html-element-content-newline -->
  <div class="space-y-5 max-w-xl">
    <div>
      <h3 class="text-base font-semibold text-slate-800 mb-1">Modèles IA</h3>
      <p class="text-xs text-slate-500">
        Connectez des fournisseurs d'IA avec votre clé API : leurs modèles apparaissent dans le sélecteur de
        modèle du chat. Votre clé est chiffrée côté serveur et n'est jamais réaffichée.
      </p>
    </div>

    <div v-if="rg.llmConnShared.length" class="set-block">
      <div class="flex items-center gap-2 mb-2.5">
        <i class="ph ph-broadcast text-slate-400 text-sm"></i>
        <span class="text-xs font-semibold text-slate-700">Fournis par l'administrateur</span>
      </div>
      <div class="space-y-1.5">
        <div v-for="c in rg.llmConnShared" :key="'sh' + c.id" class="flex items-center gap-2.5 text-sm">
          <i class="ph ph-plugs-connected text-slate-400 text-sm"></i>
          <span class="font-medium text-slate-700 truncate">{{
            c.label || rg.llmPresetLabel(c.provider_type)
          }}</span>
          <span class="text-[11px] text-slate-400">{{ rg.llmPresetLabel(c.provider_type) }}</span>
          <span
            v-if="c.default_model"
            class="ml-auto text-[11px] font-mono text-slate-400 truncate max-w-[45%]"
            :title="c.default_model"
            >{{ c.default_model }}</span
          >
        </div>
      </div>
    </div>

    <div>
      <div class="flex items-center justify-between mb-2">
        <span class="text-xs font-semibold text-slate-700">Mes fournisseurs</span>
        <button
          v-if="!rg.llmConnForm && rg.llmConnectors.length && rg.llmConnAllowed.length"
          class="text-xs font-medium text-blue-600 hover:text-blue-700 flex items-center gap-1"
          @click="rg.newLlmConnector()"
        >
          <i class="ph ph-plus"></i> Ajouter
        </button>
      </div>

      <p
        v-if="rg.llmConnectors.length && !rg.llmConnAllowed.length && !rg.llmConnForm"
        class="text-xs text-slate-400 mb-2"
      >
        Aucun fournisseur cloud n'est ouvert aux comptes par l'administrateur : utilisez les serveurs qu'il
        fournit.
      </p>
      <div v-if="rg.llmConnectors.length" class="set-block !p-0 divide-y divide-slate-100 overflow-hidden">
        <div
          v-for="c in rg.llmConnectors"
          :key="'lc' + c.id"
          class="group flex items-center gap-3 px-3.5 py-2.5"
        >
          <i class="ph ph-plugs-connected text-slate-400"></i>
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="text-sm font-medium text-slate-800 truncate">{{
                c.label || rg.llmPresetLabel(c.provider_type)
              }}</span>
              <span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 shrink-0">{{
                rg.llmPresetLabel(c.provider_type)
              }}</span>
              <span
                v-if="'provider_allowed' in c && c.provider_allowed === false"
                class="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 shrink-0"
                title="Ce fournisseur n'est plus ouvert aux comptes par l'administrateur : ce connecteur reste enregistré mais n'est pas utilisable."
                >fermé par l'administrateur</span
              >
            </div>
            <div class="flex items-center gap-2 mt-0.5 text-[11px] text-slate-400 min-w-0">
              <span v-if="c.default_model" class="font-mono truncate" :title="c.default_model">{{
                c.default_model
              }}</span>
              <span v-else>Modèle choisi dans le chat</span>
              <template v-if="rg.llmConnTest[c.id]">
                <span class="text-slate-300">·</span>
                <span v-if="rg.llmConnTest[c.id]?.testing" class="flex items-center gap-0.5 shrink-0"
                  ><i class="ph ph-spinner-gap animate-spin"></i> test…</span
                >
                <span
                  v-else-if="rg.llmConnTest[c.id]?.ok"
                  class="text-emerald-600 flex items-center gap-0.5 shrink-0"
                  ><i class="ph ph-check-circle"></i> {{ rg.llmConnTest[c.id]?.models_count }} modèles</span
                >
                <span
                  v-else
                  class="text-red-500 flex items-center gap-0.5 shrink-0"
                  :title="rg.llmConnTest[c.id]?.hint || rg.llmConnTest[c.id]?.error"
                  ><i class="ph ph-warning-circle"></i> échec</span
                >
              </template>
            </div>
          </div>
          <div class="flex items-center gap-0.5 opacity-50 group-hover:opacity-100 transition-opacity">
            <button
              class="w-7 h-7 flex items-center justify-center rounded-md text-slate-400 hover:text-blue-600 hover:bg-blue-50 transition-colors"
              title="Tester la connexion"
              @click="rg.testLlmConnector(c)"
            >
              <i class="ph ph-pulse"></i>
            </button>
            <button
              class="w-7 h-7 flex items-center justify-center rounded-md text-slate-400 hover:text-blue-600 hover:bg-blue-50 transition-colors"
              title="Modifier"
              @click="rg.editLlmConnector(c)"
            >
              <i class="ph ph-pencil-simple"></i>
            </button>
            <button
              class="w-7 h-7 flex items-center justify-center rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50 transition-colors"
              title="Supprimer"
              @click="rg.deleteLlmConnector(c)"
            >
              <i class="ph ph-trash"></i>
            </button>
          </div>
        </div>
      </div>

      <div v-else-if="!rg.llmConnForm" class="set-block text-center py-7">
        <i class="ph ph-sparkle text-2xl text-slate-300"></i>
        <p class="text-sm text-slate-500 mt-2">Aucun fournisseur connecté.</p>
        <p class="text-xs text-slate-400 mt-0.5 mb-3.5 max-w-xs mx-auto">
          Ajoutez Anthropic, OpenAI ou un autre fournisseur avec votre clé pour utiliser ses modèles dans le
          chat.
        </p>
        <button
          v-if="rg.llmConnAllowed.length"
          class="px-3.5 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium inline-flex items-center gap-1.5 transition-colors"
          @click="rg.newLlmConnector()"
        >
          <i class="ph ph-plus"></i> Ajouter un fournisseur
        </button>
        <p v-else class="text-xs text-slate-400 max-w-xs mx-auto">
          Aucun fournisseur cloud n'est ouvert aux comptes par l'administrateur : utilisez les serveurs qu'il
          fournit.
        </p>
      </div>

      <div v-if="rg.llmConnForm" class="set-block mt-2 space-y-3">
        <div class="flex items-center gap-2">
          <i class="ph ph-plus-circle text-blue-500"></i>
          <span class="text-sm font-semibold text-slate-700">{{
            rg.llmConnForm.id ? "Modifier le fournisseur" : "Nouveau fournisseur"
          }}</span>
        </div>
        <div v-if="!rg.llmConnForm.id">
          <label class="text-[11px] font-medium text-slate-500 block mb-1">Fournisseur</label>
          <select v-model="rg.llmConnForm.provider_type" class="set-select w-full">
            <option v-for="pt in rg.llmConnAllowed" :key="pt" :value="pt">
              {{ rg.llmPresetLabel(pt) }}
            </option>
          </select>
          <p
            v-if="rg.llmConnPresets[rg.llmConnForm.provider_type]"
            class="text-[11px] text-slate-400 mt-1 font-mono truncate"
          >
            → {{ rg.llmConnPresets[rg.llmConnForm.provider_type]?.base_url }}
          </p>
        </div>
        <div>
          <label class="text-[11px] font-medium text-slate-500 block mb-1">Clé API</label>
          <input
            v-model="rg.llmConnForm.api_key"
            type="password"
            :placeholder="rg.llmConnForm.id ? 'Vide = clé inchangée' : 'sk-…'"
            class="set-input"
          />
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="text-[11px] font-medium text-slate-500 block mb-1"
              >Modèle par défaut <span class="text-slate-400 font-normal">(optionnel)</span></label
            >
            <input
              v-model="rg.llmConnForm.default_model"
              placeholder="ex. claude-sonnet-4-6"
              class="set-input"
            />
          </div>
          <div>
            <label class="text-[11px] font-medium text-slate-500 block mb-1"
              >Nom <span class="text-slate-400 font-normal">(optionnel)</span></label
            >
            <input v-model="rg.llmConnForm.label" placeholder="ex. perso" class="set-input" />
          </div>
        </div>
        <div class="flex items-center gap-2 pt-0.5">
          <button
            :disabled="rg.llmConnBusy"
            class="px-3.5 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium disabled:opacity-50 inline-flex items-center gap-1.5 transition-colors"
            @click="rg.saveLlmConnector()"
          >
            <i v-if="rg.llmConnBusy" class="ph ph-spinner-gap animate-spin"></i>
            {{ rg.llmConnForm.id ? "Enregistrer" : "Ajouter" }}
          </button>
          <button
            class="px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
            @click="rg.cancelLlmConnector()"
          >
            Annuler
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
