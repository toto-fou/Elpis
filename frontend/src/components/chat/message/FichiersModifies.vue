<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/message/FichiersModifies.vue — lignes « Fichiers modifiés » d'une réponse : statistiques, diff déplié, téléchargements. -->
<script setup lang="ts">
import { computed } from "vue";

import { CLE_FIL, domaine } from "../../../features/chat/page/domaines";
import type { EntreeMessage } from "../../../features/chat/message/types";

const props = defineProps<{ entry: EntreeMessage }>();
const fil = domaine(CLE_FIL);
// Une seule lecture par rendu (la liste programme aussi le calcul des statistiques).
const fichiers = computed(() => fil.diffFilesFor(props.entry.msg, props.entry.idx));
const aTelecharger = computed(() => fichiers.value.filter((f) => f.change !== "deleted").map((f) => f.path));
</script>

<template>
  <template v-if="!entry.msg.isStreaming && !fil.isDiffEditorEnabled() && fil.hasDiffFiles(entry.msg)">
    <div class="mt-3 diff-rows space-y-1">
      <p class="text-[11.5px] text-slate-500 mb-1.5 ml-0.5">Fichiers modifiés</p>

      <template v-for="file in fichiers" :key="file.path">
        <div class="diff-file-block">
          <div
            class="diff-row-flat diff-row-flat--clickable group"
            role="button"
            tabindex="0"
            :aria-expanded="file.open ? 'true' : 'false'"
            :aria-label="'Voir le diff de ' + file.name"
            @click="fil.onDiffRowClick(entry.idx, file)"
            @keydown.enter.prevent="fil.onDiffRowClick(entry.idx, file)"
            @keydown.space.prevent="fil.onDiffRowClick(entry.idx, file)"
          >
            <i
              class="ph text-base shrink-0 self-start mt-0.5"
              :class="
                file.change === 'created'
                  ? 'ph-file-plus text-emerald-600'
                  : file.change === 'deleted'
                    ? 'ph-file-minus text-rose-500'
                    : file.change === 'moved'
                      ? 'ph-arrow-bend-up-right text-slate-500'
                      : 'ph-file-code text-slate-500'
              "
            ></i>

            <div class="flex-1 min-w-0">
              <div class="text-[12.5px] font-medium text-slate-800 truncate">
                {{ file.name }}
                <span v-if="file.change === 'created'" class="ml-1 text-[10.5px] font-normal text-emerald-600"
                  >créé</span
                >
                <span
                  v-else-if="file.change === 'deleted'"
                  class="ml-1 text-[10.5px] font-normal text-rose-500"
                  >supprimé</span
                >
                <span
                  v-else-if="file.change === 'moved'"
                  class="ml-1 text-[10.5px] font-normal text-slate-500"
                  >déplacé</span
                >
              </div>
              <div class="mt-0.5 flex items-center gap-2 text-[11px] font-mono min-w-0">
                <span v-if="file.loading" class="text-slate-400 inline-flex items-center gap-1">
                  <i class="ph ph-spinner-gap animate-spin"></i>
                </span>
                <span v-else-if="file.error" class="text-amber-500" :title="file.error"
                  ><i class="ph ph-warning-circle"></i
                ></span>
                <template v-else-if="file.computed && !file.noStats">
                  <span v-if="file.additions > 0" class="text-emerald-600">+{{ file.additions }}</span>
                  <span v-if="file.deletions > 0" class="text-rose-500">-{{ file.deletions }}</span>
                  <span v-if="!file.additions && !file.deletions" class="text-slate-300"
                    >aucun changement</span
                  >
                </template>
                <span
                  v-if="file.change === 'moved' && file.from"
                  class="text-slate-400 truncate"
                  :title="file.from"
                  >depuis {{ file.from }}</span
                >
                <template v-else-if="file.dir">
                  <span v-if="file.computed || file.loading || file.error" class="text-slate-300">·</span>
                  <span class="text-slate-400 truncate">{{ file.dir }}</span>
                </template>
              </div>
            </div>

            <button
              v-if="file.change !== 'deleted'"
              type="button"
              class="diff-download-btn shrink-0 self-start mt-0.5"
              :title="'Télécharger ' + file.name"
              @click.stop="fil.downloadOneFile(file.path)"
            >
              <i class="ph ph-download-simple text-[13px]"></i>
              <span>Télécharger</span>
            </button>
          </div>

          <div
            v-if="file.open && file.lines"
            class="diff-inline mt-1 ml-2 max-h-80 overflow-auto rounded-md border border-slate-200 bg-slate-50 text-[11px] font-mono leading-snug"
          >
            <div
              v-for="(ln, li) in file.lines"
              :key="li"
              class="px-2 whitespace-pre"
              :class="
                ln.t === '+'
                  ? 'bg-emerald-50 text-emerald-800'
                  : ln.t === '-'
                    ? 'bg-rose-50 text-rose-800'
                    : ln.t === '@'
                      ? 'text-slate-400 bg-slate-100'
                      : 'text-slate-600'
              "
            >
              {{ (ln.t === "@" ? "" : ln.t) + ln.text }}
            </div>
            <div v-if="!file.lines.length" class="px-2 py-1 text-slate-400">aucun changement</div>
            <div v-if="file.truncated" class="px-2 py-1 text-slate-400">diff tronqué</div>
          </div>
        </div>
      </template>

      <div v-if="aTelecharger.length >= 2" class="pt-1 flex justify-end">
        <button
          type="button"
          class="text-[11px] text-slate-500 hover:text-slate-700 inline-flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-slate-100 transition-colors"
          @click="fil.downloadAllFilesAsZip(aTelecharger, 'files.zip')"
        >
          <i class="ph ph-file-zip text-[12px]"></i>
          Tout télécharger
        </button>
      </div>
    </div>
  </template>
</template>
