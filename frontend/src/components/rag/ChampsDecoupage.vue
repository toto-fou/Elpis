<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/rag/ChampsDecoupage.vue — champs d'un découpage : méthode, séparateur ou expression (exemples cliquables), unité, taille, chevauchement, taille maximale ; les champs suivent la méthode. -->
<script setup lang="ts">
import { computed } from "vue";
import { METHODES_DECOUPAGE_RAG, UNITES_DECOUPAGE_RAG, VALEUR_DECOUPAGE_RAG_MAX } from "@elpis/contracts";
import type { MethodeDecoupageRag, ParamsDecoupageRag, UniteDecoupageRag } from "@elpis/contracts";

import {
  AIDES_METHODE,
  BORNES_DECOUPAGE,
  EXEMPLES_VALEUR,
  LIBELLES_METHODE,
  LIBELLES_UNITE,
  champsVisibles,
  erreursParams,
} from "../../features/rag/decoupage";

const props = defineProps<{ modelValue: ParamsDecoupageRag; idBase: string }>();
const emit = defineEmits<{ "update:modelValue": [valeur: ParamsDecoupageRag] }>();

const p = computed(() => props.modelValue);
const visibles = computed(() => champsVisibles(p.value.methode));
const erreurs = computed(() => erreursParams(p.value));
const exemples = computed(() => {
  const m = p.value.methode;
  return m === "separateur" || m === "regex" ? EXEMPLES_VALEUR[m] : [];
});
const unite = computed(() => (p.value.unite === "jetons" ? "jetons" : "caractères"));

function maj(patch: Partial<ParamsDecoupageRag>): void {
  emit("update:modelValue", { ...p.value, ...patch });
}

function nombre(e: Event): number {
  const v = (e.target as HTMLInputElement).value;
  return v === "" ? Number.NaN : Number(v);
}
</script>

<template>
  <div class="rag-dec-champs">
    <div class="rag-field">
      <label :for="idBase + '-methode'">Méthode</label>
      <select
        :id="idBase + '-methode'"
        class="rag-select"
        :value="p.methode"
        :aria-describedby="idBase + '-methode-aide'"
        @change="maj({ methode: ($event.target as HTMLSelectElement).value as MethodeDecoupageRag })"
      >
        <option v-for="m in METHODES_DECOUPAGE_RAG" :key="m" :value="m">{{ LIBELLES_METHODE[m] }}</option>
      </select>
      <small :id="idBase + '-methode-aide'">{{ AIDES_METHODE[p.methode] }}</small>
    </div>

    <div v-if="visibles.valeur" class="rag-field">
      <label :for="idBase + '-valeur'">{{
        p.methode === "regex" ? "Expression régulière" : "Séparateur"
      }}</label>
      <input
        :id="idBase + '-valeur'"
        class="rag-input rag-input--plain rag-mono"
        type="text"
        autocomplete="off"
        spellcheck="false"
        :maxlength="VALEUR_DECOUPAGE_RAG_MAX"
        :value="p.valeur ?? ''"
        :aria-invalid="erreurs.valeur ? 'true' : undefined"
        :aria-describedby="idBase + '-valeur-aide ' + idBase + '-valeur-err'"
        @input="maj({ valeur: ($event.target as HTMLInputElement).value })"
      />
      <small :id="idBase + '-valeur-aide'">
        {{
          p.methode === "regex"
            ? "Le texte est coupé à chaque correspondance."
            : "Écrivez \\n pour un saut de ligne, \\t pour une tabulation."
        }}
      </small>
      <div class="rag-exemples" role="group" :aria-label="'Exemples'">
        <span class="rag-hint">Exemples</span>
        <button
          v-for="e in exemples"
          :key="e.valeur"
          type="button"
          class="rag-chip"
          :title="e.libelle"
          :aria-label="'Utiliser ' + e.valeur + ' : ' + e.libelle"
          @click="maj({ valeur: e.valeur })"
        >
          <code>{{ e.valeur }}</code>
        </button>
      </div>
      <span :id="idBase + '-valeur-err'" class="rag-err" role="alert">{{ erreurs.valeur }}</span>
    </div>

    <div class="rag-dec-grille">
      <div class="rag-field">
        <label :for="idBase + '-unite'">Unité</label>
        <select
          :id="idBase + '-unite'"
          class="rag-select"
          :value="p.unite"
          @change="maj({ unite: ($event.target as HTMLSelectElement).value as UniteDecoupageRag })"
        >
          <option v-for="u in UNITES_DECOUPAGE_RAG" :key="u" :value="u">{{ LIBELLES_UNITE[u] }}</option>
        </select>
      </div>
      <div class="rag-field">
        <label :for="idBase + '-taille'">Taille visée ({{ unite }})</label>
        <input
          :id="idBase + '-taille'"
          class="rag-input rag-input--plain"
          type="number"
          :min="BORNES_DECOUPAGE.taille.min"
          :max="BORNES_DECOUPAGE.taille.max"
          :value="p.taille"
          :aria-invalid="erreurs.taille ? 'true' : undefined"
          :aria-describedby="idBase + '-taille-err'"
          @input="maj({ taille: nombre($event) })"
        />
        <span :id="idBase + '-taille-err'" class="rag-err" role="alert">{{ erreurs.taille }}</span>
      </div>
      <div v-if="visibles.chevauchement" class="rag-field">
        <label :for="idBase + '-chevauchement'">Chevauchement ({{ unite }})</label>
        <input
          :id="idBase + '-chevauchement'"
          class="rag-input rag-input--plain"
          type="number"
          :min="BORNES_DECOUPAGE.chevauchement.min"
          :max="BORNES_DECOUPAGE.chevauchement.max"
          :value="p.chevauchement"
          :aria-invalid="erreurs.chevauchement ? 'true' : undefined"
          :aria-describedby="idBase + '-chevauchement-err'"
          @input="maj({ chevauchement: nombre($event) })"
        />
        <span :id="idBase + '-chevauchement-err'" class="rag-err" role="alert">{{
          erreurs.chevauchement
        }}</span>
      </div>
      <div class="rag-field">
        <label :for="idBase + '-max'">Taille maximale ({{ unite }})</label>
        <input
          :id="idBase + '-max'"
          class="rag-input rag-input--plain"
          type="number"
          :min="BORNES_DECOUPAGE.tailleMax.min"
          :max="BORNES_DECOUPAGE.tailleMax.max"
          :value="p.taille_max"
          :aria-invalid="erreurs.tailleMax ? 'true' : undefined"
          :aria-describedby="idBase + '-max-aide ' + idBase + '-max-err'"
          @input="maj({ taille_max: nombre($event) })"
        />
        <small :id="idBase + '-max-aide'">Aucun passage ne dépasse cette taille.</small>
        <span :id="idBase + '-max-err'" class="rag-err" role="alert">{{ erreurs.tailleMax }}</span>
      </div>
    </div>
  </div>
</template>
