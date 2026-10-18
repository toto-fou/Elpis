<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/outils/EtapeOutil.vue — une étape d'un segment : réflexion, pastille d'état, progression, journal, puis console ou carte détail. -->
<script setup lang="ts">
import { fmtCompression } from "../../../features/chat/outils/format";
import type { EtapeOutil, GroupeSegment } from "../../../features/chat/outils/types";
import { suivreReflexionOuverte } from "../../../utils/dom";
import { fmtElapsedMs } from "../../../utils/utils-purs";
import CarteOutil from "./CarteOutil.vue";
import ConsoleShell from "./ConsoleShell.vue";

const props = defineProps<{
  step: EtapeOutil;
  numero: number;
  actif: boolean;
  shell: boolean;
  grp: GroupeSegment;
  cleConsole: string;
  consoleShell: boolean;
  masquerReflexion: boolean;
  compactOuvert: boolean;
}>();
const emit = defineEmits<{
  basculer: [];
  fermer: [];
  reflexion: [ouvert: boolean];
  compact: [ouvert: boolean];
  notifier: [message: string, type?: string];
}>();

function basculerReflexion(ev: Event): void {
  const el = ev.target as HTMLDetailsElement;
  emit("reflexion", el.open);
  suivreReflexionOuverte(el);
}

function bloquerReflexion(ev: MouseEvent): void {
  if (props.masquerReflexion) ev.preventDefault();
}
</script>

