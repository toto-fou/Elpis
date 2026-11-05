<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/editor/MenuVersions.vue — menu « Versions » au bout du fil, éditeur lié au skin : comparer le fichier actif (sauvegarde, dernier commit, original), son historique. -->
<script setup lang="ts">
import { ref } from "vue";

import MenuDeroulant from "./MenuDeroulant.vue";
import { domaineEditeur } from "../../features/editor/domaine";

const ed = domaineEditeur();
const ouvert = ref(false);
const compare = (base: string): boolean => ed.isDiffView && ed.diffBase === base;

/** Ouvre la vue Historique, versions du fichier actif dépliées. */
function historiqueDuFichier(): void {
  ed.openHistoryPanel();
  const actif = ed.activeTabPath;
  if (actif && !ed.historyEntries[actif]) ed.toggleHistoryFile(actif);
}
</script>

<template>
  <MenuDeroulant v-model="ouvert" etiquette="Versions du fichier" cote="droite" largeur="250px">
    <template #declencheur="{ basculer }">
      <button
        type="button"
        class="ed2-btn ed2-btn--petit"
        :class="ed.isDiffView ? 'ed2-btn--actif' : ''"
        title="Comparer le fichier ou voir son historique"
        aria-haspopup="menu"
        :aria-expanded="ouvert ? 'true' : 'false'"
        @click="basculer"
      >
        <i class="ph ph-clock-counter-clockwise" aria-hidden="true"></i>
        <span>{{ ed.isDiffView ? "Comparaison" : "Versions" }}</span>
        <i class="ph ph-caret-down ed2-caret" aria-hidden="true"></i>
      </button>
    </template>
    <template v-if="!ed.activeIsViewer">
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
      <div class="ed2-menu__sep"></div>
    </template>
    <button role="menuitem" class="ed2-menu__item" @click="historiqueDuFichier">
      <i class="ph ph-list-bullets" aria-hidden="true"></i
      ><span class="ed2-menu__libelle">Historique du fichier</span>
    </button>
  </MenuDeroulant>
</template>
