<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/editor/MenuFichiers.vue — menu « Plus » de la vue Fichiers : nouveau dossier, import, fichiers cachés, localiser, tout replier, actualiser. -->
<script setup lang="ts">
import { ref } from "vue";

import MenuDeroulant from "./MenuDeroulant.vue";
import { domaineEditeur } from "../../features/editor/domaine";

const ed = domaineEditeur();
const ouvert = ref(false);
</script>

<template>
  <MenuDeroulant v-model="ouvert" etiquette="Actions des fichiers" cote="droite" largeur="236px">
    <template #declencheur="{ basculer }">
      <button
        type="button"
        class="ed2-vue"
        title="Actions des fichiers"
        aria-label="Actions des fichiers"
        aria-haspopup="menu"
        :aria-expanded="ouvert ? 'true' : 'false'"
        @click.stop="basculer"
      >
        <i class="ph ph-dots-three" aria-hidden="true"></i>
      </button>
    </template>

    <button role="menuitem" class="ed2-menu__item" @click="ed.createFolder()">
      <i class="ph ph-folder-plus" aria-hidden="true"></i
      ><span class="ed2-menu__libelle">Nouveau dossier</span>
    </button>
    <button role="menuitem" class="ed2-menu__item" @click="ed.triggerSandboxImport('file')">
      <i class="ph ph-upload-simple" aria-hidden="true"></i
      ><span class="ed2-menu__libelle">Importer des fichiers</span>
    </button>
    <button role="menuitem" class="ed2-menu__item" @click="ed.triggerSandboxImport('folder')">
      <i class="ph ph-folder-open" aria-hidden="true"></i
      ><span class="ed2-menu__libelle">Importer un dossier</span>
    </button>

    <div class="ed2-menu__sep"></div>
    <button
      role="menuitemcheckbox"
      class="ed2-menu__item"
      title="Fichiers commençant par un point (.dotfiles)"
      :aria-checked="ed.showHiddenFiles ? 'true' : 'false'"
      @click="ed.toggleHiddenFiles()"
    >
      <i class="ph" :class="ed.showHiddenFiles ? 'ph-eye' : 'ph-eye-slash'" aria-hidden="true"></i
      ><span class="ed2-menu__libelle">Fichiers cachés</span>
      <i v-if="ed.showHiddenFiles" class="ph ph-check" aria-hidden="true"></i>
    </button>
    <button
      role="menuitem"
      class="ed2-menu__item"
      :disabled="!ed.activeTabPath"
      @click="ed.revealActiveInTree()"
    >
      <i class="ph ph-crosshair" aria-hidden="true"></i
      ><span class="ed2-menu__libelle">Localiser le fichier ouvert</span><kbd class="ed2-kbd">Alt L</kbd>
    </button>
    <button role="menuitem" class="ed2-menu__item" @click="ed.collapseAllFolders()">
      <i class="ph ph-arrows-in-line-vertical" aria-hidden="true"></i
      ><span class="ed2-menu__libelle">Tout replier</span>
    </button>
    <button role="menuitem" class="ed2-menu__item" @click="ed.loadSandboxFiles()">
      <i class="ph ph-arrow-clockwise" aria-hidden="true"></i
      ><span class="ed2-menu__libelle">Actualiser</span>
    </button>
  </MenuDeroulant>
</template>
