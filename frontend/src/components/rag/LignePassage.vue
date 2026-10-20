<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/rag/LignePassage.vue — un passage dans la fenêtre Découpage : numéro, barre de taille relative, caractères et jetons, page et section, texte repliable, actions. -->
<script setup lang="ts">
import { computed } from "vue";

import type { PassageListeRag } from "@elpis/contracts";
import { emplacementPassage, formaterNombre } from "../../features/rag/format";

const props = defineProps<{
  passage: PassageListeRag;
  numero: number;
  idBase: string;
  /** Largeur relative de la barre, de 0 à 100. */
  largeur: number;
  ouvert: boolean;
  redecoupable?: boolean;
  defaisable?: boolean;
}>();
defineEmits<{ basculer: []; redecouper: []; defaire: [] }>();

const lieu = computed(() =>
  emplacementPassage({ page: props.passage.page, heading_path: props.passage.section ?? "" }),
);
const idTexte = computed(() => `${props.idBase}-texte`);
</script>

<template>
  <li class="rag-pas" :class="{ 'is-sub': passage.redecoupe_de !== null }" data-rag-passage>
    <div class="rag-pas__head">
      <span class="rag-pas__n rag-num">{{ numero }}</span>
      <span class="rag-pas__bar" aria-hidden="true"><i :style="{ width: largeur + '%' }"></i></span>
      <span class="rag-pas__meta rag-num"
        >{{ formaterNombre(passage.caracteres) }} car. · {{ formaterNombre(passage.jetons) }} jetons</span
      >
      <span v-if="lieu" class="rag-pas__lieu" :title="lieu">{{ lieu }}</span>
      <span v-if="passage.redecoupe_de !== null" class="rag-badge">Redécoupé</span>
      <span class="rag-pas__acts">
        <button v-if="defaisable" type="button" class="rag-link" @click="$emit('defaire')">Défaire</button>
        <button
          v-if="redecoupable"
          :id="idBase + '-redecouper'"
          type="button"
          class="rag-btn rag-btn--sm"
          :aria-label="'Redécouper le passage ' + numero"
          @click="$emit('redecouper')"
        >
          <i class="ph ph-scissors" aria-hidden="true"></i>Redécouper
        </button>
        <button
          type="button"
          class="rag-btn rag-btn--sm"
          :aria-expanded="ouvert ? 'true' : 'false'"
          :aria-controls="idTexte"
          :aria-label="(ouvert ? 'Replier' : 'Déplier') + ' le texte du passage ' + numero"
          @click="$emit('basculer')"
        >
          <i class="ph" :class="ouvert ? 'ph-caret-up' : 'ph-caret-down'" aria-hidden="true"></i
          >{{ ouvert ? "Replier" : "Texte" }}
        </button>
      </span>
    </div>
    <p :id="idTexte" class="rag-pas__txt" :class="{ 'is-open': ouvert }">{{ passage.texte }}</p>
    <slot />
  </li>
</template>
