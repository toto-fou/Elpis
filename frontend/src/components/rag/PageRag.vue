<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/rag/PageRag.vue — page RAG : en-tête (retour, nouvelle collection), colonne des collections, détail ou première visite, boîtes (publier, nouvelle, import, découpage) ; reçoit les fichiers glissés sur la page. -->
<script setup lang="ts">
import { computed } from "vue";

import { glissePorteDesFichiers, lireEntreesGlissees } from "../../features/rag/depot";
import { domaineRag } from "../../features/rag/domaine";
import BoiteDecoupage from "./BoiteDecoupage.vue";
import BoiteImportBac from "./BoiteImportBac.vue";
import BoiteNouvelle from "./BoiteNouvelle.vue";
import BoitePublier from "./BoitePublier.vue";
import DetailCollection from "./DetailCollection.vue";
import EtatVideRag from "./EtatVideRag.vue";
import ListeCollections from "./ListeCollections.vue";

const rg = domaineRag();
let compteur = 0;

const peutDeposer = computed(
  () => rg.utilisable && (rg.premiereVisite || (rg.estProprietaire && rg.onglet === "documents")),
);

function motifRefusDepot(): string {
  if (!rg.utilisable) return rg.etat?.reason?.message ?? "Le RAG est indisponible.";
  if (!rg.estProprietaire)
    return "Cette collection est en lecture seule : aucun document ne peut y être ajouté.";
  return "Déposez les fichiers dans l’onglet Documents.";
}

function entre(e: DragEvent): void {
  if (!glissePorteDesFichiers(e.dataTransfer)) return;
  e.preventDefault();
  compteur++;
  rg.documents.depot.survol = peutDeposer.value;
}

function survole(e: DragEvent): void {
  if (!glissePorteDesFichiers(e.dataTransfer)) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = peutDeposer.value ? "copy" : "none";
}

function quitte(): void {
  compteur = Math.max(0, compteur - 1);
  if (compteur === 0) rg.documents.depot.survol = false;
}

async function depose(e: DragEvent): Promise<void> {
  if (!glissePorteDesFichiers(e.dataTransfer) || !e.dataTransfer) return;
  e.preventDefault();
  compteur = 0;
  rg.documents.depot.survol = false;
  if (!peutDeposer.value) {
    rg.informer(motifRefusDepot());
    return;
  }
  const entrees = await lireEntreesGlissees(e.dataTransfer);
  if (entrees.length === 0) return;
  if (rg.premiereVisite) rg.ouvrirNouvelle(entrees);
  else await rg.documents.deposer(entrees);
}
</script>

<template>
  <div
    v-if="rg.ouverte"
    role="region"
    aria-label="RAG"
    class="elpis-rag-page"
    @dragenter="entre"
    @dragover="survole"
    @dragleave="quitte"
    @drop="depose"
  >
    <header
      class="h-16 shrink-0 flex items-center justify-between gap-3 px-4 bg-white border-b border-slate-200"
    >
      <div class="flex items-center gap-3 min-w-0 shrink-0">
        <button
          title="Retour au chat"
          aria-label="Retour au chat"
          class="w-9 h-9 rounded-lg text-slate-500 hover:bg-slate-50 hover:text-slate-700 flex items-center justify-center transition-colors shrink-0"
          @click="rg.fermer()"
        >
          <i class="ph ph-arrow-left text-lg" aria-hidden="true"></i>
        </button>
        <i class="ph ph-books text-blue-500 text-2xl shrink-0" aria-hidden="true"></i>
        <div class="min-w-0">
          <h2 class="font-bold text-base text-slate-900 tracking-tight leading-tight">RAG</h2>
          <p class="text-xs text-slate-500 truncate">Les documents que l’assistant peut citer</p>
        </div>
      </div>
      <div class="flex items-center gap-1.5 shrink-0">
        <button
          v-if="!rg.premiereVisite"
          type="button"
          class="rag-btn"
          :disabled="!rg.utilisable"
          :title="rg.utilisable ? undefined : (rg.etat?.reason?.message ?? 'Le RAG est indisponible')"
          @click="rg.ouvrirNouvelle()"
        >
          <i class="ph ph-plus" aria-hidden="true"></i>Nouvelle collection
        </button>
      </div>
    </header>

    <div v-if="rg.etat && !rg.utilisable" class="rag-notice" role="status" data-rag-avis>
      <i class="ph ph-warning-circle" aria-hidden="true"></i>
      <span
        >{{ rg.etat.reason?.message ?? "Le RAG est indisponible pour le moment." }} Les collections restent
        consultables ; l’ajout de documents et la création sont suspendus.</span
      >
    </div>

    <div class="rag-body">
      <ListeCollections />
      <section class="rag-detail" aria-label="Collection sélectionnée">
        <DetailCollection v-if="rg.courante" />
        <EtatVideRag v-else-if="rg.premiereVisite" />
        <p v-else class="rag-empty-docs" role="status">
          {{ rg.erreurListe ? "" : "Chargement des collections…" }}
        </p>
      </section>
    </div>

    <BoitePublier />
    <BoiteNouvelle />
    <BoiteImportBac />
    <BoiteDecoupage />
  </div>
</template>
