<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/page/BarreActivite.vue — barre « Activité » au-dessus du composeur (interface nouvelle), visible quand quelque chose tourne : tâches de fond (horloge vivante, échec en rouge), sous-agents, étape en cours ; un clic ramène à la ligne du fil ; le volet des tâches de fond s'ouvre depuis sa puce « N ici ». -->
<script setup lang="ts">
import { computed, ref, watch } from "vue";

import type { ResumeJob } from "@elpis/contracts";

import { toolIconFor } from "../../../features/chat/coeur/formats";
import { dureeJob, issueJob, jobActif } from "../../../features/chat/jobs/format";
import type { IssueJob } from "../../../features/chat/jobs/format";
import { utiliserHorloge } from "../../../features/chat/jobs/horloge";
import {
  allerALEtape,
  appelDuJob,
  etapeEnCours,
  sousAgentsActifs,
} from "../../../features/chat/page/activite";
import { CLE_CONVERSATION, CLE_PAGE, domaine } from "../../../features/chat/page/domaines";
import PuceJobs from "../outils/PuceJobs.vue";

const p = domaine(CLE_PAGE);
const conv = domaine(CLE_CONVERSATION);

const actifs = computed(() => p.jobsChat.filter(jobActif));
const agents = computed(() => sousAgentsActifs(p.messages));
const etape = computed(() => etapeEnCours(p.messages));
const echecs = ref<ResumeJob[]>([]);
const maintenant = utiliserHorloge(() => actifs.value.length > 0);

const voletJobs = computed(
  () =>
    p.jobsActifsTotal > 0 || p.jobsOuvert || p.jobsFileReveil.length > 0 || p.jobsReveilEnCours.length > 0,
);
const visible = computed(
  () =>
    actifs.value.length > 0 ||
    echecs.value.length > 0 ||
    agents.value.length > 0 ||
    !!etape.value ||
    voletJobs.value,
);

const nomJob = (j: ResumeJob): string => j.label || j.command;
const sortie = (j: ResumeJob): string => (j.signal ? j.signal : `code ${j.exit_code ?? "?"}`);

function allerAuJob(j: ResumeJob): void {
  conv.isUserScrolling = true;
  // Étape absente du fil chargé : le volet des tâches de fond montre la tâche et son journal.
  if (!allerALEtape(appelDuJob(p.messages, j.id))) p.jobsBasculer(true);
}

function allerAEtape(callId: string | null): void {
  conv.isUserScrolling = true;
  allerALEtape(callId);
}

function masquer(j: ResumeJob): void {
  echecs.value = echecs.value.filter((x) => x.id !== j.id);
}

function signalerEchec(j: ResumeJob): void {
  echecs.value = [...echecs.value.filter((x) => x.id !== j.id), j];
  p.showToast(`« ${nomJob(j)} » s'est arrêté : ${sortie(j)}`, "error", {
    duration: 10000,
    actionLabel: "Aller au message",
    onAction: () => allerAuJob(j),
  });
}

// Issue connue de chaque job de la conversation : seul le passage d'« actif » à « échec » est signalé.
const vus = new Map<string, IssueJob>();
let chatSuivi: string | null | undefined;
watch(
  () => [p.currentChatId, p.jobsChat] as const,
  ([chat, jobs]) => {
    if (chat !== chatSuivi) {
      chatSuivi = chat;
      vus.clear();
      echecs.value = [];
    }
    for (const j of jobs) {
      const avant = vus.get(j.id);
      const issue = issueJob(j);
      vus.set(j.id, issue);
      if (avant === "actif" && issue === "echec") signalerEchec(j);
    }
  },
  { immediate: true },
);

const PUCE =
  "inline-flex items-center gap-1 h-7 px-2 rounded-lg border text-xs font-medium transition-colors min-w-0 max-w-[16rem]";
const NEUTRE = "border-slate-200 bg-white text-slate-700 hover:bg-slate-100";
</script>

