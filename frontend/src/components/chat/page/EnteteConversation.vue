<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/page/EnteteConversation.vue — en-tête flottant du chat : titre (double-clic pour le modifier) et menu « Conversation » ; mode plan et réglages vivent dans le composeur. -->
<script setup lang="ts">
import { nextTick, useTemplateRef } from "vue";

import { executerConversation } from "../../../features/chat/page/conversation";
import type { ActionConversation } from "../../../features/chat/page/conversation";
import { CLE_ENTETE, domaine } from "../../../features/chat/page/domaines";
import { focusPremiere, naviguerMenu } from "../../../features/chat/page/menu-clavier";
import MenuConversation from "./MenuConversation.vue";

const ent = domaine(CLE_ENTETE);
const bouton = useTemplateRef<HTMLButtonElement>("bouton");
const menu = useTemplateRef<HTMLDivElement>("menu");

function basculer(): void {
  ent.showChatMenu = !ent.showChatMenu;
  if (ent.showChatMenu) void nextTick(() => focusPremiere(menu.value));
}

function fermer(rendreFocus: boolean): void {
  ent.showChatMenu = false;
  if (rendreFocus) void nextTick(() => bouton.value?.focus());
}

async function agir(action: ActionConversation): Promise<void> {
  fermer(true);
  const id = ent.currentChatId;
  if (id) await executerConversation(action, { id, title: ent.currentChatTitle }, ent);
}

function surTouche(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    e.stopPropagation();
    fermer(true);
  } else if (e.key === "F2") {
    e.preventDefault();
    void agir("renommer");
  } else if (menu.value) naviguerMenu(e, menu.value);
}
</script>

<template>
  <header class="absolute top-0 left-0 right-0 z-20 pointer-events-none">
    <div class="elpis-chat-topfade absolute inset-x-0 top-0 h-20"></div>
    <div class="relative flex items-start justify-between gap-3 px-3 md:px-4 pt-3">
      <div class="flex items-center gap-2 min-w-0 pointer-events-auto">
        <button
          type="button"
          :title="ent.showSidebar ? 'Fermer le volet' : 'Ouvrir le volet'"
          :aria-label="ent.showSidebar ? 'Fermer le volet' : 'Ouvrir le volet'"
          :aria-expanded="ent.showSidebar ? 'true' : 'false'"
          class="lg:hidden w-8 h-8 flex items-center justify-center text-slate-500 hover:bg-slate-100 rounded-md transition-colors"
          @click="ent.showSidebar = !ent.showSidebar"
        >
          <i class="ph ph-list text-lg" aria-hidden="true"></i>
        </button>

        <input
          v-if="ent.editingChatTitle"
          id="chat-title-edit-input"
          v-model="ent.chatTitleDraft"
          class="font-semibold text-base text-slate-800 bg-blue-50 border border-blue-300 rounded-md px-2 py-0.5 outline-none focus:ring-1 focus:ring-blue-500 max-w-[150px] md:max-w-[300px]"
          maxlength="200"
          placeholder="Titre de la conversation"
          @keydown.enter.prevent="ent.commitChatTitleEdit"
          @keydown.escape.prevent="ent.cancelChatTitleEdit"
          @blur="ent.commitChatTitleEdit"
        />
        <span
          v-else
          :title="ent.currentChatId ? 'Double-cliquer pour renommer' : ''"
          class="text-sm font-medium text-slate-500 truncate max-w-[160px] md:max-w-[340px]"
          :class="[
            ent.currentChatId
              ? 'cursor-text hover:text-slate-700 hover:bg-slate-100/70 rounded-md px-1.5 py-0.5 -mx-1.5 transition-colors'
              : '',
            ent.titleFlash ? 'elpis-title-flash' : '',
          ]"
          @dblclick="ent.startChatTitleEdit"
          >{{ ent.currentChatTitle }}</span
        >
      </div>

      <div v-if="ent.currentChatId" class="flex gap-1 items-center pointer-events-auto">
        <div class="relative" @click.stop>
          <button
            ref="bouton"
            type="button"
            title="Conversation"
            aria-label="Conversation"
            aria-haspopup="menu"
            :aria-expanded="ent.showChatMenu ? 'true' : 'false'"
            class="w-8 h-8 flex items-center justify-center rounded-md transition-colors"
            :class="
              ent.showChatMenu
                ? 'text-blue-600 bg-blue-50'
                : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100'
            "
            data-menu-conversation
            @click="basculer"
          >
            <i class="ph ph-dots-three-outline-vertical text-lg" aria-hidden="true"></i>
          </button>
          <div v-if="ent.showChatMenu" class="fixed inset-0 z-40" @click="fermer(false)"></div>
          <Transition name="popover">
            <div
              v-if="ent.showChatMenu"
              ref="menu"
              role="menu"
              aria-label="Conversation"
              class="absolute right-0 top-full mt-1.5 w-56 bg-white border border-slate-200 rounded-xl shadow-xl z-50 p-1.5 space-y-0.5"
              @keydown="surTouche"
            >
              <MenuConversation @action="agir" />
            </div>
          </Transition>
        </div>
      </div>
    </div>
  </header>
</template>
