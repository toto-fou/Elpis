<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/rag/ResultatsDepot.vue — résultat par fichier d'un dépôt ou d'un import : ajouté, remplacé, déjà présent, refusé avec son message. -->
<script setup lang="ts">
import { computed } from "vue";

import { libelleResultat } from "../../features/rag/depot";
import { domaineRag } from "../../features/rag/domaine";

const rg = domaineRag();
const d = computed(() => rg.documents.depot);
const MAX = 200;
// Les refus d'abord : ce sont les lignes qui demandent une réaction.
const lignes = computed(() =>
  [...d.value.resultats]
    .sort((a, b) => Number(b.status === "refuse") - Number(a.status === "refuse"))
    .slice(0, MAX),
);
</script>

<template>
  <section class="rag-results" aria-label="Résultat du dépôt" data-rag-resultats>
    <div class="rag-results__head">
      <b v-if="d.enCours">Envoi en cours : {{ d.envoyes }} / {{ d.total }}</b>
      <b v-else>{{ rg.documents.depotBilan || "Aucun fichier retenu" }}</b>
      <span v-if="d.ignores > 0" class="rag-hint"
        >{{ d.ignores }} fichier{{ d.ignores > 1 ? "s" : "" }} caché{{ d.ignores > 1 ? "s" : "" }} ignoré{{
          d.ignores > 1 ? "s" : ""
        }}</span
      >
      <span class="rag-tools__grow"></span>
      <button
        v-if="!d.enCours"
        type="button"
        class="rag-btn rag-btn--icon"
        title="Fermer le résultat"
        aria-label="Fermer le résultat"
        @click="d.visible = false"
      >
        <i class="ph ph-x" aria-hidden="true"></i>
      </button>
    </div>
    <p v-if="d.erreur" class="rag-error" role="alert">
      <i class="ph ph-warning-circle" aria-hidden="true"></i><span>{{ d.erreur }}</span>
    </p>
    <ul v-if="lignes.length > 0" class="rag-results__list">
      <li
        v-for="(r, i) in lignes"
        :key="i"
        class="rag-results__item"
        :class="{ 'is-refuse': r.status === 'refuse' }"
      >
        <span :title="r.name">{{ r.name }}</span>
        <small
          >{{ libelleResultat(r) }}<template v-if="r.message"> : {{ r.message }}</template></small
        >
      </li>
    </ul>
  </section>
</template>
