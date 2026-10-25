<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/message/FilTour.vue — le tour d'un message assistant en une liste chronologique : réflexions, textes à leur place, étapes groupées en ligne riche (et leurs captures, aperçu en direct pendant la navigation), sous-agents, tâches de fond, mémoire, compression, puis le texte qui s'écrit. -->
<script setup lang="ts">
import { computed, inject, onUnmounted, ref, watch } from "vue";

import type { ResumeJob } from "@elpis/contracts";

import { capturesDuTour, visionneuseCaptures } from "../../../features/chat/message/captures-tour";
import { chronologieTour } from "../../../features/chat/message/chronologie";
import type { BlocFil } from "../../../features/chat/message/chronologie";
import type { EntreeMessage } from "../../../features/chat/message/types";
import { fmtCompression, fmtDuree } from "../../../features/chat/outils/format";
import { CLE_MODALES } from "../../../features/chat/modales/domaine";
import { jobDeLEtape } from "../../../features/chat/message/taches-fond";
import type { EtapeOutil } from "../../../features/chat/outils/types";
import { CLE_FIL, CLE_PAGE, domaine } from "../../../features/chat/page/domaines";

import ContenuMarkdown from "../ContenuMarkdown.vue";
import CarteOutil from "../outils/CarteOutil.vue";
import LigneEtapes from "../outils/LigneEtapes.vue";
import LigneJob from "../outils/LigneJob.vue";
import LignesAgents from "../outils/LignesAgents.vue";
import type { AgentLigne } from "../outils/LignesAgents.vue";
import EffetMemoire from "./EffetMemoire.vue";
import LigneReflexion from "./LigneReflexion.vue";

const props = defineProps<{ entry: EntreeMessage }>();
const fil = domaine(CLE_FIL);
const modales = inject(CLE_MODALES, null);
// Tâches de fond de la conversation (page du chat) ; absentes quand le fil est monté seul.
const page = inject(CLE_PAGE, null);

// Horloge des étapes vivantes : une seconde, seulement pendant le flux.
const maintenant = ref(Date.now());
let minuterie: ReturnType<typeof globalThis.setInterval> | null = null;
watch(
  () => !!props.entry.msg.isStreaming,
  (vivant) => {
    if (minuterie) globalThis.clearInterval(minuterie);
    minuterie = vivant ? globalThis.setInterval(() => (maintenant.value = Date.now()), 1000) : null;
    maintenant.value = Date.now();
  },
  { immediate: true },
);
onUnmounted(() => {
  if (minuterie) globalThis.clearInterval(minuterie);
});

const blocs = computed(() => chronologieTour(props.entry.msg, maintenant.value));
const ouverts = computed(() => props.entry.msg._filOuverts ?? {});
const detail = computed(() => props.entry.msg._activeToolStep ?? null);
const lignesMemoire = computed(() => fil.effectLinesFor(props.entry.msg, props.entry.idx));
const dernier = computed(() => props.entry.idx === fil.lastAssistantIdx);
const verrouillee = computed(() => !!fil.settings.hide_thinking && !!props.entry.msg.content);

const vivant = computed(() => {
  const m = props.entry.msg;
  const texte = m._pendingPreContent || "";
  if (!texte.trim() || !dernier.value) return null;
  return m._ppBlocks || m._ppActiveHtml
    ? {
        isStreaming: true,
        content: texte,
        _mdBlocks: m._ppBlocks ?? null,
        _mdActiveHtml: m._ppActiveHtml ?? "",
      }
    : { content: texte };
});

const captures = computed(() => (fil.settings.hide_web_screenshots ? [] : capturesDuTour(props.entry.msg)));
const visionneuse = computed(() => visionneuseCaptures(captures.value));

function voirCapture(rang: number): void {
  fil.openImageViewer(visionneuse.value.items, rang, { captures: true });
}

// Pendant la navigation : la dernière capture sous le dernier groupe d'étapes, tant que rien d'autre ne le suit.
const apercu = computed(() => {
  const c = captures.value[captures.value.length - 1];
  if (!c || !props.entry.msg.isStreaming || !dernier.value || vivant.value) return null;
  const i = blocs.value.findLastIndex((b) => b.k !== "reflexion");
  const b = blocs.value[i];
  if (b?.k !== "etapes") return null;
  const lie = b.etapes.some(
    (e) => e.flat === c.flat || (e.etape.status === "running" && (e.etape.name ?? "").startsWith("pw_")),
  );
  return lie ? { cle: b.cle, url: c.url, attente: c.attente } : null;
});

function basculer(cle: string): void {
  fil.setMsgUi(props.entry, { _filOuverts: { ...ouverts.value, [cle]: !ouverts.value[cle] } });
}

function basculerDetail(flat: number): void {
  fil.setMsgUi(props.entry, { _activeToolStep: detail.value === flat ? null : flat });
}

function agentsDe(b: Extract<BlocFil, { k: "agents" }>): AgentLigne[] {
  const runs = props.entry.msg.taskRuns ?? [];
  return b.agents.flatMap((a) => {
    const run = runs[a.ri];
    return run ? [{ run, ri: a.ri, callId: a.etape.callId ?? null }] : [];
  });
}

type BlocJob = Extract<BlocFil, { k: "job" }>;

function jobDe(b: BlocJob): ResumeJob | null {
  return page ? jobDeLEtape(b.etape, page.jobsChat) : null;
}

// Journal dans l'éditeur, sinon le volet des tâches de fond ; job inconnu : détail de l'appel.
function ouvrirJob(b: BlocJob): void {
  const job = jobDe(b);
  if (!page || !job) basculerDetail(b.flat);
  else if (fil.settings.enable_editor) page.jobsOuvrirJournal(job);
  else page.jobsBasculer(true);
}

