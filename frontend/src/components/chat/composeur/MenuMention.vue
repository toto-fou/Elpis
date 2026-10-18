<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/composeur/MenuMention.vue — liste « @ » des fichiers de la sandbox : récents puis tous, pages au défilement, ligne active gardée visible. -->
<script setup lang="ts">
import { useTemplateRef } from "vue";

import { suivreLigneActive } from "../../../features/chat/composeur/ligne-active";

import {
  mentionDirOf,
  mentionFilenameOf,
  mentionIconClass,
} from "../../../features/chat/composeur/composeur";
import type { FichierMention } from "../../../features/chat/composeur/composeur";

const props = defineProps<{
  ouvert: boolean;
  requete: string;
  fichiers: readonly FichierMention[];
  index: number;
  recents: number;
  chargement: boolean;
  encore: boolean;
}>();
const emit = defineEmits<{ choisir: [f: FichierMention]; survol: [i: number]; defiler: [e: Event] }>();
const liste = useTemplateRef<HTMLUListElement>("liste");

suivreLigneActive(liste, () => props.index, "li[data-mention-row]");
</script>

<template>
  <transition name="fade">
    <div
      v-if="props.ouvert"
      class="absolute bottom-full left-0 right-0 mb-2 bg-white border border-slate-200 rounded-xl shadow-2xl z-50 overflow-hidden"
    >
      <div
        class="px-3 py-2 text-xs font-semibold text-slate-500 border-b border-slate-100 flex items-center gap-2 bg-slate-50"
      >
        <i class="ph ph-at text-blue-500"></i>
        Insérer un fichier
        <span v-if="props.requete" class="text-blue-600 font-mono">{{ props.requete }}</span>
        <span class="ml-auto text-slate-300 normal-case font-normal">↑↓ Entrée · Échap</span>
      </div>
      <div v-if="props.chargement" class="flex items-center justify-center py-5 text-slate-400">
        <i class="ph ph-spinner animate-spin text-lg mr-2"></i> Chargement...
      </div>
      <div v-else-if="props.fichiers.length === 0" class="py-5 text-center text-xs text-slate-400">
        Aucun fichier trouvé
      </div>
      <ul
        v-else
        id="mention-list"
        ref="liste"
        class="max-h-52 overflow-y-auto custom-scrollbar py-1"
        @scroll.passive="emit('defiler', $event)"
      >
        <template v-for="(f, i) in props.fichiers" :key="f.path">
          <li
            v-if="i === 0 && props.recents > 0"
            class="px-3 pt-1.5 pb-0.5 text-[11px] font-semibold text-slate-500 pointer-events-none select-none"
          >
            Récents
          </li>
          <li
            v-if="i === props.recents && props.recents > 0 && i < props.fichiers.length"
            class="px-3 pt-2 pb-0.5 text-[11px] font-semibold text-slate-500 pointer-events-none select-none border-t border-slate-100 mt-1"
          >
            Tous
          </li>
          <li
            data-mention-row
            :class="props.index === i ? 'bg-blue-50 text-blue-700' : 'text-slate-700 hover:bg-slate-50'"
            class="flex items-center gap-2.5 px-3 py-1.5 cursor-pointer transition-colors text-sm"
            @click="emit('choisir', f)"
            @mouseover="emit('survol', i)"
          >
            <i
              class="ph shrink-0"
              :class="[mentionIconClass(f.name || f.path).icon, mentionIconClass(f.name || f.path).color]"
              style="font-size: 18px"
            ></i>
            <div class="flex-1 min-w-0 leading-tight">
              <div class="font-mono text-xs font-medium truncate">{{ mentionFilenameOf(f.path) }}</div>
              <div class="font-mono text-[10px] text-slate-400 truncate">{{ mentionDirOf(f.path) }}</div>
            </div>
            <i v-if="props.index === i" class="ph ph-arrow-bend-down-left text-blue-400 text-xs shrink-0"></i>
          </li>
        </template>
        <li
          v-if="props.encore"
          class="flex items-center justify-center gap-1.5 px-3 py-1.5 text-[10px] text-slate-400 italic"
        >
          <i class="ph ph-dots-three-outline text-xs"></i> Faire défiler pour afficher plus
        </li>
      </ul>
    </div>
  </transition>
</template>
