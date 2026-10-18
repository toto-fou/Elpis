<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/editor/BandeauxEditeur.vue — fil d'Ariane du fichier actif et bandeau de protection (proposition de l'IA, copie de secours, encodage, conflit disque). -->
<script setup lang="ts">
import { domaineEditeur } from "../../features/editor/domaine";

const ed = domaineEditeur();
</script>

<template>
  <nav
    v-if="ed.editorMode === 'code' && ed.breadcrumbSegments.length"
    aria-label="Chemin du fichier"
    class="h-6 shrink-0 bg-[#1e1e1e] border-b border-black/20 flex items-center px-2 overflow-x-auto no-scrollbar text-[11px] text-slate-500 font-mono"
  >
    <template v-for="(seg, i) in ed.breadcrumbSegments" :key="seg.prefix">
      <i v-if="i > 0" class="ph ph-caret-right text-[8px] text-slate-600 mx-0.5 shrink-0"></i>
      <button
        v-if="!seg.isLast"
        class="shrink-0 hover:text-slate-200 transition-colors px-0.5 rounded"
        @click="ed.revealFolderInTree(seg.prefix)"
      >
        {{ seg.name }}
      </button>
      <button
        v-else
        title="Localiser dans l'arbre (Alt+L)"
        class="shrink-0 text-slate-300 hover:text-white transition-colors px-0.5 rounded"
        @click="ed.revealActiveInTree()"
      >
        {{ seg.name }}
      </button>
    </template>
  </nav>
  <div
    v-if="ed.editorMode === 'code' && (ed.aiProposal || ed.activeBanner)"
    role="status"
    class="elpis-editor-banner shrink-0"
    :class="ed.aiProposal ? 'elpis-editor-banner--ai' : ''"
  >
    <template v-if="ed.aiProposal">
      <i class="ph ph-sparkle text-sm shrink-0"></i>
      <span class="truncate flex-1" :title="ed.aiProposal.label + ' : la proposition est à droite du diff'"
        >{{ ed.aiProposal.label }} — proposition à droite</span
      >
      <button class="elpis-banner-btn" @click="ed.rejectAiProposal()">Rejeter</button>
      <button class="elpis-banner-btn elpis-banner-btn--primary" @click="ed.acceptAiProposal()">
        Accepter
      </button>
    </template>
    <template v-else-if="ed.activeBanner?.kind === 'stash'">
      <i class="ph ph-lifebuoy text-sm shrink-0"></i>
      <span
        class="truncate flex-1"
        title="L'assistant a réécrit ce fichier ; vos modifications non enregistrées sont gardées à part"
        >Réécrit par l'assistant — vos modifications sont gardées</span
      >
      <button class="elpis-banner-btn" @click="ed.stashCompare()">Comparer</button>
      <button class="elpis-banner-btn elpis-banner-btn--primary" @click="ed.stashRestore()">Restaurer</button>
      <button
        class="elpis-banner-x"
        title="Garder la version de l'assistant"
        aria-label="Fermer"
        @click="ed.stashDismiss()"
      >
        <i class="ph ph-x"></i>
      </button>
    </template>
    <template v-else-if="ed.activeBanner?.kind === 'encoding'">
      <i class="ph ph-text-aa text-sm shrink-0"></i>
      <span
        class="truncate flex-1"
        title="Le fichier n'est pas en UTF-8 : l'enregistrer depuis l'éditeur remplacerait ses caractères accentués. Convertissez-le (iconv) depuis le terminal pour l'éditer."
        >Encodage non UTF-8 — lecture seule</span
      >
    </template>
    <template v-else>
      <i class="ph ph-warning text-sm shrink-0"></i>
      <span
        class="truncate flex-1"
        :title="
          ed.activeBanner?.kind === 'missing'
            ? 'Le fichier a été supprimé du disque ; vos modifications sont intactes dans l\'onglet'
            : 'Le fichier a changé sur le disque ; vos modifications sont intactes dans l\'onglet'
        "
        >{{ ed.activeBanner?.kind === "missing" ? "Supprimé du disque" : "Modifié sur le disque" }}</span
      >
      <button
        v-if="ed.activeBanner?.kind !== 'missing'"
        class="elpis-banner-btn"
        @click="ed.conflictCompare()"
      >
        Comparer
      </button>
      <button
        v-if="ed.activeBanner?.kind !== 'missing'"
        class="elpis-banner-btn"
        @click="ed.conflictReload()"
      >
        Recharger
      </button>
      <button class="elpis-banner-btn elpis-banner-btn--primary" @click="ed.conflictOverwrite()">
        {{ ed.activeBanner?.kind === "missing" ? "Recréer" : "Écraser" }}
      </button>
      <button class="elpis-banner-x" title="Masquer" aria-label="Fermer" @click="ed.conflictDismiss()">
        <i class="ph ph-x"></i>
      </button>
    </template>
  </div>
</template>
