<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/admin/PiedListe.vue — pied d'une liste paginée côté serveur : « 1-50 sur 1 284 », pages précédente et suivante. -->
<script setup lang="ts">
import { computed } from "vue";

import { libelleFenetre, pagesDe, totalDepasseLimite } from "../../features/admin/pagination";

const props = defineProps<{
  page: number;
  parPage: number;
  total: number;
  nbLignes: number;
  unite: string;
  chargement?: boolean;
}>();
const emit = defineEmits<{ page: [numero: number] }>();

const pages = computed(() => pagesDe(props.total, props.parPage));
</script>

<template>
  <div class="sup-pied">
    <span>
      <b>{{ libelleFenetre(page, parPage, total, nbLignes) }}</b> {{ unite }}
      <span v-if="totalDepasseLimite(total, parPage)" class="adm-muted">
        · les pages au-delà de {{ (pages * parPage).toLocaleString("fr-FR") }} ne sont pas atteignables :
        affiner la recherche
      </span>
    </span>
    <div class="sup-pied__fin">
      <button
        type="button"
        class="adm-btn adm-btn--quiet adm-btn--sm"
        :disabled="page <= 1 || chargement"
        @click="emit('page', page - 1)"
      >
        <i class="ph ph-caret-left" aria-hidden="true"></i> Précédent
      </button>
      <span class="tabular-nums">Page {{ page }} sur {{ pages }}</span>
      <button
        type="button"
        class="adm-btn adm-btn--quiet adm-btn--sm"
        :disabled="page >= pages || chargement"
        @click="emit('page', page + 1)"
      >
        Suivant <i class="ph ph-caret-right" aria-hidden="true"></i>
      </button>
    </div>
  </div>
</template>