<template>
  <div
    v-if="visible"
    role="region"
    aria-label="Activité"
    class="mb-2 flex flex-wrap items-center gap-1.5 px-1"
    data-barre-activite
  >
    <span class="text-xs font-semibold text-slate-500 mr-0.5">Activité</span>

    <PuceJobs
      v-if="voletJobs || p.jobsChat.length > 0"
      :jobs="p.jobsPortee === 'all' ? p.jobsTous : p.jobsChat"
      :portee="p.jobsPortee"
      :ouvert="p.jobsOuvert"
      :actifs-chat="p.jobsActifsChat"
      :actifs-total="p.jobsActifsTotal"
      :file-reveil="p.jobsFileReveil"
      :reveil-en-cours="p.jobsReveilEnCours"
      :reveil-desactive="p.jobsReveilDesactive"
      :chat-id="p.currentChatId"
      :limite="p.jobsPortee === 'all' ? p.jobsLimites.compte : p.jobsLimites.chat"
      @basculer="p.jobsBasculer($event)"
      @portee="p.jobsChoisirPortee($event)"
      @arreter="p.jobsArreter($event)"
      @tout-arreter="p.jobsToutArreter()"
      @journal="p.jobsOuvrirJournal($event)"
      @interrupteur="p.jobsBasculerReveil()"
      @conversation="p.jobsOuvrirConversation($event)"
    />

    <button
      v-for="j in actifs"
      :key="j.id"
      type="button"
      :class="[PUCE, NEUTRE]"
      :title="`${j.command} : aller à l'étape dans le fil`"
      :data-activite-job="j.id"
      @click="allerAuJob(j)"
    >
      <i
        class="ph ph-circle-notch animate-spin motion-reduce:animate-none text-blue-600 shrink-0"
        aria-hidden="true"
      ></i>
      <span class="truncate">{{ nomJob(j) }}</span>
      <span class="shrink-0 tabular-nums text-slate-500">· {{ dureeJob(j, maintenant) }}</span>
    </button>

    <span
      v-for="j in echecs"
      :key="'e' + j.id"
      :class="[PUCE, 'border-red-200 bg-red-50 text-red-700 pr-0.5']"
      :data-activite-echec="j.id"
    >
      <button
        type="button"
        class="inline-flex items-center gap-1 min-w-0"
        :title="`${j.command} : aller à l'étape dans le fil`"
        @click="allerAuJob(j)"
      >
        <i class="ph ph-x-circle shrink-0" aria-hidden="true"></i>
        <span class="truncate">{{ nomJob(j) }}</span>
        <span class="shrink-0">· {{ sortie(j) }}</span>
      </button>
      <button
        type="button"
        title="Masquer"
        :aria-label="`Masquer l'échec de ${nomJob(j)}`"
        class="w-6 h-6 rounded-md flex items-center justify-center hover:bg-red-100"
        @click="masquer(j)"
      >
        <i class="ph ph-x text-xs" aria-hidden="true"></i>
      </button>
    </span>

    <button
      v-for="a in agents"
      :key="'a' + a.idx + '-' + a.ri"
      type="button"
      :class="[PUCE, NEUTRE]"
      :title="a.titre"
      data-activite-agent
      @click="p.openTaskModal({ idx: a.idx, msg: p.messages[a.idx] }, a.ri)"
    >
      <i class="ph ph-users-three text-slate-500 shrink-0" aria-hidden="true"></i>
      <span class="truncate">{{ a.libelle }}</span>
    </button>

    <button
      v-if="etape"
      type="button"
      :class="[PUCE, NEUTRE]"
      title="Étape en cours : aller à la ligne du fil"
      data-activite-etape
      @click="allerAEtape(etape.callId)"
    >
      <i class="ph text-slate-500 shrink-0" :class="toolIconFor(etape.nom)" aria-hidden="true"></i>
      <span class="truncate font-mono">{{ etape.nom }}</span>
    </button>
  </div>
</template>
