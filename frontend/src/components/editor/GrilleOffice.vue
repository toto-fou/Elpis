<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/editor/GrilleOffice.vue — grille xlsx en lecture seule de l'éditeur, virtualisée en lignes et colonnes, servie par morceaux (LRU de 30, requêtes annulées, un seul requestAnimationFrame par salve, observateur libéré au démontage). -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from "vue";

import { chunksFor, colName, colWindow, createLru, prefixSums, rowWindow } from "../../utils/office-model";
import type { Lru } from "../../utils/office-model";

export interface FeuilleOffice {
  name: string;
  rows: number;
  cols: number;
  chunks: number;
  widths?: number[];
  hidden?: boolean;
  truncated?: boolean;
}

type Ligne = unknown[];

const props = withDefaults(
  defineProps<{
    docKey: string;
    sheets: FeuilleOffice[];
    chunkSize?: number;
    fetchChunk: (cle: string, feuille: number, morceau: number, signal: AbortSignal) => Promise<unknown>;
  }>(),
  { chunkSize: 200 },
);

const ROW_H = 22;
const HEAD_H = 22;
const CHAR_PX = 7;
const CELL_PAD = 14;
const LRU_MAX = 30;
const NUMERIQUE = /^[-+]?[\d\s .,]+(%|\s?[€$£])?$/;

const scroller = useTemplateRef<HTMLDivElement>("scroller");
const scrollTop = ref(0);
const scrollLeft = ref(0);
const viewW = ref(800);
const viewH = ref(400);
const version = ref(0);
const failed = ref(0);

function premiereVisible(): number {
  const i = (props.sheets || []).findIndex((s) => !s.hidden);
  return i >= 0 ? i : 0;
}
const sheetIdx = ref(premiereVisible());

let cache: Lru<Ligne[]> = createLru<Ligne[]>(LRU_MAX);
const enVol = new Map<string, AbortController>();
let rafId: number | null = null;
let observateur: ResizeObserver | null = null;
let vivant = true;

const sheet = computed<FeuilleOffice | null>(() => (props.sheets || [])[sheetIdx.value] ?? null);
const largeurs = computed(() => {
  const s = sheet.value;
  if (!s) return [];
  const w = s.widths || [];
  const out: number[] = [];
  for (let i = 0; i < s.cols; i++) out.push((w[i] || 6) * CHAR_PX + CELL_PAD);
  return out;
});
const prefixe = computed(() => prefixSums(largeurs.value));
const rownumW = computed(() => Math.max(40, String(sheet.value ? sheet.value.rows : 0).length * 8 + 18));
const totalW = computed(() => rownumW.value + (prefixe.value[prefixe.value.length - 1] ?? 0));
const totalH = computed(() => HEAD_H + (sheet.value ? sheet.value.rows : 0) * ROW_H);

const fenetreLignes = computed(() =>
  rowWindow(scrollTop.value, viewH.value - HEAD_H, ROW_H, sheet.value ? sheet.value.rows : 0, 6),
);
const fenetreColonnes = computed(() =>
  colWindow(scrollLeft.value, Math.max(0, viewW.value - rownumW.value), prefixe.value, 2),
);

const cols = computed(() => {
  const out: Array<{ c: number; name: string; left: number; width: number }> = [];
  for (let c = fenetreColonnes.value.start; c < fenetreColonnes.value.end; c++) {
    out.push({
      c,
      name: colName(c),
      left: rownumW.value + (prefixe.value[c] ?? 0),
      width: largeurs.value[c] ?? 0,
    });
  }
  return out;
});

function cleMorceau(s: number, c: number): string {
  return props.docKey + ":" + s + ":" + c;
}

const visibleRows = computed(() => {
  void version.value;
  const s = sheet.value;
  const out: Array<{
    r: number;
    top: number;
    loaded: boolean;
    cells: Array<{ c: number; left: number; width: number; text: string; num: boolean; long: boolean }>;
  }> = [];
  if (!s) return out;
  for (let r = fenetreLignes.value.start; r < fenetreLignes.value.end; r++) {
    const morceau = cache.get(cleMorceau(sheetIdx.value, Math.floor(r / props.chunkSize)));
    const ligne = morceau ? (morceau[r % props.chunkSize] ?? []) : null;
    const cells = cols.value.map((col) => {
      const v = ligne ? ligne[col.c] : null;
      const text = v == null ? "" : String(v);
      return {
        c: col.c,
        left: col.left,
        width: col.width,
        text,
        num: text !== "" && NUMERIQUE.test(text),
        long: text.length * CHAR_PX > col.width - CELL_PAD || text.indexOf("\n") >= 0,
      };
    });
    out.push({ r, top: HEAD_H + r * ROW_H, loaded: !!ligne, cells });
  }
  return out;
});

function toutAnnuler(): void {
  enVol.forEach((ac) => ac.abort());
  enVol.clear();
}

function assurerMorceaux(): void {
  const s = sheet.value;
  if (!s || !s.rows || !vivant) return;
  const idx = sheetIdx.value;
  const cle = props.docKey;
  for (const c of chunksFor(fenetreLignes.value.start, fenetreLignes.value.end, props.chunkSize)) {
    const k = cleMorceau(idx, c);
    if (cache.has(k) || enVol.has(k) || c >= s.chunks) continue;
    const ac = new AbortController();
    enVol.set(k, ac);
    props
      .fetchChunk(cle, idx, c, ac.signal)
      .then((lignes) => {
        if (!vivant || ac.signal.aborted || cle !== props.docKey) return;
        cache.set(k, Array.isArray(lignes) ? (lignes as Ligne[]) : []);
        version.value++;
      })
      .catch(() => {
        if (!vivant || ac.signal.aborted) return;
        failed.value++;
      })
      .finally(() => {
        if (enVol.get(k) === ac) enVol.delete(k);
      });
  }
}

