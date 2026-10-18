<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/editor/PageEditeur.vue — page de l'éditeur : diviseur avec le chat, colonne de l'éditeur (barre, bandeaux, explorateur, zone d'édition, terminal, barre d'état), ouverture rapide, menu d'onglet et aide des raccourcis. -->
<script setup lang="ts">
import AideRaccourcis from "./AideRaccourcis.vue";
import BandeauxEditeur from "./BandeauxEditeur.vue";
import BarreEditeur from "./BarreEditeur.vue";
import BarreEtat from "./BarreEtat.vue";
import ExplorateurEditeur from "./ExplorateurEditeur.vue";
import MenuOnglet from "./MenuOnglet.vue";
import OuvertureRapide from "./OuvertureRapide.vue";
import PanneauTerminal from "./PanneauTerminal.vue";
import ZoneEdition from "./ZoneEdition.vue";
import { domaineEditeur } from "../../features/editor/domaine";

const ed = domaineEditeur();
</script>

<template>
  <div
    v-if="ed.showEditor && ed.settings.enable_editor && !ed.editorFullscreen"
    class="w-1 hover:w-1.5 bg-slate-700 hover:bg-blue-500 cursor-col-resize flex-shrink-0 z-40 transition-colors group relative"
    :class="{ 'elpis-splitter-light': ed.settings.editor_dark_mode === false }"
    title="Redimensionner"
    @mousedown="ed.editorSplitStart"
    @touchstart.prevent="ed.editorSplitStart"
  >
    <div class="absolute inset-y-0 -left-1 -right-1"></div>
  </div>
  <div
    class="flex flex-col h-full bg-[#1e1e1e] relative z-30"
    data-editor-root
    :class="[
      ed.showEditor && ed.settings.enable_editor
        ? 'opacity-100'
        : 'w-0 opacity-0 border-none pointer-events-none',
      ed.editorFullscreen ? 'editor-fullscreen' : '',
      ed.editorSplitDragging ? '' : 'elpis-slide-panel',
      ed.settings.editor_dark_mode === false ? 'elpis-editor-light' : '',
    ]"
    :style="{
      width: ed.editorFullscreen
        ? '100%'
        : ed.showEditor && ed.settings.enable_editor
          ? ed.settings.editor_ratio + '%'
          : '0%',
      flexGrow: ed.editorFullscreen ? 1 : 0,
    }"
  >
    <button
      v-if="ed.editorFullscreen && ed.showEscapeHint"
      title="Quitter le plein écran"
      class="absolute top-2.5 right-3 z-40 flex items-center gap-1.5 bg-slate-800/85 border border-white/10 text-slate-200 text-[11px] font-medium px-2.5 py-1.5 rounded-lg shadow-lg backdrop-blur-sm hover:bg-slate-700/90 transition-colors"
      @click="ed.toggleEditorFullscreen"
    >
      <i class="ph ph-keyboard text-xs"></i>
      <span><kbd class="font-mono font-semibold">Échap</kbd> pour quitter</span>
    </button>

    <div class="w-full h-full flex flex-col min-w-[300px]">
      <BarreEditeur />

      <BandeauxEditeur />

      <div class="flex-1 flex overflow-hidden">
        <ExplorateurEditeur />

        <div
          v-show="ed.showExplorer"
          class="w-1 hover:w-1.5 bg-transparent hover:bg-blue-500 cursor-col-resize flex-shrink-0 transition-colors relative group"
          title="Redimensionner l'explorateur"
          @mousedown="ed.explorerResizeStart"
          @touchstart.prevent="ed.explorerResizeStart"
        >
          <div class="absolute inset-y-0 -left-1 -right-1"></div>
        </div>

        <div class="flex-1 flex flex-col bg-[#1e1e1e] min-w-0">
          <ZoneEdition />

          <PanneauTerminal />

          <BarreEtat></BarreEtat>
        </div>
      </div>
    </div>
  </div>
  <OuvertureRapide></OuvertureRapide>
  <MenuOnglet
    :ouvert="ed.tabCtxMenu.show"
    :x="ed.tabCtxMenu.x"
    :y="ed.tabCtxMenu.y"
    :chemin="ed.tabCtxMenu.path"
    :nb-onglets="ed.openTabs.length"
    :epingle="ed.tabIsPinned(ed.tabCtxMenu.path)"
    :visionneuse="ed.officeIsViewerPath(ed.tabCtxMenu.path)"
    :nb-modifies="ed.dirtyTabs.size"
    @clore="ed.closeTabCtxMenu"
    @fermer="ed.closeTab"
    @fermer-autres="ed.closeOtherTabs"
    @fermer-droite="ed.closeTabsToRight"
    @tout-fermer="ed.closeAllTabs"
    @scinder="ed.openInSplit"
    @copier="ed.copyTabPath"
    @localiser="ed.revealActiveInTree"
    @epingler="ed.togglePinTab"
    @joindre="ed.attachToChat"
    @tout-enregistrer="ed.saveAllTabs"
  ></MenuOnglet>
  <AideRaccourcis></AideRaccourcis>
</template>
