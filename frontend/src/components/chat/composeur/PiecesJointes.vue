<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/composeur/PiecesJointes.vue — puces des pièces jointes du composeur (mention de fichier, image, fichier) et leur retrait. -->
<script setup lang="ts">
import type { PieceJointe } from "../../../features/chat/composeur/composeur";

const props = defineProps<{ fichiers: readonly PieceJointe[] }>();
const emit = defineEmits<{ retirer: [index: number] }>();

function nomCourt(chemin: string): string {
  return chemin.split("/").pop() ?? "";
}
</script>

<template>
  <div v-if="props.fichiers.length > 0" class="flex flex-wrap gap-2 px-3 pt-3 pb-1">
    <div
      v-for="(file, index) in props.fichiers"
      :key="file._uid || file.name + ':' + index"
      class="relative group/file"
    >
      <div
        class="shadow-sm border transition-colors"
        :class="[
          file.isImage ? 'rounded-md overflow-hidden' : 'file-chip',
          file.isMention
            ? 'w-20 h-24 bg-blue-50 border-blue-200 hover:border-blue-400 flex flex-col file-chip-mention'
            : file.isImage
              ? 'w-20 h-20 border-slate-200 hover:border-blue-300 bg-slate-100'
              : 'w-20 h-24 bg-white border-slate-200 hover:border-slate-300 flex flex-col',
        ]"
      >
        <template v-if="file.isMention">
          <div class="flex-1 flex items-center justify-center pt-3">
            <i
              class="ph text-2xl"
              :class="[
                { 'ph-file-js text-yellow-400': file.name.endsWith('.js') || file.name.endsWith('.mjs') },
                { 'ph-file-ts text-blue-400': file.name.endsWith('.ts') || file.name.endsWith('.tsx') },
                { 'ph-browsers text-orange-500': file.name.endsWith('.html') },
                { 'ph-paint-brush text-sky-400': file.name.endsWith('.css') },
                { 'ph-brackets-curly text-lime-500': file.name.endsWith('.json') },
                { 'ph-file-py text-blue-500': file.name.endsWith('.py') },
                { 'ph-terminal-window text-green-500': file.name.endsWith('.sh') },
                { 'ph-info text-slate-400': file.name.endsWith('.md') },
                { 'ph-file-text text-slate-500': file.name.endsWith('.txt') },
                {
                  'ph-file text-blue-400': !file.name.match(/\.(js|mjs|ts|tsx|html|css|json|py|sh|md|txt)$/),
                },
              ]"
            >
            </i>
          </div>
          <div class="px-2 pt-1.5">
            <span
              class="block text-[10px] font-medium text-slate-800 leading-tight truncate text-center"
              :title="file.name"
              >{{ nomCourt(file.name).replace(/\.[^.]+$/, "") }}</span
            >
          </div>
          <div class="flex items-center justify-between px-2 pb-1.5 pt-1">
            <span class="text-[10px] font-medium uppercase text-slate-500">{{
              file.name.split(".").pop()
            }}</span>
            <span class="text-[9px] text-slate-400 font-mono"
              >{{ (file.content || "").split("\n").length }}L</span
            >
          </div>
        </template>
        <template v-else-if="file.isImage">
          <img :src="file.content" :alt="file.name" class="w-full h-full object-cover" />
          <div class="absolute bottom-0 left-0 right-0 bg-black/50 px-1.5 py-0.5">
            <span class="text-[9px] text-white font-medium truncate block">{{ file.name }}</span>
          </div>
        </template>
        <template v-else>
          <div class="flex-1 flex items-center justify-center pt-3">
            <i class="ph ph-file-text text-slate-400 text-2xl"></i>
          </div>
          <div class="px-2 pt-1.5">
            <span
              class="block text-[10px] font-medium text-slate-800 leading-tight truncate text-center"
              :title="file.name"
              >{{ file.name.replace(/\.[^.]+$/, "") }}</span
            >
          </div>
          <div class="flex items-center justify-between px-2 pb-1.5 pt-1">
            <span class="text-[10px] font-medium uppercase text-slate-500">{{
              file.name.split(".").pop()
            }}</span>
            <span v-if="file.content" class="text-[9px] text-slate-400 font-mono"
              >{{ file.content.split("\n").length }}L</span
            >
          </div>
        </template>
      </div>
      <button
        class="absolute -top-1.5 -right-1.5 w-5 h-5 flex items-center justify-center rounded-full opacity-0 group-hover/file:opacity-100 focus-visible:opacity-100 transition-all z-20 bg-slate-700 text-white hover:bg-slate-900 shadow-md"
        @click="emit('retirer', index)"
      >
        <i class="ph ph-x text-[10px]"></i>
      </button>
    </div>
  </div>
</template>
