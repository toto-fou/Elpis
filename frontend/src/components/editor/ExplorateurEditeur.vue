<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/editor/ExplorateurEditeur.vue — explorateur de l'éditeur : en-tête et actions, import (fichiers, dossier, progression), choix de la vue, fichiers (recherche, remplacement, arbre), historique et Git. -->
<script setup lang="ts">
import ElementArbre from "./ElementArbre.vue";
import HistoriqueSession from "./HistoriqueSession.vue";
import PanneauGit from "./PanneauGit.vue";
import { domaineEditeur } from "../../features/editor/domaine";

const ed = domaineEditeur();
</script>

<template>
  <div
    v-show="ed.showExplorer"
    class="bg-[#252526] border-r border-black/20 flex flex-col shrink-0"
    :style="{ width: ed.explorerWidth + 'px' }"
    :class="ed.explorerDragOver ? 'ring-2 ring-inset ring-blue-500/40' : ''"
    @contextmenu.prevent="ed.openContextMenu($event, 'explorer-bg', { path: '' })"
    @dragover.prevent="ed.onExplorerDragOver"
    @dragleave="ed.onExplorerDragLeave"
    @drop.prevent="ed.handleExplorerDrop($event)"
  >
    <div class="relative px-2 py-1.5 flex justify-between items-center shrink-0 border-b border-white/5">
      <div class="flex gap-0.5 flex-1 justify-end min-w-0 overflow-hidden">
        <button
          title="Nouveau fichier"
          aria-label="Nouveau fichier"
          class="hover:text-white p-1 rounded hover:bg-white/5 text-slate-500"
          @click="ed.createFile()"
        >
          <i class="ph ph-file-plus text-sm"></i>
        </button>
        <button
          title="Nouveau dossier"
          aria-label="Nouveau dossier"
          class="hover:text-white p-1 rounded hover:bg-white/5 text-slate-500"
          @click="ed.createFolder()"
        >
          <i class="ph ph-folder-plus text-sm"></i>
        </button>
        <button
          class="hover:text-white p-1 rounded hover:bg-white/5 text-slate-500"
          title="Importer"
          aria-label="Importer"
          :aria-expanded="ed.showImportMenu ? 'true' : 'false'"
          @click.stop="ed.showImportMenu = !ed.showImportMenu"
        >
          <i class="ph ph-upload-simple text-sm"></i>
        </button>
        <button
          :title="
            ed.showHiddenFiles
              ? 'Masquer les fichiers cachés (.dotfiles)'
              : 'Afficher les fichiers cachés (.dotfiles)'
          "
          :aria-pressed="ed.showHiddenFiles ? 'true' : 'false'"
          class="p-1 rounded hover:bg-white/5"
          :class="
            ed.showHiddenFiles ? 'text-blue-400 hover:text-blue-300' : 'text-slate-500 hover:text-white'
          "
          @click="ed.toggleHiddenFiles()"
        >
          <i class="ph text-sm" :class="ed.showHiddenFiles ? 'ph-eye' : 'ph-eye-slash'"></i>
        </button>
        <button
          :disabled="!ed.activeTabPath"
          title="Localiser le fichier ouvert (Alt+L)"
          aria-label="Localiser le fichier ouvert"
          class="hover:text-white p-1 rounded hover:bg-white/5 text-slate-500 disabled:opacity-30"
          @click="ed.revealActiveInTree()"
        >
          <i class="ph ph-crosshair text-sm"></i>
        </button>
        <button
          title="Tout replier"
          aria-label="Tout replier"
          class="hover:text-white p-1 rounded hover:bg-white/5 text-slate-500"
          @click="ed.collapseAllFolders()"
        >
          <i class="ph ph-arrows-in-line-vertical text-sm"></i>
        </button>
        <button
          title="Actualiser"
          aria-label="Actualiser l'arborescence"
          class="hover:text-white p-1 rounded hover:bg-white/5 text-slate-500"
          @click="ed.loadSandboxFiles"
        >
          <i class="ph ph-arrow-clockwise text-sm" :class="{ 'animate-spin': ed.isLoadingFiles }"></i>
        </button>
      </div>
      <!-- Menu hors de la barre d'outils : son overflow-hidden le rognait, et le clic tombait sur le voile. -->
      <template v-if="ed.showImportMenu">
        <div class="fixed inset-0 z-40" @click="ed.showImportMenu = false"></div>
        <div
          class="absolute right-2 top-full mt-1 w-36 bg-[#1e1e1e] border border-white/10 rounded-lg shadow-xl z-50 py-1 overflow-hidden"
        >
          <button
            class="w-full text-left px-3 py-1.5 text-xs text-slate-300 hover:bg-white/10 flex items-center gap-2"
            @click="ed.triggerSandboxImport('file')"
          >
            <i class="ph ph-files text-blue-400"></i> Fichiers
          </button>
          <button
            class="w-full text-left px-3 py-1.5 text-xs text-slate-300 hover:bg-white/10 flex items-center gap-2"
            @click="ed.triggerSandboxImport('folder')"
          >
            <i class="ph ph-folder-open text-yellow-400"></i> Dossier
          </button>
        </div>
      </template>
    </div>
    <input
      :ref="(el) => (ed.sandboxFileInput = el as HTMLInputElement | null)"
      type="file"
      class="hidden"
      multiple
      data-sandbox-import="files"
      @change="ed.handleSandboxImport"
    />
    <input
      :ref="(el) => (ed.sandboxFolderInput = el as HTMLInputElement | null)"
      type="file"
      class="hidden"
      webkitdirectory
      data-sandbox-import="folder"
      @change="ed.handleSandboxImport"
    />

    <div
      v-if="ed.uploadProgress.active"
      class="px-3 py-2 border-b border-white/5 bg-blue-500/5"
      data-upload-progress
    >
      <div class="flex items-center justify-between text-xs mb-1">
        <span class="font-semibold text-blue-400">
          <i class="ph ph-upload-simple"></i>
          {{ ed.uploadProgress.phase === "prepare" ? "Préparation…" : "Import en cours" }}
        </span>
        <span class="flex items-center gap-1">
          <span v-if="ed.uploadProgress.phase !== 'prepare'" class="font-mono tabular-nums text-slate-300"
            >{{ ed.uploadProgress.pct || 0 }}%</span
          >
          <button
            type="button"
            title="Annuler l'import"
            aria-label="Annuler l'import"
            class="p-0.5 rounded text-slate-500 hover:text-white hover:bg-white/5"
            @click="ed.cancelSandboxUpload()"
          >
            <i class="ph ph-x text-sm"></i>
          </button>
        </span>
      </div>
      <div class="relative w-full h-1.5 rounded-full bg-white/10 overflow-hidden">
        <div
          v-if="ed.uploadProgress.phase === 'prepare'"
          class="absolute inset-y-0 left-0 w-1/3 rounded-full bg-blue-500/60 animate-pulse"
        ></div>
        <div
          v-else
          class="absolute inset-y-0 left-0 right-0 rounded-full bg-blue-500 transition-transform duration-150"
          :style="{
            transformOrigin: 'left',
            transform: 'scaleX(' + (ed.uploadProgress.pct || 0) / 100 + ')',
          }"
        ></div>
      </div>
      <div class="flex items-center justify-between text-[9px] text-slate-500 mt-1 font-mono">
        <span class="truncate flex-1 mr-2" :title="ed.uploadProgress.current_file">{{
          ed.uploadProgress.current_file || "..."
        }}</span>
        <span v-if="ed.uploadProgress.phase === 'prepare'" class="shrink-0 tabular-nums">{{
          ed.uploadProgress.total_files || 0
        }}</span>
        <span v-else class="shrink-0 tabular-nums"
          >{{ ed.uploadProgress.files_done || 0 }} / {{ ed.uploadProgress.total_files || 0 }}</span
        >
      </div>
    </div>

    <div
      class="relative px-1.5 py-1 border-b border-white/5 shrink-0 flex items-center gap-1"
      @keydown.escape.stop="ed.showExplorerMenu = false"
    >
      <button
        aria-haspopup="menu"
        :aria-expanded="ed.showExplorerMenu ? 'true' : 'false'"
        class="flex-1 min-w-0 flex items-center gap-1.5 px-2 py-1 rounded hover:bg-white/5 transition text-left"
        @click.stop="ed.showExplorerMenu = !ed.showExplorerMenu"
      >
        <i
          class="ph text-xs shrink-0"
          :class="
            ed.explorerTab === 'git'
              ? 'ph-git-branch text-orange-400'
              : ed.explorerTab === 'history'
                ? 'ph-clock-counter-clockwise text-emerald-400'
                : 'ph-files text-blue-400'
          "
        ></i>
        <span class="text-xs font-semibold text-white truncate">{{
          ed.explorerTab === "git" ? "Git" : ed.explorerTab === "history" ? "Historique" : "Fichiers"
        }}</span>
        <i class="ph ph-caret-down text-[8px] text-slate-500 shrink-0 ml-auto"></i>
      </button>
      <button
        v-if="
          ed.explorerTab !== 'git' &&
          ed.gitStatus &&
          ed.gitStatus.is_repo &&
          ed.gitStatus.modified.length + ed.gitStatus.untracked.length + ed.gitStatus.staged.length > 0
        "
        :title="
          ed.gitStatus.modified.length +
          ed.gitStatus.untracked.length +
          ed.gitStatus.staged.length +
          ' modification(s) — ouvrir la vue Git'
        "
        class="bg-orange-500 hover:bg-orange-400 text-white text-[8px] font-bold rounded-full min-w-[16px] h-4 px-1 flex items-center justify-center leading-none transition-colors shrink-0"
        @click="
          ed.gitOpenTab();
          ed.loadGitConnectors();
        "
      >
        {{ ed.gitStatus.modified.length + ed.gitStatus.untracked.length + ed.gitStatus.staged.length }}
      </button>
      <template v-if="ed.showExplorerMenu">
        <div class="fixed inset-0 z-40" @click="ed.showExplorerMenu = false"></div>
        <div
          role="menu"
          aria-label="Vue de l'explorateur"
          class="absolute left-1.5 right-1.5 top-full mt-1 bg-[#1e1e1e] border border-white/10 rounded-lg shadow-xl z-50 py-1"
        >
          <button
            role="menuitemradio"
            :aria-checked="ed.explorerTab === 'files' ? 'true' : 'false'"
            class="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2"
            :class="
              ed.explorerTab === 'files' ? 'text-blue-400 bg-blue-500/10' : 'text-slate-300 hover:bg-white/5'
            "
            @click="
              ed.showExplorerMenu = false;
              ed.explorerTab = 'files';
            "
          >
            <i class="ph ph-files text-xs"></i> <span class="flex-1">Fichiers</span>
            <i v-if="ed.explorerTab === 'files'" class="ph ph-check text-[10px]"></i>
          </button>
          <button
            role="menuitemradio"
            :aria-checked="ed.explorerTab === 'git' ? 'true' : 'false'"
            class="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2"
            :class="
              ed.explorerTab === 'git' ? 'text-blue-400 bg-blue-500/10' : 'text-slate-300 hover:bg-white/5'
            "
            @click="
              ed.showExplorerMenu = false;
              ed.gitOpenTab();
              ed.loadGitConnectors();
            "
          >
            <i class="ph ph-git-branch text-xs text-orange-400"></i> <span class="flex-1">Git</span>
            <span
              v-if="
                ed.gitStatus &&
                ed.gitStatus.is_repo &&
                ed.gitStatus.modified.length + ed.gitStatus.untracked.length + ed.gitStatus.staged.length > 0
              "
              class="bg-orange-500 text-white text-[8px] font-bold rounded-full min-w-[16px] h-4 px-1 flex items-center justify-center leading-none"
              >{{
                ed.gitStatus.modified.length + ed.gitStatus.untracked.length + ed.gitStatus.staged.length
              }}</span
            >
            <i v-else-if="ed.explorerTab === 'git'" class="ph ph-check text-[10px]"></i>
          </button>
          <button
            role="menuitemradio"
            :aria-checked="ed.explorerTab === 'history' ? 'true' : 'false'"
            class="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2"
            :class="
              ed.explorerTab === 'history'
                ? 'text-blue-400 bg-blue-500/10'
                : 'text-slate-300 hover:bg-white/5'
            "
            @click="
              ed.showExplorerMenu = false;
              ed.openHistoryPanel();
            "
          >
            <i class="ph ph-clock-counter-clockwise text-xs text-emerald-400"></i>
            <span class="flex-1">Historique</span>
            <i v-if="ed.explorerTab === 'history'" class="ph ph-check text-[10px]"></i>
          </button>
        </div>
      </template>
    </div>

    <div v-show="ed.explorerTab === 'files'" class="flex flex-col flex-1 min-h-0">
      <div class="px-2 pb-2 border-b border-white/5 space-y-1.5 shrink-0">
        <div class="relative">
          <i
            class="ph ph-magnifying-glass text-[10px] text-slate-500 absolute left-2 top-1/2 -translate-y-1/2"
          ></i>
          <input
            id="elpis-file-search-input"
            v-model="ed.sandboxSearch"
            placeholder="Rechercher..."
            type="search"
            autocomplete="off"
            data-1p-ignore
            data-lpignore="true"
            class="w-full bg-[#3c3c3c] text-white pl-6 pr-6 py-1 text-xs rounded outline-none border border-transparent focus:border-blue-500 transition-colors"
          />
          <button
            v-if="ed.sandboxSearch"
            class="absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white p-0.5 rounded hover:bg-white/10"
            @click="ed.sandboxSearch = ''"
          >
            <i class="ph ph-x text-[10px]"></i>
          </button>
        </div>

        <div
          v-if="ed.sandboxSearch && ed.sandboxSearch.trim() && ed.sandboxSearchMode === 'content'"
          class="flex items-center gap-1"
        >
          <button
            :aria-pressed="ed.searchCase ? 'true' : 'false'"
            title="Respecter la casse"
            class="h-5 px-1.5 rounded text-[10px] font-mono font-bold border transition-colors"
            :class="
              ed.searchCase
                ? 'bg-blue-600 border-blue-600 text-white'
                : 'border-white/10 text-slate-400 hover:text-white'
            "
            @click="ed.searchCase = !ed.searchCase"
          >
            Aa
          </button>
          <button
            :aria-pressed="ed.searchRegex ? 'true' : 'false'"
            title="Expression régulière"
            class="h-5 px-1.5 rounded text-[10px] font-mono font-bold border transition-colors"
            :class="
              ed.searchRegex
                ? 'bg-blue-600 border-blue-600 text-white'
                : 'border-white/10 text-slate-400 hover:text-white'
            "
            @click="ed.searchRegex = !ed.searchRegex"
          >
            .*
          </button>
          <input
            v-model="ed.searchGlob"
            placeholder="*.py"
            aria-label="Filtrer par nom de fichier"
            title="Filtre de nom (ex. *.py)"
            class="flex-1 min-w-0 h-5 bg-[#3c3c3c] text-white px-1.5 text-[10px] font-mono rounded outline-none border border-transparent focus:border-blue-500"
          />
          <button
            :aria-pressed="ed.showReplace ? 'true' : 'false'"
            title="Remplacer dans les fichiers"
            class="h-5 w-5 flex items-center justify-center rounded border transition-colors"
            :class="
              ed.showReplace
                ? 'bg-blue-600 border-blue-600 text-white'
                : 'border-white/10 text-slate-400 hover:text-white'
            "
            @click="ed.showReplace = !ed.showReplace"
          >
            <i class="ph ph-swap text-[11px]"></i>
          </button>
        </div>
        <div
          v-if="
            ed.showReplace &&
            ed.sandboxSearch &&
            ed.sandboxSearch.trim() &&
            ed.sandboxSearchMode === 'content'
          "
          class="flex items-center gap-1"
        >
          <input
            v-model="ed.replaceText"
            placeholder="Remplacer par…"
            aria-label="Texte de remplacement"
            class="flex-1 min-w-0 bg-[#3c3c3c] text-white px-2 py-1 text-xs rounded outline-none border border-transparent focus:border-blue-500"
            @keydown.enter="ed.previewReplace()"
          />
          <button
            :disabled="ed.replaceBusy"
            title="Voir ce qui sera remplacé"
            class="shrink-0 px-2 py-1 text-[10px] font-semibold rounded bg-white/10 text-slate-200 hover:bg-white/15 disabled:opacity-40"
            @click="ed.previewReplace()"
          >
            Aperçu
          </button>
        </div>

        <div
          v-if="ed.sandboxSearch && ed.sandboxSearch.trim()"
          class="flex rounded overflow-hidden border border-white/10 text-[10px] font-semibold"
        >
          <button
            class="flex-1 py-0.5 transition-colors"
            :class="
              ed.sandboxSearchMode === 'content'
                ? 'bg-blue-600 text-white'
                : 'text-slate-400 hover:text-white hover:bg-white/10'
            "
            @click="ed.sandboxSearchMode = 'content'"
          >
            <i class="ph ph-file-text mr-1"></i>Contenu
          </button>
          <button
            class="flex-1 py-0.5 transition-colors"
            :class="
              ed.sandboxSearchMode === 'name'
                ? 'bg-blue-600 text-white'
                : 'text-slate-400 hover:text-white hover:bg-white/10'
            "
            @click="ed.sandboxSearchMode = 'name'"
          >
            <i class="ph ph-files mr-1"></i>Nom
          </button>
        </div>
      </div>
      <div class="flex-1 overflow-y-auto overflow-x-auto custom-scrollbar">
        <template v-if="ed.sandboxSearch && ed.sandboxSearch.trim()">
          <div v-if="ed.isSearchingSandbox" class="px-3 py-3 text-center">
            <i class="ph ph-spinner-gap animate-spin text-slate-500 text-sm"></i>
          </div>
          <template v-else-if="ed.sandboxSearchMode === 'content' && ed.replacePreview">
            <div
              class="px-2 py-1.5 flex items-center gap-2 border-b border-white/5 text-[10px] text-slate-400"
            >
              <span class="flex-1"
                >{{ ed.replaceSelectedCount }} occurrence(s) ·
                {{ ed.replacePreview.files.filter((f) => f.on).length }} fichier(s)</span
              >
              <button class="text-slate-500 hover:text-white" @click="ed.replacePreview = null">
                Annuler
              </button>
              <button
                :disabled="ed.replaceBusy || !ed.replaceSelectedCount"
                class="px-2 py-0.5 rounded bg-blue-600 hover:bg-blue-500 text-white font-semibold disabled:opacity-40"
                @click="ed.applyReplace()"
              >
                Remplacer
              </button>
            </div>
            <div
              v-for="f in ed.replacePreview.files"
              :key="'rp:' + f.path"
              class="border-b border-white/[0.04]"
            >
              <label
                class="flex items-center gap-1.5 px-2 py-1 cursor-pointer"
                :title="f.dirty ? 'Onglet modifié non enregistré : exclu' : f.path"
              >
                <input v-model="f.on" type="checkbox" :disabled="f.dirty" class="accent-blue-500" />
                <span
                  class="text-[10px] text-blue-400 font-mono truncate flex-1"
                  :class="f.dirty ? 'line-through opacity-60' : ''"
                  >{{ f.path }}</span
                >
                <span class="text-[9px] text-slate-500 font-mono shrink-0">{{ f.count }}</span>
              </label>
              <div
                v-for="smp in f.samples"
                :key="'rp:' + f.path + ':' + smp.line"
                class="pl-6 pr-2 pb-1 font-mono text-[10px] leading-relaxed"
              >
                <div class="truncate text-rose-300/80">
                  <span class="text-slate-600 mr-1">{{ smp.line }}</span
                  >− {{ smp.before }}
                </div>
                <div class="truncate text-emerald-300/80">
                  <span class="text-slate-600 mr-1">{{ smp.line }}</span
                  >+ {{ smp.after }}
                </div>
              </div>
            </div>
            <div
              v-if="ed.replacePreview.truncated"
              class="px-3 py-2 text-center text-amber-300/80 text-[10px]"
            >
              Recherche partielle — affinez le filtre
            </div>
          </template>
          <template v-else-if="ed.sandboxSearchMode === 'content'">
            <div v-if="ed.searchError" class="px-3 py-3 text-center text-rose-300 text-[11px]">
              {{ ed.searchError }}
            </div>
            <div
              v-else-if="!ed.sandboxSearchResults.length"
              class="px-3 py-4 text-center text-slate-600 text-xs"
            >
              Aucun résultat
            </div>
            <div
              v-for="grp in ed.searchResultGroups"
              :key="'sg:' + grp.path"
              class="border-b border-white/[0.04]"
            >
              <div class="flex items-center gap-1.5 px-2 pt-1.5 pb-0.5">
                <i class="ph ph-file-code text-slate-500 text-[10px] shrink-0"></i>
                <span class="text-[10px] text-blue-400 font-mono truncate flex-1" :title="grp.path">{{
                  grp.path
                }}</span>
                <span class="text-[9px] text-slate-500 font-mono shrink-0">{{ grp.items.length }}</span>
              </div>
              <div
                v-for="item in grp.items"
                :key="item.path + ':' + item.line + ':' + item.col"
                class="pl-6 pr-2 py-0.5 hover:bg-white/5 cursor-pointer transition-colors group flex gap-1.5"
                @click="ed.openFileAtLine(item.path, item.line, item.col)"
              >
                <span class="text-[9px] text-slate-600 font-mono shrink-0 w-7 text-right">{{
                  item.line
                }}</span>
                <span
                  class="text-[10px] text-slate-400 font-mono truncate leading-relaxed group-hover:text-slate-300"
                  >{{ item.pre }}<mark class="elpis-search-hit">{{ item.hit }}</mark
                  >{{ item.post }}</span
                >
              </div>
            </div>
            <div v-if="ed.searchTruncated" class="px-3 py-2 text-center text-slate-600 text-[10px]">
              Résultats partiels -- affinez la recherche
            </div>
          </template>
          <template v-else>
            <div
              v-if="!ed.sandboxSearchResults.length && !ed.filteredFilesList.length"
              class="px-3 py-4 text-center text-slate-600 text-xs"
            >
              Aucun résultat
            </div>
            <ul class="space-y-0.5 px-1 mt-1">
              <li
                v-for="item in ed.sandboxSearchResults.length
                  ? ed.sandboxSearchResults
                  : ed.filteredFilesList"
                :key="item.path"
                class="select-none"
              >
                <div
                  class="flex items-center gap-2 py-1 px-2 hover:bg-[rgba(255,255,255,0.08)] rounded-md cursor-pointer transition-colors"
                  @click="item.type !== 'folder' && ed.openFile(item.path)"
                >
                  <i
                    class="ph text-sm shrink-0"
                    :class="
                      item.type === 'folder' ? 'ph-folder text-blue-400' : 'ph-file-code text-slate-400'
                    "
                  ></i>
                  <span class="text-xs text-slate-300 truncate flex-1 font-mono tracking-tight">{{
                    item.name
                  }}</span>
                  <span
                    v-if="item.path !== item.name"
                    class="text-[9px] text-slate-600 truncate max-w-[90px] font-mono"
                    :title="item.path"
                    >{{ item.path }}</span
                  >
                </div>
              </li>
            </ul>
          </template>
        </template>

        <ul v-else role="tree" aria-label="Arborescence des fichiers" class="space-y-0.5 px-1 mt-1">
          <ElementArbre
            v-for="item in ed.sandboxFiles"
            :key="item.path"
            :item="item"
            @open-file="ed.openFile"
            @download="ed.downloadFile"
            @delete="ed.deleteFile"
            @rename="ed.renameItem"
            @context-menu="
              (e) => ed.openContextMenu(e.event, e.item.type === 'folder' ? 'folder' : 'file', e.item)
            "
            @move-item="(e) => ed.moveItem(e.oldPath, e.newParent)"
          ></ElementArbre>
        </ul>

        <div
          v-if="ed.treeTruncated"
          class="mx-2 my-1.5 px-2 py-1.5 rounded bg-amber-500/10 border border-amber-500/25 flex items-start gap-1.5"
          :title="
            'Au-delà de ' +
            ed.treeTruncated.max +
            ' entrées, l\'explorateur devient inutilisable dans le navigateur. Les fichiers non listés restent accessibles depuis le terminal et la recherche.'
          "
        >
          <i class="ph ph-warning text-amber-400 text-[11px] mt-px shrink-0"></i>
          <span class="text-[10px] text-amber-200/90 leading-snug"
            >Arborescence tronquée ({{ ed.treeTruncated.max }} entrées max) — utilisez la recherche ou le
            terminal.</span
          >
        </div>
        <div
          v-show="ed.explorerDragOver"
          class="mx-2 my-1.5 py-1.5 border border-dashed border-blue-400/40 rounded flex items-center justify-center gap-1 pointer-events-none"
        >
          <i class="ph ph-arrow-elbow-down-right text-blue-400/60 text-xs"></i>
          <span class="text-[10px] text-blue-400/60 font-medium">Racine /</span>
        </div>
      </div>
    </div>

    <HistoriqueSession />
    <PanneauGit />
  </div>
</template>
