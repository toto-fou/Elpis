<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/rag/PiedSources.vue — pied de sources sous une réponse : documents cités avec leurs renvois, et le lien « N passages lus, non cités » qui montre ce que l'assistant a écarté. -->
<script setup lang="ts">
import { computed, ref } from "vue";
import type { SourceCiteeRag } from "@elpis/contracts";

import type { EntreeMessage } from "../../features/chat/message/types";
import { domaineRagOptionnel } from "../../features/rag/domaine";
import { accorder, emplacementPassage, formaterScore, iconeFichier } from "../../features/rag/format";
import {
  collectionsDesSources,
  documentsCites,
  extensionDe,
  passagesNonCites,
} from "../../features/rag/sources-affichage";
import PastilleSource from "./PastilleSource.vue";
import TexteSurligne from "./TexteSurligne.vue";

const props = defineProps<{ entry: EntreeMessage }>();
const rag = domaineRagOptionnel();
const ecartes = ref(false);

const sources = computed<readonly SourceCiteeRag[]>(() => props.entry.msg.rag_sources ?? []);
const enFlux = computed(() => !!props.entry.msg.isStreaming);
const documents = computed(() => documentsCites(sources.value));
const nonCites = computed(() => passagesNonCites(sources.value));
const nbCitees = computed(() => sources.value.length - nonCites.value.length);
const titre = computed(() => {
  if (enFlux.value) return accorder(sources.value.length, "passage") + " lus";
  return nbCitees.value === 0 ? "Aucune source citée" : accorder(nbCitees.value, "source");
});
const lienEcartes = computed(
  () =>
    `${accorder(nonCites.value.length, "passage")} lu${nonCites.value.length > 1 ? "s" : ""}, non cité${nonCites.value.length > 1 ? "s" : ""}`,
);
const idListe = computed(() => `rag-ecartes-${props.entry.idx}`);
const actif = (n: number): boolean =>
  rag !== null && (rag.sources.visionneuse.numero === n || rag.sources.bulle.etat?.source.n === n);

function ouvrir(s: SourceCiteeRag): void {
  if (rag) void rag.sources.voir(s, props.entry.idx);
}
</script>

<template>
  <div
    v-if="sources.length > 0"
    class="rag-sources"
    role="group"
    aria-label="Sources de la réponse"
    data-rag-sources
  >
    <div class="rag-sources__head">
      <i class="ph ph-books" aria-hidden="true"></i>
      <b>{{ titre }}</b>
      <span v-if="collectionsDesSources(sources)">{{ ` · ${collectionsDesSources(sources)}` }}</span>
      <button
        v-if="!enFlux && nonCites.length > 0"
        type="button"
        class="rag-sources__more"
        :aria-expanded="ecartes"
        :aria-controls="idListe"
        data-rag-ecartes
        @click="ecartes = !ecartes"
      >
        {{ ` ${lienEcartes}` }}
      </button>
    </div>

    <template v-if="!enFlux">
      <div v-for="d in documents" :key="d.cle" class="rag-src" data-rag-source-doc>
        <div class="rag-src__doc">
          <i class="ph" :class="iconeFichier(extensionDe(d.nom))" aria-hidden="true"></i>
          <span :title="d.chemin">{{ d.nom }}</span>
          <small v-if="d.detail">{{ d.detail }}</small>
        </div>
        <span class="rag-mini">
          <PastilleSource v-for="s in d.sources" :key="s.n" :source="s" :actif="actif(s.n)" :voir="ouvrir" />
        </span>
      </div>

      <ul v-if="ecartes && nonCites.length > 0" :id="idListe" class="rag-lus" data-rag-lus>
        <li v-for="s in nonCites" :key="s.n" class="rag-lu">
          <PastilleSource :source="s" :actif="actif(s.n)" :voir="ouvrir" />
          <div class="rag-lu__corps">
            <div class="rag-lu__src">
              <b :title="s.passage.rel_path">{{ s.passage.document_name }}</b>
              <span v-if="emplacementPassage(s.passage)">{{ emplacementPassage(s.passage) }}</span>
              <span v-if="s.relevance !== null" class="rag-num"
                >Pertinence {{ formaterScore(s.relevance) }}</span
              >
            </div>
            <p class="rag-lu__texte"><TexteSurligne :texte="s.passage.text" :requete="s.query" /></p>
          </div>
        </li>
      </ul>
    </template>
  </div>
</template>
