<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/rag/PassagesIndexes.vue — onglet « Passages indexés » : la vraie liste du document, chargée par pages, avec un filtre texte. -->
<script setup lang="ts">
import { computed } from "vue";

import { jetonsMax, largeurRelative } from "../../features/rag/decoupage";
import { domaineRag } from "../../features/rag/domaine";
import { formaterNombre } from "../../features/rag/format";
import LignePassage from "./LignePassage.vue";

const rg = domaineRag();
const plusLong = computed(() => jetonsMax(rg.decoupage.indexes));

function surDefilement(e: Event): void {
  const z = e.target as HTMLElement;
  if (z.scrollTop + z.clientHeight >= z.scrollHeight - 80 && rg.decoupage.indexesRestants > 0)
    void rg.decoupage.chargerIndexes();
}
</script>

<template>
  <div class="rag-apercu" data-rag-indexes>
    <div class="rag-tools">
      <div class="rag-search">
        <i class="ph ph-magnifying-glass" aria-hidden="true"></i>
        <input
          v-model="rg.decoupage.filtre"
          class="rag-input"
          type="search"
          placeholder="Filtrer les passages"
          aria-label="Filtrer les passages indexés"
        />
      </div>
      <span class="rag-tools__grow"></span>
      <span class="rag-hint rag-num" role="status">
        {{ formaterNombre(rg.decoupage.indexes.length) }} sur {{ formaterNombre(rg.decoupage.indexesTotal) }}
        {{ rg.decoupage.indexesTotal > 1 ? "passages" : "passage" }}
      </span>
    </div>
    <p v-if="rg.decoupage.indexesErreur" class="rag-error" role="alert">
      <i class="ph ph-warning-circle" aria-hidden="true"></i><span>{{ rg.decoupage.indexesErreur }}</span>
    </p>
    <div class="rag-scroll" @scroll.passive="surDefilement">
      <ul class="rag-pas-list" aria-label="Passages indexés">
        <LignePassage
          v-for="p in rg.decoupage.indexesVisibles"
          :key="p.index"
          :passage="p"
          :numero="p.index + 1"
          :id-base="'rag-ix-' + p.index"
          :largeur="largeurRelative(p.jetons, plusLong)"
          :ouvert="rg.decoupage.depliesIndexes.includes(p.index)"
          @basculer="rg.decoupage.basculerIndexe(p.index)"
        />
      </ul>
      <p v-if="rg.decoupage.indexesEnCours" class="rag-empty-docs" role="status">
        <i class="ph ph-circle-notch animate-spin" aria-hidden="true"></i> Chargement des passages…
      </p>
      <p
        v-else-if="
          rg.decoupage.indexesCharges &&
          rg.decoupage.indexesVisibles.length === 0 &&
          !rg.decoupage.indexesErreur
        "
        class="rag-empty-docs"
      >
        {{
          rg.decoupage.filtre.trim() !== ""
            ? "Aucun passage chargé ne correspond au filtre."
            : "Ce document n’a pas encore de passage indexé."
        }}
      </p>
      <div v-if="rg.decoupage.indexesRestants > 0 && !rg.decoupage.indexesEnCours" class="rag-more">
        <p v-if="rg.decoupage.filtre.trim() !== ''" class="rag-hint">
          Le filtre porte sur les passages déjà chargés.
        </p>
        <button type="button" class="rag-btn" @click="rg.decoupage.chargerIndexes()">
          Afficher la suite ({{ formaterNombre(rg.decoupage.indexesRestants) }})
        </button>
      </div>
    </div>
  </div>
</template>
