<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/editor/BarreExplorateur.vue — actions de l'explorateur : nouveau fichier ou dossier, import, fichiers cachés, localiser, tout replier, actualiser. -->
<script setup lang="ts">
import { domaineEditeur } from "../../features/editor/domaine";

const ed = domaineEditeur();
</script>

<template>
  <div
    class="relative px-2 py-1.5 flex justify-between items-center shrink-0 border-b border-white/5 elpis-ed-actions"
  >
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
        :class="ed.showHiddenFiles ? 'text-blue-400 hover:text-blue-300' : 'text-slate-500 hover:text-white'"
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
</template>
