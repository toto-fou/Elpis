<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/page/BoutonBas.vue — bouton « descendre » au-dessus du composeur. -->
<script setup lang="ts">
import { CLE_CONVERSATION, domaine } from "../../../features/chat/page/domaines";

const conv = domaine(CLE_CONVERSATION);
</script>

<template>
  <transition name="fade">
    <button
      v-if="conv.messages.length >= 3 && conv.chatAwayFromBottom"
      :style="{ bottom: conv.scrollBtnBottom + 'px' }"
      class="absolute left-1/2 -translate-x-1/2 z-30 w-9 h-9 bg-white border border-slate-200 rounded-full shadow-lg flex items-center justify-center text-slate-500 hover:text-blue-600 hover:border-blue-300 transition-all"
      @click="
        conv.isUserScrolling = false;
        conv.scrollToBottom(true);
      "
    >
      <i class="ph ph-arrow-down text-base"></i>
    </button>
  </transition>
</template>
