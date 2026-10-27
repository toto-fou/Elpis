<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/outils/LignesAgents.vue — sous-agents d'un tour, une ligne chacun comme une étape (nom, étape courante, horloge ; fini : bilan court, état) ; lancés ensemble, groupés sous « 2 agents · 1 fini » ; un clic ouvre le volet de l'agent. -->
<script setup lang="ts">
import { computed } from "vue";

import { bilanCourtAgent, etapeCouranteAgent, resumeAgents } from "../../../features/chat/outils/agents";
import { statutReserve } from "../../../features/chat/outils/bilan-tache";
import { fmtDuree } from "../../../features/chat/outils/format";
import type { ExecutionSousAgent } from "../../../features/chat/outils/types";
import { fmtTokenCount } from "../../../utils/utils-purs";

export interface AgentLigne {
  run: ExecutionSousAgent;
  ri: number;
  callId: string | null;
}

const props = defineProps<{ agents: readonly AgentLigne[]; maintenant: number; actif: number | null }>();
const emit = defineEmits<{ ouvrir: [ri: number] }>();

const resume = computed(() => resumeAgents(props.agents.map((a) => a.run)));
const enCours = computed(() => props.agents.some((a) => a.run.state === "running"));

function nom(r: ExecutionSousAgent): string {
  return r.agent || "agent";
}

function horloge(r: ExecutionSousAgent): string {
  if (r.state === "running")
    return typeof r.startedAt === "number" ? fmtDuree(props.maintenant - r.startedAt) : "";
  return typeof r.duration_ms === "number" && r.duration_ms > 0 ? fmtDuree(r.duration_ms) : "";
}

function icone(r: ExecutionSousAgent): string {
  if (r.state === "running")
    return r.id ? "ph-spinner-gap animate-spin text-blue-500" : "ph-hourglass-medium text-slate-400";
  if (r.state === "completed")
    return statutReserve(r) === null ? "ph-check text-emerald-600" : "ph-warning-circle text-amber-600";
  if (r.state === "failed" || r.state === "timeout") return "ph-x-circle text-red-500";
  if (r.state === "cancelled") return "ph-stop-circle text-slate-400";
  return "ph-warning-circle text-amber-600";
}

function detail(r: ExecutionSousAgent): string {
  if (r.state !== "running") return bilanCourtAgent(r);
  if (!r.id) return "en attente";
  return r.cancelRequested ? "arrêt demandé" : etapeCouranteAgent(r) || "démarre";
}

function infobulle(r: ExecutionSousAgent): string {
  const t = typeof r.tokens === "number" && r.tokens > 0 ? fmtTokenCount(r.tokens) + " jetons" : "";
  return [r.label || "", t].filter(Boolean).join(" · ");
}
</script>

<template>
  <div class="mb-1" data-agents>
    <div
      v-if="agents.length > 1"
      class="flex items-center gap-2 px-1.5 py-1 -mx-1.5 text-[13px] text-slate-700"
    >
      <i
        class="ph ph-users-three shrink-0 text-[14px]"
        :class="enCours ? 'text-blue-500' : 'text-slate-400'"
        aria-hidden="true"
      ></i>
      <span class="flex-1 min-w-0 truncate" data-resume-agents>{{ resume }}</span>
    </div>
    <div :class="agents.length > 1 ? 'pl-5' : ''">
      <button
        v-for="a in agents"
        :key="a.ri + ':' + (a.callId || '')"
        type="button"
        class="w-full flex items-center gap-2 px-1.5 py-1 -mx-1.5 rounded-md text-left text-[13px] text-slate-700 hover:bg-slate-100 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        :class="actif === a.ri ? 'bg-slate-100' : ''"
        :data-etape="a.callId || undefined"
        :title="infobulle(a.run) || undefined"
        :aria-pressed="actif === a.ri ? 'true' : 'false'"
        data-ligne-agent
        @click="emit('ouvrir', a.ri)"
      >
        <i class="ph shrink-0 text-[14px]" :class="icone(a.run)" aria-hidden="true"></i>
        <span class="flex-1 min-w-0 truncate"
          ><b class="font-semibold">{{ nom(a.run) }}</b
          >{{ " · " + detail(a.run) }}</span
        >
        <span class="shrink-0 text-[12px] text-slate-500 tabular-nums">{{ horloge(a.run) }}</span>
        <i class="ph ph-caret-right shrink-0 text-[11px] text-slate-400" aria-hidden="true"></i>
      </button>
    </div>
  </div>
</template>
