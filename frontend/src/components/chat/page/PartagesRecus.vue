<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/page/PartagesRecus.vue — volet « Partages reçus » ouvert depuis le « + » du composeur : prompts reçus, sélection, suppression. -->
<script setup lang="ts">
import { CLE_COMPOSEUR, domaine } from "../../../features/chat/page/domaines";

const comp = domaine(CLE_COMPOSEUR);
</script>

<template>
  <Transition name="popover-up">
    <div
      v-if="comp.showSharedPrompts"
      class="absolute bottom-full left-0 mb-3 w-72 bg-white border border-slate-200 rounded-xl shadow-2xl z-50 max-h-64 overflow-hidden flex flex-col"
    >
      <div
        class="p-2.5 border-b border-slate-100 font-bold text-slate-700 bg-slate-50 flex justify-between items-center z-10 shrink-0 text-xs"
      >
        <span>Partages reçus</span>
        <div class="flex items-center gap-1">
          <button
            v-if="comp.sharedPromptsList.length > 0"
            class="text-[10px] font-bold px-1.5 py-0.5 rounded transition-colors"
            :class="comp.sharedSelectMode ? 'text-white bg-blue-600' : 'text-blue-600 bg-blue-50'"
            :title="comp.sharedSelectMode ? 'Terminer la sélection' : 'Sélectionner'"
            :aria-label="comp.sharedSelectMode ? 'Terminer la sélection' : 'Sélectionner'"
            @click.stop="
              comp.sharedSelectMode = !comp.sharedSelectMode;
              comp.sharedSelected = [];
            "
          >
            <i class="ph" :class="comp.sharedSelectMode ? 'ph-x' : 'ph-check-square'" aria-hidden="true"></i>
          </button>
          <button
            v-if="comp.sharedSelectMode && comp.sharedSelected.length > 0"
            class="text-[10px] font-bold text-red-500 bg-red-50 px-1.5 py-0.5 rounded"
            title="Supprimer la sélection"
            :aria-label="`Supprimer ${comp.sharedSelected.length} partage(s)`"
            @click.stop="comp.deleteSelectedSharedPrompts"
          >
            <i class="ph ph-trash"></i> {{ comp.sharedSelected.length }}
          </button>
          <button
            v-if="comp.sharedPromptsList.length > 0 && !comp.sharedSelectMode"
            class="text-[10px] font-bold text-red-500 hover:underline px-1.5 py-0.5 rounded bg-red-50"
            @click.stop="comp.clearAllSharedPrompts"
          >
            Vider
          </button>
          <button
            title="Fermer"
            aria-label="Fermer"
            class="text-slate-400 hover:text-slate-800 p-0.5 rounded hover:bg-slate-200"
            @click.stop="comp.showSharedPrompts = false"
          >
            <i class="ph ph-x" aria-hidden="true"></i>
          </button>
        </div>
      </div>
      <div class="overflow-y-auto flex-1 p-1.5 custom-scrollbar">
        <div
          v-if="comp.sharedPromptsList.length === 0"
          class="p-6 text-center text-slate-400 text-xs font-medium"
        >
          Aucun prompt reçu
        </div>
        <div
          v-for="sp in comp.sharedPromptsList"
          :key="sp.id"
          class="p-2.5 mb-1 rounded-lg cursor-pointer transition-colors text-left group relative border"
          :class="
            comp.sharedSelected.includes(sp.id)
              ? 'border-blue-300 bg-blue-50'
              : 'border-transparent hover:bg-blue-50 hover:border-blue-100'
          "
          @click="comp.sharedSelectMode ? comp.toggleSharedSelect(sp.id) : comp.useSharedPrompt(sp.content)"
        >
          <div class="flex items-start gap-2">
            <div v-if="comp.sharedSelectMode" class="shrink-0 mt-0.5">
              <div
                class="w-4 h-4 rounded border flex items-center justify-center transition-colors"
                :class="
                  comp.sharedSelected.includes(sp.id) ? 'bg-blue-600 border-blue-600' : 'border-slate-300'
                "
              >
                <i v-if="comp.sharedSelected.includes(sp.id)" class="ph ph-check text-white text-[9px]"></i>
              </div>
            </div>
            <div class="flex-1 min-w-0">
              <div class="flex justify-between items-start">
                <div class="font-bold text-xs text-slate-800 pr-5">{{ sp.title }}</div>
                <button
                  v-if="!comp.sharedSelectMode"
                  title="Supprimer"
                  :aria-label="`Supprimer ${sp.title}`"
                  class="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 absolute right-2 top-2 text-red-400 hover:text-red-600"
                  @click.stop="comp.deleteSharedPrompt(sp.id, $event, sp.title)"
                >
                  <i class="ph ph-trash text-sm"></i>
                </button>
              </div>
              <div class="text-[10px] text-blue-600 mt-1 font-bold flex items-center gap-1">
                <i class="ph ph-user"></i> {{ sp.from_username }}
              </div>
              <div
                class="text-[10px] text-slate-500 font-mono truncate mt-1 bg-white px-1.5 py-0.5 rounded border border-slate-100"
              >
                {{ sp.content }}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>
