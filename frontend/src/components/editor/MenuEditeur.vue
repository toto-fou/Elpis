<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/editor/MenuEditeur.vue — menu « + » de la barre de l'éditeur (diff, vue scindée, aperçus, historique, exécution, snapshots…) et panneau des snapshots. -->
<script setup lang="ts">
import { domaineEditeur } from "../../features/editor/domaine";

const ed = domaineEditeur();
</script>

<template>
  <div class="relative h-full flex items-center" @keydown.escape.stop="ed.showEditorMore = false">
    <button
      aria-haspopup="menu"
      :aria-expanded="ed.showEditorMore ? 'true' : 'false'"
      title="Plus d'actions"
      class="text-slate-400 hover:text-white w-7 h-7 flex items-center justify-center rounded hover:bg-white/5"
      :class="
        ed.showEditorMore
          ? 'text-blue-400 bg-blue-500/10'
          : ed.snapshotBusy !== 'idle'
            ? ed.snapshotBusy === 'restore'
              ? 'text-amber-400 bg-amber-500/10'
              : 'text-blue-400 bg-blue-500/10'
            : ''
      "
      @click.stop="ed.showEditorMore = !ed.showEditorMore"
    >
      <i
        class="ph text-sm"
        :class="ed.snapshotBusy !== 'idle' ? 'ph-spinner-gap animate-spin' : 'ph-plus'"
      ></i>
    </button>
    <div v-if="ed.showEditorMore" class="fixed inset-0 z-40" @click="ed.showEditorMore = false"></div>
    <Transition name="popover">
      <div
        v-if="ed.showEditorMore"
        role="menu"
        aria-label="Actions de l'éditeur"
        class="absolute right-0 top-full mt-1 w-60 bg-[#1e1e1e] border border-white/10 rounded-lg shadow-xl z-50 py-1"
      >
        <button
          v-if="ed.editorMode === 'code' && (ed.isCurrentFileMd || ed.isCurrentFileSvg)"
          role="menuitem"
          class="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2"
          :class="
            ed.splitView && ed.splitMode === 'render'
              ? 'text-blue-400 bg-blue-500/10'
              : 'text-slate-300 hover:bg-white/5'
          "
          @click="
            ed.showEditorMore = false;
            ed.toggleSplitRender();
          "
        >
          <i class="ph ph-eye text-sm shrink-0"></i>
          <span class="flex-1">{{ ed.isCurrentFileMd ? "Aperçu Markdown" : "Aperçu SVG" }}</span>
          <i v-if="ed.splitView && ed.splitMode === 'render'" class="ph ph-check text-[10px]"></i>
        </button>
        <button
          v-if="ed.editorMode === 'code' && ed.activeTabPath && ed.canRunActive()"
          role="menuitem"
          class="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-slate-300 hover:bg-white/5"
          @click="ed.runActiveFile()"
        >
          <i class="ph ph-play text-sm shrink-0 text-emerald-400"></i>
          <span class="flex-1">Exécuter le fichier</span>
        </button>
        <button
          v-if="ed.editorMode === 'code'"
          role="menuitem"
          class="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2"
          :class="ed.showTerminal ? 'text-blue-400 bg-blue-500/10' : 'text-slate-300 hover:bg-white/5'"
          @click="
            ed.showEditorMore = false;
            ed.toggleTerminal();
          "
        >
          <i class="ph ph-terminal-window text-sm shrink-0"></i>
          <span class="flex-1">Terminal</span>
          <i v-if="ed.showTerminal" class="ph ph-check text-[10px]"></i>
          <kbd v-else class="text-[9px] bg-white/[0.07] px-1.5 py-0.5 rounded font-mono text-slate-500"
            >Ctrl+`</kbd
          >
        </button>
        <button
          v-if="ed.editorMode === 'code' && !ed.activeIsViewer"
          role="menuitem"
          :aria-pressed="ed.isDiffView && ed.diffBase === 'saved'"
          class="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2"
          :class="
            ed.isDiffView && ed.diffBase === 'saved'
              ? 'text-blue-400 bg-blue-500/10'
              : 'text-slate-300 hover:bg-white/5'
          "
          @click="
            ed.showEditorMore = false;
            ed.toggleDiffMode('saved');
          "
        >
          <i class="ph ph-arrows-left-right text-sm shrink-0"></i>
          <span class="flex-1">Diff depuis la sauvegarde</span>
          <i v-if="ed.isDiffView && ed.diffBase === 'saved'" class="ph ph-check text-[10px]"></i>
        </button>
        <button
          v-if="ed.editorMode === 'code' && !ed.activeIsViewer && ed.activeInRepo"
          role="menuitem"
          :aria-pressed="ed.isDiffView && ed.diffBase === 'head'"
          class="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2"
          :class="
            ed.isDiffView && ed.diffBase === 'head'
              ? 'text-blue-400 bg-blue-500/10'
              : 'text-slate-300 hover:bg-white/5'
          "
          @click="
            ed.showEditorMore = false;
            ed.toggleDiffMode('head');
          "
        >
          <i class="ph ph-git-diff text-sm shrink-0"></i>
          <span class="flex-1">Diff depuis le dernier commit</span>
          <i v-if="ed.isDiffView && ed.diffBase === 'head'" class="ph ph-check text-[10px]"></i>
        </button>
        <button
          v-if="ed.editorMode === 'code' && !ed.activeIsViewer && ed.activeTabPath"
          role="menuitem"
          :aria-pressed="ed.isDiffView && ed.diffBase === 'history'"
          class="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2"
          :class="
            ed.isDiffView && ed.diffBase === 'history'
              ? 'text-blue-400 bg-blue-500/10'
              : 'text-slate-300 hover:bg-white/5'
          "
          @click="ed.toggleOriginalDiff()"
        >
          <i class="ph ph-flag text-sm shrink-0"></i>
          <span class="flex-1">Diff depuis l'original</span>
          <i v-if="ed.isDiffView && ed.diffBase === 'history'" class="ph ph-check text-[10px]"></i>
        </button>
        <button
          role="menuitem"
          class="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-slate-300 hover:bg-white/5"
          @click="ed.openHistoryPanel()"
        >
          <i class="ph ph-clock-counter-clockwise text-sm shrink-0"></i>
          <span class="flex-1">Historique de la session</span>
        </button>
        <button
          v-if="ed.editorMode === 'code' && !ed.activeIsViewer"
          role="menuitem"
          :disabled="ed.isTypingEffect"
          class="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-slate-300 hover:bg-white/5 disabled:opacity-40"
          @click="
            ed.showEditorMore = false;
            ed.saveEditorContent();
          "
        >
          <i class="ph ph-floppy-disk text-sm shrink-0"></i>
          <span class="flex-1">Sauvegarder</span>
          <kbd class="text-[9px] bg-white/[0.07] px-1.5 py-0.5 rounded font-mono text-slate-500">Ctrl+S</kbd>
        </button>
        <button
          v-if="ed.editorMode === 'code'"
          role="menuitem"
          :disabled="!ed.dirtyTabs.size"
          class="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-slate-300 hover:bg-white/5 disabled:opacity-40"
          @click="ed.saveAllTabs()"
        >
          <i class="ph ph-floppy-disk-back text-sm shrink-0"></i>
          <span class="flex-1">Tout enregistrer</span>
          <kbd class="text-[9px] bg-white/[0.07] px-1.5 py-0.5 rounded font-mono text-slate-500"
            >Ctrl+Alt+S</kbd
          >
        </button>
        <button
          role="menuitem"
          class="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-slate-300 hover:bg-white/5"
          @click="
            ed.showEditorMore = false;
            ed.openShortcutsModal();
          "
        >
          <i class="ph ph-keyboard text-sm shrink-0"></i>
          <span class="flex-1">Raccourcis clavier</span>
          <kbd class="text-[9px] bg-white/[0.07] px-1.5 py-0.5 rounded font-mono text-slate-500">Ctrl+/</kbd>
        </button>
        <button
          v-if="ed.editorMode === 'code'"
          role="menuitem"
          class="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2"
          :class="
            ed.snapshotBusy !== 'idle'
              ? ed.snapshotBusy === 'restore'
                ? 'text-amber-400 bg-amber-500/10'
                : 'text-blue-400 bg-blue-500/10'
              : 'text-slate-300 hover:bg-white/5'
          "
          @click="
            ed.showEditorMore = false;
            ed.toggleSnapshotPanel();
          "
        >
          <i
            class="ph text-sm shrink-0"
            :class="ed.snapshotBusy !== 'idle' ? 'ph-spinner-gap animate-spin' : 'ph-camera'"
          ></i>
          <span class="flex-1">{{
            ed.snapshotBusy === "create"
              ? "Snapshot… " + (ed.snapshotProgress.pct || 0) + "%"
              : ed.snapshotBusy === "restore"
                ? "Restauration… " + (ed.snapshotProgress.pct || 0) + "%"
                : "Snapshots de la sandbox"
          }}</span>
        </button>
        <button
          v-if="ed.editorMode === 'code' && ed.activeTabPath && !ed.activeIsViewer"
          role="menuitem"
          class="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2"
          :class="
            ed.splitView && ed.splitMode === 'code'
              ? 'text-blue-400 bg-blue-500/10'
              : 'text-slate-300 hover:bg-white/5'
          "
          @click="
            ed.showEditorMore = false;
            ed.toggleSplit();
          "
        >
          <i class="ph ph-columns text-sm shrink-0"></i>
          <span class="flex-1">{{
            ed.splitView && ed.splitMode === "code" ? "Fermer la vue scindée" : "Vue scindée"
          }}</span>
          <i v-if="ed.splitView && ed.splitMode === 'code'" class="ph ph-check text-[10px]"></i>
        </button>
        <button
          v-if="ed.editorMode === 'code' && ed.settings.enable_preview && !ed.activeIsViewer"
          role="menuitem"
          class="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2"
          :class="
            ed.splitView && ed.splitMode === 'preview'
              ? 'text-blue-400 bg-blue-500/10'
              : 'text-slate-300 hover:bg-white/5'
          "
          @click="
            ed.showEditorMore = false;
            ed.toggleSplitPreview();
          "
        >
          <i class="ph ph-browsers text-sm shrink-0"></i>
          <span class="flex-1">{{
            ed.splitView && ed.splitMode === "preview"
              ? "Fermer l'aperçu côte à côte"
              : "Aperçu à côté du code"
          }}</span>
          <i v-if="ed.splitView && ed.splitMode === 'preview'" class="ph ph-check text-[10px]"></i>
        </button>
      </div>
    </Transition>

    <template v-if="ed.showSnapshotPanel">
      <div class="fixed inset-0 z-30" @click="ed.showSnapshotPanel = false"></div>
      <div
        class="absolute right-0 top-full mt-1 w-80 bg-[#252526] border border-white/10 rounded-xl shadow-2xl z-40 overflow-hidden"
      >
        <div class="px-3 pt-3 pb-2 border-b border-white/5">
          <div class="flex items-center justify-between mb-1">
            <div class="text-xs font-semibold text-slate-400 flex items-center gap-1.5">
              <i class="ph ph-camera"></i> Snapshots de la sandbox
            </div>
            <span v-if="ed.snapshots && ed.snapshotsMax" class="text-[9px] text-slate-600 font-mono"
              >{{ ed.snapshots.length }}/{{ ed.snapshotsMax }}</span
            >
          </div>
          <p class="text-[10px] text-slate-500 leading-relaxed">
            Capture l'ensemble de vos fichiers. Restaurer une snapshot remplace tout le contenu actuel.
          </p>
        </div>

        <div v-if="ed.restoreIncomplete" class="px-3 py-2 border-b border-white/5 bg-red-500/10">
          <div class="flex items-start gap-2">
            <i class="ph ph-warning-octagon text-red-400 text-sm mt-0.5 shrink-0"></i>
            <div class="flex-1 min-w-0">
              <div class="text-[11px] font-semibold text-red-300">Restauration interrompue</div>
              <p class="text-[10px] text-slate-400 leading-relaxed mt-0.5">
                Vos fichiers sont peut-être incomplets. Relancez la restauration<span
                  v-if="ed.restoreIncompleteWhen()"
                >
                  (tentative du {{ ed.restoreIncompleteWhen() }})</span
                >.
              </p>
              <button
                class="mt-1 text-[10px] text-slate-500 hover:text-slate-300 underline"
                @click="ed.dismissRestoreIncomplete()"
              >
                J'ai vérifié, ignorer
              </button>
            </div>
          </div>
        </div>

        <div class="px-3 py-2 border-b border-white/5">
          <input
            v-model="ed.snapshotName"
            :disabled="ed.snapshotBusy !== 'idle'"
            placeholder="Nom (optionnel)"
            maxlength="80"
            class="w-full bg-[#1e1e1e] text-slate-200 text-xs rounded-lg border border-white/10 px-3 py-1.5 focus:ring-1 focus:ring-blue-500 outline-none disabled:opacity-50"
            @keydown.enter="ed.createSnapshot()"
          />
          <div class="flex justify-end mt-1.5">
            <button
              :disabled="ed.snapshotBusy !== 'idle'"
              class="bg-blue-600 hover:bg-blue-700 disabled:bg-slate-700 disabled:cursor-not-allowed text-white text-[10px] font-bold px-3 py-1 rounded-lg flex items-center gap-1"
              @click="ed.createSnapshot()"
            >
              <i class="ph ph-camera"></i> Créer une snapshot
            </button>
          </div>
        </div>

        <div v-if="ed.snapshotBusy !== 'idle'" class="px-3 py-2 border-b border-white/5 bg-blue-500/5">
          <div class="flex items-center justify-between text-xs mb-1">
            <span
              class="font-semibold"
              :class="ed.snapshotBusy === 'restore' ? 'text-amber-400' : 'text-blue-400'"
            >
              <i
                class="ph"
                :class="ed.snapshotBusy === 'restore' ? 'ph-clock-counter-clockwise' : 'ph-camera'"
              ></i>
              {{
                ed.snapshotBusy === "restore"
                  ? ed.snapshotProgress.phase === "clearing"
                    ? "Nettoyage..."
                    : "Restauration"
                  : "Création"
              }}
            </span>
            <span class="font-mono tabular-nums text-slate-300">{{ ed.snapshotProgress.pct || 0 }}%</span>
          </div>
          <div class="relative w-full h-1.5 rounded-full bg-white/10 overflow-hidden">
            <div
              class="absolute inset-y-0 left-0 right-0 rounded-full transition-transform duration-150"
              :class="ed.snapshotBusy === 'restore' ? 'bg-amber-400' : 'bg-blue-500'"
              :style="{
                transformOrigin: 'left',
                transform: 'scaleX(' + (ed.snapshotProgress.pct || 0) / 100 + ')',
              }"
            ></div>
          </div>
          <div class="flex items-center justify-between text-[9px] text-slate-500 mt-1 font-mono">
            <span class="truncate flex-1 mr-2" :title="ed.snapshotProgress.current_file">{{
              ed.snapshotProgress.current_file || "..."
            }}</span>
            <span class="shrink-0 tabular-nums"
              >{{ ed.snapshotProgress.files_done || 0 }} / {{ ed.snapshotProgress.total_files || 0 }}</span
            >
          </div>
        </div>

        <div v-if="ed.snapshots && ed.snapshots.length" class="max-h-72 overflow-y-auto custom-scrollbar">
          <div
            v-for="s in ed.snapshots"
            :key="s.id"
            class="px-3 py-2 border-b border-white/5 group hover:bg-white/3"
          >
            <div class="flex items-start justify-between gap-2">
              <div class="flex-1 min-w-0">
                <div class="text-xs text-slate-200 font-semibold truncate" :title="s.name">{{ s.name }}</div>
                <div class="flex items-center gap-2 text-[9px] text-slate-500 font-mono mt-0.5">
                  <span><i class="ph ph-file"></i> {{ s.file_count }}</span>
                  <span
                    ><i class="ph ph-archive"></i> {{ Math.round((s.archive_bytes || 0) / 1024) }} Ko</span
                  >
                  <span class="truncate" :title="new Date((s.ts || 0) * 1000).toLocaleString('fr-FR')">{{
                    new Date((s.ts || 0) * 1000).toLocaleString("fr-FR")
                  }}</span>
                </div>
              </div>
              <div class="flex items-center gap-0.5 shrink-0">
                <button
                  :disabled="ed.snapshotBusy !== 'idle'"
                  class="w-6 h-6 flex items-center justify-center text-slate-400 hover:text-amber-400 hover:bg-amber-500/10 rounded disabled:opacity-30 disabled:cursor-not-allowed"
                  title="Restaurer"
                  @click="ed.restoreSnapshot(s.id, s.name)"
                >
                  <i class="ph ph-clock-counter-clockwise text-xs"></i>
                </button>
                <button
                  :disabled="ed.snapshotBusy !== 'idle'"
                  class="w-6 h-6 flex items-center justify-center text-slate-600 hover:text-red-400 hover:bg-red-500/10 rounded opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity disabled:opacity-30 disabled:cursor-not-allowed"
                  title="Supprimer"
                  @click="ed.deleteSnapshot(s.id)"
                >
                  <i class="ph ph-trash text-xs"></i>
                </button>
              </div>
            </div>
          </div>
        </div>
        <div v-else class="px-3 py-4 text-center text-slate-600 text-xs">Aucune snapshot pour le moment</div>
      </div>
    </template>
  </div>
</template>
