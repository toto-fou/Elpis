<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/rag/OngletReglages.vue — onglet Réglages (propriétaire) : nom, description lue par l'assistant, découpage et règles par type de fichier, OCR, zone de danger. -->
<script setup lang="ts">
import { computed } from "vue";
import { DESCRIPTION_COLLECTION_RAG_MAX, NOM_COLLECTION_RAG_MAX } from "@elpis/contracts";

import { domaineRag } from "../../features/rag/domaine";
import ChampsDecoupage from "./ChampsDecoupage.vue";
import ReglesExtensions from "./ReglesExtensions.vue";

const rg = domaineRag();
const r = computed(() => rg.reglages);
</script>

<template>
  <div class="rag-pane rag-pane--scroll">
    <form class="rag-form" novalidate @submit.prevent="r.enregistrer()">
      <div class="rag-field">
        <label for="rag-reg-nom">Nom</label>
        <input
          id="rag-reg-nom"
          v-model="r.brouillon.name"
          class="rag-input rag-input--plain"
          type="text"
          :maxlength="NOM_COLLECTION_RAG_MAX + 20"
          :aria-invalid="r.erreurs.name ? 'true' : undefined"
          aria-describedby="rag-reg-nom-err"
        />
        <span id="rag-reg-nom-err" class="rag-err" role="alert">{{ r.erreurs.name }}</span>
      </div>

      <div class="rag-field">
        <label for="rag-reg-desc">Description</label>
        <textarea
          id="rag-reg-desc"
          v-model="r.brouillon.description"
          class="rag-textarea"
          :aria-invalid="r.erreurs.description ? 'true' : undefined"
          aria-describedby="rag-reg-desc-aide"
        ></textarea>
        <small id="rag-reg-desc-aide">
          L’assistant la lit pour savoir quand chercher dans cette collection.
          {{ r.brouillon.description.length }} / {{ DESCRIPTION_COLLECTION_RAG_MAX }}
        </small>
        <span v-if="r.erreurs.description" class="rag-err" role="alert">{{ r.erreurs.description }}</span>
      </div>

      <fieldset class="rag-field rag-fieldset">
        <legend class="rag-label">Découpage</legend>
        <ChampsDecoupage v-model="r.brouillon.decoupage" id-base="rag-reg-dec" />
        <ReglesExtensions />
        <small class="rag-hint"
          >Modifier le découpage réindexe les documents concernés. Un document peut aussi avoir son propre
          découpage, réglé depuis l’onglet Documents.</small
        >
      </fieldset>

      <div class="rag-field">
        <div class="rag-line-set">
          <div>
            <span id="rag-reg-ocr" class="rag-label">OCR des documents scannés</span>
            <small class="rag-hint rag-hint--block">
              {{
                r.ocrDispo
                  ? "Lit les pages sans texte avec un modèle de vision. Plus lent."
                  : "L’OCR n’est pas configuré sur ce serveur."
              }}
            </small>
          </div>
          <button
            type="button"
            role="switch"
            class="rag-switch"
            :class="{ 'is-off': !r.brouillon.ocr }"
            aria-labelledby="rag-reg-ocr"
            :aria-checked="r.brouillon.ocr ? 'true' : 'false'"
            :disabled="!r.ocrDispo && !r.brouillon.ocr"
            @click="r.brouillon.ocr = !r.brouillon.ocr"
          >
            <s aria-hidden="true"></s>{{ r.brouillon.ocr ? "Activé" : "Désactivé" }}
          </button>
        </div>
      </div>

      <p v-if="r.erreur" class="rag-error" role="alert">
        <i class="ph ph-warning-circle" aria-hidden="true"></i><span>{{ r.erreur }}</span>
      </p>
      <div class="rag-form__acts">
        <button type="submit" class="rag-btn rag-btn--primary" :disabled="!r.enregistrable">
          Enregistrer
        </button>
        <button type="button" class="rag-btn" :disabled="!r.modifie" @click="r.annuler()">Annuler</button>
      </div>
    </form>

    <section class="rag-danger" aria-labelledby="rag-danger-titre">
      <h3 id="rag-danger-titre">Zone de danger</h3>
      <div class="rag-danger__row">
        <div>
          Vider la collection<small
            >Supprime tous les documents ; la collection, sa description et sa publication restent.</small
          >
        </div>
        <button type="button" class="rag-btn rag-btn--danger" @click="r.vider()">Vider…</button>
      </div>
      <div class="rag-danger__row">
        <div>
          Supprimer la collection<small
            >Supprime la collection, ses documents et son index. Il faut saisir son nom pour confirmer.</small
          >
        </div>
        <button type="button" class="rag-btn rag-btn--danger" @click="r.supprimer()">Supprimer…</button>
      </div>
    </section>
  </div>
</template>
