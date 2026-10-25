<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/rag/DetailCollection.vue — détail d'une collection : titre, actions (propriétaire ou lecteur), pastilles, chiffres, onglets Documents, Tester, Réglages. -->
<script setup lang="ts">
import { computed } from "vue";

import type { ItemMenuRag, OngletRag } from "../../features/rag/base";
import { choisirFichiers } from "../../features/rag/depot";
import { focaliserId } from "../../features/rag/dom";
import { domaineRag } from "../../features/rag/domaine";
import {
  formaterModification,
  formaterNombre,
  formaterTaille,
  iconeVisibilite,
  initiales,
  libelleVisibilite,
  nomAuteur,
} from "../../features/rag/format";
import MenuRag from "./MenuRag.vue";
import OngletDocuments from "./OngletDocuments.vue";
import OngletReglages from "./OngletReglages.vue";
import OngletTester from "./OngletTester.vue";

const rg = domaineRag();
// `courante` n'est jamais nulle ici : la page ne monte ce composant qu'avec une collection.
const c = computed(() => rg.courante);

const onglets = computed<{ id: OngletRag; libelle: string }[]>(() => [
  { id: "documents", libelle: "Documents" },
  { id: "tester", libelle: "Tester" },
  ...(rg.estProprietaire ? [{ id: "reglages" as const, libelle: "Réglages" }] : []),
]);

const itemsMenu = computed<ItemMenuRag[]>(() => [
  {
    id: "importer",
    libelle: "Importer depuis la sandbox",
    icone: "ph-folder-open",
    desactive: !rg.utilisable,
  },
  {
    id: "dossier",
    libelle: "Ajouter un dossier…",
    icone: "ph-folder-simple-plus",
    desactive: !rg.utilisable,
  },
  {
    id: "reindexer",
    libelle: "Réindexer tous les documents",
    icone: "ph-arrow-clockwise",
    desactive: !rg.utilisable,
  },
  { id: "reglages", libelle: "Réglages", icone: "ph-sliders-horizontal", separateurAvant: true },
  { id: "supprimer", libelle: "Supprimer la collection…", icone: "ph-trash", danger: true },
]);

async function ajouter(dossier = false): Promise<void> {
  const fichiers = await choisirFichiers(dossier);
  if (fichiers.length > 0) await rg.documents.deposer(fichiers);
}

function surMenu(id: string): void {
  if (id === "importer") void rg.bac.ouvrir();
  else if (id === "dossier") void ajouter(true);
  else if (id === "reindexer") void rg.documents.reindexerTout();
  else if (id === "reglages") rg.choisirOnglet("reglages");
  else if (id === "supprimer") void rg.reglages.supprimer();
}

function surClavierOnglets(e: KeyboardEvent): void {
  const ids = onglets.value.map((o) => o.id);
  const i = ids.indexOf(rg.onglet);
  const cible =
    e.key === "ArrowRight"
      ? i + 1
      : e.key === "ArrowLeft"
        ? i - 1
        : e.key === "Home"
          ? 0
          : e.key === "End"
            ? ids.length - 1
            : null;
  if (cible === null) return;
  e.preventDefault();
  const id = ids[(cible + ids.length) % ids.length];
  if (id === undefined) return;
  rg.choisirOnglet(id);
  focaliserId(`rag-tab-${id}`);
}
</script>