// Agent dont le volet est ouvert : sa ligne reste marquée.
const agentActif = computed(() => {
  const tm = modales?.taskModal;
  return tm && tm.idx === props.entry.idx ? tm.ri : null;
});

function resumeCompression(s: EtapeOutil): string {
  if (s.status === "running") return "en cours…";
  if (s.status === "skipped") return s.reasonLabel || "non appliquée";
  const gain = fmtCompression(s.stats);
  const ms = s.stats?.duration_ms;
  return [gain, typeof ms === "number" && ms > 0 ? fmtDuree(ms) : ""].filter(Boolean).join(" · ");
}
</script>

<template>
  <div v-if="blocs.length || vivant" class="mb-1 flex flex-col" data-fil-tour>
    <template v-for="b in blocs" :key="b.cle">
      <ContenuMarkdown
        v-if="b.k === 'texte'"
        class="mb-1.5"
        :msg="{ content: b.texte }"
        data-texte-tour
        @click-markdown="fil.handleMarkdownClick"
      ></ContenuMarkdown>
      <LigneReflexion
        v-else-if="b.k === 'reflexion'"
        :texte="b.texte"
        :ms="b.ms"
        :vivante="b.vivante"
        :ouvert="!!ouverts[b.cle]"
        :verrouillee="verrouillee"
        :repondre="b.vivante && dernier && !!entry.msg.isStreaming"
        @basculer="basculer(b.cle)"
        @repondre="fil.respondNow(entry.idx)"
      />
      <template v-else-if="b.k === 'etapes'">
        <LigneEtapes
          :etapes="b.etapes"
          :ouvert="!!ouverts[b.cle]"
          :detail="detail"
          :maintenant="maintenant"
          :compact-ouvert="!!entry.msg._compactOpen"
          :captures="visionneuse.parEtape"
          @basculer="basculer(b.cle)"
          @detail="basculerDetail"
          @compact="(o: boolean) => fil.setMsgUi(entry, { _compactOpen: o })"
          @capture="voirCapture"
        />
        <div v-if="apercu && apercu.cle === b.cle" class="pl-6 mb-1.5" data-apercu-direct>
          <div
            class="elpis-on-media elpis-media-canvas relative rounded-xl overflow-hidden ring-1 ring-slate-900/5"
            style="width: 260px; max-width: 100%; aspect-ratio: 16 / 10"
            role="img"
            aria-label="Aperçu du navigateur en direct"
          >
            <img
              v-if="apercu.url"
              :src="apercu.url"
              alt=""
              class="absolute inset-0 w-full h-full object-cover object-top"
            />
            <span
              class="absolute top-1.5 right-1.5 flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-black/40 text-[10px] text-white/90"
            >
              <span class="relative flex h-1.5 w-1.5 shrink-0">
                <span
                  class="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-300 opacity-75"
                ></span>
                <span class="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-400"></span>
              </span>
              En direct
            </span>
            <div
              v-if="apercu.attente"
              class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/90 shadow-lg border border-white/50"
            >
              <i class="ph ph-spinner-gap animate-spin text-blue-500" style="font-size: 10px"></i>
              <span class="text-[10px] font-medium text-slate-700">capture...</span>
            </div>
          </div>
        </div>
      </template>
      <LignesAgents
        v-else-if="b.k === 'agents'"
        :agents="agentsDe(b)"
        :maintenant="maintenant"
        :actif="agentActif"
        @ouvrir="(ri: number) => fil.openTaskModal(entry, ri)"
      />
      <div v-else-if="b.k === 'job'" class="mb-1">
        <LigneJob :etape="b.etape" :job="jobDe(b)" @ouvrir="ouvrirJob(b)" />
        <CarteOutil
          v-if="detail === b.flat"
          :step="b.etape"
          :numero="0"
          :compact-ouvert="!!entry.msg._compactOpen"
          @fermer="basculerDetail(b.flat)"
          @compact="(o: boolean) => fil.setMsgUi(entry, { _compactOpen: o })"
        />
      </div>
      <div v-else-if="b.k === 'memoire' && lignesMemoire[b.rang]" class="elpis-effects mb-1" data-effects>
        <EffetMemoire :line="lignesMemoire[b.rang]!" />
      </div>
      <div v-else-if="b.k === 'compression'" class="mb-1" :data-etape="b.etape.callId || undefined">
        <button
          type="button"
          class="w-full flex items-center gap-2 px-1.5 py-1 -mx-1.5 rounded-md text-left text-[13px] text-slate-600 hover:bg-slate-100 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          :aria-expanded="detail === b.flat ? 'true' : 'false'"
          data-ligne-compression
          @click="basculerDetail(b.flat)"
        >
          <i
            class="ph shrink-0 text-[14px]"
            :class="
              b.etape.status === 'running'
                ? 'ph-arrows-in-simple animate-pulse text-blue-500'
                : 'ph-arrows-in-simple text-slate-400'
            "
            aria-hidden="true"
          ></i>
          <span class="flex-1 min-w-0 truncate">Compression du contexte</span>
          <span class="shrink-0 text-[12px] text-slate-500 tabular-nums">{{
            resumeCompression(b.etape)
          }}</span>
        </button>
        <CarteOutil
          v-if="detail === b.flat"
          :step="b.etape"
          :numero="0"
          :compact-ouvert="!!entry.msg._compactOpen"
          @fermer="basculerDetail(b.flat)"
          @compact="(o: boolean) => fil.setMsgUi(entry, { _compactOpen: o })"
        />
      </div>
    </template>
    <ContenuMarkdown
      v-if="vivant"
      class="mb-1.5"
      :msg="vivant"
      data-texte-vivant
      @click-markdown="fil.handleMarkdownClick"
    ></ContenuMarkdown>
  </div>
</template>
