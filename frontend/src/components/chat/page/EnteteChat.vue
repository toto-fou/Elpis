<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/page/EnteteChat.vue — en-tête flottant du chat : titre éditable, mode plan, réglages de génération, menu de la conversation. -->
<script setup lang="ts">
import { CLE_ENTETE, domaine } from "../../../features/chat/page/domaines";

const ent = domaine(CLE_ENTETE);
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

        <span
          v-if="ent.planMode"
          data-plan-badge
          title="Mode plan : outils d'écriture retirés jusqu'à la réponse. Se coupe seul une fois le plan rendu ; /plan pour le couper à la main."
          class="flex items-center gap-1 px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 text-[10px] font-medium shrink-0"
        >
          <i class="ph ph-binoculars" aria-hidden="true"></i> Mode plan
        </span>
      </div>

      <div class="flex gap-1 items-center pointer-events-auto">
        <div v-if="ent.settings.enable_model_selector" class="flex items-center gap-2">
          <button
            v-if="ent.selectedModel"
            :class="
              ent.showSamplingPanel
                ? 'text-blue-600 bg-blue-50'
                : 'text-slate-400 hover:text-slate-600 hover:bg-slate-100'
            "
            class="flex items-center justify-center w-8 h-8 rounded-md transition-colors"
            aria-label="Réglages de génération"
            :aria-pressed="ent.showSamplingPanel ? 'true' : 'false'"
            :title="
              ent.selectedConnector || !ent.activeModelIds.includes(ent.selectedModel)
                ? 'Réglages de génération — valeurs du modèle indisponibles, vos réglages s\'appliquent quand même'
                : 'Réglages de génération'
            "
            @click="ent.togglePanel('sampling')"
          >
            <i class="ph ph-sliders-horizontal text-sm"></i>
          </button>
        </div>

        <div class="relative" @click.stop>
          <button
            title="Menu de la conversation"
            aria-label="Menu de la conversation"
            :aria-expanded="ent.showChatMenu ? 'true' : 'false'"
            class="w-8 h-8 flex items-center justify-center rounded-md transition-colors"
            :class="
              ent.showChatMenu
                ? 'text-blue-600 bg-blue-50'
                : 'text-slate-400 hover:text-slate-600 hover:bg-slate-100'
            "
            @click="ent.showChatMenu = !ent.showChatMenu"
          >
            <i class="ph ph-dots-three-outline-vertical text-lg"></i>
          </button>
          <div
            v-if="ent.showChatMenu"
            class="fixed inset-0 z-40"
            @click="
              ent.showChatMenu = false;
              ent.showExportFormatMenu = false;
            "
          ></div>
          <Transition name="popover">
            <div
              v-if="ent.showChatMenu"
              class="absolute right-0 top-full mt-1.5 w-48 bg-white border border-slate-200 rounded-xl shadow-xl z-50 p-1.5 space-y-0.5"
            >
              <div class="relative" @click.stop>
                <button
                  class="w-full text-left px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100 rounded-lg flex items-center gap-2.5 transition-colors"
                  @click="ent.showExportFormatMenu = !ent.showExportFormatMenu"
                >
                  <i class="ph ph-export text-slate-400"></i> Exporter
                  <i class="ph ph-caret-right text-[10px] text-slate-400 ml-auto"></i>
                </button>
                <Transition name="popover">
                  <div
                    v-if="ent.showExportFormatMenu"
                    class="absolute right-full top-0 mr-1 w-40 bg-white border border-slate-200 rounded-xl shadow-xl z-50 p-1.5 space-y-0.5"
                  >
                    <button
                      class="w-full text-left px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100 rounded-lg flex items-center gap-2.5 transition-colors"
                      @click="
                        ent.exportChatAs('json');
                        ent.showChatMenu = false;
                      "
                    >
                      <i class="ph ph-brackets-curly text-slate-400" aria-hidden="true"></i> JSON
                    </button>
                    <button
                      class="w-full text-left px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100 rounded-lg flex items-center gap-2.5 transition-colors"
                      @click="
                        ent.exportChatAs('md');
                        ent.showChatMenu = false;
                      "
                    >
                      <i class="ph ph-markdown-logo text-slate-400" aria-hidden="true"></i> Markdown
                    </button>
                    <button
                      class="w-full text-left px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100 rounded-lg flex items-center gap-2.5 transition-colors"
                      @click="
                        ent.exportChatAs('txt');
                        ent.showChatMenu = false;
                      "
                    >
                      <i class="ph ph-file-text text-slate-400" aria-hidden="true"></i> Texte brut
                    </button>
                    <button
                      class="w-full text-left px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100 rounded-lg flex items-center gap-2.5 transition-colors"
                      @click="
                        ent.exportChatAs('pdf');
                        ent.showChatMenu = false;
                      "
                    >
                      <i class="ph ph-file-pdf text-slate-400" aria-hidden="true"></i> PDF
                    </button>
                  </div>
                </Transition>
              </div>
              <button
                class="w-full text-left px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100 rounded-lg flex items-center gap-2.5 transition-colors"
                :class="ent.messageSearchActive ? 'bg-blue-50 text-blue-700' : ''"
                @click="
                  ent.messageSearchActive = !ent.messageSearchActive;
                  if (!ent.messageSearchActive) ent.messageSearch = '';
                  ent.showChatMenu = false;
                "
              >
                <i
                  class="ph ph-magnifying-glass"
                  :class="ent.messageSearchActive ? 'text-blue-500' : 'text-slate-400'"
                ></i>
                Rechercher
              </button>
              <button
                v-if="ent.features.opencode"
                class="w-full text-left px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100 rounded-lg flex items-center gap-2.5 transition-colors"
                @click="
                  ent.showOpenCodeModal = true;
                  ent.showChatMenu = false;
                "
              >
                <i class="ph ph-terminal text-slate-400" aria-hidden="true"></i> OpenCode
              </button>
              <div class="h-px bg-slate-100 my-1"></div>
              <button
                class="w-full text-left px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100 rounded-lg flex items-center gap-2.5 transition-colors"
                @click="
                  ent.openHelp();
                  ent.showChatMenu = false;
                "
              >
                <i class="ph ph-question text-slate-400"></i> Aide
              </button>
              <button
                class="w-full text-left px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100 rounded-lg flex items-center gap-2.5 transition-colors"
                @click="
                  ent.showInfoModal = true;
                  ent.showChatMenu = false;
                "
              >
                <i class="ph ph-info text-slate-400"></i> Informations
              </button>
            </div>
          </Transition>
        </div>
      </div>
    </div>
  </header>
</template>
