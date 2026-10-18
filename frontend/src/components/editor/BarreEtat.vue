<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/editor/BarreEtat.vue — barre d'état de l'éditeur : branche Git, curseur, problèmes du fichier, langage, indentation, encodage et fins de ligne, état d'enregistrement. -->
<script setup lang="ts">
import { domaineEditeur } from "../../features/editor/domaine";

const ed = domaineEditeur();
</script>

<template>
  <div
    v-if="ed.activeTabPath"
    class="elpis-statusbar shrink-0 h-6 flex items-center px-3 gap-3 text-[10px] font-mono select-none whitespace-nowrap overflow-hidden"
    :class="
      ed.settings.editor_dark_mode === false
        ? 'bg-slate-50 text-slate-600 border-t border-slate-200'
        : 'bg-[#252526] text-slate-400 border-t border-white/5'
    "
  >
    <template v-if="ed.activeIsViewer">
      <span><i class="ph ph-lock-simple mr-1"></i>Lecture seule</span>
    </template>
    <template v-else>
      <button
        v-if="ed.statusBranch"
        :title="'Branche Git ' + ed.statusBranch + ' — ouvrir la vue Git'"
        class="flex items-center gap-1 hover:text-white transition-colors shrink min-w-[48px] max-w-[140px]"
        @click="
          ed.gitOpenTab();
          ed.loadGitConnectors();
        "
      >
        <i class="ph ph-git-branch shrink-0"></i><span class="truncate">{{ ed.statusBranch }}</span>
      </button>
      <span class="shrink-0" :title="'Position du curseur — ' + ed.statusLineCount + ' lignes'">
        <i class="ph ph-cursor-text mr-1"></i>Ln {{ ed.statusCursor.line }}, Col {{ ed.statusCursor.col
        }}<span v-if="ed.statusSelection" class="ml-1 text-slate-500 elpis-sb-opt"
          >({{ ed.statusSelection }})</span
        >
      </span>

      <span class="relative shrink-0">
        <button
          :disabled="!ed.activeProblems.length"
          :title="ed.activeProblems.length ? 'Problèmes du fichier' : 'Aucun problème'"
          class="flex items-center gap-1.5 hover:text-white transition-colors disabled:hover:text-inherit"
          @click="ed.showProblems = !ed.showProblems"
        >
          <span class="flex items-center gap-0.5" :class="ed.problemCounts.errors ? 'text-rose-400' : ''"
            ><i class="ph ph-x-circle"></i>{{ ed.problemCounts.errors }}</span
          >
          <span class="flex items-center gap-0.5" :class="ed.problemCounts.warnings ? 'text-amber-400' : ''"
            ><i class="ph ph-warning"></i>{{ ed.problemCounts.warnings }}</span
          >
        </button>
        <template v-if="ed.showProblems && ed.activeProblems.length">
          <div class="fixed inset-0 z-40" @click="ed.showProblems = false"></div>
          <div
            role="listbox"
            aria-label="Problèmes"
            class="fixed bottom-8 z-50 w-[420px] max-w-[70vw] max-h-64 overflow-y-auto custom-scrollbar bg-[#252526] border border-white/10 rounded-lg shadow-2xl py-1 font-sans whitespace-normal"
          >
            <button
              v-for="(pb, i) in ed.activeProblems"
              :key="i"
              role="option"
              class="w-full text-left px-3 py-1 flex items-start gap-2 text-[11px] text-slate-300 hover:bg-white/5"
              @click="ed.goToProblem(pb)"
            >
              <i
                class="ph shrink-0 mt-0.5"
                :class="pb.sev === 'error' ? 'ph-x-circle text-rose-400' : 'ph-warning text-amber-400'"
              ></i>
              <span class="flex-1 min-w-0 break-words">{{ pb.message }}</span>
              <span class="shrink-0 text-slate-500 font-mono">{{ pb.line }}:{{ pb.col }}</span>
            </button>
          </div>
        </template>
      </span>
      <span class="shrink-0 uppercase elpis-sb-opt" :title="'Langage : ' + ed.statusLanguage">{{
        ed.statusLanguage
      }}</span>
      <span class="shrink-0 elpis-sb-opt" title="Indentation du fichier">{{ ed.statusIndent }}</span>
      <span
        class="shrink-0 elpis-sb-opt2"
        :title="
          ed.statusEolMixed
            ? 'Fins de ligne mixtes sur le disque, unifiées à l\'enregistrement — clic : convertir'
            : 'Encodage · fin de ligne — clic : convertir LF/CRLF'
        "
        >{{ ed.statusEncoding }} ·
        <button type="button" class="hover:underline" @click="ed.toggleEol">
          {{ ed.statusEol }}<span v-if="ed.statusEolMixed"> (mixtes)</span>
        </button></span
      >
      <span v-if="ed.dirtyTabs.has(ed.activeTabPath)" class="ml-auto shrink-0"
        ><i class="ph ph-circle-fill text-amber-500"></i> non sauvegardé</span
      >
      <span v-else class="ml-auto shrink-0"
        ><i class="ph ph-check-circle text-emerald-500"></i> sauvegardé</span
      >
    </template>
  </div>
</template>
