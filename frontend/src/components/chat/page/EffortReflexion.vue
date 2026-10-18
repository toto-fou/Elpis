<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/page/EffortReflexion.vue — menu de l'effort de réflexion du modèle chargé. -->
<script setup lang="ts">
import { CLE_MODELES, domaine } from "../../../features/chat/page/domaines";

const mod = domaine(CLE_MODELES);
</script>

<template>
  <div v-if="!mod.imageMode && mod.reasoningEffortValues.length" class="relative shrink-0" data-effort-menu>
    <button
      aria-haspopup="listbox"
      :aria-expanded="mod.showReasoningEffortMenu ? 'true' : 'false'"
      title="Effort de réflexion"
      class="flex items-center gap-1 px-1.5 py-1 rounded-lg text-xs font-medium transition-colors text-slate-500 hover:text-slate-700 hover:bg-slate-100"
      :class="mod.showReasoningEffortMenu ? 'bg-slate-100 text-slate-700' : ''"
      @click="mod.toggleReasoningEffortMenu()"
    >
      <i class="ph ph-gauge text-xs"></i>
      <span class="max-w-[72px] truncate">{{ mod.samplingOverride.reasoning_effort || "auto" }}</span>
      <i
        class="ph ph-caret-down text-[10px] transition-transform"
        :class="mod.showReasoningEffortMenu && 'rotate-180'"
      ></i>
    </button>
    <Transition name="popover-up">
      <div
        v-if="mod.showReasoningEffortMenu"
        class="absolute left-0 bottom-full mb-2 w-44 bg-white rounded-xl shadow-2xl border border-slate-200 z-[200] overflow-hidden"
        role="listbox"
        aria-label="Effort de réflexion"
        @click.stop
      >
        <div
          class="px-3 py-1.5 bg-slate-50 border-b text-[10px] font-semibold text-slate-500 uppercase tracking-wide"
        >
          Effort de réflexion
        </div>
        <div
          role="option"
          tabindex="0"
          :aria-selected="!mod.samplingOverride.reasoning_effort ? 'true' : 'false'"
          class="flex items-center gap-2 px-3 py-2 cursor-pointer text-xs border-b border-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          :class="
            !mod.samplingOverride.reasoning_effort
              ? 'bg-blue-50 text-blue-700 font-medium'
              : 'text-slate-700 hover:bg-slate-50'
          "
          @click="mod.pickReasoningEffort(null)"
          @keydown.enter.prevent="mod.pickReasoningEffort(null)"
          @keydown.space.prevent="mod.pickReasoningEffort(null)"
        >
          <div
            class="w-1.5 h-1.5 rounded-full flex-shrink-0"
            :class="!mod.samplingOverride.reasoning_effort ? 'bg-blue-500' : 'bg-transparent'"
          ></div>
          Auto
        </div>
        <div
          v-for="v in mod.reasoningEffortValues"
          :key="'eff' + v"
          role="option"
          tabindex="0"
          :aria-selected="mod.samplingOverride.reasoning_effort === v ? 'true' : 'false'"
          class="flex items-center gap-2 px-3 py-2 cursor-pointer text-xs border-b border-slate-50 last:border-b-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          :class="
            mod.samplingOverride.reasoning_effort === v
              ? 'bg-blue-50 text-blue-700 font-medium'
              : 'text-slate-700 hover:bg-slate-50'
          "
          @click="mod.pickReasoningEffort(v)"
          @keydown.enter.prevent="mod.pickReasoningEffort(v)"
          @keydown.space.prevent="mod.pickReasoningEffort(v)"
        >
          <div
            class="w-1.5 h-1.5 rounded-full flex-shrink-0"
            :class="mod.samplingOverride.reasoning_effort === v ? 'bg-blue-500' : 'bg-transparent'"
          ></div>
          {{ v }}
        </div>
      </div>
    </Transition>
  </div>
</template>
