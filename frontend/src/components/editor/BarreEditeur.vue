<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/editor/BarreEditeur.vue — barre d'en-tête de l'éditeur : explorateur, modes code et web, onglets, cible de l'aperçu, quota, menu « + », plein écran et fermeture. -->
<script setup lang="ts">
import MenuEditeur from "./MenuEditeur.vue";
import OngletsEditeur from "./OngletsEditeur.vue";
import { domaineEditeur } from "../../features/editor/domaine";
import type { CommandesBarreOnglets } from "../../features/editor/etat";

const ed = domaineEditeur();
</script>

<template>
  <div class="h-9 bg-[#252526] flex items-center shrink-0 border-b border-black/20">
    <button
      aria-label="Basculer l'explorateur de fichiers"
      title="Explorateur de fichiers"
      class="w-9 h-full flex items-center justify-center text-slate-400 hover:text-white hover:bg-white/5 transition border-r border-white/5"
      @click="ed.showExplorer = !ed.showExplorer"
    >
      <i class="ph ph-sidebar-simple text-sm"></i>
    </button>
    <div class="flex items-center h-full px-1 border-r border-white/5 gap-0.5">
      <button
        :class="ed.editorMode === 'code' ? 'text-white bg-white/10' : 'text-slate-400 hover:bg-white/5'"
        class="px-2 py-0.5 rounded text-[11px] font-bold flex items-center gap-1 transition"
        @click="ed.editorMode = 'code'"
      >
        <i class="ph ph-code"></i> Code
      </button>
      <button
        v-if="ed.settings.enable_preview"
        :class="
          ed.editorMode === 'preview' ? 'text-blue-400 bg-blue-500/10' : 'text-slate-400 hover:bg-white/5'
        "
        class="px-2 py-0.5 rounded text-[11px] font-bold flex items-center gap-1 transition"
        @click="ed.editorMode = 'preview'"
      >
        <i class="ph ph-browser"></i> Web
      </button>
    </div>

    <OngletsEditeur
      :ref="(el) => (ed.tabStripRef = el as CommandesBarreOnglets | null)"
      v-model:caches="ed.hiddenTabsCount"
      v-model:debordement="ed.showTabsOverflow"
      :visible="ed.editorMode === 'code'"
      :onglets="ed.openTabs"
      :actif="ed.activeTabPath"
      :modifies="ed.dirtyTabs"
      :onglet-droit="ed.splitView ? ed.splitTabPath : null"
      :indices="ed.tabHints"
      :meta-fichier="ed.tabIcon"
      @activer="ed.onTabActivate"
      @basculer="ed.switchTab"
      @fermer="ed.closeTab"
      @menu="ed.openTabCtxMenu"
      @reordonner="ed.reorderTabs"
      @choisir="ed.pickTabFromOverflow"
    ></OngletsEditeur>
    <div v-show="ed.editorMode === 'preview'" class="flex-1 flex px-3 items-center gap-1.5">
      <div
        class="flex items-center rounded border border-white/10 overflow-hidden shrink-0 text-[10.5px]"
        role="group"
        aria-label="Source de l'aperçu"
      >
        <button
          title="Fichier de la sandbox (statique)"
          :aria-pressed="ed.previewSource === 'file'"
          class="px-2 py-0.5 flex items-center gap-1 transition-colors"
          :class="
            ed.previewSource === 'file'
              ? 'bg-blue-500/20 text-blue-300'
              : 'text-slate-500 hover:text-slate-300'
          "
          @click="ed.previewSource = 'file'"
        >
          <i class="ph ph-file-html"></i> Fichier
        </button>
        <button
          title="Serveur qui tourne dans la sandbox (localhost:port)"
          :aria-pressed="ed.previewSource === 'server'"
          class="px-2 py-0.5 flex items-center gap-1 border-l border-white/10 transition-colors"
          :class="
            ed.previewSource === 'server'
              ? 'bg-blue-500/20 text-blue-300'
              : 'text-slate-500 hover:text-slate-300'
          "
          @click="ed.previewSource = 'server'"
        >
          <i class="ph ph-plugs-connected"></i> Serveur
        </button>
      </div>
      <div
        class="flex items-center bg-[#1e1e1e] w-full rounded border border-white/10 px-2 py-0.5 text-[11px] text-slate-400"
      >
        <template v-if="ed.previewSource === 'file'">
          <i class="ph ph-link mr-1.5"></i>
          <input
            v-model="ed.previewPath"
            aria-label="Chemin du fichier à prévisualiser"
            class="bg-transparent border-none outline-none flex-1 font-mono text-slate-300"
            placeholder="index.html"
          />
        </template>
        <template v-else>
          <i class="ph ph-globe-hemisphere-west mr-1.5"></i>

          <input
            v-model="ed.previewServerUrl"
            aria-label="Adresse du serveur dans la sandbox"
            placeholder="localhost:8080/ — ou 8080, ou http://localhost:5173/app"
            class="bg-transparent border-none outline-none flex-1 font-mono text-slate-300"
            @keydown.enter="ed.commitPreviewServerUrl"
            @blur="ed.commitPreviewServerUrl"
          />
          <span
            v-if="ed.previewServerHostWarn"
            class="shrink-0 text-amber-400 ml-1"
            :title="
              'L’aperçu passe toujours par votre sandbox : l’hôte « ' +
              ed.previewServerHostWarn +
              ' » a été ignoré, seuls le port et le chemin sont utilisés.'
            "
          >
            <i class="ph ph-warning"></i>
          </span>
        </template>
        <button title="Recharger" class="hover:text-blue-400 ml-1.5" @click="ed.reloadPreview">
          <i class="ph ph-arrows-clockwise"></i>
        </button>
      </div>
    </div>
    <div class="flex items-center px-1 gap-0.5 h-full border-l border-white/5">
      <div
        v-if="ed.sandboxQuota && ed.sandboxQuota.quota_mb > 0"
        class="flex items-center gap-1.5 px-2 h-full"
        :title="`Sandbox : ${ed.sandboxQuota.used_mb} Mo / ${ed.sandboxQuota.quota_mb} Mo utilisés`"
      >
        <div class="relative w-20 h-1.5 rounded-full bg-white/10 overflow-hidden">
          <div
            class="absolute inset-y-0 left-0 right-0 rounded-full transition-transform duration-500"
            :class="
              ed.sandboxQuota.pct >= 90
                ? 'bg-red-500'
                : ed.sandboxQuota.pct >= 70
                  ? 'bg-amber-400'
                  : 'bg-emerald-500'
            "
            :style="{ transformOrigin: 'left', transform: 'scaleX(' + ed.sandboxQuota.pct / 100 + ')' }"
          ></div>
        </div>
        <span
          class="text-[10px] font-mono tabular-nums"
          :class="
            ed.sandboxQuota.pct >= 90
              ? 'text-red-400'
              : ed.sandboxQuota.pct >= 70
                ? 'text-amber-400'
                : 'text-slate-500'
          "
        >
          {{ ed.sandboxQuota.pct }}%
        </span>
      </div>

      <MenuEditeur />
      <button
        class="text-slate-400 hover:text-white w-7 h-7 flex items-center justify-center rounded hover:bg-white/5"
        :class="ed.editorFullscreen ? 'text-yellow-400 bg-yellow-500/10' : ''"
        :title="ed.editorFullscreen ? 'Quitter plein écran' : 'Plein écran'"
        @click="ed.toggleEditorFullscreen"
      >
        <i class="ph text-sm" :class="ed.editorFullscreen ? 'ph-arrows-in' : 'ph-arrows-out'"></i>
      </button>
      <button
        class="text-slate-400 hover:text-white w-7 h-7 flex items-center justify-center rounded hover:bg-white/5"
        title="Fermer"
        @click="
          ed.editorFullscreen = false;
          ed.showEditor = false;
        "
      >
        <i class="ph ph-x text-sm"></i>
      </button>
    </div>
  </div>
</template>
