<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/message/TravailAssistant.vue — conteneur « Travail de l'assistant » : narrations de segment, outils par segment, narration vivante dessous. -->
<script setup lang="ts">
import { computed } from "vue";

import { CLE_FIL, domaine } from "../../../features/chat/page/domaines";

import ContenuMarkdown from "../ContenuMarkdown.vue";
import NarrationVivante from "../NarrationVivante.vue";
import GroupeOutils from "../outils/GroupeOutils.vue";
import type { EntreeMessage } from "../../../features/chat/message/types";
import type { EtapeOutil } from "../../../features/chat/outils/types";

const props = defineProps<{ entry: EntreeMessage }>();
const fil = domaine(CLE_FIL);
const pl = computed(() => fil.pipelineFor(props.entry.msg));

/** Message chargé gelé : l'état replié de la réflexion d'étape n'y est pas mémorisé (comme avant). */
function reflexionEtape(s: EtapeOutil, o: boolean): void {
  if (!Object.isFrozen(s)) s.thinkingOpen = o;
}

function ouvert(e: Event): boolean {
  return (e.target as HTMLDetailsElement).open;
}
</script>

<template>
  <template v-if="pl">
    <details
      v-if="pl.show"
      data-pipeline
      :open="!!entry.msg._pipelineOpen"
      class="mb-2 group/pipeline"
      @toggle="fil.setMsgUi(entry, { _pipelineOpen: ouvert($event) })"
    >
      <summary
        class="list-none flex items-center gap-1.5 cursor-pointer select-none w-fit py-0.5 text-slate-400 hover:text-slate-600 transition-colors"
      >
        <i
          class="ph ph-gear text-slate-400/80 shrink-0"
          :class="pl.running ? 'animate-spin' : ''"
          style="font-size: 11px"
        ></i>
        <span
          class="text-[12.5px] font-medium text-slate-500 truncate max-w-[420px]"
          :class="pl.running ? 'mem-wave' : ''"
        >
          <template v-if="pl.running && pl.label">{{ pl.label }}</template>
          <template v-else-if="pl.summary">{{ pl.summary }}</template>
          <template v-else>Travail de l'assistant</template>
        </span>
        <span v-if="pl.running && pl.label" class="sr-only" role="status" aria-live="polite">{{
          pl.label
        }}</span>
        <span
          v-if="entry.msg.isStreaming && entry.msg.iterBudget && entry.msg.iterBudget.n > 1"
          class="text-[11px] font-normal shrink-0 tabular-nums"
          :class="
            entry.msg.iterBudget.n >= entry.msg.iterBudget.max * 0.8 ? 'text-amber-600' : 'text-slate-400'
          "
          title="Itérations de la boucle d'outils : en cours / budget du tour"
          >· tour {{ entry.msg.iterBudget.n }}/{{ entry.msg.iterBudget.max }}</span
        >
        <template v-if="!pl.running">
          <span v-if="pl.nTools > 0" class="text-[11px] text-slate-400 font-normal shrink-0"
            >· {{ pl.nTools }} outil{{ pl.nTools > 1 ? "s" : "" }}</span
          >
          <span v-if="pl.nComp > 0" class="text-[11px] text-slate-400 font-normal shrink-0"
            >· {{ pl.nComp }} compression{{ pl.nComp > 1 ? "s" : "" }} du contexte</span
          >
          <span
            v-if="(entry.msg.pruned ?? 0) > 0"
            class="text-[11px] text-slate-400 font-normal shrink-0"
            title="Sorties d'outils anciennes remplacées par un marqueur pour libérer du contexte"
            >· {{ entry.msg.pruned }} sortie{{ (entry.msg.pruned ?? 0) > 1 ? "s" : "" }} retirée{{
              (entry.msg.pruned ?? 0) > 1 ? "s" : ""
            }}
            du contexte</span
          >
        </template>
        <i
          class="ph ph-caret-right text-slate-300 transition-transform group-open/pipeline:rotate-90 shrink-0"
          style="font-size: 9px"
        ></i>
      </summary>
      <div class="mt-1.5 pl-3 border-l-2 border-slate-200 ml-0.5">
        <template v-for="grp in fil.segGroupsFor(entry.msg)" :key="'seg' + grp.gi">
          <ContenuMarkdown
            v-if="grp.text"
            class="markdown-body--worklog mb-1.5"
            :msg="{ content: grp.text }"
            @click-markdown="fil.handleMarkdownClick"
          ></ContenuMarkdown>

          <GroupeOutils
            v-if="grp.disp.length > 0"
            :msg="entry.msg"
            :idx="entry.idx"
            :grp="grp"
            :console-shell="!!fil.settings.live_shell_enabled"
            :masquer-reflexion="!!fil.settings.hide_thinking"
            @ui="fil.setMsgUi(entry, $event)"
            @basculer-etape="(f: number, g: number) => fil.toggleToolDetail(entry, f, g)"
            @reflexion-etape="reflexionEtape"
            @notifier="fil.showToast"
          ></GroupeOutils>
        </template>
      </div>
    </details>

    <NarrationVivante
      v-if="
        (entry.msg._pendingPreContent || entry.msg._pendingToolThinking) && entry.idx === fil.lastAssistantIdx
      "
      :msg="entry.msg"
      @click-markdown="fil.handleMarkdownClick"
    ></NarrationVivante>
  </template>
</template>
