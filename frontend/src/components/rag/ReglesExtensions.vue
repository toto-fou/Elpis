<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/rag/ReglesExtensions.vue — règles de découpage par type de fichier : une extension, son découpage ; ajouter et retirer. -->
<script setup lang="ts">
import { computed, nextTick } from "vue";
import { EXTENSIONS_RAG } from "@elpis/contracts";

import { focaliserId } from "../../features/rag/dom";
import { domaineRag } from "../../features/rag/domaine";
import ChampsDecoupage from "./ChampsDecoupage.vue";

const rg = domaineRag();
const r = computed(() => rg.reglages);

async function ajouter(): Promise<void> {
  const cle = r.value.ajouterRegle();
  await nextTick();
  focaliserId(`rag-reg-regle-${cle}-ext`);
}
</script>

<template>
  <section class="rag-rules" aria-labelledby="rag-regles-titre" data-rag-regles>
    <h4 id="rag-regles-titre">Règles par type de fichier</h4>
    <p id="rag-regles-aide" class="rag-hint">
      Un type de fichier peut avoir son propre découpage : il remplace celui de la collection pour ces
      fichiers.
    </p>
    <ul v-if="r.brouillon.regles.length > 0" class="rag-rules__list">
      <li
        v-for="regle in r.brouillon.regles"
        :key="regle.cle"
        class="rag-rule"
        role="group"
        :aria-label="'Règle pour ' + (regle.ext ? '.' + regle.ext : 'un type de fichier à choisir')"
        data-rag-regle
      >
        <div class="rag-rule__head">
          <label :for="'rag-reg-regle-' + regle.cle + '-ext'">Type de fichier</label>
          <select
            :id="'rag-reg-regle-' + regle.cle + '-ext'"
            v-model="regle.ext"
            class="rag-select rag-rule__ext"
            :aria-invalid="r.erreurs.regles[regle.cle] ? 'true' : undefined"
            :aria-describedby="'rag-reg-regle-' + regle.cle + '-ext-err'"
          >
            <option value="">Choisir…</option>
            <option v-for="e in EXTENSIONS_RAG" :key="e" :value="e">.{{ e }}</option>
          </select>
          <button
            type="button"
            class="rag-btn rag-btn--icon"
            :title="'Retirer la règle ' + (regle.ext ? '.' + regle.ext : '')"
            :aria-label="'Retirer la règle ' + (regle.ext ? '.' + regle.ext : 'sans type de fichier')"
            @click="r.retirerRegle(regle.cle)"
          >
            <i class="ph ph-trash" aria-hidden="true"></i>
          </button>
        </div>
        <span :id="'rag-reg-regle-' + regle.cle + '-ext-err'" class="rag-err" role="alert">{{
          r.erreurs.regles[regle.cle]
        }}</span>
        <ChampsDecoupage v-model="regle.params" :id-base="'rag-reg-regle-' + regle.cle" />
      </li>
    </ul>
    <div>
      <button type="button" class="rag-btn" aria-describedby="rag-regles-aide" @click="ajouter()">
        <i class="ph ph-plus" aria-hidden="true"></i>Ajouter une règle
      </button>
    </div>
  </section>
</template>
