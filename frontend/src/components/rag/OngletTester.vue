<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/rag/OngletTester.vue — onglet Tester : question, mode, nombre de passages, reclassement, carte « Où se trouvent les passages » (bande de passages) et passages que l'assistant recevrait. -->
<script setup lang="ts">
import { computed } from "vue";
import { MODES_RECHERCHE_RAG } from "@elpis/contracts";

import { extensionDe } from "../../features/rag/depot";
import { domaineRag } from "../../features/rag/domaine";
import {
  emplacementPassage,
  formaterJetons,
  formaterScore,
  iconeFichier,
  surlignerTexte,
} from "../../features/rag/format";
import { LIBELLES_MODE } from "../../features/rag/rag-tester";

const rg = domaineRag();
const t = computed(() => rg.tester);
const limiteMax = 20;
</script>

<template>
  <div class="rag-pane rag-pane--scroll">
    <form class="rag-ask" role="search" @submit.prevent="t.chercher()">
      <div class="rag-search">
        <i class="ph ph-magnifying-glass" aria-hidden="true"></i>
        <input
          v-model="t.requete"
          class="rag-input"
          type="search"
          placeholder="Posez une question à cette collection"
          aria-label="Question à poser à la collection"
          maxlength="2000"
        />
      </div>
      <button
        type="submit"
        class="rag-btn rag-btn--primary"
        :disabled="t.chargement || t.requete.trim() === '' || !rg.utilisable"
      >
        <i v-if="t.chargement" class="ph ph-circle-notch animate-spin" aria-hidden="true"></i>Chercher
      </button>
    </form>

    <div class="rag-opts">
      <span class="rag-opts__group">
        <span id="rag-mode-lib">Recherche</span>
        <span class="rag-seg" role="radiogroup" aria-labelledby="rag-mode-lib">
          <button
            v-for="m in MODES_RECHERCHE_RAG"
            :key="m"
            type="button"
            role="radio"
            :class="{ 'is-on': t.mode === m }"
            :aria-checked="t.mode === m ? 'true' : 'false'"
            @click="t.choisirMode(m)"
          >
            {{ LIBELLES_MODE[m] }}
          </button>
        </span>
      </span>
      <span class="rag-opts__group">
        <span id="rag-passages-lib">Passages</span>
        <span class="rag-step" role="group" aria-labelledby="rag-passages-lib">
          <button type="button" aria-label="Moins de passages" :disabled="t.limite <= 1" @click="t.pas(-1)">
            −
          </button>
          <span aria-live="polite">{{ t.limite }}</span>
          <button
            type="button"
            aria-label="Plus de passages"
            :disabled="t.limite >= limiteMax"
            @click="t.pas(1)"
          >
            +
          </button>
        </span>
      </span>
      <button
        type="button"
        role="switch"
        class="rag-switch"
        :class="{ 'is-off': !t.reclasser || !t.reclassementDispo }"
        :aria-checked="t.reclasser && t.reclassementDispo ? 'true' : 'false'"
        :disabled="!t.reclassementDispo"
        :title="
          t.reclassementDispo ? undefined : 'Aucun modèle de reclassement n’est configuré sur ce serveur'
        "
        @click="t.reclasser = !t.reclasser"
      >
        <s aria-hidden="true"></s>Reclasser
      </button>
    </div>

    <p v-if="t.erreur" class="rag-error" role="alert">
      <i class="ph ph-warning-circle" aria-hidden="true"></i><span>{{ t.erreur }}</span>
    </p>
    <p v-else-if="!t.resultat && !t.chargement" class="rag-note">
      <i class="ph ph-info" aria-hidden="true"></i>Posez une question comme dans une conversation : vous
      verrez où se trouvent les passages et ce que l’assistant recevrait.
    </p>

    <template v-if="t.resultat">
      <p v-for="(w, i) in t.resultat.warnings" :key="'w' + i" class="rag-warn">{{ w }}</p>
      <p v-for="(e, i) in t.resultat.errors" :key="'e' + i" class="rag-warn">{{ e.message }}</p>

      <div class="rag-sub">
        Où se trouvent les passages <span>{{ t.resume }}</span>
      </div>
      <div v-if="t.carte.length > 0" class="rag-map" data-rag-carte>
        <template v-for="l in t.carte" :key="l.documentId">
          <div class="rag-map__doc">
            <i class="ph" :class="iconeFichier(extensionDe(l.nom))" aria-hidden="true"></i
            ><span :title="l.nom">{{ l.nom }}</span>
          </div>
          <span
            class="rag-strip rag-strip--big"
            role="img"
            :aria-label="
              'Passages trouvés dans ' +
              l.nom +
              ', rangs ' +
              l.cellules
                .filter((c) => c.rang !== null)
                .map((c) => c.rang)
                .join(', ')
            "
          >
            <i
              v-for="(cell, n) in l.cellules"
              :key="n"
              :class="cell.rang === null ? '' : cell.retenu ? 'is-hit' : 'is-out'"
              :data-r="cell.etiquette ? cell.rang : undefined"
              :title="cell.rang === null ? undefined : 'Passage ' + cell.rang"
            ></i>
          </span>
          <span class="rag-map__n">{{ l.passages }} passage{{ l.passages > 1 ? "s" : "" }}</span>
        </template>
        <div v-if="t.autresDocuments > 0" class="rag-map__more">
          {{ t.autresDocuments }} autre{{ t.autresDocuments > 1 ? "s" : "" }} document{{
            t.autresDocuments > 1 ? "s" : ""
          }}
          sans passage retenu
        </div>
      </div>
      <p v-else class="rag-note">
        <i class="ph ph-info" aria-hidden="true"></i>Aucun passage trouvé pour cette question.
      </p>

      <div class="rag-sub">
        Ce que l’assistant recevra
        <span class="rag-budget"
          ><i class="ph ph-info" aria-hidden="true"></i
          >{{
            t.resultat.passages.length > 1
              ? "les " + t.resultat.passages.length + " meilleurs"
              : t.resultat.passages.length === 1
                ? "le meilleur passage"
                : "aucun passage"
          }}
          · {{ formaterJetons(t.resultat.tokens) }}</span
        >
      </div>
      <ol class="rag-hits">
        <li
          v-for="p in t.resultat.passages"
          :key="p.document_id + '-' + p.chunk_index"
          class="rag-hit"
          data-rag-passage
        >
          <span class="rag-hit__rank">{{ p.rank }}</span>
          <div>
            <div class="rag-hit__src">
              <i class="ph" :class="iconeFichier(extensionDe(p.document_name))" aria-hidden="true"></i>
              <b :title="p.rel_path">{{ p.document_name }}</b>
              <span>{{ emplacementPassage(p) }}</span>
              <span class="rag-score" :title="'Pertinence ' + formaterScore(p.relevance)"
                ><s aria-hidden="true"><i :style="{ width: p.relevance * 100 + '%' }"></i></s
                >{{ formaterScore(p.relevance) }}</span
              >
            </div>
            <p>
              <template v-for="(seg, i) in surlignerTexte(p.text, t.requeteAffichee)" :key="i">
                <mark v-if="seg.marque">{{ seg.texte }}</mark>
                <span v-else>{{ seg.texte }}</span>
              </template>
            </p>
          </div>
        </li>
      </ol>
    </template>
  </div>
</template>
