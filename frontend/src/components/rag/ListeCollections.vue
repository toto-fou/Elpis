<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/rag/ListeCollections.vue — colonne de gauche de la page RAG : mes collections, partagées avec moi (pastille de l'auteur), masquées, progression d'indexation, quota de stockage. -->
<script setup lang="ts">
import { computed } from "vue";

import { domaineRag } from "../../features/rag/domaine";
import {
  accorder,
  formaterQuotaMo,
  formaterTaille,
  iconeVisibilite,
  initiales,
  libelleVisibilite,
  nomAuteur,
} from "../../features/rag/format";

const rg = domaineRag();

const usage = computed(() => rg.etat?.usage.storage_bytes ?? 0);
const quotaMo = computed(() => rg.etat?.quotas.storage_mb ?? 0);
/** Une ligne de « Mes collections » : la collection, sa part d'indexation et sa ligne de chiffres. */
const mesVues = computed(() =>
  rg.mesFiltrees.map((c) => ({
    c,
    pct: rg.documents.progression(c.id),
    resume:
      accorder(c.doc_count, "document") +
      (c.chunk_count > 0 ? " · " + accorder(c.chunk_count, "passage") : ""),
  })),
);
const pourcentQuota = computed(() =>
  quotaMo.value > 0 ? Math.min(100, (usage.value / (quotaMo.value * 1024 * 1024)) * 100) : 0,
);
</script>

<template>
  <aside class="rag-list" aria-label="Collections">
    <div class="rag-search">
      <i class="ph ph-magnifying-glass" aria-hidden="true"></i>
      <input
        v-model="rg.filtre"
        class="rag-input"
        type="search"
        placeholder="Filtrer les collections"
        aria-label="Filtrer les collections"
      />
    </div>
    <div class="rag-list__scroll">
      <p v-if="rg.erreurListe" class="rag-error" role="alert">
        <span
          >{{ rg.erreurListe }}
          <button type="button" class="rag-link" @click="rg.charger()">Réessayer</button></span
        >
      </p>

      <h3 class="rag-group">
        Mes collections <span>{{ rg.mes.length }}</span>
      </h3>
      <div v-if="rg.mes.length === 0" class="rag-list__none">Aucune collection pour l’instant</div>
      <button
        v-for="v in mesVues"
        :key="v.c.id"
        type="button"
        class="rag-coll"
        :class="{ 'is-on': v.c.id === rg.selection }"
        :aria-current="v.c.id === rg.selection ? 'true' : undefined"
        @click="rg.selectionner(v.c.id)"
      >
        <div class="rag-coll__name">
          <span>{{ v.c.name }}</span>
          <i
            v-if="v.c.visibility !== 'private'"
            class="ph"
            :class="iconeVisibilite(v.c.visibility)"
            :title="'Publiée : ' + libelleVisibilite(v.c)"
            role="img"
            aria-label="Publiée"
          ></i>
        </div>
        <div class="rag-coll__meta">
          <b v-if="v.pct !== null">Indexation {{ v.pct }} %</b>
          <span v-else-if="v.c.status === 'error'" class="is-err">Erreur d’indexation</span>
          <template v-if="v.pct !== null || v.c.status === 'error'"> · </template>
          {{ v.resume }}
        </div>
        <div
          v-if="v.pct !== null"
          class="rag-prog"
          role="progressbar"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-valuenow="v.pct"
          :aria-label="'Indexation de ' + v.c.name"
        >
          <i :style="{ width: v.pct + '%' }"></i>
        </div>
      </button>
      <div v-if="rg.mes.length > 0 && rg.mesFiltrees.length === 0" class="rag-list__none">
        Aucune collection ne correspond
      </div>

      <template v-if="rg.partagees.length > 0 || rg.masquees.length > 0">
        <h3 class="rag-group">
          Partagées avec moi <span>{{ rg.partagees.length }}</span>
        </h3>
        <button
          v-for="c in rg.partageesFiltrees"
          :key="c.id"
          type="button"
          class="rag-coll"
          :class="{ 'is-on': c.id === rg.selection }"
          :aria-current="c.id === rg.selection ? 'true' : undefined"
          @click="rg.selectionner(c.id)"
        >
          <div class="rag-coll__name">
            <span>{{ c.name }}</span>
            <span
              class="rag-owner"
              :title="'Partagée par ' + nomAuteur(c)"
              role="img"
              :aria-label="'Partagée par ' + nomAuteur(c)"
              >{{ initiales(nomAuteur(c)) }}</span
            >
          </div>
          <div class="rag-coll__meta">{{ nomAuteur(c) }} · {{ accorder(c.doc_count, "document") }}</div>
        </button>
        <div v-if="rg.partagees.length > 0 && rg.partageesFiltrees.length === 0" class="rag-list__none">
          Aucune collection ne correspond
        </div>
        <template v-if="rg.masquees.length > 0">
          <button
            type="button"
            class="rag-group rag-group--btn"
            :aria-expanded="rg.masqueesVisibles ? 'true' : 'false'"
            @click="rg.masqueesVisibles = !rg.masqueesVisibles"
          >
            {{ rg.masqueesVisibles ? "Masquées" : "Afficher les masquées" }}
            <span>{{ rg.masquees.length }}</span>
          </button>
          <template v-if="rg.masqueesVisibles">
            <div v-for="c in rg.masqueesFiltrees" :key="c.id" class="rag-coll is-off">
              <div class="rag-coll__name">
                <span>{{ c.name }}</span>
                <button
                  type="button"
                  class="rag-unhide"
                  :aria-label="'Afficher ' + c.name + ' dans ma liste'"
                  @click="rg.masquer(c, false)"
                >
                  Afficher
                </button>
              </div>
              <div class="rag-coll__meta">{{ nomAuteur(c) }}</div>
            </div>
          </template>
        </template>
      </template>
    </div>
    <div v-if="rg.etat" class="rag-list__foot rag-num">
      {{ formaterTaille(usage) }}<template v-if="quotaMo > 0"> sur {{ formaterQuotaMo(quotaMo) }}</template>
      <div v-if="quotaMo > 0" class="rag-quota" aria-hidden="true">
        <i :style="{ width: pourcentQuota + '%' }"></i>
      </div>
    </div>
  </aside>
</template>
