<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/rag/NoticeRecherche.vue — notice du fil de `/rag search` : les passages trouvés dans les collections actives, sans tour de l'assistant ; chaque passage s'ouvre dans la visionneuse. -->
<script setup lang="ts">
import { computed } from "vue";
import type { SourceCiteeRag } from "@elpis/contracts";

import type { EntreeMessage } from "../../features/chat/message/types";
import { domaineRagOptionnel } from "../../features/rag/domaine";
import {
  accorder,
  emplacementPassage,
  formaterDuree,
  formaterScore,
  iconeFichier,
} from "../../features/rag/format";
import { lireNotice, sourcesDeNotice } from "../../features/rag/notice-recherche";
import { extensionDe } from "../../features/rag/sources-affichage";
import PastilleSource from "./PastilleSource.vue";
import TexteSurligne from "./TexteSurligne.vue";

const props = defineProps<{ entry: EntreeMessage }>();
const rag = domaineRagOptionnel();

const notice = computed(() => lireNotice(props.entry.msg.summary));
const sources = computed(() => (notice.value ? sourcesDeNotice(notice.value) : []));
const collections = computed(() => notice.value?.collections.map((c) => c.name).join(", ") ?? "");
const actif = (n: number): boolean =>
  rag !== null && (rag.sources.visionneuse.numero === n || rag.sources.bulle.etat?.source.n === n);

function voir(s: SourceCiteeRag): void {
  void rag?.sources.voirEnsemble(s, sources.value);
}
</script>

<template>
  <section class="rag-fil-notice" aria-label="Résultat de la recherche dans les collections" data-rag-notice>
    <template v-if="notice">
      <div class="rag-fil-notice__head">
        <i class="ph ph-magnifying-glass" aria-hidden="true"></i>
        <span class="rag-fil-notice__titre">Recherche : « {{ notice.requete }} »</span>
        <span class="rag-fil-notice__meta rag-num">{{
          ` ${accorder(notice.passages.length, "passage")} · ${formaterDuree(notice.duree_ms)}`
        }}</span>
      </div>
      <div class="rag-fil-notice__sub">Dans {{ collections }} · aucune réponse de l’assistant</div>
      <ul v-if="notice.passages.length > 0" class="rag-fil-notice__liste">
        <li v-for="s in sources" :key="s.n" class="rag-fil-notice__hit" data-rag-hit>
          <PastilleSource :source="s" :actif="actif(s.n)" :voir="voir" />
          <div class="rag-fil-notice__corps">
            <div class="rag-lu__src">
              <i
                class="ph"
                :class="iconeFichier(extensionDe(s.passage.document_name))"
                aria-hidden="true"
              ></i>
              <b :title="s.passage.rel_path">{{ s.passage.document_name }}</b>
              <span v-if="emplacementPassage(s.passage)">{{ emplacementPassage(s.passage) }}</span>
              <span class="rag-num">Pertinence {{ formaterScore(s.relevance ?? 0) }}</span>
            </div>
            <p class="rag-lu__texte"><TexteSurligne :texte="s.passage.text" :requete="notice.requete" /></p>
            <button type="button" class="rag-pop__voir" @click="voir(s)">
              Voir dans le document <i class="ph ph-arrow-right" aria-hidden="true"></i>
            </button>
          </div>
        </li>
      </ul>
      <p v-else class="rag-fil-notice__vide">Aucun passage trouvé pour cette question.</p>
      <p v-for="e in notice.erreurs" :key="e" class="rag-warn">{{ e }}</p>
    </template>
    <p v-else class="rag-fil-notice__vide">Résultat de recherche illisible.</p>
  </section>
</template>