function onScroll(): void {
  if (rafId != null) return;
  rafId = globalThis.requestAnimationFrame(() => {
    rafId = null;
    const el = scroller.value;
    if (!el) return;
    scrollTop.value = el.scrollTop;
    scrollLeft.value = el.scrollLeft;
  });
}

function mesurer(): void {
  const el = scroller.value;
  if (!el) return;
  viewW.value = el.clientWidth;
  viewH.value = el.clientHeight;
}

function selectSheet(i: number): void {
  if (i === sheetIdx.value) return;
  toutAnnuler();
  sheetIdx.value = i;
  failed.value = 0;
  const el = scroller.value;
  if (el) {
    el.scrollTop = 0;
    el.scrollLeft = 0;
  }
  scrollTop.value = 0;
  scrollLeft.value = 0;
}

watch(
  () => [fenetreLignes.value.start, fenetreLignes.value.end, sheetIdx.value, props.docKey],
  assurerMorceaux,
);
watch(
  () => props.docKey,
  () => {
    toutAnnuler();
    cache.clear();
    cache = createLru<Ligne[]>(LRU_MAX);
    sheetIdx.value = premiereVisible();
    version.value++;
  },
);

onMounted(() => {
  mesurer();
  if (typeof ResizeObserver !== "undefined" && scroller.value) {
    observateur = new ResizeObserver(() => mesurer());
    observateur.observe(scroller.value);
  }
  assurerMorceaux();
});
onBeforeUnmount(() => {
  vivant = false;
  toutAnnuler();
  cache.clear();
  if (rafId != null) globalThis.cancelAnimationFrame(rafId);
  rafId = null;
  observateur?.disconnect();
  observateur = null;
});

defineExpose({ failed });
</script>

<template>
  <div class="flex flex-col h-full min-h-0 bg-[#1e1e1e]">
    <div
      ref="scroller"
      class="flex-1 min-h-0 overflow-auto custom-scrollbar outline-none"
      tabindex="0"
      role="grid"
      :aria-label="sheet ? 'Feuille ' + sheet.name : 'Feuille'"
      @scroll.passive="onScroll"
    >
      <div
        v-if="sheet && sheet.rows"
        class="relative"
        :style="{ width: totalW + 'px', height: totalH + 'px' }"
      >
        <div
          class="sticky top-0 z-20 flex bg-[#252526] border-b border-white/10"
          :style="{ width: totalW + 'px', height: HEAD_H + 'px' }"
        >
          <div
            class="sticky left-0 z-10 shrink-0 bg-[#252526] border-r border-white/10"
            :style="{ width: rownumW + 'px' }"
          ></div>
          <div
            v-for="col in cols"
            :key="col.c"
            role="columnheader"
            class="absolute top-0 h-full flex items-center justify-center text-[10.5px] font-mono text-slate-400 border-r border-white/10 select-none"
            :style="{ left: col.left + 'px', width: col.width + 'px' }"
            v-text="col.name"
          ></div>
        </div>
        <div
          v-for="row in visibleRows"
          :key="row.r"
          role="row"
          class="absolute left-0 flex"
          :style="{ top: row.top + 'px', width: totalW + 'px', height: ROW_H + 'px' }"
        >
          <div
            class="sticky left-0 z-10 shrink-0 bg-[#252526] border-r border-b border-white/10 text-[10.5px] font-mono text-slate-500 flex items-center justify-end pr-2 select-none"
            :style="{ width: rownumW + 'px' }"
            v-text="row.r + 1"
          ></div>
          <div
            v-for="cell in row.cells"
            :key="cell.c"
            role="gridcell"
            class="absolute top-0 h-full px-[7px] flex items-center border-r border-b border-white/[0.06] text-[12px] text-slate-200 whitespace-nowrap overflow-hidden"
            :class="cell.num ? 'justify-end tabular-nums' : ''"
            :style="{ left: cell.left + 'px', width: cell.width + 'px' }"
            :title="cell.long ? cell.text : undefined"
          >
            <span class="truncate" v-text="cell.text"></span>
          </div>
        </div>
      </div>
      <div v-else class="h-full flex items-center justify-center text-xs text-slate-500">Feuille vide</div>
    </div>
    <div
      v-if="props.sheets.length > 1 || (sheet && sheet.truncated)"
      role="tablist"
      aria-label="Feuilles"
      class="shrink-0 h-8 flex items-center gap-1 px-2 border-t border-white/10 bg-[#252526] overflow-x-auto custom-scrollbar"
    >
      <button
        v-for="(s, i) in props.sheets"
        :key="i"
        role="tab"
        :aria-selected="i === sheetIdx ? 'true' : 'false'"
        :title="s.hidden ? 'Feuille masquée : ' + s.name : s.name"
        class="shrink-0 h-6 px-2.5 rounded text-[11px] flex items-center gap-1.5 max-w-[14rem]"
        :class="i === sheetIdx ? 'bg-white/10 text-white' : 'text-slate-400 hover:bg-white/5'"
        @click="selectSheet(i)"
      >
        <i v-if="s.hidden" class="ph ph-eye-slash text-[11px]"></i>
        <span class="truncate" :class="s.hidden ? 'italic' : ''" v-text="s.name"></span>
      </button>
      <span
        v-if="sheet && sheet.truncated"
        class="ml-auto shrink-0 text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300"
        title="Aperçu limité : 100 000 lignes, 512 colonnes, 1 000 caractères par cellule"
        >Tronqué</span
      >
    </div>
  </div>
</template>
