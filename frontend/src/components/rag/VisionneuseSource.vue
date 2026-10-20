<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/rag/VisionneuseSource.vue — visionneuse de source, volet à droite du chat : mode Page (rendu réel, passage surligné) ou Texte (passages voisins), navigation entre les sources citées, bande du document, original pour qui y a droit. -->
<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";

import { domaineRagOptionnel } from "../../features/rag/domaine";
import { accorder, emplacementPassage, formaterScore, iconeFichier } from "../../features/rag/format";
import { creerGardeFocus } from "../../features/rag/focus-volet";
import { PHRASE_SOURCES_FERMEES } from "../../features/rag/visionneuse";
import { bandeDuDocument, extensionDe } from "../../features/rag/sources-affichage";
import PastilleSource from "./PastilleSource.vue";
import TexteSurligne from "./TexteSurligne.vue";

const rag = domaineRagOptionnel();
const racine = ref<HTMLElement | null>(null);
const nom = ref<HTMLElement | null>(null);

const vis = computed(() => rag?.sources.visionneuse ?? null);
const source = computed(() => vis.value?.source ?? null);
const passage = computed(() => source.value?.passage ?? null);
const mode = computed(() => vis.value?.mode ?? "page");
const nbPassages = computed(() => vis.value?.document?.chunk_count ?? vis.value?.texte.chunkCount ?? 0);
const pageMontree = computed(() => vis.value?.page.num ?? passage.value?.page ?? null);
const sousTitre = computed(() => {
  const p = passage.value;
  if (p === null || vis.value === null) return "";
  const parts = [p.collection_name];
  if (mode.value === "page" && pageMontree.value !== null)
    parts.push(
      vis.value.totalPages === null
        ? `page ${pageMontree.value}`
        : `page ${pageMontree.value} sur ${vis.value.totalPages}`,
    );
  else if (emplacementPassage(p)) parts.push(emplacementPassage(p));
  if (nbPassages.value > 0) parts.push(accorder(nbPassages.value, "passage"));
  return parts.join(" · ");
});
const bande = computed(() => {
  const v = vis.value;
  if (v === null) return [];
  return bandeDuDocument(
    nbPassages.value,
    v.duDocument.map((s) => ({ chunk_index: s.passage.chunk_index, n: s.n })),
    v.numero,
  );
});
const libelleBande = computed(() => {
  const ns = vis.value?.duDocument.map((s) => s.n) ?? [];
  return `Position dans le document des passages cités : ${ns.join(", ")}, sur ${accorder(nbPassages.value, "passage")}`;
});
const textes = computed(() => {
  const v = vis.value;
  const p = passage.value;
  if (v === null || p === null) return [];
  if (v.texte.passages.length > 0) return v.texte.passages;
  // Rien lu du serveur (chargement, refus, collection retirée) : l'extrait enregistré avec la source.
  return [{ chunk_index: p.chunk_index, text: p.text, heading_path: p.heading_path, page: p.page }];
});
const messageTexte = computed(() => {
  const v = vis.value;
  if (v === null) return "";
  if (v.introuvable) return v.introuvable.message;
  if (v.restreint) return PHRASE_SOURCES_FERMEES;
  return v.texte.erreur?.message ?? "";
});

// « Passage 27 · page 7 · 3.2 Renouvellement · Pertinence 0,79 » : la pertinence ne qualifie que le passage cité.
function meta(p: { chunk_index: number; page: number | null; heading_path: string }): string {
  const parts = [`Passage ${p.chunk_index + 1}`, emplacementPassage(p)];
  const s = source.value;
  if (s !== null && s.passage.chunk_index === p.chunk_index && s.relevance !== null)
    parts.push(`Pertinence ${formaterScore(s.relevance)}`);
  return parts.filter((x) => x !== "").join(" · ");
}

function ouvrirSource(s: { n: number }): void {
  void vis.value?.aller(s.n);
}