<template>
  <template v-if="c">
    <div class="rag-head">
      <div class="rag-head__row">
        <div>
          <h3 class="rag-title">{{ c.name }}</h3>
          <div v-if="c.description" class="rag-desc">{{ c.description }}</div>
          <button
            v-else-if="rg.estProprietaire"
            type="button"
            class="rag-link rag-desc"
            title="L’assistant lit la description pour savoir quand chercher dans cette collection"
            @click="rg.choisirOnglet('reglages')"
          >
            Ajouter une description
          </button>
        </div>
        <div v-if="rg.estProprietaire" class="rag-actions">
          <button type="button" class="rag-btn" @click="rg.discuter()">
            <i class="ph ph-chat-circle-text" aria-hidden="true"></i>Discuter avec
          </button>
          <button type="button" class="rag-btn" @click="rg.publier.ouvrir()">
            <i class="ph ph-share-network" aria-hidden="true"></i>Publier…
          </button>
          <button
            type="button"
            class="rag-btn"
            :class="{ 'rag-btn--primary': rg.onglet === 'documents' }"
            :disabled="!rg.utilisable"
            :title="rg.utilisable ? undefined : (rg.etat?.reason?.message ?? 'Le RAG est indisponible')"
            @click="ajouter(false)"
          >
            <i class="ph ph-plus" aria-hidden="true"></i>Ajouter des documents
          </button>
          <MenuRag
            id="actions"
            libelle="Plus d’actions"
            icone="ph-dots-three"
            :items="itemsMenu"
            @choisir="surMenu"
          />
        </div>
        <div v-else class="rag-actions">
          <button type="button" class="rag-btn" @click="rg.masquer(c, true)">
            <i class="ph ph-eye-slash" aria-hidden="true"></i>Masquer de ma liste
          </button>
          <button type="button" class="rag-btn rag-btn--primary" @click="rg.discuter()">
            <i class="ph ph-chat-circle-text" aria-hidden="true"></i>Discuter avec
          </button>
        </div>
      </div>
      <div class="rag-meta">
        <template v-if="rg.estProprietaire">
          <span class="rag-pill"
            ><i class="ph" :class="iconeVisibilite(c.visibility)" aria-hidden="true"></i
            >{{ libelleVisibilite(c) }}</span
          >
        </template>
        <template v-else>
          <span class="rag-pill rag-pill--shared"
            ><span class="rag-owner" aria-hidden="true">{{ initiales(nomAuteur(c)) }}</span
            >Partagée par {{ nomAuteur(c) }}</span
          >
          <span class="rag-pill"><i class="ph ph-eye" aria-hidden="true"></i>Lecture seule</span>
        </template>
        <span
          ><b>{{ formaterNombre(c.doc_count) }}</b> {{ c.doc_count > 1 ? "documents" : "document" }}</span
        >
        <span
          ><b>{{ formaterNombre(c.chunk_count) }}</b> {{ c.chunk_count > 1 ? "passages" : "passage" }}</span
        >
        <span v-if="rg.estProprietaire">{{ formaterTaille(c.bytes) }}</span>
        <span>{{ formaterModification(c.updated_at, new Date(), !rg.estProprietaire) }}</span>
      </div>
      <div
        class="rag-tabs"
        role="tablist"
        aria-label="Sections de la collection"
        @keydown="surClavierOnglets"
      >
        <button
          v-for="o in onglets"
          :id="'rag-tab-' + o.id"
          :key="o.id"
          type="button"
          role="tab"
          class="rag-tab"
          :class="{ 'is-on': rg.onglet === o.id }"
          :aria-selected="rg.onglet === o.id ? 'true' : 'false'"
          :aria-controls="'rag-panel-' + o.id"
          :tabindex="rg.onglet === o.id ? 0 : -1"
          @click="rg.choisirOnglet(o.id)"
        >
          {{ o.libelle }}
          <span v-if="o.id === 'documents'">{{ formaterNombre(c.doc_count) }}</span>
        </button>
      </div>
    </div>
    <OngletDocuments
      v-if="rg.onglet === 'documents'"
      id="rag-panel-documents"
      role="tabpanel"
      aria-labelledby="rag-tab-documents"
    />
    <OngletTester
      v-else-if="rg.onglet === 'tester'"
      id="rag-panel-tester"
      role="tabpanel"
      aria-labelledby="rag-tab-tester"
    />
    <OngletReglages
      v-else-if="rg.onglet === 'reglages' && rg.estProprietaire"
      id="rag-panel-reglages"
      role="tabpanel"
      aria-labelledby="rag-tab-reglages"
    />
  </template>
</template>
