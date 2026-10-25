<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/reglages/onglets/OngletCompaction.vue — onglet « compaction » des Paramètres. -->
<script setup lang="ts">
import AideOnglet from "../AideOnglet.vue";
import { domaineReglages } from "../../../features/reglages/domaine";

const rg = domaineReglages();
</script>

<template>
  <!-- eslint-disable vue/multiline-html-element-content-newline -->
  <div class="space-y-5 max-w-xl">
    <AideOnglet titre="Compaction"
      >Quand l'assistant résume les anciens tours pour libérer du contexte.</AideOnglet
    >

    <div class="bg-slate-50 rounded-xl">
      <label class="set-row cursor-pointer hover:bg-white/60 transition-colors rounded-xl">
        <i class="ph ph-arrows-in-line-horizontal text-slate-400 text-lg w-5"></i>
        <div class="flex-1 min-w-0">
          <div class="text-sm text-slate-800">Compaction automatique</div>
          <div class="text-xs text-slate-500">
            Désactivée par défaut. Une fois activée, l'assistant résume tout seul les anciens tours quand le
            contexte se remplit.
          </div>
        </div>
        <div class="relative inline-flex items-center shrink-0">
          <input
            v-model="rg.settings.compression_enabled"
            type="checkbox"
            class="sr-only peer"
            @change="rg.persistCompressionEnabled()"
          />
          <div class="set-switch-track peer-checked:bg-blue-600 peer-checked:border-blue-600"></div>
        </div>
      </label>
    </div>

    <div v-if="rg.settings.compression_enabled" class="bg-slate-50 rounded-lg p-3.5">
      <div class="flex justify-between items-center gap-3">
        <label for="set-compact-unit" class="text-sm text-slate-700">Seuil</label>
        <select
          id="set-compact-unit"
          class="set-select set-control--sm shrink-0"
          :value="rg.compactionUnit"
          @change="rg.setCompactionUnit(($event.target as HTMLInputElement).value)"
        >
          <option value="auto">Auto</option>
          <option value="pct">Pourcentage</option>
          <option value="tokens">Jetons</option>
        </select>
      </div>

      <div v-if="rg.compactionUnit === 'pct'" class="mt-3">
        <div class="flex justify-between items-center mb-2">
          <span class="text-xs text-slate-500">Part de la fenêtre</span>
          <span class="text-xs font-mono text-blue-600 bg-white px-2 py-0.5 rounded border border-slate-200"
            >{{ rg.compactionPct }} %</span
          >
        </div>
        <input
          type="range"
          min="30"
          max="95"
          step="5"
          :value="rg.compactionPct"
          class="set-range w-full"
          @input="rg.setCompactionPct(($event.target as HTMLInputElement).value)"
          @change="rg.persistCompactionThreshold()"
        />
      </div>

      <div v-else-if="rg.compactionUnit === 'tokens'" class="mt-3">
        <label for="set-compact-tokens" class="block text-xs text-slate-500 mb-2">Jetons de contexte</label>
        <div class="flex items-center gap-2">
          <input
            id="set-compact-tokens"
            type="number"
            min="2048"
            max="4000000"
            step="1000"
            placeholder="80000"
            :value="rg.settings.compression_threshold_tokens || ''"
            class="set-input max-w-[9rem]"
            @input="rg.setCompactionTokens(($event.target as HTMLInputElement).value)"
            @change="rg.persistCompactionThreshold()"
          />
          <span
            class="text-xs font-mono text-blue-600 bg-white px-2 py-0.5 rounded border border-slate-200"
            >{{ rg.compactionTokensLabel }}</span
          >
        </div>
      </div>

      <p class="text-xs text-slate-500 mt-2">{{ rg.compactionThresholdHint }}</p>
    </div>

    <div v-if="rg.settings.compression_enabled" class="bg-slate-50 rounded-lg p-3.5">
      <div class="flex justify-between items-center gap-3">
        <label for="set-compact-rounds" class="text-sm text-slate-700">Compactions max</label>
        <select
          id="set-compact-rounds"
          class="set-select set-control--sm shrink-0"
          :value="rg.compactionRoundsMode"
          @change="rg.setCompactionRoundsMode(($event.target as HTMLInputElement).value)"
        >
          <option value="auto">Auto</option>
          <option value="custom">Nombre</option>
          <option value="unlimited">Illimité</option>
        </select>
      </div>

      <div v-if="rg.compactionRoundsMode === 'custom'" class="mt-3">
        <label for="set-compact-rounds-n" class="block text-xs text-slate-500 mb-2">Par conversation</label>
        <input
          id="set-compact-rounds-n"
          type="number"
          min="1"
          max="200"
          step="1"
          placeholder="24"
          :value="(rg.settings.compression_max_rounds ?? 0) > 0 ? rg.settings.compression_max_rounds : ''"
          class="set-input max-w-[6rem]"
          @input="rg.setCompactionRounds(($event.target as HTMLInputElement).value)"
          @change="rg.persistCompactionMaxRounds()"
        />
      </div>

      <p class="text-xs text-slate-500 mt-2">{{ rg.compactionRoundsHint }}</p>
    </div>

    <div class="bg-slate-50 rounded-lg px-3.5 py-3 space-y-2">
      <div v-if="rg.settings.compression_enabled" class="flex gap-2.5 text-xs text-slate-500">
        <i class="ph ph-infinity text-slate-400 text-base shrink-0"></i>
        <span
          >La compaction s'intercale entre deux appels d'outils : une tâche de plusieurs heures tient sans
          jamais saturer la fenêtre.</span
        >
      </div>
      <div class="flex gap-2.5 text-xs text-slate-500">
        <i class="ph ph-terminal text-slate-400 text-base shrink-0"></i>
        <span
          >La commande <span class="font-mono">/compact</span> reste disponible dans tous les cas, seuil ou
          pas.</span
        >
      </div>
    </div>
  </div>
</template>
