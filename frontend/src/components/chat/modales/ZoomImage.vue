<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/modales/ZoomImage.vue — agrandissement plein écran d'une image du chat (images jointes, diagrammes). -->
<script setup lang="ts">
import { domaineModales } from "../../../features/chat/modales/domaine";

const m = domaineModales();
</script>

<template>
  <!-- Image zoom modal -- must be INSIDE #app so Vue can bind imgZoom -->
  <Transition name="modal">
    <div
      v-if="m.imgZoom"
      class="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-sm cursor-zoom-out"
      @click="m.imgZoom = null"
    >
      <img
        :src="m.imgZoom"
        class="max-w-[92vw] max-h-[92vh] object-contain rounded-xl shadow-2xl cursor-default"
        @click.stop
      />
      <button
        class="absolute top-4 right-4 w-10 h-10 flex items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors backdrop-blur-sm"
        @click="m.imgZoom = null"
      >
        <i class="ph ph-x text-lg"></i>
      </button>
    </div>
  </Transition>
</template>
