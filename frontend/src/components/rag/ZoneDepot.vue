<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/rag/ZoneDepot.vue — zone de dépôt de l'onglet Documents : fichiers ou dossier glissés, ou choisis par le sélecteur. -->
<script setup lang="ts">
import { choisirFichiers } from "../../features/rag/depot";
import { domaineRag } from "../../features/rag/domaine";
import { formaterQuotaMo } from "../../features/rag/format";

const rg = domaineRag();

async function parcourir(dossier: boolean): Promise<void> {
  const fichiers = await choisirFichiers(dossier);
  if (fichiers.length > 0) await rg.documents.deposer(fichiers);
}
</script>

<template>
  <div class="rag-drop" :class="{ 'is-over': rg.documents.depot.survol }" data-rag-zone-depot>
    <i class="ph ph-upload-simple" aria-hidden="true"></i>
    <span v-if="rg.documents.depot.enCours"
      >Envoi en cours : {{ rg.documents.depot.envoyes }} / {{ rg.documents.depot.total }} fichiers</span
    >
    <span v-else>
      Glissez des fichiers ou un dossier ici, ou
      <button type="button" class="rag-link" :disabled="!rg.utilisable" @click="parcourir(false)">
        parcourez
      </button>
      <span aria-hidden="true"> · </span>
      <button
        type="button"
        class="rag-link"
        aria-label="Choisir un dossier"
        :disabled="!rg.utilisable"
        @click="parcourir(true)"
      >
        un dossier
      </button>
    </span>
    <small>
      PDF, Word, Excel, PowerPoint, Markdown, HTML, texte<template
        v-if="rg.etat && rg.etat.quotas.file_mb > 0"
      >
        · {{ formaterQuotaMo(rg.etat.quotas.file_mb) }} par fichier</template
      >
    </small>
  </div>
</template>
