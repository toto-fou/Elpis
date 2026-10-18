<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/editor/MenuCode.vue — menu contextuel du code : complétion et actions IA, édition, navigation, chat. -->
<script setup lang="ts">
import { domaineEditeur } from "../../features/editor/domaine";

const ed = domaineEditeur();
</script>

<template>
  <template v-if="ed.editorCtxMenu.show">
    <div
      class="fixed inset-0 z-[499]"
      @mousedown.prevent
      @click="ed.closeEditorCtxMenu()"
      @contextmenu.prevent="ed.closeEditorCtxMenu()"
    ></div>

    <div
      class="fixed z-[500] w-64 bg-[#1e1e1e] border border-white/[0.08] rounded-xl shadow-2xl overflow-hidden select-none"
      :style="{ top: ed.editorCtxMenu.y + 'px', left: ed.editorCtxMenu.x + 'px' }"
      @mousedown.stop.prevent
      @click.stop
    >
      <div class="px-3 py-2 bg-[#252526] border-b border-white/[0.06] flex items-center gap-2">
        <i
          class="ph text-sm"
          :class="
            ed.editorCtxMenu.hasSelection ? 'ph-text-select text-blue-400' : 'ph-cursor-text text-slate-500'
          "
        ></i>
        <span class="text-[11px] text-slate-400 font-medium truncate">
          {{
            ed.editorCtxMenu.hasSelection
              ? ed.editorCtxMenu.lineCount +
                " ligne" +
                (ed.editorCtxMenu.lineCount > 1 ? "s" : "") +
                " sélectionnée" +
                (ed.editorCtxMenu.lineCount > 1 ? "s" : "")
              : "Position curseur"
          }}
        </span>
      </div>

      <div class="py-1 border-b border-white/[0.06]">
        <p class="px-3 pt-1.5 pb-0.5 text-xs text-slate-500 font-semibold">Actions IA</p>
        <button
          :disabled="ed.fimLoading"
          class="w-full text-left px-3 py-1.5 flex items-center gap-2.5 hover:bg-white/[0.06] transition-colors cursor-pointer disabled:opacity-40"
          @mousedown.stop.prevent="ed.editorCtxComplete()"
        >
          <i
            class="ph text-base"
            :class="ed.fimLoading ? 'ph-spinner-gap animate-spin text-slate-400' : 'ph-brain text-slate-400'"
          ></i>
          <span class="text-[13px] text-slate-200">{{
            ed.fimLoading ? "En cours..." : "Compléter ici"
          }}</span>
          <kbd class="ml-auto text-[9px] bg-white/[0.07] px-1.5 py-0.5 rounded font-mono text-slate-500"
            >Alt+\</kbd
          >
        </button>
        <template v-if="ed.editorCtxMenu.hasSelection">
          <button
            class="w-full text-left px-3 py-1.5 flex items-center gap-2.5 hover:bg-white/[0.06] transition-colors cursor-pointer"
            @mousedown.stop.prevent="ed.editorCtxRunAI('explain')"
          >
            <i class="ph ph-question text-blue-400 text-base shrink-0"></i>
            <span class="text-[13px] text-slate-300">Expliquer ce code</span>
          </button>
          <button
            class="w-full text-left px-3 py-1.5 flex items-center gap-2.5 hover:bg-white/[0.06] transition-colors cursor-pointer"
            @mousedown.stop.prevent="ed.editorCtxRunAI('comment')"
          >
            <i class="ph ph-chat-dots text-sky-400 text-base shrink-0"></i>
            <span class="text-[13px] text-slate-300">Commenter (IA)</span>
          </button>
          <button
            class="w-full text-left px-3 py-1.5 flex items-center gap-2.5 hover:bg-white/[0.06] transition-colors cursor-pointer"
            @mousedown.stop.prevent="ed.editorCtxRunAI('refactor')"
          >
            <i class="ph ph-arrows-clockwise text-slate-400 text-base shrink-0"></i>
            <span class="text-[13px] text-slate-300">Refactoriser</span>
          </button>
          <button
            class="w-full text-left px-3 py-1.5 flex items-center gap-2.5 hover:bg-white/[0.06] transition-colors cursor-pointer"
            @mousedown.stop.prevent="ed.editorCtxRunAI('bugs')"
          >
            <i class="ph ph-bug text-red-400 text-base shrink-0"></i>
            <span class="text-[13px] text-slate-300">Chercher des bugs</span>
          </button>
          <button
            class="w-full text-left px-3 py-1.5 flex items-center gap-2.5 hover:bg-white/[0.06] transition-colors cursor-pointer"
            @mousedown.stop.prevent="ed.editorCtxRunAI('optimize')"
          >
            <i class="ph ph-lightning text-yellow-400 text-base shrink-0"></i>
            <span class="text-[13px] text-slate-300">Optimiser</span>
          </button>
          <button
            class="w-full text-left px-3 py-1.5 flex items-center gap-2.5 hover:bg-white/[0.06] transition-colors cursor-pointer"
            @mousedown.stop.prevent="ed.editorCtxRunAI('docstring')"
          >
            <i class="ph ph-note-pencil text-green-400 text-base shrink-0"></i>
            <span class="text-[13px] text-slate-300">Ajouter docstring</span>
          </button>
          <button
            class="w-full text-left px-3 py-1.5 flex items-center gap-2.5 hover:bg-white/[0.06] transition-colors cursor-pointer"
            @mousedown.stop.prevent="ed.editorCtxRunAI('tests')"
          >
            <i class="ph ph-test-tube text-slate-400 text-base shrink-0"></i>
            <span class="text-[13px] text-slate-300">Générer des tests</span>
          </button>
        </template>
      </div>

      <div class="py-1 border-b border-white/[0.06]">
        <button
          v-if="ed.editorCtxMenu.hasSelection"
          class="w-full text-left px-3 py-1.5 flex items-center gap-2.5 hover:bg-white/[0.06] transition-colors cursor-pointer"
          @mousedown.stop.prevent="ed.askChatAboutSelection()"
        >
          <i class="ph ph-chat-circle-text text-blue-400 text-base shrink-0"></i>
          <span class="text-[13px] text-slate-200">Demander au chat</span>
        </button>
        <button
          v-if="ed.canRunActive()"
          class="w-full text-left px-3 py-1.5 flex items-center gap-2.5 hover:bg-white/[0.06] transition-colors cursor-pointer"
          @mousedown.stop.prevent="ed.runActiveFile()"
        >
          <i class="ph ph-play text-emerald-400 text-base shrink-0"></i>
          <span class="text-[13px] text-slate-300">Exécuter le fichier</span>
        </button>
      </div>

      <div class="py-1 border-b border-white/[0.06]">
        <p class="px-3 pt-1.5 pb-0.5 text-xs text-slate-500 font-semibold">Édition</p>
        <button
          class="w-full text-left px-3 py-1.5 flex items-center gap-2.5 hover:bg-white/[0.06] transition-colors cursor-pointer"
          @mousedown.stop.prevent="ed.editorCtxToggleComment()"
        >
          <i class="ph ph-hash text-slate-400 text-base shrink-0"></i>
          <span class="text-[13px] text-slate-300">Commenter / Décommenter</span>
          <kbd class="ml-auto text-[9px] bg-white/[0.07] px-1.5 py-0.5 rounded font-mono text-slate-500"
            >Ctrl+/</kbd
          >
        </button>
        <button
          class="w-full text-left px-3 py-1.5 flex items-center gap-2.5 hover:bg-white/[0.06] transition-colors cursor-pointer"
          @mousedown.stop.prevent="ed.editorCtxFormatDoc()"
        >
          <i class="ph ph-magic-wand text-slate-400 text-base shrink-0"></i>
          <span class="text-[13px] text-slate-300">Formater le document</span>
          <kbd class="ml-auto text-[9px] bg-white/[0.07] px-1.5 py-0.5 rounded font-mono text-slate-500"
            >⇧Alt+F</kbd
          >
        </button>
        <button
          v-if="ed.editorCtxMenu.hasSelection"
          class="w-full text-left px-3 py-1.5 flex items-center gap-2.5 hover:bg-white/[0.06] transition-colors cursor-pointer"
          @mousedown.stop.prevent="ed.editorCtxCopy()"
        >
          <i class="ph ph-copy text-slate-400 text-base shrink-0"></i>
          <span class="text-[13px] text-slate-300">Copier la sélection</span>
          <kbd class="ml-auto text-[9px] bg-white/[0.07] px-1.5 py-0.5 rounded font-mono text-slate-500"
            >Ctrl+C</kbd
          >
        </button>
      </div>

      <div class="py-1">
        <p class="px-3 pt-1.5 pb-0.5 text-xs text-slate-500 font-semibold">Navigation</p>
        <button
          class="w-full text-left px-3 py-1.5 flex items-center gap-2.5 hover:bg-white/[0.06] transition-colors cursor-pointer"
          @mousedown.stop.prevent="ed.editorCtxGoToDef()"
        >
          <i class="ph ph-arrow-square-out text-slate-400 text-base shrink-0"></i>
          <span class="text-[13px] text-slate-300">Aller à la définition</span>
          <kbd class="ml-auto text-[9px] bg-white/[0.07] px-1.5 py-0.5 rounded font-mono text-slate-500"
            >F12</kbd
          >
        </button>
        <button
          class="w-full text-left px-3 py-1.5 flex items-center gap-2.5 hover:bg-white/[0.06] transition-colors cursor-pointer"
          @mousedown.stop.prevent="ed.editorCtxFindRefs()"
        >
          <i class="ph ph-magnifying-glass text-slate-400 text-base shrink-0"></i>
          <span class="text-[13px] text-slate-300">Trouver les références</span>
          <kbd class="ml-auto text-[9px] bg-white/[0.07] px-1.5 py-0.5 rounded font-mono text-slate-500"
            >⇧F12</kbd
          >
        </button>
        <button
          class="w-full text-left px-3 py-1.5 flex items-center gap-2.5 hover:bg-white/[0.06] transition-colors cursor-pointer"
          @mousedown.stop.prevent="ed.editorCtxRename()"
        >
          <i class="ph ph-pencil-simple text-slate-400 text-base shrink-0"></i>
          <span class="text-[13px] text-slate-300">Renommer le symbole</span>
          <kbd class="ml-auto text-[9px] bg-white/[0.07] px-1.5 py-0.5 rounded font-mono text-slate-500"
            >F2</kbd
          >
        </button>
      </div>
    </div>
  </template>
</template>