// À l'ouverture le focus entre dans le volet ; à la fermeture il retourne à ce qui l'avait.
const garde = creerGardeFocus();
watch(
  () => vis.value?.ouverte ?? false,
  (ouverte) => {
    if (ouverte) void nextTick(() => garde.entrer(racine.value, nom.value));
    else garde.sortir();
  },
  { flush: "post" },
);

const surImage = (e: Event): void => {
  const img = e.target as HTMLImageElement;
  vis.value?.imageChargee(img.naturalWidth, img.naturalHeight);
};
</script>

<template>
  <aside
    v-if="rag && vis && vis.ouverte && source && passage"
    ref="racine"
    class="rag-viewer"
    aria-label="Source citée"
    data-rag-viewer
  >
    <div class="rag-viewer__head">
      <div class="rag-viewer__row">
        <i class="ph" :class="iconeFichier(extensionDe(passage.document_name))" aria-hidden="true"></i>
        <div ref="nom" class="rag-viewer__name" tabindex="-1" :title="passage.rel_path">
          {{ passage.document_name }}
        </div>
        <span v-if="!vis.restreint" class="rag-seg" role="group" aria-label="Affichage de la source">
          <button
            type="button"
            :class="{ 'is-on': mode === 'page' }"
            :aria-pressed="mode === 'page'"
            data-rag-mode="page"
            @click="vis.basculer('page')"
          >
            Page
          </button>
          <button
            type="button"
            :class="{ 'is-on': mode === 'texte' }"
            :aria-pressed="mode === 'texte'"
            data-rag-mode="texte"
            @click="vis.basculer('texte')"
          >
            Texte
          </button>
        </span>
        <a
          v-if="vis.peutOuvrirOriginal"
          class="rag-btn rag-btn--icon"
          :href="vis.urlOriginal"
          download
          title="Ouvrir l’original"
          aria-label="Ouvrir l’original"
          data-rag-original
        >
          <i class="ph ph-arrow-square-out" aria-hidden="true"></i>
        </a>
        <button
          type="button"
          class="rag-btn rag-btn--icon"
          title="Fermer"
          aria-label="Fermer la source"
          data-rag-fermer
          @click="vis.fermer()"
        >
          <i class="ph ph-x" aria-hidden="true"></i>
        </button>
      </div>
      <div class="rag-viewer__sub" data-rag-sous-titre>{{ sousTitre }}</div>
      <div class="rag-viewer__nav">
        <button
          type="button"
          class="rag-btn rag-btn--icon"
          title="Source précédente"
          aria-label="Source précédente"
          :disabled="vis.ensemble.length < 2"
          @click="vis.voisine(-1)"
        >
          <i class="ph ph-caret-left" aria-hidden="true"></i>
        </button>
        <PastilleSource
          v-for="s in vis.ensemble"
          :key="s.n"
          :source="s"
          :actif="s.n === vis.numero"
          :courante="s.n === vis.numero"
          :voir="ouvrirSource"
          sans-bulle
        />
        <button
          type="button"
          class="rag-btn rag-btn--icon"
          title="Source suivante"
          aria-label="Source suivante"
          :disabled="vis.ensemble.length < 2"
          @click="vis.voisine(1)"
        >
          <i class="ph ph-caret-right" aria-hidden="true"></i>
        </button>
        <span v-if="bande.length > 0" class="rag-strip rag-strip--big" role="img" :aria-label="libelleBande">
          <i
            v-for="(c, i) in bande"
            :key="i"
            :class="{ 'is-hit': c.renvois.length > 0, 'is-cur': c.courante }"
            :data-r="c.renvois.length > 0 ? (c.courante ? vis.numero : c.renvois[0]) : undefined"
          ></i>
        </span>
      </div>
    </div>

    <div class="rag-viewer__body" data-rag-corps>
      <template v-if="mode === 'page' && !vis.introuvable">
        <div v-if="vis.page.etat === 'chargement'" class="rag-viewer__avis" role="status">
          <i class="ph ph-spinner-gap animate-spin" aria-hidden="true"></i> Chargement de la page…
        </div>
        <div
          v-else-if="vis.page.etat === 'erreur'"
          class="rag-viewer__avis rag-viewer__avis--erreur"
          role="alert"
        >
          <i class="ph ph-warning-circle" aria-hidden="true"></i>
          <div>
            {{ vis.page.erreur?.message }}
            <button type="button" class="rag-viewer__lien" @click="vis.basculer('texte')">
              Lire le texte
            </button>
          </div>
        </div>
        <template v-else-if="vis.page.etat === 'pret'">
          <p v-if="vis.page.sansSurlignage" class="rag-viewer__note">
            Le passage n’a pas pu être situé exactement dans la page : lisez-le dans l’onglet Texte.
          </p>
          <p v-else-if="vis.page.approximatif" class="rag-viewer__note">
            Surlignage approximatif : le passage a été retrouvé dans la page par son texte.
          </p>
          <div class="rag-paper" data-rag-page>
            <img
              :src="vis.page.url"
              :alt="`Page ${vis.page.num} du document ${passage.document_name}`"
              draggable="false"
              @load="surImage"
            />
            <template v-for="(r, i) in vis.surlignages" :key="i">
              <span
                class="rag-paper__hl"
                :class="{ 'is-soft': !r.courant }"
                :style="{
                  left: r.gauche + '%',
                  top: r.haut + '%',
                  width: r.largeur + '%',
                  height: r.hauteur + '%',
                }"
                :data-rag-hl="r.n || undefined"
                aria-hidden="true"
              ></span>
              <span
                v-if="r.n"
                class="rag-cite rag-paper__tag"
                :class="{ 'is-on': r.courant }"
                :style="{ left: r.gauche + '%', top: r.haut + '%' }"
                aria-hidden="true"
                >{{ r.n }}</span
              >
            </template>
          </div>
          <div v-if="vis.totalPages !== null && vis.totalPages > 1" class="rag-viewer__pager" data-rag-pager>
            <button
              type="button"
              class="rag-btn rag-btn--icon"
              title="Page précédente"
              aria-label="Page précédente"
              :disabled="(vis.page.num ?? 1) <= 1"
              @click="vis.allerPage((vis.page.num ?? 1) - 1)"
            >
              <i class="ph ph-caret-left" aria-hidden="true"></i>
            </button>
            <span class="rag-num">Page {{ vis.page.num }} sur {{ vis.totalPages }}</span>
            <button
              type="button"
              class="rag-btn rag-btn--icon"
              title="Page suivante"
              aria-label="Page suivante"
              :disabled="(vis.page.num ?? 1) >= vis.totalPages"
              @click="vis.allerPage((vis.page.num ?? 1) + 1)"
            >
              <i class="ph ph-caret-right" aria-hidden="true"></i>
            </button>
          </div>
        </template>
      </template>

      <template v-else>
        <div
          v-if="messageTexte"
          class="rag-viewer__avis"
          :class="{ 'rag-viewer__avis--erreur': vis.introuvable !== null || vis.texte.erreur !== null }"
          :role="vis.restreint ? 'note' : 'alert'"
          data-rag-volet-avis
        >
          <i
            class="ph"
            :class="vis.restreint ? 'ph-lock-simple' : 'ph-warning-circle'"
            aria-hidden="true"
          ></i>
          <div>{{ messageTexte }}</div>
        </div>
        <div v-else-if="vis.texte.etat === 'chargement'" class="rag-viewer__avis" role="status">
          <i class="ph ph-spinner-gap animate-spin" aria-hidden="true"></i> Chargement du texte…
        </div>
        <ol class="rag-txt" data-rag-texte>
          <li
            v-for="p in textes"
            :key="p.chunk_index"
            class="rag-txt__p"
            :class="{ 'is-cur': p.chunk_index === passage.chunk_index }"
          >
            <span v-if="p.chunk_index === passage.chunk_index" class="rag-cite is-on" aria-hidden="true">{{
              source.n
            }}</span>
            <div class="rag-txt__meta">{{ meta(p) }}</div>
            <p>
              <TexteSurligne
                :texte="p.text"
                :requete="p.chunk_index === passage.chunk_index ? source.query : null"
              />
            </p>
          </li>
        </ol>
      </template>
    </div>
  </aside>
</template>
