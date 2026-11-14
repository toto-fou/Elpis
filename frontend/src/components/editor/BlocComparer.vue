<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/editor/BlocComparer.vue — bloc « Comparer avec » des menus Plus et Versions de l'éditeur lié au skin : sauvegarde, dernier commit, original. -->
<script setup lang="ts">
import { domaineEditeur } from "../../features/editor/domaine";

const ed = domaineEditeur();
const compare = (base: string): boolean => ed.isDiffView && ed.diffBase === base;
</script>

<template>
  <div class="ed2-menu__titre">Comparer avec</div>
  <button
    role="menuitemcheckbox"
    class="ed2-menu__item"
    :aria-checked="compare('saved') ? 'true' : 'false'"
    @click="ed.toggleDiffMode('saved')"
  >
    <i class="ph ph-floppy-disk" aria-hidden="true"></i><span class="ed2-menu__libelle">La sauvegarde</span>
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
