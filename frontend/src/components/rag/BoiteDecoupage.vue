<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/rag/BoiteDecoupage.vue — fenêtre « Découpage » d'un document : à gauche hériter ou découpage propre, à droite l'aperçu et les passages indexés ; Appliquer et réindexer. -->
<script setup lang="ts">
import { computed } from "vue";

import { resumeParams } from "../../features/rag/decoupage";
import { focaliserId } from "../../features/rag/dom";
import { domaineRag } from "../../features/rag/domaine";
import type { OngletDecoupage } from "../../features/rag/rag-decoupage";
import ApercuDecoupage from "./ApercuDecoupage.vue";
import ChampsDecoupage from "./ChampsDecoupage.vue";
import PassagesIndexes from "./PassagesIndexes.vue";

const rg = domaineRag();
const d = computed(() => rg.decoupage);

const onglets = computed<{ id: OngletDecoupage; libelle: string }[]>(() => [
  ...(d.value.lecture ? [] : [{ id: "apercu" as const, libelle: "Aperçu du découpage" }]),
  { id: "indexes", libelle: "Passages indexés" },
]);

const sousTitre = computed(() => {
  if (d.value.lecture) return `Lecture seule · ${rg.courante?.name ?? ""}`;
  return d.value.propreAuDepart
    ? "Ce document a son propre découpage."
    : "Ce document suit le découpage de la collection.";
});

function surClavierOnglets(e: KeyboardEvent): void {
  const ids = onglets.value.map((o) => o.id);
  const i = ids.indexOf(d.value.onglet);
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
  d.value.choisirOnglet(id);
  focaliserId(`rag-dtab-${id}`);
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="d.ouvert && d.doc"
      class="rag-veil bg-slate-900/80"
      data-a11y-modal
      data-rag-dialog="decoupage"
      @click.self="d.fermer()"
    >
      <div
        class="rag-dialog rag-dialog--decoupage shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rag-dec-titre"
        aria-describedby="rag-dec-sous"
      >
        <div class="rag-dialog__head">
          <div class="rag-dialog__chip"><i class="ph ph-scissors" aria-hidden="true"></i></div>
          <div class="rag-dialog__titre">
            <h3 id="rag-dec-titre">Découpage de « {{ d.doc.name }} »</h3>
            <div id="rag-dec-sous" class="rag-dialog__sub">{{ sousTitre }}</div>
          </div>
          <button
            type="button"
            class="rag-btn rag-btn--icon"
            title="Fermer"
            aria-label="Fermer"
            @click="d.fermer()"
          >
            <i class="ph ph-x" aria-hidden="true"></i>
          </button>
        </div>

        <div class="rag-dec" :class="{ 'is-lecture': d.lecture }">
          <section v-if="!d.lecture" class="rag-dec__params" aria-label="Paramètres de découpage du document">
            <fieldset class="rag-field rag-fieldset">
              <legend class="rag-label">Découpage de ce document</legend>
              <label class="rag-radio-row"
                ><input v-model="d.mode" type="radio" name="rag-dec-mode" value="heriter" />Hériter de la
                collection</label
              >
              <small class="rag-hint rag-hint--indent">{{ resumeParams(d.paramsHerites) }}</small>
              <label class="rag-radio-row"
                ><input v-model="d.mode" type="radio" name="rag-dec-mode" value="propre" />Découpage
                propre</label
              >
            </fieldset>
            <ChampsDecoupage v-if="d.mode === 'propre'" v-model="d.params" id-base="rag-dec-doc" />
            <p class="rag-hint">
              Appliquer réindexe ce document seul ; les autres documents ne changent pas.
            </p>
          </section>

          <section class="rag-dec__main" aria-label="Contenu du document">
            <div
              class="rag-tabs rag-tabs--dec"
              role="tablist"
              aria-label="Contenu du document"
              @keydown="surClavierOnglets"
            >
              <button
                v-for="o in onglets"
                :id="'rag-dtab-' + o.id"
                :key="o.id"
                type="button"
                role="tab"
                class="rag-tab"
                :class="{ 'is-on': d.onglet === o.id }"
                :aria-selected="d.onglet === o.id ? 'true' : 'false'"
                :aria-controls="'rag-dpanel-' + o.id"
                :tabindex="d.onglet === o.id ? 0 : -1"
                @click="d.choisirOnglet(o.id)"
              >
                {{ o.libelle }}
              </button>
            </div>
            <ApercuDecoupage
              v-if="d.onglet === 'apercu' && !d.lecture"
              id="rag-dpanel-apercu"
              role="tabpanel"
              aria-labelledby="rag-dtab-apercu"
            />
            <PassagesIndexes
              v-else
              id="rag-dpanel-indexes"
              role="tabpanel"
              aria-labelledby="rag-dtab-indexes"
            />
          </section>
        </div>

        <p v-if="d.erreur" class="rag-error rag-dec__err" role="alert">
          <i class="ph ph-warning-circle" aria-hidden="true"></i><span>{{ d.erreur }}</span>
        </p>
        <div v-if="!d.lecture" class="rag-dialog__foot">
          <button
            v-if="d.propreAuDepart"
            type="button"
            class="rag-btn"
            :disabled="!d.peutRevenir"
            @click="d.revenir()"
          >
            <i class="ph ph-arrow-counter-clockwise" aria-hidden="true"></i>Revenir au découpage de la
            collection
          </button>
          <span class="rag-tools__grow"></span>
          <button type="button" class="rag-btn" @click="d.fermer()">Annuler</button>
          <button
            type="button"
            class="rag-btn rag-btn--primary"
            :disabled="!d.peutAppliquer"
            :title="d.modifie ? undefined : 'Aucun changement à appliquer'"
            @click="d.appliquer()"
          >
            Appliquer et réindexer
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
