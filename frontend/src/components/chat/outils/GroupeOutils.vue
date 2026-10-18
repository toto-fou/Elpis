<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/outils/GroupeOutils.vue — compteur et dropdown des outils d'un segment ; l'état ouvert vit dans le message (setMsgUi). -->
<script setup lang="ts">
import type {
  EtapeOutil,
  GroupeSegment,
  MessageOutils,
  PatchUiMessage,
} from "../../../features/chat/outils/types";
import EtapeOutilVue from "./EtapeOutil.vue";

const props = defineProps<{
  msg: MessageOutils;
  idx: number;
  grp: GroupeSegment;
  consoleShell: boolean;
  masquerReflexion: boolean;
}>();
const emit = defineEmits<{
  ui: [patch: PatchUiMessage];
  "basculer-etape": [flat: number, gi: number];
  "reflexion-etape": [etape: EtapeOutil, ouvert: boolean];
  notifier: [message: string, type?: string];
}>();

function basculerGroupe(ev: Event): void {
  const ouvert = (ev.target as HTMLDetailsElement).open;
  emit("ui", { _segsOpen: Object.assign({}, props.msg._segsOpen, { [props.grp.gi]: ouvert }) });
}
</script>

<template>
  <details
    :open="!!(props.msg._segsOpen && props.msg._segsOpen[props.grp.gi])"
    class="mb-2 group/toolwrap"
    @toggle="basculerGroupe"
  >
    <summary
      class="list-none flex items-center gap-1.5 cursor-pointer select-none w-fit py-0.5 text-slate-400 hover:text-slate-600 transition-colors"
    >
      <i
        class="ph ph-gear text-slate-400/80"
        :class="grp.running ? 'animate-spin' : ''"
        style="font-size: 11px"
      ></i>
      <span class="text-[12.5px] font-semibold text-slate-500">
        <template v-if="grp.nTools > 0"> {{ grp.nTools }} outil{{ grp.nTools > 1 ? "s" : "" }} </template>
        <template v-if="grp.nComp > 0">
          <span v-if="grp.nTools > 0" class="text-slate-400 font-normal"> · </span>
          {{ grp.nComp }} compression{{ grp.nComp > 1 ? "s" : "" }} du contexte
        </template>
      </span>

      <span v-if="grp.pills.pills.length > 0" class="hidden sm:inline-flex items-center gap-1 ml-1 flex-wrap">
        <template v-for="pill in grp.pills.pills" :key="pill.name">
          <span
            class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-slate-100 text-slate-600 text-[10.5px] font-mono font-normal"
          >
            <i class="ph text-[10px]" :class="pill.icon"></i>
            {{ pill.name
            }}<template v-if="pill.count > 1"
              ><span class="text-slate-400"> ×{{ pill.count }}</span></template
            >
          </span>
        </template>
        <span v-if="grp.pills.extraCount > 0" class="text-[10.5px] text-slate-400 font-normal font-mono"
          >+{{ grp.pills.extraCount }}</span
        >
      </span>

      <i
        class="ph ph-caret-right text-slate-300 transition-transform group-open/toolwrap:rotate-90"
        style="font-size: 9px"
      ></i>
    </summary>
    <div class="mt-1.5">
      <div class="flex flex-col">
        <template v-for="({ step, flat, shell }, si) in grp.disp" :key="si">
          <div v-if="si > 0" class="flex items-center h-4 ml-0.5 my-0.5 select-none" aria-hidden="true">
            <span class="text-slate-300 text-[11px] font-light leading-none">|</span>
          </div>
          <EtapeOutilVue
            :step="step"
            :numero="si + 1"
            :actif="props.msg._activeToolStep === flat"
            :shell="shell"
            :grp="grp"
            :cle-console="props.idx + '-' + grp.gi"
            :console-shell="props.consoleShell"
            :masquer-reflexion="props.masquerReflexion"
            :compact-ouvert="!!props.msg._compactOpen"
            @basculer="emit('basculer-etape', flat, grp.gi)"
            @fermer="emit('ui', { _activeToolStep: null })"
            @reflexion="(o) => emit('reflexion-etape', step, o)"
            @compact="(o) => emit('ui', { _compactOpen: o })"
            @notifier="(m, t) => emit('notifier', m, t)"
          />
        </template>
      </div>
    </div>
  </details>
</template>
