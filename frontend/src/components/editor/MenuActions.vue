<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/editor/MenuActions.vue — menu « Plus » de l'éditeur lié au skin, rangé par geste : fichier, comparer, affichage, sandbox, puis raccourcis et réglages. -->
<script setup lang="ts">
import { computed } from "vue";

import MenuDeroulant from "./MenuDeroulant.vue";
import { domaineEditeur } from "../../features/editor/domaine";

const ed = domaineEditeur();
const code = computed(() => ed.editorMode === "code");
const fichier = computed(() => code.value && !!ed.activeTabPath && !ed.activeIsViewer);
const compare = (base: string): boolean => ed.isDiffView && ed.diffBase === base;

function reglages(): void {
  void ed.openSettingsTab("features:editeur");
}

/** Ferme le menu avant la bascule : il disparaît avec l'interface et ne se fermerait plus seul. */
function editeurClassique(): void {
  ed.showEditorMore = false;
  void ed.persistEditorUi("classic");
}
</script>

<template>
  <MenuDeroulant v-model="ed.showEditorMore" etiquette="Plus d'actions" cote="droite" largeur="272px">
    <template #declencheur="{ basculer }">
      <button
        type="button"
        class="ed2-btn ed2-btn--icone"
        title="Plus d'actions"
        aria-label="Plus d'actions"
        aria-haspopup="menu"
        :aria-expanded="ed.showEditorMore ? 'true' : 'false'"
        @click.stop="basculer"
      >
        <i
          class="ph"
          :class="ed.snapshotBusy !== 'idle' ? 'ph-spinner-gap animate-spin' : 'ph-dots-three'"
          aria-hidden="true"
        ></i>
      </button>
    </template>

    <div class="ed2-menu__titre">Fichier</div>
    <button
      role="menuitem"
      class="ed2-menu__item"
      :disabled="!fichier || ed.isTypingEffect"
      @click="ed.saveEditorContent()"
    >
      <i class="ph ph-floppy-disk" aria-hidden="true"></i><span class="ed2-menu__libelle">Enregistrer</span
      ><kbd class="ed2-kbd">Ctrl S</kbd>
    </button>
    <button role="menuitem" class="ed2-menu__item" :disabled="!ed.dirtyTabs.size" @click="ed.saveAllTabs()">
      <i class="ph ph-floppy-disk-back" aria-hidden="true"></i
      ><span class="ed2-menu__libelle">Tout enregistrer</span><kbd class="ed2-kbd">Ctrl Alt S</kbd>
    </button>
    <button
      v-if="fichier && ed.canRunActive()"
      role="menuitem"
      class="ed2-menu__item"
      @click="ed.runActiveFile()"
    >
      <i class="ph ph-play" aria-hidden="true"></i><span class="ed2-menu__libelle">Exécuter</span>
    </button>

    <template v-if="fichier">
      <div class="ed2-menu__sep"></div>
      <div class="ed2-menu__titre">Comparer avec</div>
      <button
        role="menuitemcheckbox"
        class="ed2-menu__item"
        :aria-checked="compare('saved') ? 'true' : 'false'"
        @click="ed.toggleDiffMode('saved')"
      >
        <i class="ph ph-floppy-disk" aria-hidden="true"></i
        ><span class="ed2-menu__libelle">La sauvegarde</span>
        <i v-if="compare('saved')" class="ph ph-check" aria-hidden="true"></i>
      </button>
      <button
        v-if="ed.activeInRepo"
        role="menuitemcheckbox"
        class="ed2-menu__item"
        :aria-checked="compare('head') ? 'true' : 'false'"
        @click="ed.toggleDiffMode('head')"
      >
        <i class="ph ph-git-commit" aria-hidden="true"></i
        ><span class="ed2-menu__libelle">Le dernier commit</span>
        <i v-if="compare('head')" class="ph ph-check" aria-hidden="true"></i>
      </button>
      <button
        role="menuitemcheckbox"
        class="ed2-menu__item"
        :aria-checked="compare('history') ? 'true' : 'false'"
        @click="ed.toggleOriginalDiff()"
      >
        <i class="ph ph-flag" aria-hidden="true"></i><span class="ed2-menu__libelle">L'original</span>
        <i v-if="compare('history')" class="ph ph-check" aria-hidden="true"></i>
      </button>
    </template>

    <div class="ed2-menu__sep"></div>
    <div class="ed2-menu__titre">Affichage</div>
    <button
      v-if="code"
      role="menuitemcheckbox"
      class="ed2-menu__item"
      :aria-checked="ed.showTerminal ? 'true' : 'false'"
      @click="ed.toggleTerminal()"
    >
      <i class="ph ph-terminal-window" aria-hidden="true"></i><span class="ed2-menu__libelle">Terminal</span
      ><kbd class="ed2-kbd">Ctrl `</kbd>
    </button>
    <button
      v-if="fichier"
      role="menuitemcheckbox"
      class="ed2-menu__item"
      :aria-checked="ed.splitView && ed.splitMode === 'code' ? 'true' : 'false'"
      @click="ed.toggleSplit()"
    >
      <i class="ph ph-columns" aria-hidden="true"></i><span class="ed2-menu__libelle">Vue scindée</span>
      <i v-if="ed.splitView && ed.splitMode === 'code'" class="ph ph-check" aria-hidden="true"></i>
    </button>
    <button
      v-if="code && (ed.isCurrentFileMd || ed.isCurrentFileSvg)"
      role="menuitemcheckbox"
      class="ed2-menu__item"
      :aria-checked="ed.splitView && ed.splitMode === 'render' ? 'true' : 'false'"
      @click="ed.toggleSplitRender()"
    >
      <i class="ph ph-eye" aria-hidden="true"></i
      ><span class="ed2-menu__libelle">{{ ed.isCurrentFileMd ? "Aperçu Markdown" : "Aperçu SVG" }}</span>
      <i v-if="ed.splitView && ed.splitMode === 'render'" class="ph ph-check" aria-hidden="true"></i>
    </button>
    <button
      v-if="code && ed.settings.enable_preview && !ed.activeIsViewer"
      role="menuitemcheckbox"
      class="ed2-menu__item"
      :aria-checked="ed.splitView && ed.splitMode === 'preview' ? 'true' : 'false'"
      @click="ed.toggleSplitPreview()"
    >
      <i class="ph ph-browsers" aria-hidden="true"></i><span class="ed2-menu__libelle">Aperçu à côté</span>
      <i v-if="ed.splitView && ed.splitMode === 'preview'" class="ph ph-check" aria-hidden="true"></i>
    </button>

    <div class="ed2-menu__sep"></div>
    <div class="ed2-menu__titre">Sandbox</div>
    <button role="menuitem" class="ed2-menu__item" @click="ed.openHistoryPanel()">
      <i class="ph ph-clock-counter-clockwise" aria-hidden="true"></i
      ><span class="ed2-menu__libelle">Historique de la session</span>
    </button>
    <button
      v-if="code"
      role="menuitem"
      class="ed2-menu__item"
      title="Capturer ou restaurer tous les fichiers de la sandbox"
      @click="ed.toggleSnapshotPanel()"
    >
      <i class="ph ph-camera" aria-hidden="true"></i><span class="ed2-menu__libelle">Snapshots</span>
      <span v-if="ed.snapshotBusy !== 'idle'" class="ed2-menu__detail"
        >{{ ed.snapshotProgress.pct || 0 }} %</span
      >
    </button>

    <div class="ed2-menu__sep"></div>
    <button role="menuitem" class="ed2-menu__item" @click="ed.openShortcutsModal()">
      <i class="ph ph-keyboard" aria-hidden="true"></i><span class="ed2-menu__libelle">Raccourcis</span
      ><kbd class="ed2-kbd">Ctrl /</kbd>
    </button>
    <button role="menuitem" class="ed2-menu__item" @click="reglages">
      <i class="ph ph-sliders-horizontal" aria-hidden="true"></i
      ><span class="ed2-menu__libelle">Réglages de l'éditeur</span>
    </button>
    <button role="menuitem" class="ed2-menu__item" @click="editeurClassique">
      <i class="ph ph-squares-four" aria-hidden="true"></i
      ><span class="ed2-menu__libelle">Éditeur classique</span>
    </button>
  </MenuDeroulant>
</template>
