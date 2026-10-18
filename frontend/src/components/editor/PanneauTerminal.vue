<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/editor/PanneauTerminal.vue — panneau des terminaux : démarrage du conteneur, redimensionnement, onglets de sessions (renommage, état), surfaces xterm. -->
<script setup lang="ts">
import { domaineEditeur } from "../../features/editor/domaine";

const ed = domaineEditeur();
</script>

<template>
  <div
    v-show="ed.showTerminal"
    class="flex flex-col bg-[#1e1e1e] shrink-0 relative rounded-tr-lg overflow-hidden"
    :style="{ height: ed.terminalHeight + 'px' }"
  >
    <Transition name="modal">
      <div
        v-if="ed.terminalInitOverlay.visible"
        class="absolute inset-0 z-30 bg-[#1e1e1e]/95 backdrop-blur-sm flex items-center justify-center p-6"
      >
        <div class="max-w-md w-full">
          <div class="flex items-center gap-3 mb-4">
            <div
              class="w-10 h-10 rounded-xl bg-blue-500/10 border border-blue-500/30 flex items-center justify-center shrink-0"
            >
              <div
                v-if="!ed.terminalInitOverlay.error"
                class="w-5 h-5 border-2 border-blue-400 border-t-transparent rounded-full animate-spin"
              ></div>
              <i v-else class="ph ph-warning-circle text-red-400 text-xl"></i>
            </div>
            <div class="flex-1 min-w-0">
              <div class="text-sm font-bold text-slate-100">
                {{ ed.terminalInitOverlay.label || "Démarrage…" }}
              </div>
              <div v-if="!ed.terminalInitOverlay.error" class="text-[11px] text-slate-400">
                Préparation de l'environnement d'exécution…
              </div>
              <div v-else class="text-[11px] text-red-300 mt-0.5">
                Le terminal nécessite un container Docker démarré.
              </div>
            </div>
            <div class="text-2xl font-bold text-blue-400 tabular-nums shrink-0">
              {{ Math.round(ed.terminalInitOverlay.progress) }}%
            </div>
          </div>
          <div class="h-1.5 bg-[#252526] rounded-full overflow-hidden border border-white/5">
            <div
              :class="[
                'h-full w-full transition-transform duration-500 ease-out rounded-full',
                ed.terminalInitOverlay.error ? 'bg-red-500' : 'bg-blue-500',
              ]"
              :style="{
                transformOrigin: 'left',
                transform: 'scaleX(' + ed.terminalInitOverlay.progress / 100 + ')',
              }"
            ></div>
          </div>
          <div
            v-if="ed.terminalInitOverlay.error"
            class="mt-3 text-[11px] font-mono bg-red-500/10 border border-red-500/30 text-red-200 rounded-lg p-2 max-h-32 overflow-y-auto whitespace-pre-wrap"
          >
            {{ ed.terminalInitOverlay.error }}
          </div>
          <div v-if="ed.terminalInitOverlay.error" class="mt-3 flex justify-end">
            <button
              class="px-3 py-1.5 text-[11px] rounded-lg bg-white/5 border border-white/10 hover:bg-white/10 text-slate-200"
              @click="ed.dismissTerminalInitOverlay"
            >
              Fermer
            </button>
          </div>
        </div>
      </div>
    </Transition>
    <div
      class="h-1 bg-[#252526] cursor-ns-resize hover:bg-blue-500/40 transition-colors shrink-0 group flex items-center justify-center"
      @mousedown="ed.terminalResizeStart"
      @touchstart="ed.terminalResizeStart"
    >
      <div class="w-8 h-0.5 rounded-full bg-slate-600 group-hover:bg-blue-400 transition-colors"></div>
    </div>

    <div class="term-tabstrip flex items-end shrink-0 min-h-[30px] pt-1">
      <div class="flex items-end gap-0.5 flex-1 min-w-0 overflow-x-auto no-scrollbar px-2">
        <i class="ph ph-terminal-window text-green-400 text-xs shrink-0 mr-1 mb-1.5"></i>

        <div
          v-for="s in ed.termSessions"
          :key="s.id"
          class="term-tab"
          :class="{ 'is-active': ed.termActiveSid === s.id }"
          :title="ed.termSessionTitle(s.id)"
          @click="ed.termSwitchTo(s.id)"
          @dblclick="ed.termStartRename(s.id)"
        >
          <template v-if="ed.termRenamingSid === s.id">
            <input
              v-model="ed.termRenameValue"
              type="text"
              :data-term-rename-sid="s.id"
              maxlength="64"
              class="bg-[#111] text-white px-1 py-0 border border-blue-400/60 rounded text-[11.5px] w-28 focus:outline-none"
              @click.stop
              @keydown.enter.prevent="ed.termCommitRename"
              @keydown.esc.prevent="ed.termCancelRename"
              @blur="ed.termCommitRename"
            />
          </template>
          <template v-else>
            <span class="term-tab-dot" :class="'is-' + ed.termSessionState(s.id)"></span>
            <span class="truncate">{{ s.name }}</span>
            <button
              v-if="ed.termMultiSession"
              class="term-tab-close"
              title="Fermer ce terminal"
              @click.stop="ed.termCloseSession(s.id)"
            >
              <i class="ph ph-x text-[10px]"></i>
            </button>
          </template>
        </div>

        <button
          v-if="ed.termMultiSession"
          :disabled="ed.termSessions.length >= ed.termMaxSessions"
          class="flex items-center justify-center w-6 h-6 rounded-md hover:bg-white/10 text-slate-400 hover:text-white shrink-0 disabled:opacity-30 disabled:cursor-not-allowed transition-colors ml-1 mb-0.5"
          :title="
            ed.termSessions.length >= ed.termMaxSessions
              ? 'Limite atteinte : ' +
                ed.termSessions.length +
                '/' +
                ed.termMaxSessions +
                ' terminaux. Fermez-en un (✕) pour en ouvrir un autre.'
              : 'Nouveau terminal (' + ed.termSessions.length + '/' + ed.termMaxSessions + ')'
          "
          @click="ed.termNewSession"
        >
          <i class="ph ph-plus text-xs"></i>
        </button>

        <span
          v-if="ed.termMultiSession && ed.termSessions.length >= ed.termMaxSessions - 1"
          class="text-[9px] font-mono text-slate-500 shrink-0 ml-1 mb-1.5 tabular-nums"
          :class="ed.termSessions.length >= ed.termMaxSessions ? 'text-amber-400/80' : ''"
          :title="'Limite de ' + ed.termMaxSessions + ' terminaux simultanés par utilisateur'"
          >{{ ed.termSessions.length }}/{{ ed.termMaxSessions }}</span
        >
      </div>
      <button
        class="text-slate-500 hover:text-white px-2 mb-1 rounded hover:bg-white/10 transition-colors shrink-0"
        title="Masquer le panneau"
        @click="ed.toggleTerminal"
      >
        <i class="ph ph-x text-xs"></i>
      </button>
    </div>

    <div class="flex-1 min-h-0 relative">
      <div
        v-for="s in ed.termSessions"
        v-show="ed.termActiveSid === s.id"
        :key="s.id"
        :data-term-sid="s.id"
        class="absolute inset-0 overflow-hidden"
      ></div>
    </div>
  </div>
</template>
