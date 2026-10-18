<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/page/MenuPlus.vue — menu « + » du composeur : joindre, images, sources RAG, partages reçus. -->
<script setup lang="ts">
import { useTemplateRef } from "vue";

import { CLE_COMPOSEUR, domaine } from "../../../features/chat/page/domaines";
import { publierElement } from "../../../features/chat/page/element";

const emit = defineEmits<{ ancre: [el: HTMLDivElement | null]; rag: [el: HTMLDivElement | null] }>();
const comp = domaine(CLE_COMPOSEUR);
publierElement(useTemplateRef<HTMLDivElement>("ancre"), (el) => emit("ancre", el));
publierElement(useTemplateRef<HTMLDivElement>("rag"), (el) => emit("rag", el));
</script>

<template>
  <div ref="ancre" class="relative group flex items-center">
    <button
      class="w-8 h-8 flex items-center justify-center text-slate-400 hover:text-blue-600 hover:bg-slate-100 rounded-lg transition-colors relative"
      :class="comp.inboxCount > 0 || comp.showComposerPlus ? 'text-blue-600' : ''"
      title="Plus d'actions"
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
        v-if="comp.showComposerPlus && !comp.showSharedPrompts && !comp.showRagPanel"
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
          v-if="comp.settings.enable_rag"
          class="w-full text-left px-3 py-2 text-sm rounded-lg flex items-center gap-2.5 transition-colors"
          :class="
            comp.config.use_rag
              ? 'bg-blue-50 text-blue-800 hover:bg-blue-100'
              : 'text-slate-700 hover:bg-slate-100'
          "
          @click.stop="
            comp.showComposerPlus = false;
            comp.showRagPanel = true;
          "
        >
          <i
            class="ph ph-books text-base"
            :class="comp.config.use_rag ? 'text-blue-600' : 'text-slate-400'"
          ></i>
          <span class="flex-1">Sources RAG</span>
          <span v-if="comp.config.use_rag" class="text-[10px] font-mono opacity-80">on</span>
        </button>

        <div v-if="comp.settings.enable_rag" class="h-px bg-slate-100 my-1"></div>

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

    <Transition name="popover-up">
      <div
        v-if="comp.showRagPanel"
        ref="rag"
        class="absolute bottom-full left-0 mb-2 w-72 bg-white border border-slate-200 rounded-xl shadow-2xl z-[100] p-4"
      >
        <div class="flex items-center justify-between mb-4">
          <span class="text-sm font-bold text-slate-800 flex items-center gap-2">
            <i class="ph ph-database text-blue-600"></i> Mode RAG
          </span>
          <div class="flex items-center gap-1">
            <div
              class="relative inline-flex items-center cursor-pointer mr-1"
              @click="comp.config.use_rag = !comp.config.use_rag"
            >
              <input v-model="comp.config.use_rag" type="checkbox" class="sr-only peer" />
              <div
                class="w-9 h-5 bg-slate-200 border border-slate-300 rounded-full peer peer-checked:bg-blue-600 peer-checked:border-blue-600 transition-colors after:content-[''] after:absolute after:top-[1px] after:left-[1px] after:bg-white after:border after:border-slate-300 after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full peer-checked:after:border-white"
              ></div>
            </div>
            <button
              class="text-slate-400 hover:text-slate-800 p-0.5 rounded hover:bg-slate-100"
              @click.stop="comp.showRagPanel = false"
            >
              <i class="ph ph-x text-sm"></i>
            </button>
          </div>
        </div>

        <div
          class="space-y-3.5 transition-opacity"
          :class="comp.config.use_rag ? 'opacity-100' : 'opacity-50 pointer-events-none'"
        >
          <div>
            <label class="block text-xs font-semibold text-slate-600 mb-1.5">Collection</label>
            <select
              v-model="comp.config.rag_collection"
              class="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 text-xs font-semibold text-slate-700 focus:ring-1 focus:ring-blue-500 outline-none transition-colors cursor-pointer"
            >
              <option value="">Défaut</option>
              <option v-for="c in comp.ragCollections" :key="c" :value="c">{{ c }}</option>
            </select>
          </div>

          <div>
            <label class="block text-xs font-semibold text-slate-600 mb-1.5">Mode de recherche</label>
            <div class="grid grid-cols-3 gap-1 bg-slate-100 rounded-lg p-0.5">
              <button
                v-for="m in [
                  { v: 'classic', l: 'Vectoriel' },
                  { v: 'hybrid', l: 'Hybride' },
                  { v: 'bm25', l: 'BM25' },
                ]"
                :key="m.v"
                :class="
                  comp.config.rag_search_mode === m.v
                    ? 'bg-white text-blue-700 shadow-sm font-bold'
                    : 'text-slate-500 hover:text-slate-700'
                "
                class="px-1 py-1.5 text-[10px] rounded-md transition-all text-center leading-tight"
                @click="comp.config.rag_search_mode = m.v"
              >
                {{ m.l }}
              </button>
            </div>
            <p class="text-[10px] text-slate-400 mt-1 leading-snug">
              <span v-if="comp.config.rag_search_mode === 'hybrid'">Vecteurs + BM25 fusionnés (RRF)</span>
              <span v-else-if="comp.config.rag_search_mode === 'bm25'">Mots-clés uniquement</span>
              <span v-else>Similarité vectorielle pure</span>
            </p>
          </div>

          <div>
            <label class="flex items-center justify-between text-xs font-semibold text-slate-600 mb-1.5">
              <span>Résultats (top-K)</span>
              <span class="text-blue-700 font-mono normal-case text-[11px]">{{
                comp.config.rag_top_k || 8
              }}</span>
            </label>
            <input
              type="range"
              min="2"
              max="20"
              step="1"
              :value="comp.config.rag_top_k || 8"
              class="w-full h-1.5 bg-slate-200 rounded-full appearance-none cursor-pointer accent-blue-600"
              @input="comp.config.rag_top_k = +($event.target as HTMLInputElement).value"
            />
            <div class="flex justify-between text-[10px] text-slate-400 mt-0.5">
              <span>2</span><span>20</span>
            </div>
          </div>

          <div class="flex items-center justify-between pt-0.5 border-t border-slate-100">
            <div>
              <span class="text-xs font-semibold text-slate-700">Déduplication MMR</span>
              <p class="text-[10px] text-slate-400 leading-snug">Filtre les chunks similaires</p>
            </div>
            <label class="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                class="sr-only peer"
                :checked="comp.config.rag_use_mmr !== false"
                aria-label="Déduplication MMR"
                @change="comp.config.rag_use_mmr = ($event.target as HTMLInputElement).checked"
              />
              <div
                class="w-9 h-5 rounded-full transition-colors bg-slate-200 border border-slate-300 peer-checked:bg-blue-600 peer-checked:border-blue-600 peer-focus-visible:ring-2 peer-focus-visible:ring-blue-500 peer-focus-visible:ring-offset-1 after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all after:shadow-sm peer-checked:after:translate-x-full"
              ></div>
            </label>
          </div>
        </div>
      </div>
    </Transition>

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
              @click.stop="
                comp.sharedSelectMode = !comp.sharedSelectMode;
                comp.sharedSelected = [];
              "
            >
              <i class="ph" :class="comp.sharedSelectMode ? 'ph-x' : 'ph-check-square'"></i>
            </button>
            <button
              v-if="comp.sharedSelectMode && comp.sharedSelected.length > 0"
              class="text-[10px] font-bold text-red-500 bg-red-50 px-1.5 py-0.5 rounded"
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
              class="text-slate-400 hover:text-slate-800 p-0.5 rounded hover:bg-slate-200"
              @click.stop="comp.showSharedPrompts = false"
            >
              <i class="ph ph-x"></i>
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
  </div>
</template>
