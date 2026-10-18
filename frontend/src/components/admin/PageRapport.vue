<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/admin/PageRapport.vue — page Supervision › Rapport quotidien. -->
<script setup lang="ts">
import { domaineAdmin } from "../../features/admin/domaine";

const adm = domaineAdmin();
</script>

<template>
  <div v-if="adm.adminTab === 'report'" class="animate-[fadeIn_0.2s] space-y-4">
    <section class="adm-card">
      <header class="adm-card__head">
        <i class="ph ph-file-text adm-card__icon" aria-hidden="true"></i>
        <div>
          <h3 class="adm-card__title">Rapport du jour</h3>
          <p class="adm-card__hint">
            Usage de l'IA sur les dernières 24 h<span v-if="adm.dailyReport && adm.dailyReport.date">
              · {{ adm.dailyReport.date }}</span
            >
          </p>
        </div>
        <div class="adm-card__actions">
          <select
            v-if="adm.reportHistory && adm.reportHistory.length"
            class="set-select text-sm"
            aria-label="Jour du rapport"
            @change="adm.loadDailyReport(($event.target as HTMLInputElement).value || undefined)"
          >
            <option value="">Aujourd'hui</option>
            <option v-for="r in adm.reportHistory" :key="r.date" :value="r.date">{{ r.date }}</option>
          </select>
          <button type="button" class="adm-btn adm-btn--quiet adm-tool" @click="adm.printDailyReport()">
            <i class="ph ph-printer" aria-hidden="true"></i> Imprimer
          </button>
          <button
            type="button"
            :disabled="adm.dailyReportGenerating"
            class="adm-btn adm-btn--primary"
            @click="adm.generateDailyReport()"
          >
            <i
              class="ph"
              :class="adm.dailyReportGenerating ? 'ph-spinner animate-spin' : 'ph-paper-plane-tilt'"
              aria-hidden="true"
            ></i>
            Générer
          </button>
        </div>
      </header>
      <div class="adm-rows">
        <div class="adm-row">
          <div>
            <span class="adm-row__label" title="Chaque jour, aux administrateurs.">Envoi automatique</span>
            <span class="sr-only">Chaque jour, aux administrateurs.</span>
          </div>
          <div>
            <label class="flex items-center gap-2 text-sm cursor-pointer w-fit">
              <span class="relative inline-flex items-center shrink-0">
                <input
                  type="checkbox"
                  class="sr-only peer"
                  :checked="adm.dailyDigestAuto"
                  @change="adm.setDailyDigestAuto(($event.target as HTMLInputElement).checked)"
                />
                <span class="set-switch-track"></span>
              </span>
              <span class="adm-row__label">{{ adm.dailyDigestAuto ? "Activé" : "Désactivé" }}</span>
            </label>
          </div>
        </div>
      </div>
    </section>

    <div v-if="adm.dailyReportLoading && !adm.dailyReport" class="adm-card p-12 text-center">
      <i class="ph ph-spinner animate-spin text-3xl mb-2 block adm-empty__icon" aria-hidden="true"></i>
      <span class="adm-empty">Chargement du rapport…</span>
    </div>

    <section v-for="sec in adm.reportValueSections" :key="sec.id" class="adm-card">
      <header class="adm-card__head">
        <div>
          <h3 class="adm-card__title">{{ sec.label }}</h3>
        </div>
      </header>
      <div class="p-4 grid grid-cols-2 md:grid-cols-4 gap-3">
        <div v-for="wid in sec.widgets" :key="wid" class="adm-stat">
          <div class="adm-stat__label">{{ adm.reportTitle(wid) }}</div>
          <div class="adm-stat__value tabular-nums">{{ adm.reportVal(wid) }}</div>
        </div>
      </div>
    </section>
  </div>
</template>
