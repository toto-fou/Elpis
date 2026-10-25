<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/page/MenuPlus.vue — menu « + » du composeur (interface classique) : joindre, images, partages reçus. -->
<script setup lang="ts">
import { useTemplateRef } from "vue";

import { CLE_COMPOSEUR, domaine } from "../../../features/chat/page/domaines";
import { publierElement } from "../../../features/chat/page/element";
import PartagesRecus from "./PartagesRecus.vue";

const emit = defineEmits<{ ancre: [el: HTMLDivElement | null] }>();
const comp = domaine(CLE_COMPOSEUR);
publierElement(useTemplateRef<HTMLDivElement>("ancre"), (el) => emit("ancre", el));
</script>

<template>
  <div ref="ancre" class="relative group flex items-center">
    <button
      class="w-8 h-8 flex items-center justify-center text-slate-400 hover:text-blue-600 hover:bg-slate-100 rounded-lg transition-colors relative"
      :class="comp.inboxCount > 0 || comp.showComposerPlus ? 'text-blue-600' : ''"
      title="Plus d'actions"
      aria-label="Plus d'actions"
      aria-haspopup="menu"
      :aria-expanded="comp.showComposerPlus || comp.showSharedPrompts ? 'true' : 'false'"
      @click.prevent="
        comp.showComposerPlus = !comp.showComposerPlus;
        if (comp.showComposerPlus) comp.refreshInboxCount();
      "
    >
      <i class="ph ph-plus text-lg"></i>
      <span
        v-if="comp.inboxCount > 0 && !comp.showComposerPlus"
        class="absolute -top-1 -right-1 min-w-[16px] h-4 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center px-1 leading-none shadow-sm"
        >{{ comp.inboxCount > 99 ? "99+" : comp.inboxCount }}</span
      >
    </button>

    <Transition name="popover-up">
      <div
        v-if="comp.showComposerPlus && !comp.showSharedPrompts"
        class="absolute bottom-full left-0 mb-2 w-60 bg-white border border-slate-200 rounded-xl shadow-xl z-50 p-1.5 space-y-0.5"
      >
        <button
          class="w-full text-left px-3 py-2 text-sm text-slate-700 hover:bg-slate-100 rounded-lg flex items-center gap-2.5 transition-colors"
          @click.stop="
            comp.showComposerPlus = false;
            comp.triggerFileUpload();
          "
        >
          <i class="ph ph-paperclip text-slate-400 text-base"></i>
          <span class="flex-1">Joindre un fichier</span>
        </button>
        <button
          v-if="comp.imageAvailable"
          data-image-entry
          :aria-pressed="comp.imageMode ? 'true' : 'false'"
          title="Alt+I"
          class="w-full text-left px-3 py-2 text-sm rounded-lg flex items-center gap-2.5 transition-colors hover:bg-slate-100"
          :class="comp.imageMode ? 'bg-blue-50 text-blue-800' : 'text-slate-700'"
          @click.stop="
            comp.showComposerPlus = false;
            comp.toggleImageMode();
          "
        >
          <i
            class="ph ph-image text-base"
            :class="comp.imageMode ? 'text-blue-600' : 'text-slate-400'"
            aria-hidden="true"
          ></i>
          <span class="flex-1">Images</span>
          <span v-if="comp.imageMode" class="text-[10px] font-mono opacity-80">on</span>
        </button>
        <div class="h-px bg-slate-100 my-1"></div>

        <button
          class="w-full text-left px-3 py-2 text-sm text-slate-700 hover:bg-slate-100 rounded-lg flex items-center gap-2.5 transition-colors"
          @click.stop="
            comp.showComposerPlus = false;
            comp.showSharedPrompts = true;
            comp.loadSharedPrompts();
            comp.refreshInboxCount();
          "
        >
          <i class="ph ph-tray text-slate-400 text-base"></i>
          <span class="flex-1">Partages reçus</span>
          <span
            v-if="comp.inboxCount > 0"
            class="ml-auto bg-red-500 text-white text-[10px] font-bold rounded-full px-1.5 leading-[14px] min-w-[16px] text-center"
            >{{ comp.inboxCount > 99 ? "99+" : comp.inboxCount }}</span
          >
        </button>
      </div>
    </Transition>

    <PartagesRecus />
  </div>
</template>
