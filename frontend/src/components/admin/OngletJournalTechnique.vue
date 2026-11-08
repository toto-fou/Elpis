<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/admin/OngletJournalTechnique.vue — Journaux › Technique : historique du journal commun et flux en direct. -->
<script setup lang="ts">
import { domaineAdmin } from "../../features/admin/domaine";
import EtatActualisation from "./EtatActualisation.vue";

const adm = domaineAdmin();
</script>

<template>
  <div :aria-busy="adm.logsLoading ? 'true' : 'false'">
    <div class="adm-card">
      <header class="adm-card__head relative flex-wrap">
        <i class="ph ph-terminal-window adm-card__icon" aria-hidden="true"></i>
        <div>
          <h3 class="adm-card__title">Journaux</h3>
          <span class="sr-only">300 dernières entrées du journal commun, puis flux en direct.</span>
        </div>
        <div class="adm-card__actions flex-wrap">
          <span
            class="adm-direct"
            :class="{ 'is-on': adm.fluxOuvert }"
            :title="adm.fluxIndisponible ? 'Trop de flux en direct ouverts : nouvel essai automatique.' : ''"
          >
            <span class="adm-maj__point" aria-hidden="true"></span>
            {{ adm.fluxOuvert ? "Direct" : adm.fluxIndisponible ? "Direct indisponible" : "Connexion…" }}
          </span>
          <EtatActualisation
            :chargement="adm.logsLoading"
            :derniere-maj="adm.logsDerniereMaj"
            :echec="adm.logsEchec"
            @actualiser="adm.loadRecentLogs()"
          />
        </div>
        <div class="adm-progression !bottom-0" :class="{ 'is-on': adm.logsLoading }" aria-hidden="true"></div>
      </header>
      <div class="adm-journal__filtres">
        <input
          v-model="adm.logFilters.query"
          type="search"
          placeholder="Filtrer le texte…"
          class="set-input text-sm"
          aria-label="Filtrer les journaux par texte"
        />
        <select v-model="adm.filtreNiveau" class="set-input text-sm" aria-label="Niveau">
          <option value="">Tous les niveaux</option>
          <option v-for="n in adm.niveauxDisponibles" :key="n" :value="n">{{ n }}</option>
        </select>
        <select v-model="adm.filtreService" class="set-input text-sm" aria-label="Service">
          <option value="">Tous les services</option>
          <option v-for="n in adm.servicesDisponibles" :key="n" :value="n">{{ n }}</option>
        </select>
        <select v-model="adm.filtreCategorie" class="set-input text-sm" aria-label="Catégorie">
          <option value="">Toutes les catégories</option>
          <option v-for="n in adm.categoriesDisponibles" :key="n" :value="n">{{ n }}</option>
        </select>
        <label class="flex items-center gap-1.5 text-xs adm-muted cursor-pointer">
          <input v-model="adm.logAutoScroll" type="checkbox" /> Suivre
        </label>
      </div>
      <div
        :ref="
          (el) => {
            adm.logsConsoleRef = el as typeof adm.logsConsoleRef;
          }
        "
        role="log"
        aria-live="polite"
        class="adm-journal custom-scrollbar p-3 font-mono text-xs space-y-0.5"
      >
        <p v-if="!adm.filteredLogs.length" class="adm-empty">Aucune entrée pour ce filtre.</p>

        <div v-for="l in adm.filteredLogs" :key="l.id || l.ts + '|' + l.message" class="flex gap-2">
          <span class="adm-muted shrink-0">{{ adm.fmtLogTs(l.ts) }}</span>
          <span
            class="shrink-0 font-semibold"
            :class="
              l.level === 'ERROR' ? 'text-rose-600' : l.level === 'WARNING' ? 'text-amber-700' : 'adm-muted'
            "
            >{{ l.level }}</span
          >
          <span class="adm-muted shrink-0">{{ l.service }}</span>
          <span class="min-w-0 break-all">{{ l.message }}</span>
        </div>
      </div>
    </div>
  </div>
</template>
