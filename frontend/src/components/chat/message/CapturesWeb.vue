<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/message/CapturesWeb.vue — carrousel des captures du navigateur d'un message (déroulé classique) : vignette, agrandie, navigation ; caché par « Masquer les captures web ». -->
<script setup lang="ts">
import { computed, ref } from "vue";

import { CLE_FIL, domaine } from "../../../features/chat/page/domaines";
import { preferencesChat } from "../../../features/reglages/affichage-chat";

import type { CaptureWeb, EntreeMessage } from "../../../features/chat/message/types";

const props = defineProps<{ entry: EntreeMessage }>();
const fil = domaine(CLE_FIL);
const pref = preferencesChat();

const captures = computed(() => (pref.captures ? (props.entry.msg.webScreenshots ?? []) : []));
const courant = computed(() => props.entry.msg.webScreenshotIdx ?? captures.value.length - 1);
const capture = computed(() => captures.value[courant.value]);
const expirees = ref<ReadonlySet<string>>(new Set());
// Capture rechargée : lue directement sur le serveur (même origine), tant qu'elle existe.
function source(c: CaptureWeb | undefined): string {
  if (!c) return "";
  if (c.blobUrl) return c.blobUrl;
  const u = c.serverUrl ?? "";
  return u.startsWith("/api/playwright/screenshot/") && !expirees.value.has(u) ? u : "";
}
const image = computed(() => source(capture.value));
const expiree = computed(() => !image.value && !!capture.value?.serverUrl && !capture.value.pending);
function perdue(): void {
  const u = capture.value?.serverUrl;
  if (u && !capture.value?.blobUrl) expirees.value = new Set([...expirees.value, u]);
}
const enCapture = computed(() => {
  const n = captures.value.length;
  const i = props.entry.msg.webScreenshotIdx;
  return !!captures.value[n - 1]?.pending && (i == null || i === n - 1);
});
</script>

<template>
  <div
    v-if="captures.length > 0"
    class="my-2.5 transition-all duration-300 ease-out"
    :class="entry.msg.webScreenshotExpanded ? 'max-w-full' : 'max-w-[320px]'"
  >
    <div
      class="elpis-on-media relative rounded-2xl overflow-hidden group/live shadow-lg shadow-blue-500/5 ring-1 ring-slate-900/5 bg-white/70 transition-all duration-300"
      :class="entry.msg.webScreenshotExpanded ? 'hover:shadow-xl' : 'hover:shadow-xl cursor-zoom-in'"
    >
      <div
        class="absolute top-0 left-0 right-0 z-10 flex items-center gap-2 px-2.5 py-1.5 bg-gradient-to-b from-black/40 via-black/20 to-transparent pointer-events-none"
      >
        <span class="relative flex h-1.5 w-1.5 shrink-0">
          <span
            v-if="enCapture"
            class="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-300 opacity-75"
          ></span>
          <span class="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-400"></span>
        </span>
        <i class="ph ph-browser text-white/90" style="font-size: 11px"></i>
        <span v-if="capture" class="text-[10px] font-mono font-medium text-white/95 truncate">
          {{ capture?.tool }}
        </span>
        <span class="ml-auto text-[10px] text-white/80 tabular-nums">
          {{ courant + 1 }} / {{ captures.length }}
        </span>
        <button
          type="button"
          class="pointer-events-auto w-5 h-5 flex items-center justify-center rounded-md bg-white/20 hover:bg-white/30 text-white/90 transition-colors"
          @click.stop="fil.webShotToggleExpand(entry.msg)"
        >
          <i
            :class="entry.msg.webScreenshotExpanded ? 'ph ph-arrows-in-simple' : 'ph ph-arrows-out-simple'"
            style="font-size: 10px"
          ></i>
        </button>
      </div>

      <div
        v-if="!entry.msg.webScreenshotExpanded"
        class="elpis-media-canvas relative overflow-hidden"
        style="aspect-ratio: 16 / 10; min-height: 180px"
        @click.stop="fil.webShotToggleExpand(entry.msg)"
      >
        <img
          v-if="image"
          :src="image"
          alt=""
          class="absolute inset-0 w-full h-full object-cover object-top transition-opacity duration-200"
          loading="lazy"
          @error="perdue"
        />
        <span
          v-else-if="expiree"
          class="absolute inset-0 flex items-center justify-center text-[12px] text-slate-500"
          data-capture-expiree
          >Capture expirée</span
        >
      </div>

      <div
        v-else
        class="elpis-media-canvas relative flex items-center justify-center overflow-hidden"
        style="min-height: 320px; max-height: 70dvh"
      >
        <img
          v-if="image"
          :src="image"
          alt=""
          class="max-w-full max-h-full w-auto h-auto object-contain transition-opacity duration-200"
          style="max-height: 70dvh"
          loading="lazy"
          @error="perdue"
        />
        <span v-else-if="expiree" class="text-[12px] text-slate-500">Capture expirée</span>
      </div>

      <div
        v-if="enCapture"
        class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-30 pointer-events-none"
      >
        <div
          class="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/90 shadow-lg border border-white/50"
        >
          <i class="ph ph-spinner-gap animate-spin text-blue-500" style="font-size: 10px"></i>
          <span class="text-[10px] font-medium text-slate-700">capture...</span>
        </div>
      </div>

      <template v-if="captures.length > 1">
        <button
          type="button"
          class="absolute left-1.5 top-1/2 -translate-y-1/2 w-7 h-7 flex items-center justify-center rounded-full bg-white/80 hover:bg-white shadow-md ring-1 ring-slate-900/10 text-slate-700 opacity-0 group-hover/live:opacity-100 transition-all duration-200 hover:scale-110 z-20"
          @click.stop="fil.webShotPrev(entry.msg)"
        >
          <i class="ph ph-caret-left" style="font-size: 12px"></i>
        </button>
        <button
          type="button"
          class="absolute right-1.5 top-1/2 -translate-y-1/2 w-7 h-7 flex items-center justify-center rounded-full bg-white/80 hover:bg-white shadow-md ring-1 ring-slate-900/10 text-slate-700 opacity-0 group-hover/live:opacity-100 transition-all duration-200 hover:scale-110 z-20"
          @click.stop="fil.webShotNext(entry.msg)"
        >
          <i class="ph ph-caret-right" style="font-size: 12px"></i>
        </button>
      </template>

      <div
        v-if="captures.length > 1 && captures.length <= 12"
        class="absolute bottom-1.5 left-1/2 -translate-x-1/2 flex items-center gap-1 px-2 py-1 rounded-full bg-black/40 z-20"
      >
        <button
          v-for="(s, i) in captures"
          :key="i"
          type="button"
          class="rounded-full transition-all duration-200 border-0 p-0"
          :class="i === courant ? 'w-2 h-2 bg-white' : 'w-1.5 h-1.5 bg-white/50 hover:bg-white/80'"
          @click.stop="fil.webShotGoto(entry.msg, i)"
        ></button>
      </div>
      <div
        v-else-if="captures.length > 12"
        class="absolute bottom-1.5 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-full bg-black/40 text-[9px] font-mono text-white/90 z-20"
      >
        #{{ courant + 1 }} / {{ captures.length }}
      </div>
    </div>
  </div>
</template>
