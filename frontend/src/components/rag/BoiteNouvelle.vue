<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/rag/BoiteNouvelle.vue — boîte « Nouvelle collection » : nom, description lue par l'assistant, fichiers déjà choisis (première visite ou dépôt sur la page vide). -->
<script setup lang="ts">
import { NOM_COLLECTION_RAG_MAX } from "@elpis/contracts";

import { domaineRag } from "../../features/rag/domaine";

const rg = domaineRag();
</script>

<template>
  <Teleport to="body">
    <div
      v-if="rg.nouvelle.ouvert"
      class="rag-veil bg-slate-900/80"
      data-a11y-modal
      data-rag-dialog="nouvelle"
      @click.self="rg.fermerNouvelle()"
    >
      <form
        class="rag-dialog shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rag-nouv-titre"
        @submit.prevent="rg.creerNouvelle()"
      >
        <div class="rag-dialog__head">
          <div class="rag-dialog__chip"><i class="ph ph-books" aria-hidden="true"></i></div>
          <div>
            <h3 id="rag-nouv-titre">Nouvelle collection</h3>
            <div class="rag-dialog__sub">Un ensemble de documents que l’assistant pourra interroger.</div>
          </div>
        </div>
        <div class="rag-dialog__body">
          <div class="rag-field">
            <label for="rag-nouv-nom">Nom</label>
            <input
              id="rag-nouv-nom"
              v-model="rg.nouvelle.nom"
              class="rag-input rag-input--plain"
              type="text"
              :maxlength="NOM_COLLECTION_RAG_MAX"
              autocomplete="off"
              required
            />
          </div>
          <div class="rag-field">
            <label for="rag-nouv-desc">Description <small>(facultative)</small></label>
            <textarea
              id="rag-nouv-desc"
              v-model="rg.nouvelle.description"
              class="rag-textarea"
              maxlength="500"
              aria-describedby="rag-nouv-aide"
            ></textarea>
            <small id="rag-nouv-aide"
              >L’assistant la lit pour savoir quand chercher dans cette collection.</small
            >
          </div>
          <div v-if="rg.nouvelle.fichiers.length > 0" class="rag-note">
            <i class="ph ph-upload-simple" aria-hidden="true"></i
            ><span
              >{{ rg.nouvelle.fichiers.length }} fichier{{
                rg.nouvelle.fichiers.length > 1 ? "s" : ""
              }}
              seront ajoutés dès la création.</span
            >
          </div>
          <p v-if="rg.nouvelle.erreur" class="rag-error" role="alert">
            <i class="ph ph-warning-circle" aria-hidden="true"></i><span>{{ rg.nouvelle.erreur }}</span>
          </p>
        </div>
        <div class="rag-dialog__foot">
          <button type="button" class="rag-btn" @click="rg.fermerNouvelle()">Annuler</button>
          <button
            type="submit"
            class="rag-btn rag-btn--primary"
            :disabled="rg.nouvelle.enCours || rg.nouvelle.nom.trim() === ''"
          >
            Créer
          </button>
        </div>
      </form>
    </div>
  </Teleport>
</template>
