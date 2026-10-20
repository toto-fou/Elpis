<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/rag/OngletDocuments.vue — onglet Documents : bandeau d'indexation, filtres, import du bac, résultats du dépôt, tableau, zone de dépôt. -->
<script setup lang="ts">
import { computed } from "vue";

import type { ItemMenuRag } from "../../features/rag/base";
import { domaineRag } from "../../features/rag/domaine";
import { FILTRES_ETAT, LIBELLES_FILTRE_ETAT } from "../../features/rag/filtres";
import type { FiltreEtat } from "../../features/rag/filtres";
import MenuRag from "./MenuRag.vue";
import ResultatsDepot from "./ResultatsDepot.vue";
import TableDocuments from "./TableDocuments.vue";
import ZoneDepot from "./ZoneDepot.vue";

const rg = domaineRag();
const d = computed(() => rg.documents);

const itemsEtat = computed<ItemMenuRag[]>(() =>
  FILTRES_ETAT.map((f) => ({ id: f, libelle: LIBELLES_FILTRE_ETAT[f], actif: d.value.filtreEtat === f })),
);
</script>

<template>
  <div class="rag-pane" :class="{ 'is-over': d.depot.survol && rg.estProprietaire }">
    <div v-if="d.bandeau && rg.estProprietaire" class="rag-job" role="status" data-rag-bandeau>
      <i
        class="ph"
        :class="d.bandeau.enPause ? 'ph-pause-circle' : 'ph-circle-notch animate-spin'"
        aria-hidden="true"
      ></i>
      <div class="rag-job__txt">
        {{ d.bandeau.titre }}
        <small>{{ d.bandeau.detail }}</small>
        <div
          class="rag-prog"
          role="progressbar"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-valuenow="d.bandeau.pourcent"
          aria-label="Progression de l’indexation"
        >
          <i :style="{ width: d.bandeau.pourcent + '%' }"></i>
        </div>
      </div>
      <button v-if="d.bandeau.enPause" type="button" class="rag-btn" @click="d.agir('reprendre')">
        Reprendre
      </button>
      <button v-else type="button" class="rag-btn" @click="d.agir('suspendre')">Suspendre</button>
      <button type="button" class="rag-btn" @click="d.agir('annuler')">Annuler</button>
    </div>

    <div class="rag-tools">
      <div class="rag-search">
        <i class="ph ph-magnifying-glass" aria-hidden="true"></i>
        <input
          v-model="d.filtreTexte"
          class="rag-input"
          type="search"
          placeholder="Filtrer les documents"
          aria-label="Filtrer les documents"
        />
      </div>
      <MenuRag
        id="etats"
        libelle="Filtrer par état"
        :texte="LIBELLES_FILTRE_ETAT[d.filtreEtat as FiltreEtat]"
        :items="itemsEtat"
        gauche
        @choisir="(id) => (d.filtreEtat = id as FiltreEtat)"
      />
      <span class="rag-tools__grow"></span>
      <button
        v-if="rg.estProprietaire"
        type="button"
        class="rag-btn"
        :disabled="!rg.utilisable"
        @click="rg.bac.ouvrir()"
      >
        <i class="ph ph-folder-open" aria-hidden="true"></i>Importer depuis la sandbox
      </button>
    </div>

    <ResultatsDepot v-if="rg.estProprietaire && d.depotSurCollection" />
    <TableDocuments />
    <ZoneDepot v-if="rg.estProprietaire" />
  </div>
</template>
