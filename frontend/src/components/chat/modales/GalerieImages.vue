<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/modales/GalerieImages.vue — galerie personnelle des images générées : filtre compte ou conversation, pages au défilement, états expirée ou supprimée. -->
<script setup lang="ts">
import { domaineModales } from "../../../features/chat/modales/domaine";

const m = domaineModales();
</script>

<template>
  <!-- Galerie personnelle (features/images) : images du compte ou de la
           conversation ouverte, par pages au défilement ; clic = visionneuse. -->
  <Transition name="modal">
    <div
      v-if="m.imageGallery"
      class="elpis-img-gallery"
      role="dialog"
      aria-modal="true"
      aria-label="Galerie d’images"
      tabindex="-1"
      data-image-gallery
      @click.self="m.closeImageGallery()"
      @keydown="m.imageGalleryKeydown"
    >
      <div class="elpis-img-gallery__box">
        <header class="elpis-img-gallery__head">
          <h2 class="elpis-img-gallery__title">Galerie</h2>
          <span
            v-if="m.imageGallery.keep"
            class="elpis-img-gallery__count"
            title="Images conservées ; au-delà, les plus anciennes sont effacées."
            >{{ m.imageGallery.total }}/{{ m.imageGallery.keep }}</span
          >
          <div class="elpis-img-gallery__filters" role="group" aria-label="Filtre">
            <button
              type="button"
              class="elpis-img-chip"
              :aria-pressed="m.imageGallery.filter === 'all' ? 'true' : 'false'"
              @click="m.setGalleryFilter('all')"
            >
              Toutes
            </button>
            <button
              type="button"
              class="elpis-img-chip"
              :aria-pressed="m.imageGallery.filter === 'chat' ? 'true' : 'false'"
              :disabled="!m.currentChatId"
              :title="m.currentChatId ? '' : 'Aucune conversation ouverte'"
              @click="m.setGalleryFilter('chat')"
            >
              Cette conversation
            </button>
          </div>
          <button
            type="button"
            class="elpis-img-viewer__close"
            title="Fermer (Échap)"
            aria-label="Fermer la galerie"
            @click="m.closeImageGallery()"
          >
            <i class="ph ph-x" aria-hidden="true"></i>
          </button>
        </header>
        <div class="elpis-img-gallery__grid custom-scrollbar" @scroll="m.onGalleryScroll($event)">
          <div
            v-for="(it, i) in m.imageGallery.items"
            :key="it.id"
            class="elpis-img-gallery__cell"
            :data-image-id="it.id"
          >
            <div v-if="m.imageCellState(it.id)" class="elpis-img-frame">
              <i
                class="ph"
                :class="m.imageCellState(it.id) === 'expired' ? 'ph-image-broken' : 'ph-trash'"
                aria-hidden="true"
              ></i>
              <span>{{ m.imageCellState(it.id) === "expired" ? "Expirée" : "Supprimée" }}</span>
            </div>
            <template v-else>
              <button
                type="button"
                class="elpis-img-open"
                :aria-label="'Agrandir : ' + (it.prompt || 'image')"
                @click="m.openGalleryItem(i)"
              >
                <img
                  :src="it.thumb_url || it.url"
                  :alt="it.prompt || 'Image générée'"
                  loading="lazy"
                  decoding="async"
                  @error="m.markImageExpired(it.id)"
                />
              </button>
              <div class="elpis-img-actions">
                <button
                  type="button"
                  class="elpis-img-act"
                  title="Télécharger"
                  aria-label="Télécharger l’image"
                  @click.stop="m.downloadImage(it, it.prompt)"
                >
                  <i class="ph ph-download-simple" aria-hidden="true"></i>
                </button>
                <button
                  type="button"
                  class="elpis-img-act is-danger"
                  title="Supprimer"
                  aria-label="Supprimer l’image"
                  @click.stop="m.removeImage(it)"
                >
                  <i class="ph ph-trash" aria-hidden="true"></i>
                </button>
              </div>
            </template>
          </div>
          <p
            v-if="!m.imageGallery.loading && !m.imageGallery.items.length && !m.imageGallery.error"
            class="elpis-img-gallery__empty"
          >
            {{ m.imageGallery.filter === "chat" ? "Aucune image dans cette conversation." : "Aucune image." }}
          </p>
          <p v-if="m.imageGallery.error" class="elpis-img-gallery__empty is-err">
            {{ m.imageGallery.error }}
          </p>
          <p v-if="m.imageGallery.loading" class="elpis-img-gallery__empty" role="status">
            <i class="ph ph-circle-notch animate-spin" aria-hidden="true"></i> Chargement…
          </p>
        </div>
      </div>
    </div>
  </Transition>
</template>
