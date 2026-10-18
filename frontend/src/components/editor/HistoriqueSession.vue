<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/editor/HistoriqueSession.vue — vue Historique de l'explorateur : fichiers modifiés pendant la session, versions, Comparer / Restaurer. -->
<script setup lang="ts">
import { domaineEditeur } from "../../features/editor/domaine";
import type { EntreeHistorique } from "../../features/editor/schemas-bac";

const ed = domaineEditeur();

/** Entrée chargée d'un fichier (0 ou 1 élément), pour la nommer dans le gabarit. */
function charge(chemin: string): EntreeHistorique[] {
  const v = ed.historyEntries[chemin];
  return v && v !== "loading" ? [v] : [];
}
</script>

<template>
  <div v-if="ed.explorerTab === 'history'" class="flex-1 flex flex-col min-h-0" data-history-panel>
    <div class="px-3 py-1.5 border-b border-white/5 flex items-center gap-2 shrink-0">
      <span
        class="text-[11px] text-slate-400 flex-1 truncate"
        :title="
          'Session ouverte à la connexion — ' +
          ((ed.historySession && ed.historySession.files.length) || 0) +
          ' fichier(s) modifié(s)'
        "
      >
        Session depuis
        {{ ed.historySession && ed.historySession.started ? ed.historyTime(ed.historySession.started) : "—" }}
      </span>
      <button
        :disabled="ed.historyLoading"
        title="Actualiser"
        aria-label="Actualiser l'historique"
        class="w-6 h-6 rounded text-slate-400 hover:text-white hover:bg-white/5 flex items-center justify-center disabled:opacity-40"
        @click="ed.loadHistorySession()"
      >
        <i class="ph ph-arrows-clockwise text-xs" :class="ed.historyLoading ? 'animate-spin' : ''"></i>
      </button>
    </div>
    <div class="flex-1 overflow-y-auto custom-scrollbar py-1">
      <p v-if="ed.historySession && !ed.historySession.files.length" class="px-3 py-4 text-xs text-slate-500">
        Aucune modification dans cette session
      </p>
      <div v-for="f in ed.historySession ? ed.historySession.files : []" :key="f.path" class="text-xs">
        <button
          :aria-expanded="ed.historyEntries[f.path] ? 'true' : 'false'"
          class="w-full flex items-center gap-1.5 px-2 py-1 hover:bg-white/5 text-left"
          :title="f.path"
          @click="ed.toggleHistoryFile(f.path)"
        >
          <i
            class="ph text-[9px] text-slate-500 shrink-0"
            :class="ed.historyEntries[f.path] ? 'ph-caret-down' : 'ph-caret-right'"
          ></i>
          <span class="truncate" :class="f.deleted ? 'text-slate-500 line-through' : 'text-slate-200'">{{
            f.path.split("/").pop()
          }}</span>
          <span class="truncate text-[10px] text-slate-500 min-w-0">{{
            f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : ""
          }}</span>
          <span v-if="!f.original_exists" class="text-[9px] text-emerald-400 shrink-0">nouveau</span>
          <span class="ml-auto text-[10px] text-slate-500 shrink-0 tabular-nums">{{ f.versions }}</span>
        </button>
        <div v-if="ed.historyEntries[f.path] === 'loading'" class="pl-6 py-1 text-[11px] text-slate-500">
          Chargement…
        </div>
        <div
          v-for="e in charge(f.path)"
          :key="'e:' + f.path + ':' + e.versions.length"
          class="pl-4 pr-1 pb-1"
        >
          <div
            v-for="(v, i) in e.versions"
            :key="'v' + i"
            class="group flex items-center gap-1.5 px-1.5 py-0.5 rounded hover:bg-white/5"
          >
            <i
              class="ph text-[10px] shrink-0"
              :class="
                v.source === 'assistant' || v.source === 'shell'
                  ? 'ph-sparkle text-purple-400'
                  : v.source === 'restore'
                    ? 'ph-arrow-counter-clockwise text-emerald-400'
                    : 'ph-pencil-simple text-slate-400'
              "
            ></i>
            <span class="text-slate-300 truncate">{{
              v.exists === false ? "Supprimé" : ed.HISTORY_SOURCES[v.source ?? ""] || v.source
            }}</span>
            <span v-if="i === 0" class="text-[9px] text-slate-500">actuel</span>
            <span class="ml-auto text-[10px] text-slate-500 tabular-nums shrink-0">{{
              ed.historyTime(v.ts)
            }}</span>
            <button
              v-if="v.exists !== false"
              title="Comparer à l'onglet"
              aria-label="Comparer cette version"
              class="opacity-0 group-hover:opacity-100 focus:opacity-100 w-5 h-5 rounded text-slate-400 hover:text-white hover:bg-white/10 flex items-center justify-center"
              @click="ed.historyCompare(f.path, v)"
            >
              <i class="ph ph-arrows-left-right text-[11px]"></i>
            </button>
            <button
              v-if="v.exists !== false"
              title="Restaurer cette version dans l'onglet"
              aria-label="Restaurer cette version"
              class="opacity-0 group-hover:opacity-100 focus:opacity-100 w-5 h-5 rounded text-slate-400 hover:text-white hover:bg-white/10 flex items-center justify-center"
              @click="ed.historyRestore(f.path, v)"
            >
              <i class="ph ph-arrow-counter-clockwise text-[11px]"></i>
            </button>
          </div>
          <div
            class="group flex items-center gap-1.5 px-1.5 py-0.5 rounded hover:bg-white/5 border-t border-white/5 mt-0.5 pt-1"
          >
            <i class="ph ph-flag text-[10px] text-amber-400 shrink-0"></i>
            <span class="text-slate-300">{{ e.original.exists ? "Original" : "Absent au départ" }}</span>
            <span class="ml-auto text-[10px] text-slate-500 shrink-0">début</span>
            <button
              v-if="e.original.exists"
              title="Comparer l'onglet à l'original"
              aria-label="Comparer à l'original"
              class="opacity-0 group-hover:opacity-100 focus:opacity-100 w-5 h-5 rounded text-slate-400 hover:text-white hover:bg-white/10 flex items-center justify-center"
              @click="ed.historyCompare(f.path, e.original)"
            >
              <i class="ph ph-arrows-left-right text-[11px]"></i>
            </button>
            <button
              v-if="e.original.exists"
              title="Restaurer l'original dans l'onglet"
              aria-label="Restaurer l'original"
              class="opacity-0 group-hover:opacity-100 focus:opacity-100 w-5 h-5 rounded text-slate-400 hover:text-white hover:bg-white/10 flex items-center justify-center"
              @click="ed.historyRestore(f.path, e.original)"
            >
              <i class="ph ph-arrow-counter-clockwise text-[11px]"></i>
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
