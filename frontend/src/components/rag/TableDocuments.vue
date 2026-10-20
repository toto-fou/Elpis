<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/rag/TableDocuments.vue — tableau des documents d'une collection : bande de passages, état, actions par ligne ; virtualisé au-delà de 500 lignes. -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from "vue";
import type { DocumentRag } from "@elpis/contracts";

import { domaineRag } from "../../features/rag/domaine";
import { HAUTEUR_LIGNE, fenetreVirtuelle } from "../../features/rag/filtres";
import type { CleTri } from "../../features/rag/filtres";
import {
  dossierDe,
  etatDocument,
  formaterDateCourte,
  formaterNombre,
  formaterTaille,
  iconeFichier,
} from "../../features/rag/format";
import BandePassages from "./BandePassages.vue";

const rg = domaineRag();
const d = computed(() => rg.documents);
const zone = useTemplateRef<HTMLElement>("zone");
const defilement = ref(0);
const hauteur = ref(600);
let observateur: ResizeObserver | null = null;

const fenetre = computed(() => fenetreVirtuelle(d.value.lignes.length, defilement.value, hauteur.value));
const affichees = computed(() =>
  d.value.virtualise ? d.value.lignes.slice(fenetre.value.debut, fenetre.value.fin) : d.value.lignes,
);
const decalage = computed(() => (d.value.virtualise ? fenetre.value.debut : 0));
const ouvrable = computed(() => rg.estProprietaire || rg.courante?.allow_source_open === true);

/** Le propriétaire règle le découpage ; un lecteur ne voit que les passages, si les sources sont ouvertes. */
function ouvrirDecoupage(doc: DocumentRag): void {
  if (ouvrable.value) void rg.decoupage.ouvrir(doc, !rg.estProprietaire);
}

function mesurer(): void {
  if (zone.value) {
    hauteur.value = zone.value.clientHeight || hauteur.value;
    defilement.value = zone.value.scrollTop;
  }
}

onMounted(() => {
  mesurer();
  if (zone.value && typeof ResizeObserver !== "undefined") {
    observateur = new ResizeObserver(mesurer);
    observateur.observe(zone.value);
  }
});
onBeforeUnmount(() => observateur?.disconnect());
// Un autre filtre ou une autre collection repart du haut de la liste.
watch(
  () => [rg.selection, d.value.filtreTexte, d.value.filtreEtat, d.value.tri],
  async () => {
    await nextTick();
    if (zone.value) zone.value.scrollTop = 0;
    mesurer();
  },
);

function trier(cle: CleTri): void {
  d.value.tri = cle;
}
const ariaTri = (cle: CleTri): "ascending" | "descending" | undefined =>
  d.value.tri !== cle ? undefined : cle === "chemin" ? "ascending" : "descending";

function mode(doc: { status: string }): "prete" | "attente" | "occupe" {
  return doc.status === "ready" ? "prete" : doc.status === "pending" ? "attente" : "occupe";
}
</script>

