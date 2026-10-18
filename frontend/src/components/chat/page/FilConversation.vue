<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/page/FilConversation.vue — conteneur de défilement du chat : accueil, recherche, fil des messages, cale du composeur. -->
<script setup lang="ts">
import { useTemplateRef } from "vue";

import { CLE_CONVERSATION, domaine } from "../../../features/chat/page/domaines";
import { publierElement } from "../../../features/chat/page/element";
import ListeMessages from "../liste/ListeMessages.vue";
import AccueilChat from "./AccueilChat.vue";
import RechercheMessages from "./RechercheMessages.vue";

const emit = defineEmits<{
  conteneur: [el: HTMLDivElement | null];
  accueil: [el: HTMLDivElement | null];
  "zoom-image": [url: string];
  edition: [texte: string];
}>();
const conv = domaine(CLE_CONVERSATION);
publierElement(useTemplateRef<HTMLDivElement>("conteneur"), (el) => emit("conteneur", el));
</script>

<template>
  <div ref="conteneur" class="flex-1 overflow-y-auto px-4 md:px-6 pb-4 md:pb-6 pt-16 scroll-smooth">
    <div
      class="elpis-chat-col mx-auto space-y-8 transition-transform duration-300"
      :style="{
        maxWidth: !conv.showEditor || !conv.settings.enable_editor ? conv.settings.chat_width + '%' : '48rem',
      }"
    >
      <AccueilChat v-if="conv.messages.length === 0" @hote="emit('accueil', $event)" />
      <RechercheMessages v-if="conv.messageSearchActive" />
      <ListeMessages @zoom-image="emit('zoom-image', $event)" @edition="emit('edition', $event)" />
      <div class="w-full shrink-0" :style="{ height: conv.chatBottomPad + 'px' }"></div>
    </div>
  </div>
</template>
