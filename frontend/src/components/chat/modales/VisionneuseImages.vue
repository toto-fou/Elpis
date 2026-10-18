<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/modales/VisionneuseImages.vue — visionneuse des images générées : navigation entre les images d'un résultat, description, actions (modifier, télécharger, copier, supprimer). -->
<script setup lang="ts">
import { domaineModales } from "../../../features/chat/modales/domaine";

const m = domaineModales();
</script>

<template>
  <!-- Visionneuse des images générées (features/images) : ← → entre les images
           d'un même résultat, description, modèle, graine, actions. Échap : cascade
           d'app.js ; focus gardé dans la fenêtre (imageViewerKeydown). -->
  <Transition name="modal">
    <div
      v-if="m.imageViewer && m.imageViewerCurrent"
      class="elpis-img-viewer"
      role="dialog"
      aria-modal="true"
      aria-label="Image générée"
      tabindex="-1"
      data-image-viewer
      @click.self="m.closeImageViewer()"
      @keydown="m.imageViewerKeydown($event)"
    >
      <div class="elpis-img-viewer__stage" @click.self="m.closeImageViewer()">
        <img
          :src="m.imageViewerCurrent.url"
          :alt="m.imageViewerPrompt || 'Image générée'"
          :width="m.imageViewerCurrent.width || undefined"
          :height="m.imageViewerCurrent.height || undefined"
        />
        <button
          v-if="m.imageViewer.items.length > 1"
          type="button"
          class="elpis-img-viewer__nav is-prev"
          aria-label="Image précédente"
          @click="m.imageViewerStep(-1)"
        >
          <i class="ph ph-caret-left" aria-hidden="true"></i>
        </button>
        <button
          v-if="m.imageViewer.items.length > 1"
          type="button"
          class="elpis-img-viewer__nav is-next"
          aria-label="Image suivante"
          @click="m.imageViewerStep(1)"
        >
          <i class="ph ph-caret-right" aria-hidden="true"></i>
        </button>
      </div>
      <aside class="elpis-img-viewer__panel">
        <div class="elpis-img-viewer__head">
          <span v-if="m.imageViewer.items.length > 1" class="elpis-img-viewer__count"
            >{{ m.imageViewer.idx + 1 }} / {{ m.imageViewer.items.length }}</span
          >
          <button
            type="button"
            class="elpis-img-viewer__close"
            title="Fermer (Échap)"
            aria-label="Fermer"
            @click="m.closeImageViewer()"
          >
            <i class="ph ph-x" aria-hidden="true"></i>
          </button>
        </div>
        <p v-if="m.imageViewerPrompt" class="elpis-img-viewer__prompt">{{ m.imageViewerPrompt }}</p>
        <p v-if="m.imageViewerInfo" class="elpis-img-viewer__meta">{{ m.imageViewerInfo }}</p>
        <div class="elpis-img-viewer__actions">
          <button
            v-if="m.imageCanEdit"
            type="button"
            class="elpis-img-btn"
            @click="
              m.editGeneratedImage(m.imageViewerCurrent);
              m.closeImageViewer();
            "
          >
            <i class="ph ph-pencil-simple" aria-hidden="true"></i>Modifier
          </button>
          <button
            type="button"
            class="elpis-img-btn"
            @click="m.downloadImage(m.imageViewerCurrent, m.imageViewerNamePrompt)"
          >
            <i class="ph ph-download-simple" aria-hidden="true"></i>Télécharger
          </button>
          <button
            v-if="m.imageViewerPrompt"
            type="button"
            class="elpis-img-btn"
            @click="m.copyImageText(m.imageViewerPrompt)"
          >
            <i class="ph ph-copy" aria-hidden="true"></i>Copier
          </button>
          <button
            v-if="m.imageViewerCurrent.chat_id && m.imageGallery"
            type="button"
            class="elpis-img-btn"
            data-image-goto-chat
            @click="m.openImageChat(String(m.imageViewerCurrent.chat_id))"
          >
            <i class="ph ph-chat-circle-text" aria-hidden="true"></i>Conversation
          </button>
          <button type="button" class="elpis-img-btn is-danger" @click="m.removeImage(m.imageViewerCurrent)">
            <i class="ph ph-trash" aria-hidden="true"></i>Supprimer
          </button>
        </div>
      </aside>
    </div>
  </Transition>
</template>
