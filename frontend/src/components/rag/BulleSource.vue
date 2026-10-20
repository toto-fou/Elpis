<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/rag/BulleSource.vue — bulle d'une source au survol ou au focus d'une pastille : document, page, section, collection, extrait aux mots de la question surlignés, pertinence et « Voir dans le document » ; au clavier, la pastille ouvre la visionneuse et Échap ferme la bulle. -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from "vue";

import { fermerQuandLaPageBouge, ID_BULLE_SOURCE, positionDansFenetre } from "../../features/rag/bulle";
import { domaineRagOptionnel } from "../../features/rag/domaine";
import { emplacementPassage, formaterScore, iconeFichier } from "../../features/rag/format";
import { collectionAffichee, droitSources, extensionDe } from "../../features/rag/sources-affichage";
import TexteSurligne from "./TexteSurligne.vue";

const rag = domaineRagOptionnel();
const etat = computed(() => rag?.sources.bulle.etat ?? null);
const source = computed(() => etat.value?.source ?? null);
const collections = computed(() => rag?.sources.collections() ?? []);
const fermee = computed(
  () =>
    source.value !== null && droitSources(source.value.passage.collection_id, collections.value) === "ferme",
);
const position = computed(() => (etat.value === null ? {} : positionDansFenetre(etat.value.ancre)));
const ou = computed(() => {
  const s = source.value;
  if (s === null) return "";
  const lieu = emplacementPassage(s.passage);
  return `${lieu}${lieu === "" ? "" : " · "}${collectionAffichee(s.passage, collections.value)}`;
});

function ouvrir(): void {
  const voir = etat.value?.voir;
  rag?.sources.bulle.fermer();
  voir?.();
}

let arreter: (() => void) | null = null;
onMounted(() => {
  arreter = fermerQuandLaPageBouge(() => rag?.sources.bulle.pageBouge());
});
onBeforeUnmount(() => arreter?.());
</script>

<template>
  <Teleport to="body">
    <div
      v-if="rag && source"
      :id="ID_BULLE_SOURCE"
      class="rag-pop"
      role="dialog"
      :aria-label="`Source ${source.n}`"
      :style="position"
      data-rag-bulle
      @mouseenter="rag.sources.bulle.entrerBulle()"
      @mouseleave="rag.sources.bulle.quitterBulle()"
    >
      <div class="rag-pop__src">
        <span class="rag-cite is-on" aria-hidden="true">{{ source.n }}</span>
        <i class="ph" :class="iconeFichier(extensionDe(source.passage.document_name))" aria-hidden="true"></i>
        <b :title="source.passage.rel_path">{{ source.passage.document_name }}</b>
      </div>
      <div class="rag-pop__where">{{ ou }}</div>
      <p><TexteSurligne :texte="source.passage.text" :requete="source.query" /></p>
      <div class="rag-pop__foot">
        <span v-if="source.relevance !== null" class="rag-num">
          Pertinence {{ formaterScore(source.relevance) }}
        </span>
        <span v-else></span>
        <button type="button" class="rag-pop__voir" @click="ouvrir">
          {{ fermee ? "Voir le passage" : "Voir dans le document" }}
          <i class="ph ph-arrow-right" aria-hidden="true"></i>
        </button>
      </div>
    </div>
  </Teleport>
</template>
