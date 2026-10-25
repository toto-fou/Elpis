<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/liste/ListeMessages.vue — fil des messages : fenêtre virtuelle (cales haute et basse), lignes mémoïsées (réveils regroupés compris), bulle de reconnexion, compaction en cours. -->
<script setup lang="ts">
import { CLE_LISTE, domaine } from "../../../features/chat/page/domaines";
import { preferencesChat } from "../../../features/reglages/affichage-chat";
import MessageChat from "../message/MessageChat.vue";

const liste = domaine(CLE_LISTE);
const pref = preferencesChat();
const emit = defineEmits<{ "zoom-image": [url: string]; edition: [texte: string] }>();
</script>

<template>
  <div v-if="liste.vsTopPad > 0" :style="{ height: liste.vsTopPad + 'px' }" aria-hidden="true"></div>

  <MessageChat
    v-for="entry in liste.visibleMessages"
    :key="entry.idx"
    v-memo="[
      entry.msg,
      entry.suite,
      entry.msg.thinkingOpen,
      entry.msg._segsOpen,
      entry.msg._activeToolStep,
      entry.msg._pipelineOpen,
      entry.msg._compactOpen,
      entry.msg.webScreenshotIdx,
      entry.msg.webScreenshotExpanded,
      liste.effectUiRev,
      liste.diffCardRev,
      entry.idx === liste.lastAssistantIdx,
      entry.idx === liste.editingMessageIndex,
      liste.isStreaming,
      liste.messageSearchActive && liste.messageSearchQ,
      !!liste.compressionStatus,
      pref.deroule,
      pref.reflexions,
      pref.metriques,
      pref.captures,
      liste.settings.assistant_name,
      liste.settings.skin,
      liste.settings.enable_editor,
      liste.logoApp,
      liste.user && liste.user.avatar,
      liste.user && liste.user.username,
    ]"
    :entry="entry"
    @zoom-image="(u: string) => emit('zoom-image', u)"
    @edition="(t: string) => emit('edition', t)"
  ></MessageChat>

  <div v-if="liste.vsBotPad > 0" :style="{ height: liste.vsBotPad + 'px' }" aria-hidden="true"></div>

  <div
    v-if="
      liste.isThinking && !liste.compressionStatus && liste.statusText && liste.statusText.includes('econnex')
    "
    role="status"
    aria-live="polite"
    class="flex items-center gap-2 opacity-70"
  >
    <i class="ph ph-spinner-gap animate-spin text-slate-400" style="font-size: 11px"></i>
    <span class="text-[11px] text-slate-400 font-medium">{{
      liste.statusText || "Génération en cours..."
    }}</span>
  </div>

  <transition name="fade">
    <div
      v-if="liste.compactionNotice && liste.compactionNotice.chatId === liste.currentChatId"
      role="status"
      aria-live="polite"
      class="flex gap-4 elpis-msg-assistant"
    >
      <div class="shrink-0 mt-0.5">
        <img
          :src="liste.logoApp"
          alt=""
          data-avatar-assistant
          class="w-9 h-9 rounded-full object-cover shadow-sm border border-slate-200"
        />
      </div>
      <div class="flex-1 min-w-0">
        <div class="flex items-baseline justify-between mb-1.5">
          <span class="font-bold text-[15px] text-slate-800">{{
            liste.skinCourant.brand ? liste.nomMarque : liste.settings.assistant_name || "Assistant"
          }}</span>
        </div>
        <div class="text-[13.5px] leading-6 text-slate-500">
          <template v-if="liste.compactionNotice.state === 'running'">
            <i class="ph ph-arrows-in-simple mr-1 align-[-2px] text-slate-400"></i>
            <span class="font-medium text-slate-600">Compaction en cours…</span>
            <span class="font-mono tabular-nums text-slate-600 ml-1.5"
              >{{ liste.compactionNotice.pct || 0 }} %</span
            >
            <div class="mt-1.5 h-1 w-56 max-w-full bg-slate-200 rounded-full overflow-hidden">
              <div
                class="h-full bg-blue-500 rounded-full"
                :style="{ width: (liste.compactionNotice.pct || 0) + '%' }"
              ></div>
            </div>
          </template>
          <template v-else>
            <i class="ph ph-prohibit mr-1 align-[-2px] text-amber-500"></i>
            <span class="font-medium text-amber-600">Compaction non appliquée.</span>
            <span> {{ liste.compactionNotice.reason }}</span>
          </template>
        </div>
      </div>
    </div>
  </transition>
</template>