<template>
  <details
    v-if="step.thinking"
    :open="!props.masquerReflexion && step.thinkingOpen"
    class="group/sthink mb-1"
    @toggle="basculerReflexion"
  >
    <summary
      class="list-none flex items-center gap-1.5 select-none w-fit py-0.5 text-slate-400 transition-colors"
      :class="props.masquerReflexion ? 'cursor-default' : 'cursor-pointer hover:text-slate-600'"
      :aria-disabled="props.masquerReflexion ? 'true' : undefined"
      :title="props.masquerReflexion ? 'Affichage du raisonnement désactivé (Paramètres)' : undefined"
      @click="bloquerReflexion"
    >
      <i class="ph ph-brain text-slate-400/80" style="font-size: 11px"></i>
      <span class="text-[12.5px] font-semibold">Réflexion…</span>
      <span class="text-slate-300 font-mono text-[10px]">· {{ step.name }}</span>
      <i
        v-if="!props.masquerReflexion"
        class="ph ph-caret-right text-slate-300 transition-transform group-open/sthink:rotate-90"
        style="font-size: 9px"
      ></i>
      <i v-else class="ph ph-lock-simple text-slate-300" style="font-size: 9px"></i>
    </summary>
    <div v-if="!props.masquerReflexion" class="mt-1 pl-3 border-l-2 border-slate-200 ml-0.5">
      <pre
        class="text-[11.5px] text-slate-600 leading-relaxed whitespace-pre-wrap break-words font-mono max-h-48 overflow-y-auto custom-scrollbar m-0 bg-transparent"
        >{{ step.thinking }}</pre>
    </div>
  </details>

  <div class="flex items-baseline gap-2 flex-wrap">
    <button class="inline-flex items-center gap-1.5 group/toolbtn" @click="emit('basculer')">
      <i
        v-if="step._kind === 'compression' && step.status === 'running'"
        class="ph ph-arrows-in-simple text-slate-400 animate-pulse"
        style="font-size: 11px"
        aria-label="Compression en cours"
      ></i>
      <i
        v-else-if="step._kind === 'compression' && step.status === 'skipped'"
        class="ph ph-prohibit text-amber-500/80"
        style="font-size: 11px"
        aria-label="Compression non appliquée"
      ></i>
      <i
        v-else-if="step._kind === 'compression'"
        class="ph ph-check-circle text-slate-400/80"
        style="font-size: 11px"
        aria-label="Compression terminée"
      ></i>
      <i
        v-else-if="step._is_error && step.status === 'done'"
        class="ph ph-x-circle text-red-500"
        style="font-size: 11px"
        aria-label="Erreur"
      ></i>
      <i
        v-else-if="step.status === 'running' && step.name.startsWith('rag_')"
        class="ph ph-database text-blue-500 animate-pulse"
        style="font-size: 11px"
      ></i>
      <i
        v-else-if="step.status === 'running'"
        class="ph ph-spinner-gap animate-spin text-blue-500"
        style="font-size: 11px"
      ></i>
      <i
        v-else-if="step.name.startsWith('rag_')"
        class="ph ph-database text-slate-400/80"
        style="font-size: 11px"
      ></i>
      <i v-else class="ph ph-check-circle text-slate-400/80" style="font-size: 11px"></i>

      <span
        class="font-mono text-[12.5px] font-semibold leading-snug"
        :class="
          step._kind === 'compression'
            ? step.status === 'running'
              ? 'text-slate-500'
              : 'text-slate-500 group-hover/toolbtn:text-slate-700'
            : step._is_error && step.status === 'done'
              ? 'text-red-600 group-hover/toolbtn:text-red-700'
              : step.status === 'running'
                ? 'text-blue-600'
                : 'text-slate-600 group-hover/toolbtn:text-blue-600'
        "
        style="transition: color 0.15s"
        >{{ step._kind === "compression" ? "compression du contexte" : step.ragLabel || step.name }}</span
      >

      <template v-if="step._kind === 'compression'">
        <span v-if="step.status === 'running' && step.turns" class="text-slate-400 text-[11px] font-normal"
          >· {{ step.turns }} tours</span
        >
        <span v-if="step.status === 'running' && step.pct" class="text-slate-400 text-[11px] font-normal"
          >· {{ step.pct }}% ctx</span
        >
        <span v-if="step.status === 'skipped'" class="text-amber-600/80 text-[11px] font-normal"
          >· {{ step.reasonLabel || "Non appliquée" }}</span
        >
        <span
          v-if="step.status === 'done' && step.stats && step.stats.tokens_before"
          class="text-slate-400 text-[11px] font-normal"
          >· {{ fmtCompression(step.stats) }}</span
        >
        <span
          v-else-if="step.status === 'done' && step.stats && step.stats.tokens_saved"
          class="text-slate-400 text-[11px] font-normal"
          >· −{{ step.stats.tokens_saved }} tokens</span
        >
        <span
          v-if="step.status === 'done' && step.stats && step.stats.duration_ms"
          class="text-slate-400 text-[11px] font-mono tabular-nums"
          >· {{ fmtElapsedMs(step.stats.duration_ms) }}</span
        >
      </template>
      <template v-else>
        <span
          v-if="step.ragResultLabel && step.status === 'done'"
          class="text-slate-400 text-[10px] font-normal"
          >· {{ step.ragResultLabel }}</span
        >

        <span
          v-else-if="!step.ragLabel && step.args && (step.args.path || step.args.filename)"
          class="text-slate-400 text-[11px] truncate max-w-[200px] font-normal"
          >{{ step.args.path || step.args.filename }}</span
        >
        <span
          v-if="step.status === 'done' && step.durationMs != null && !step.shellMs"
          class="text-slate-400 text-[11px] font-mono tabular-nums"
          >· {{ fmtElapsedMs(step.durationMs) }}</span
        >
      </template>

      <i
        class="ph ph-caret-down text-slate-300 transition-transform"
        :class="props.actif ? 'rotate-180' : ''"
        style="font-size: 8px"
      ></i>
    </button>
  </div>

  <div
    v-if="step._kind === 'compression' && step.status === 'running'"
    class="h-[2px] mt-1 mb-0.5 bg-slate-100 rounded-full overflow-hidden"
    style="width: min(280px, 60vw)"
    aria-hidden="true"
  >
    <div
      class="h-full bg-slate-400 rounded-full transition-transform duration-200 ease-out"
      :style="{
        width: '100%',
        transformOrigin: 'left',
        transform: 'scaleX(' + (step.progress || 0) / 100 + ')',
      }"
    ></div>
  </div>

  <div
    v-if="!step._kind && step.status === 'running' && step.progressInfo"
    class="flex items-center gap-2 mt-1 mb-0.5"
    style="width: min(320px, 70vw)"
    aria-hidden="true"
  >
    <div class="h-[2px] flex-1 bg-slate-100 rounded-full overflow-hidden">
      <div
        v-if="step.progressInfo.pct !== null"
        class="h-full bg-blue-400 rounded-full transition-transform duration-200 ease-out"
        :style="{
          width: '100%',
          transformOrigin: 'left',
          transform: 'scaleX(' + step.progressInfo.pct / 100 + ')',
        }"
      ></div>
      <div v-else class="h-full bg-blue-300/70 rounded-full animate-pulse" style="width: 35%"></div>
    </div>
    <span
      v-if="step.progressInfo.message"
      class="text-[10px] text-slate-400 truncate max-w-[180px] font-normal"
      >{{ step.progressInfo.message }}</span
    >
  </div>

  <div
    v-if="!step._kind && step.status === 'running' && step.logs && step.logs.length"
    class="mt-1 mb-0.5 text-[10px] font-mono leading-tight space-y-0.5"
    style="max-width: min(420px, 80vw)"
  >
    <div
      v-for="(ln, li) in step.logs.slice(-3)"
      :key="'lp' + li"
      class="truncate"
      :class="{
        'text-slate-400': ln.level === 'debug',
        'text-slate-500': ln.level === 'info' || ln.level === 'notice',
        'text-amber-500': ln.level === 'warning',
        'text-red-500':
          ln.level === 'error' || ln.level === 'critical' || ln.level === 'alert' || ln.level === 'emergency',
      }"
    >
      · {{ ln.message }}
    </div>
  </div>

  <transition name="tool-detail">
    <ConsoleShell
      v-if="props.actif && props.shell && props.consoleShell && props.grp.shellMeta"
      key="shell-console"
      :grp="props.grp"
      :meta="props.grp.shellMeta"
      :cle="props.cleConsole"
      @fermer="emit('fermer')"
      @notifier="(m, t) => emit('notifier', m, t)"
    />
    <CarteOutil
      v-else-if="props.actif"
      key="tool-card"
      :step="props.step"
      :numero="props.numero"
      :compact-ouvert="props.compactOuvert"
      @fermer="emit('fermer')"
      @compact="(o) => emit('compact', o)"
    />
  </transition>
</template>
