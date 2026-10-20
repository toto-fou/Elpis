<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/page/MenuSlash.vue — menu « / » du composeur : commandes, valeurs, prompts, skills. -->
<script setup lang="ts">
import { useTemplateRef } from "vue";

import { suivreLigneActive } from "../../../features/chat/composeur/ligne-active";
import { CLE_COMPOSEUR, domaine } from "../../../features/chat/page/domaines";

const comp = domaine(CLE_COMPOSEUR);
suivreLigneActive(useTemplateRef<HTMLUListElement>("liste"), () => comp.slashIdx, "li[data-slash-row]");
</script>

<template>
  <transition name="fade">
    <div
      v-if="comp.showSlash"
      :data-slash-level="comp.slashLevel"
      class="absolute bottom-full left-0 right-0 mb-2 bg-white border border-slate-200 rounded-xl shadow-2xl z-50 overflow-hidden"
    >
      <div
        class="elpis-slash-head px-3 py-2 text-xs font-semibold border-b border-slate-100 flex items-center gap-2 bg-slate-50"
      >
        <i class="ph text-blue-500" :class="comp.slashHeaderIcon"></i>
        {{ comp.slashHeaderLabel }}
        <span v-if="comp.slashRaw && comp.slashRaw.name" class="elpis-slash-cmd font-mono">{{
          comp.slashHeaderCmd
        }}</span>
        <span class="ml-auto normal-case font-normal">↑↓ Tab/Entrée · Échap</span>
      </div>
      <ul
        id="slash-list"
        ref="liste"
        class="max-h-52 overflow-y-auto custom-scrollbar py-1"
        :style="comp.slashLevel === 'values' ? { maxHeight: '20rem' } : undefined"
      >
        <li
          v-for="(item, i) in comp.slashList"
          :key="comp.slashRowKey(item, i)"
          data-slash-row
          :title="comp.slashRowTitle(item)"
          :class="[
            comp.slashIdx === i ? 'bg-blue-50 elpis-slash-on' : 'text-slate-700 hover:bg-slate-50',
            comp.slashCmdOk(item) ? '' : 'opacity-50',
          ]"
          class="flex items-center gap-2.5 px-3 py-1.5 cursor-pointer transition-colors text-sm"
          @click="comp.selectSlash(item)"
          @mouseover="comp.slashSetIdx(i)"
        >
          <template v-if="comp.slashLevel === 'commands'">
            <i class="ph shrink-0 text-blue-400" :class="item.icon" style="font-size: 16px"></i>
            <div class="flex-1 min-w-0 leading-tight">
              <div class="font-mono text-xs font-medium truncate">
                /{{ item.name
                }}<span
                  v-if="item.args && item.args.length"
                  class="elpis-slash-detail text-[10px] font-normal"
                >
                  ⟨{{ item.args[0]?.label }}⟩</span
                ><span class="elpis-slash-detail text-[10px] font-normal"> · {{ item.label }}</span>
              </div>
              <div class="elpis-slash-detail text-[10px] truncate">{{ item.desc }}</div>
            </div>
          </template>

          <template v-else-if="comp.slashLevel === 'values'">
            <i
              class="ph shrink-0 text-blue-400"
              :class="item.icone || 'ph-caret-right'"
              style="font-size: 16px"
            ></i>
            <div class="flex-1 min-w-0 leading-tight">
              <div class="font-mono text-xs font-medium truncate">
                {{ item.value
                }}<span v-if="item.indice" class="elpis-slash-detail text-[10px] font-normal">
                  ({{ item.indice }})</span
                ><span class="elpis-slash-detail text-[10px] font-normal"> · {{ item.label }}</span>
              </div>
            </div>
          </template>

          <template v-else-if="comp.slashLevel === 'prompts'">
            <i class="ph ph-bookmark-simple shrink-0 text-blue-400" style="font-size: 16px"></i>
            <div class="flex-1 min-w-0 leading-tight">
              <div class="text-xs font-medium truncate">{{ item.title }}</div>
              <div class="text-[10px] text-slate-400 truncate">{{ comp.promptPreview(item) }}</div>
            </div>
            <span
              v-if="item.shared"
              class="px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 text-[10px] font-mono shrink-0"
              >partagé</span
            >
          </template>

          <template v-else>
            <i class="ph ph-graduation-cap shrink-0 text-blue-400" style="font-size: 16px"></i>
            <div class="flex-1 min-w-0 leading-tight">
              <div class="font-mono text-xs font-medium truncate">
                {{ item.name
                }}<span v-if="item.domain" class="text-[10px] text-slate-400 font-normal">
                  · {{ item.domain }}</span
                >
              </div>
              <div class="text-[10px] text-slate-400 truncate">{{ item.description }}</div>
            </div>
          </template>

          <i v-if="comp.slashIdx === i" class="ph ph-arrow-bend-down-left text-blue-400 text-xs shrink-0"></i>
        </li>
      </ul>
    </div>
  </transition>
</template>
