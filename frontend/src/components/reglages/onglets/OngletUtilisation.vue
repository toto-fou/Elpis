<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/reglages/onglets/OngletUtilisation.vue — onglet « usage » des Paramètres. -->
<script setup lang="ts">
import { domaineReglages } from "../../../features/reglages/domaine";

const rg = domaineReglages();
</script>

<template>
  <!-- eslint-disable vue/multiline-html-element-content-newline -->
  <div class="space-y-5 max-w-2xl">
    <div class="flex items-start justify-between gap-4 flex-wrap">
      <div>
        <h3 class="text-base font-semibold text-slate-800 mb-1">Utilisation</h3>
        <p class="text-xs text-slate-500">Votre activité sur la période sélectionnée.</p>
      </div>

      <div class="flex items-center gap-0.5 bg-slate-100 rounded-lg p-0.5 text-xs font-medium shrink-0">
        <button
          v-for="d in [1, 7, 30, 90]"
          :key="d"
          :class="
            rg.usageDays === d ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'
          "
          class="px-2.5 py-1 rounded-md transition-colors"
          @click="rg.setUsageDays(d)"
        >
          {{ d }} j
        </button>
      </div>
    </div>

    <div
      v-if="rg.usageLoading && !rg.usageData"
      role="status"
      class="flex items-center gap-2 text-sm text-slate-500 py-8 justify-center"
    >
      <i class="ph ph-spinner-gap animate-spin" aria-hidden="true"></i> Chargement des métriques…
    </div>

    <div
      v-else-if="rg.usageError && !rg.usageData"
      role="alert"
      class="flex items-center gap-2 text-sm text-red-500 py-8 justify-center"
    >
      <i class="ph ph-warning-circle" aria-hidden="true"></i> {{ rg.usageError }}
    </div>

    <template v-else-if="rg.usageData">
      <div class="set-block">
        <div class="flex items-center gap-2 text-sm font-medium text-slate-700 mb-3">
          <i class="ph ph-coins text-blue-500" aria-hidden="true"></i>
          <span
            title="Tokens envoyés au modèle et générés par lui, toutes requêtes comprises (itérations d'outils, routines, sous-agents)"
            >Tokens</span
          >
          <span
            class="ml-auto text-xl font-bold text-slate-800 tabular-nums"
            :title="(rg.usageData.tokens?.total || 0).toLocaleString('fr-FR') + ' tokens'"
            >{{ rg.usageFmt(rg.usageData.tokens?.total) }}</span
          >
        </div>
        <div class="space-y-1.5" role="list">
          <div
            v-for="b in rg.usageBars"
            :key="'ub-' + b.key"
            role="listitem"
            class="flex items-center gap-2 text-[11px]"
            :title="b.title"
          >
            <span
              class="w-20 shrink-0 truncate"
              :class="b.sub ? 'pl-3 text-slate-500' : 'font-medium text-slate-700'"
              >{{ b.label }}</span
            >
            <div class="flex-1 h-2 rounded-full bg-slate-100 overflow-hidden">
              <div
                class="h-full rounded-full"
                :class="b.cls"
                :style="{ width: rg.usageWidth(b.value, rg.usageBarMax) }"
              ></div>
            </div>
            <span class="w-14 shrink-0 text-right font-semibold text-slate-700 tabular-nums">{{
              rg.usageFmt(b.value)
            }}</span>
            <span class="w-28 shrink-0 text-slate-400 tabular-nums truncate">{{ b.note }}</span>
          </div>
        </div>

        <div
          v-if="rg.usageData.tokens?.by_source && rg.usageData.tokens?.by_source.length > 1"
          class="mt-4 pt-3 border-t border-slate-100 space-y-1.5"
        >
          <div
            v-for="s in rg.usageData.tokens?.by_source"
            :key="'us-' + s.source"
            class="flex items-center gap-2 text-[11px]"
            :title="rg.usageSourceTitle(s)"
          >
            <span class="w-20 shrink-0 truncate text-slate-500">{{ rg.usageSourceLabel(s.source) }}</span>
            <div class="flex-1 h-1.5 rounded-full bg-slate-100 overflow-hidden">
              <div
                class="h-full rounded-full bg-blue-500"
                :style="{ width: rg.usageWidth(s.tokens, rg.usageSourceMax) }"
              ></div>
            </div>
            <span class="w-14 shrink-0 text-right font-semibold text-slate-700 tabular-nums">{{
              rg.usageFmt(s.tokens)
            }}</span>
            <span class="w-28 shrink-0 text-slate-400 tabular-nums">{{ s.turns }} tours</span>
          </div>
        </div>
      </div>

      <div class="grid grid-cols-2 gap-3">
        <div class="set-block">
          <div class="flex items-center gap-2 text-sm font-medium text-slate-700 mb-3">
            <i class="ph ph-chats-circle text-blue-500"></i> Conversations
          </div>
          <div class="flex items-baseline gap-4">
            <div>
              <span class="text-xl font-bold text-slate-800 tabular-nums">{{
                rg.usageData.chats?.active
              }}</span>
              <span class="text-[11px] text-slate-500">actives</span>
            </div>
            <div>
              <span class="text-xl font-bold text-slate-600 tabular-nums">{{
                rg.usageData.chats?.archived
              }}</span>
              <span class="text-[11px] text-slate-500">archivées</span>
            </div>
          </div>
        </div>
        <div class="set-block">
          <div class="flex items-center gap-2 text-sm font-medium text-slate-700 mb-3">
            <i class="ph ph-paper-plane-tilt text-blue-500"></i> Messages
          </div>
          <div class="flex items-baseline gap-4">
            <div>
              <span class="text-xl font-bold text-slate-800 tabular-nums">{{
                rg.usageData.messages?.sent
              }}</span>
              <span class="text-[11px] text-slate-500">envoyés</span>
            </div>
            <div>
              <span class="text-xl font-bold text-slate-600 tabular-nums">{{
                rg.usageData.messages?.received
              }}</span>
              <span class="text-[11px] text-slate-500">reçus</span>
            </div>
          </div>
        </div>
      </div>

      <div v-if="(rg.usageData.routines?.runs ?? 0) > 0" class="set-block">
        <div class="flex items-center gap-2 text-sm font-medium text-slate-700 mb-3">
          <i class="ph ph-clock-countdown text-blue-500"></i> Routines
        </div>
        <div class="flex items-baseline gap-4 flex-wrap">
          <div>
            <span class="text-xl font-bold text-slate-800 tabular-nums">{{
              rg.usageData.routines?.runs
            }}</span>
            <span class="text-[11px] text-slate-500">exécutions</span>
          </div>
          <div>
            <span class="text-base font-bold text-emerald-600 tabular-nums">{{
              rg.usageData.routines?.ok
            }}</span>
            <span class="text-[11px] text-slate-500">ok</span>
          </div>
          <div v-if="(rg.usageData.routines?.error ?? 0) > 0">
            <span class="text-base font-bold text-red-500 tabular-nums">{{
              rg.usageData.routines?.error
            }}</span>
            <span class="text-[11px] text-slate-500">erreurs</span>
          </div>
        </div>
      </div>

      <p class="text-[11px] text-slate-500">Données agrégées localement, jamais transmises à l'extérieur.</p>
    </template>
  </div>
</template>
