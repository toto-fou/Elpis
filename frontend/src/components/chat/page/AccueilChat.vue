<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/page/AccueilChat.vue — accueil d'une conversation vide : scène animée (hôte publié au parent), image, icône ou logo, salutation. -->
<script setup lang="ts">
import { useTemplateRef } from "vue";

import { CLE_CONVERSATION, domaine } from "../../../features/chat/page/domaines";
import { publierElement } from "../../../features/chat/page/element";

const emit = defineEmits<{ hote: [el: HTMLDivElement | null] }>();
const conv = domaine(CLE_CONVERSATION);
const LOGO = "static/elpis-256.png";
publierElement(useTemplateRef<HTMLDivElement>("hote"), (el) => emit("hote", el));
</script>

<template>
  <div class="elpis-welcome text-center flex flex-col items-center justify-end min-h-[calc(44dvh-4rem)] pb-3">
    <div
      v-if="conv.mascotteVisible"
      ref="hote"
      class="accueil accueil--bloc w-full mb-4"
      role="img"
      aria-label="ELPIS"
    ></div>
    <div
      v-else-if="conv.welcomeConfig && conv.welcomeConfig.type === 'image' && conv.welcomeConfig.image_b64"
      class="mb-4"
    >
      <img
        :src="conv.welcomeConfig.image_b64"
        draggable="false"
        :style="{
          width: ((conv.welcomeConfig && conv.welcomeConfig.width) || 96) + 'px',
          height: ((conv.welcomeConfig && conv.welcomeConfig.height) || 96) + 'px',
        }"
        class="object-contain opacity-90 drop-shadow-sm select-none pointer-events-none"
      />
    </div>
    <div v-else-if="conv.welcomeConfig?.type === 'icon'" class="mb-4">
      <i
        class="ph text-blue-500 drop-shadow-sm"
        :class="(conv.welcomeConfig && conv.welcomeConfig.icon) || 'ph-sparkle'"
        :style="{ fontSize: ((conv.welcomeConfig && conv.welcomeConfig.width) || 96) + 'px' }"
      ></i>
    </div>
    <div v-else class="mb-4">
      <img
        :src="LOGO"
        alt=""
        draggable="false"
        width="112"
        height="112"
        class="object-contain opacity-90 drop-shadow-sm select-none pointer-events-none"
      />
    </div>
    <h2 class="text-xl font-bold tracking-tight mb-2 text-slate-800">Bonjour {{ conv.user.username }}</h2>
    <p class="text-sm font-medium text-slate-500">Comment puis-je vous aider aujourd'hui ?</p>
  </div>
</template>