<template>
  <div ref="zone" class="rag-scroll" @scroll.passive="mesurer">
    <table class="rag-table" :aria-rowcount="d.lignes.length + 1" aria-label="Documents de la collection">
      <colgroup>
        <col />
        <col />
        <col />
        <col />
        <col />
      </colgroup>
      <thead>
        <tr>
          <th scope="col" :aria-sort="ariaTri('chemin')">
            <button type="button" @click="trier('chemin')">Nom</button>
          </th>
          <th scope="col">Passages</th>
          <th scope="col" :aria-sort="ariaTri('taille')">
            <button type="button" @click="trier('taille')">Taille</button>
          </th>
          <th scope="col" :aria-sort="ariaTri('recent')">
            <button type="button" @click="trier('recent')">Ajouté</button>
          </th>
          <th scope="col">État</th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="d.virtualise && fenetre.haut > 0" class="rag-spacer" aria-hidden="true">
          <td colspan="5" :style="{ height: fenetre.haut + 'px' }"></td>
        </tr>
        <tr
          v-for="(doc, i) in affichees"
          :key="doc.id"
          :aria-rowindex="decalage + i + 2"
          :style="d.virtualise ? { height: HAUTEUR_LIGNE + 'px' } : undefined"
          data-rag-doc
        >
          <td>
            <div class="rag-doc">
              <i class="ph" :class="iconeFichier(doc.ext)" aria-hidden="true"></i>
              <span class="rag-doc__name" :title="doc.rel_path">
                <button
                  v-if="ouvrable"
                  type="button"
                  class="rag-doc__open"
                  :aria-label="(rg.estProprietaire ? 'Découpage de ' : 'Passages de ') + doc.name"
                  @click="ouvrirDecoupage(doc)"
                >
                  {{ doc.name }}</button
                ><template v-else>{{ doc.name }}</template
                >{{ " " }}<span class="rag-doc__dir">{{ dossierDe(doc.rel_path) }}</span>
              </span>
            </div>
          </td>
          <td>
            <span v-if="doc.status === 'error'" class="rag-state">—</span>
            <template v-else>
              <BandePassages :passages="doc.chunk_count" :mode="mode(doc)" />
              <span v-if="doc.status === 'ready'" class="rag-num">{{ formaterNombre(doc.chunk_count) }}</span>
            </template>
          </td>
          <td>{{ formaterTaille(doc.bytes) }}</td>
          <td>{{ formaterDateCourte(doc.created_at) }}</td>
          <td>
            <div class="rag-cell-etat">
              <span
                class="rag-state"
                :class="{
                  'rag-state--run':
                    etatDocument(doc).cle === 'extraction' || etatDocument(doc).cle === 'indexation',
                  'rag-state--err': etatDocument(doc).cle === 'erreur',
                  'rag-state--warn': etatDocument(doc).cle === 'service',
                }"
                :title="etatDocument(doc).detail || undefined"
              >
                <i
                  v-if="etatDocument(doc).cle === 'erreur' || etatDocument(doc).cle === 'service'"
                  class="ph ph-warning-circle"
                  aria-hidden="true"
                ></i
                >{{ etatDocument(doc).libelle }}
              </span>
              <span v-if="rg.estProprietaire || ouvrable" class="rag-rowact">
                <button
                  v-if="ouvrable"
                  type="button"
                  data-rag-decoupage
                  :title="(rg.estProprietaire ? 'Découpage de ' : 'Passages de ') + doc.name"
                  :aria-label="(rg.estProprietaire ? 'Découpage de ' : 'Passages de ') + doc.name"
                  @click="ouvrirDecoupage(doc)"
                >
                  <i
                    class="ph"
                    :class="rg.estProprietaire ? 'ph-scissors' : 'ph-rows'"
                    aria-hidden="true"
                  ></i>
                </button>
                <button
                  v-if="rg.estProprietaire"
                  type="button"
                  :title="'Réindexer ' + doc.name"
                  :aria-label="'Réindexer ' + doc.name"
                  :disabled="!rg.utilisable"
                  @click="d.reindexerDocument(doc)"
                >
                  <i class="ph ph-arrow-clockwise" aria-hidden="true"></i>
                </button>
                <a
                  v-if="ouvrable"
                  :href="d.urlOriginal(doc)"
                  :download="doc.name"
                  :title="'Ouvrir l’original de ' + doc.name"
                  :aria-label="'Ouvrir l’original de ' + doc.name"
                >
                  <i class="ph ph-arrow-square-out" aria-hidden="true"></i>
                </a>
                <button
                  v-if="rg.estProprietaire"
                  type="button"
                  :title="'Retirer ' + doc.name"
                  :aria-label="'Retirer ' + doc.name"
                  @click="d.retirerDocument(doc)"
                >
                  <i class="ph ph-trash" aria-hidden="true"></i>
                </button>
              </span>
            </div>
          </td>
        </tr>
        <tr v-if="d.virtualise && fenetre.bas > 0" class="rag-spacer" aria-hidden="true">
          <td colspan="5" :style="{ height: fenetre.bas + 'px' }"></td>
        </tr>
      </tbody>
    </table>
    <p v-if="d.chargement && d.lignes.length === 0" class="rag-empty-docs" role="status">
      <i class="ph ph-circle-notch animate-spin" aria-hidden="true"></i> Chargement des documents…
    </p>
    <p v-else-if="d.erreur" class="rag-error" role="alert">
      <i class="ph ph-warning-circle" aria-hidden="true"></i><span>{{ d.erreur }}</span>
    </p>
    <p v-else-if="d.lignes.length === 0" class="rag-empty-docs">
      {{
        d.filtrees
          ? "Aucun document ne correspond au filtre."
          : rg.estProprietaire
            ? "Cette collection est vide : déposez des fichiers pour commencer."
            : "Cette collection ne contient aucun document."
      }}
    </p>
  </div>
</template>
