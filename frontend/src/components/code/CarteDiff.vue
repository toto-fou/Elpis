<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/code/CarteDiff.vue — carte diff du transcript opencode : fichiers colorisés, repli au-delà de douze lignes. -->
<script setup lang="ts">
import { computed, ref } from "vue";

import { PLIAGE_DIFF, analyserDiff, classeLigneDiff } from "../../features/code/rendu";
import type { FichierDiff } from "../../features/code/rendu";

const props = withDefaults(defineProps<{ cid?: string; text?: string }>(), { cid: "", text: "" });

const expanded = ref<Record<number, boolean>>({});
const files = computed(() => analyserDiff(props.cid, props.text));
const fold = PLIAGE_DIFF;

const lines = (f: FichierDiff, i: number) =>
  expanded.value[i] || f.lines.length <= PLIAGE_DIFF ? f.lines : f.lines.slice(0, PLIAGE_DIFF);
const hidden = (f: FichierDiff, i: number): number =>
  expanded.value[i] ? 0 : Math.max(0, f.lines.length - PLIAGE_DIFF);
const isOpen = (i: number): boolean => !!expanded.value[i];
function toggle(i: number): void {
  expanded.value = { ...expanded.value, [i]: !expanded.value[i] };
}
const lineClass = classeLigneDiff;
</script>

<template>
  <div class="diff-rows space-y-2 w-full">
    <div v-for="(f, fi) in files" :key="fi" class="diff-file-block">
      <div class="flex items-center gap-2 px-2.5 py-1.5 border-b border-slate-100">
        <i class="ph ph-file-code text-slate-400 shrink-0"></i>
        <span class="font-mono text-[11.5px] text-slate-700 truncate">{{ f.path || "diff" }}</span>
        <span class="ml-auto font-mono text-[11px] tabular-nums shrink-0">
          <span class="text-emerald-600">+{{ f.additions }}</span>
          <span class="text-rose-500 ml-1.5">−{{ f.deletions }}</span>
        </span>
      </div>
      <div class="elpis-code-diff custom-scrollbar">
        <div v-for="(l, li) in lines(f, fi)" :key="li" :class="lineClass(l.t)">{{ l.text }}</div>
      </div>
      <button
        v-if="hidden(f, fi)"
        class="w-full px-2.5 py-1 text-[11px] text-slate-400 hover:text-slate-700 hover:bg-slate-50 border-t border-slate-100 flex items-center gap-1.5 transition-colors"
        @click="toggle(fi)"
      >
        <i class="ph ph-caret-down" style="font-size: 9px"></i>
        Afficher les {{ hidden(f, fi) }} lignes restantes
      </button>
      <button
        v-else-if="isOpen(fi) && f.lines.length > fold"
        class="w-full px-2.5 py-1 text-[11px] text-slate-400 hover:text-slate-700 hover:bg-slate-50 border-t border-slate-100 flex items-center gap-1.5 transition-colors"
        @click="toggle(fi)"
      >
        <i class="ph ph-caret-up" style="font-size: 9px"></i>
        Replier le diff
      </button>
    </div>
  </div>
</template>
