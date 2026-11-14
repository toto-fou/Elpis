<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/page/LigneHistorique.vue — ligne de l'historique du volet : ouverture (lecture lancée à l'appui), case de sélection, menu au clic droit, F2 renomme, pastille de génération ; rendue seule quand ce qu'elle lit change. -->
<script setup lang="ts">
import { computed } from "vue";

import { appuiLigne, oublierPrecharge } from "../../../features/chat/historique/ouverture";
import { CLE_BARRE, domaine } from "../../../features/chat/page/domaines";
import type { ChatResume } from "../../../features/chat/page/types";

const props = defineProps<{ chat: ChatResume }>();
const b = domaine(CLE_BARRE);

// États calculés par ligne : un changement de conversation ou un sondage des runs ne re-rend que les lignes touchées.
const courante = computed(
  () =>
    !b.chatSelectMode && b.currentView === "chat" && (b.chatEnOuverture ?? b.currentChatId) === props.chat.id,
);
const cochee = computed(() => b.chatSelectMode && b.chatSelected.includes(props.chat.id));
const enCours = computed(() => b.activeRunIds.includes(String(props.chat.id)));
</script>

<template>
  <div
    data-chat-row
    :data-chat-id="chat.id"
    class="relative h-[30px] rounded-lg flex items-center group transition-colors select-none"
    :class="
      courante
        ? 'bg-blue-600/20 text-white font-medium'
        : 'text-slate-300 hover:bg-white/[0.05] hover:text-white'
    "
    @contextmenu.prevent="b.openContextMenu($event, 'chat', chat)"
  >
    <!-- Titre : ouvre (ou coche en mode sélection) ; actions au clic droit ou à la touche Menu, F2 renomme. -->
    <button
      type="button"
      data-chat-open
      class="flex-1 min-w-0 h-full pl-3 pr-2 rounded-lg flex items-center gap-2 text-left cursor-pointer"
      :aria-current="courante ? 'page' : undefined"
      :aria-pressed="b.chatSelectMode ? (cochee ? 'true' : 'false') : undefined"
      @pointerdown="appuiLigne($event, chat.id, b)"
      @pointerleave="oublierPrecharge"
      @pointercancel="oublierPrecharge"
      @dragstart="oublierPrecharge"
      @click="b.chatSelectMode ? b.toggleChatSelect(chat.id) : b.loadChat(chat.id)"
      @keydown.f2.prevent="b.renameChat(chat.id, chat.title)"
    >
      <span
        v-if="b.chatSelectMode"
        aria-hidden="true"
        class="shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-colors"
        :class="cochee ? 'bg-blue-600 border-blue-600' : 'border-white/25 group-hover:border-white/50'"
      >
        <i v-if="cochee" class="ph ph-check text-white text-[10px]"></i>
      </span>
      <span class="truncate flex-1 text-[13.5px]" :class="chat._renamed ? 'elpis-title-flash' : ''">{{
        chat.title
      }}</span>
      <!-- Run en cours (tous onglets, tous appareils) : point d'accent qui respire (immobile en mouvement réduit). -->
      <span
        v-if="enCours"
        class="elpis-run-dot shrink-0"
        role="img"
        aria-label="Génération en cours"
        title="Génération en cours…"
      ></span>
    </button>
  </div>
</template>
