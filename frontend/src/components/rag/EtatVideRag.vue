<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/rag/EtatVideRag.vue — première visite : la zone de dépôt qui crée la collection. -->
<script setup lang="ts">
import { domaineRag } from "../../features/rag/domaine";

const rg = domaineRag();
</script>

<template>
  <div class="rag-empty" data-rag-vide>
    <div class="rag-empty__zone" :class="{ 'is-over': rg.documents.depot.survol }">
      <i class="ph ph-books" aria-hidden="true"></i>
      <h3>Créez votre première collection</h3>
      <p>
        Déposez vos documents : l’assistant pourra y chercher et citer ses sources dans vos conversations.
      </p>
      <div class="rag-empty__acts">
        <button
          type="button"
          class="rag-btn rag-btn--primary"
          :disabled="!rg.utilisable"
          @click="rg.ouvrirNouvelle()"
        >
          <i class="ph ph-plus" aria-hidden="true"></i>Nouvelle collection
        </button>
        <button type="button" class="rag-btn" :disabled="!rg.utilisable" @click="rg.ouvrirNouvelle([], true)">
          <i class="ph ph-folder-open" aria-hidden="true"></i>Importer depuis la sandbox
        </button>
      </div>
      <small>Ou glissez des fichiers ici · PDF, Word, Excel, PowerPoint, Markdown, HTML, texte</small>
    </div>
  </div>
</template>
