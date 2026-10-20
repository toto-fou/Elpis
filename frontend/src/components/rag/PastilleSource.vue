<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/rag/PastilleSource.vue — pastille numérotée d'une source (pied de sources, notice, navigation de la visionneuse) : ouvre la visionneuse, montre la bulle au survol et au focus. -->
<script setup lang="ts">
import { computed } from "vue";
import type { SourceCiteeRag } from "@elpis/contracts";

import { domaineRagOptionnel } from "../../features/rag/domaine";
import { libelleAccessibleSource } from "../../features/rag/sources-affichage";

const props = defineProps<{
  source: SourceCiteeRag;
  /** Source ouverte dans la visionneuse ou dont la bulle est ouverte. */
  actif?: boolean;
  /** Ouvre la visionneuse (clic, ou bouton de la bulle) : l'appelant sait quelles sources elle parcourt. */
  voir: (source: SourceCiteeRag) => void;
  courante?: boolean;
  sansBulle?: boolean;
}>();
const rag = domaineRagOptionnel();
const libelle = computed(() => libelleAccessibleSource(props.source));

function survol(e: Event): void {
  if (!props.sansBulle && rag)
    rag.sources.bulle.survol(props.source, e.currentTarget as HTMLElement, () => props.voir(props.source));
}
function sortie(): void {
  if (!props.sansBulle && rag) rag.sources.bulle.sortie();
}
</script>

<template>
  <button
    type="button"
    class="rag-cite"
    :class="{ 'is-on': props.actif }"
    :aria-label="libelle"
    :aria-current="props.courante ? 'true' : undefined"
    aria-haspopup="dialog"
    data-rag-pastille
    @click="props.voir(props.source)"
    @mouseenter="survol"
    @mouseleave="sortie"
    @focus="survol"
    @blur="sortie"
  >
    {{ props.source.n }}
  </button>
</template>
