<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/outils/PuceJobs.vue — puce « Tâches de fond » (outil shell_job) de la barre de prompt et son volet : jobs de la conversation ou du compte, journal, arrêt, interrupteur de réveil, file de réveil ; la fermeture au clic extérieur suit [data-jobs-flyout]. -->
<script setup lang="ts">
import { computed } from "vue";

import type { ReponseJobs, ResumeJob } from "@elpis/contracts";

import { utiliserHorloge } from "../../../features/chat/jobs/horloge";
import { dureeJob, issueJob, jobActif, libelleArme, libelleJob } from "../../../features/chat/jobs/format";
import type { IssueJob } from "../../../features/chat/jobs/format";
import type { PorteeJobs } from "../../../features/chat/jobs/jobs";

const props = defineProps<{
  jobs: readonly ResumeJob[];
  portee: PorteeJobs;
  ouvert: boolean;
  actifsChat: number;
  actifsTotal: number;
  fileReveil: ReponseJobs["wake_queue"];
  reveilEnCours: ReponseJobs["wake_running"];
  reveilDesactive: boolean;
  chatId: string | null;
  limite: number;
  /** Puce calée à droite (rangée du composeur) : le volet s'ouvre vers la gauche. */
  aDroite?: boolean;
}>();
const emit = defineEmits<{
  basculer: [ouvert: boolean];
  portee: [portee: PorteeJobs];
  arreter: [id: string];
  toutArreter: [];
  journal: [job: ResumeJob];
  interrupteur: [];
  conversation: [chatId: string];
}>();

const maintenant = utiliserHorloge(() => props.ouvert);

// Le compteur dit de quoi il parle : la conversation ouverte (« ici »), sinon le compte.
const compte = computed(() => (props.chatId ? `${props.actifsChat} ici` : String(props.actifsTotal)));
const titre = computed(() =>
  props.chatId
    ? `Tâches de fond actives : ${props.actifsChat} ici, ${props.actifsTotal} sur le compte`
    : `Tâches de fond actives : ${props.actifsTotal} sur le compte`,
);
const nActifsVue = computed(() => props.jobs.filter(jobActif).length);
const enAttente = computed(() => props.fileReveil.length);
const LIMITE_AFFICHEES = 20;
/** Tâches du volet : toutes les actives, puis les terminées les plus récentes, 20 au plus en tout. */
const affichees = computed(() => {
  const place = Math.max(LIMITE_AFFICHEES - nActifsVue.value, 0);
  const terminees = new Set(props.jobs.filter((j) => !jobActif(j)).slice(0, place));
  return props.jobs.filter((j) => jobActif(j) || terminees.has(j));
});
const masquees = computed(() => props.jobs.length - affichees.value.length);

const CLASSE_ISSUE: Readonly<Record<IssueJob, string>> = {
  actif: "text-blue-600",
  reussi: "text-emerald-600",
  arrete: "text-slate-500",
  perdu: "text-amber-700",
  echec: "text-red-600",
};
const ICONE_ISSUE: Readonly<Record<IssueJob, string>> = {
  actif: "ph-circle-notch animate-spin motion-reduce:animate-none",
  reussi: "ph-check-circle",
  arrete: "ph-stop-circle",
  perdu: "ph-warning",
  echec: "ph-x-circle",
};
</script>

<template>
  <div class="relative shrink-0 flex items-center" data-jobs-flyout>
    <button
      :aria-expanded="props.ouvert ? 'true' : 'false'"
      aria-haspopup="true"
      :title="titre"
      data-jobs-chip
      class="flex items-center gap-1 px-1.5 py-1 rounded-lg text-xs font-medium transition-colors"
      :class="
        props.ouvert
          ? 'bg-slate-100 text-slate-700'
          : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100'
      "
      @click="emit('basculer', !props.ouvert)"
    >
      <i class="ph ph-timer text-base"></i>
      <span class="font-mono tabular-nums" data-jobs-count>{{ compte }}</span>
      <span
        v-if="props.actifsChat > 0"
        class="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse motion-reduce:animate-none"
        aria-hidden="true"
      ></span>
    </button>

    <Transition name="popover-up">
      <div
        v-if="props.ouvert"
        class="absolute bottom-full mb-2 w-96 bg-white border border-slate-200 rounded-xl shadow-2xl z-[100] overflow-hidden"
        :class="props.aDroite ? 'right-0 max-w-[calc(100vw-2rem)]' : 'left-0'"
        data-jobs-popover
      >
        <div class="px-3 py-2 flex items-center gap-2 border-b border-slate-100 bg-slate-50">
          <i class="ph ph-timer text-slate-500 text-base"></i>
          <span class="text-xs font-bold text-slate-800">Tâches de fond</span>
          <span class="text-xs text-slate-500 tabular-nums">{{ nActifsVue }} / {{ props.limite }}</span>
          <button
            v-if="nActifsVue > 0"
            data-jobs-stop-all
            class="ml-auto text-xs px-2 py-1 rounded-md text-red-600 hover:bg-red-50"
            @click="emit('toutArreter')"
          >
            Tout arrêter
          </button>
          <button
            class="text-slate-400 hover:text-slate-800 p-0.5 rounded hover:bg-slate-100"
            :class="nActifsVue > 0 ? '' : 'ml-auto'"
            title="Fermer"
            @click.stop="emit('basculer', false)"
          >
            <i class="ph ph-x text-sm"></i>
          </button>
        </div>

        <div class="px-3 py-2 flex items-center gap-1 border-b border-slate-100 text-xs">
          <button
            v-for="v in [
              { id: 'chat', libelle: 'Cette conversation' },
              { id: 'all', libelle: 'Toutes les conversations' },
            ] as const"
            :key="v.id"
            :data-jobs-scope="v.id"
            :aria-pressed="props.portee === v.id ? 'true' : 'false'"
            class="px-2 py-1 rounded-md transition-colors"
            :class="
              props.portee === v.id
                ? 'bg-slate-100 text-slate-800 font-medium'
                : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100'
            "
            @click="emit('portee', v.id)"
          >
            {{ v.libelle }}
          </button>
        </div>

        <ul class="px-3 py-2 space-y-2 max-h-80 overflow-y-auto custom-scrollbar text-xs">
          <li v-if="!props.jobs.length" class="text-slate-500" data-jobs-vide>Aucune tâche de fond.</li>
          <li
            v-for="j in affichees"
            :key="j.id"
            data-jobs-row
            class="border border-slate-100 rounded-lg px-2 py-1.5"
          >
            <div class="flex items-center gap-2 min-w-0">
              <i
                class="ph text-sm shrink-0"
                :class="[ICONE_ISSUE[issueJob(j)], CLASSE_ISSUE[issueJob(j)]]"
                aria-hidden="true"
              ></i>
              <span class="font-medium text-slate-800 min-w-0 break-words">{{ j.label || j.command }}</span>
              <span
                class="ml-auto shrink-0 text-slate-500"
                :class="CLASSE_ISSUE[issueJob(j)]"
                :data-jobs-issue="issueJob(j)"
                >{{ libelleJob(j) }}</span
              >
              <span class="shrink-0 font-mono tabular-nums text-slate-500">{{
                dureeJob(j, maintenant)
              }}</span>
            </div>
            <div v-if="props.portee === 'all'" class="mt-0.5 flex items-center gap-1 text-slate-500 min-w-0">
              <i class="ph ph-chat-circle-text text-sm shrink-0"></i>
              <button
                data-jobs-chat-link
                class="min-w-0 break-words text-left text-blue-600 hover:underline"
                @click="emit('conversation', j.chat_id)"
              >
                {{ j.chat_title || "Conversation" }}
              </button>
            </div>
            <div v-if="j.last_line" class="mt-1 font-mono text-slate-500 break-all" data-jobs-last>
              {{ j.last_line }}
            </div>
            <div v-if="j.wake_on.length" class="mt-1 flex flex-wrap gap-1">
              <span
                v-for="(w, wi) in j.wake_on"
                :key="wi"
                class="px-1.5 rounded bg-slate-100 text-slate-600"
                data-jobs-armed
                >{{ libelleArme(w) }}</span
              >
            </div>
            <div class="mt-1.5 flex items-center gap-2">
              <button
                data-jobs-log
                class="flex items-center gap-1 px-1.5 py-0.5 rounded text-slate-600 hover:bg-slate-100"
                @click="emit('journal', j)"
              >
                <i class="ph ph-file-text text-sm"></i>Journal
              </button>
              <button
                v-if="jobActif(j)"
                data-jobs-stop
                class="flex items-center gap-1 px-1.5 py-0.5 rounded text-red-600 hover:bg-red-50"
                @click="emit('arreter', j.id)"
              >
                <i class="ph ph-stop text-sm"></i>Arrêter
              </button>
            </div>
          </li>
          <li v-if="masquees" class="text-slate-500" data-jobs-masquees>
            {{ masquees }}
            {{
              masquees > 1
                ? "tâches terminées plus anciennes masquées"
                : "tâche terminée plus ancienne masquée"
            }}
          </li>
        </ul>

        <div
          v-if="props.reveilEnCours.length || enAttente"
          class="px-3 py-2 border-t border-slate-100 text-xs space-y-1"
          data-jobs-wakes
        >
          <div
            v-for="r in props.reveilEnCours"
            :key="r.chat_id"
            class="flex items-center gap-1 text-slate-700"
          >
            <i class="ph ph-alarm text-sm text-blue-600"></i>
            <span class="min-w-0 break-words">Réveil en cours : {{ r.chat_title || "Conversation" }}</span>
          </div>
          <div v-if="enAttente" class="text-slate-600" data-jobs-queue>
            {{ enAttente }} {{ enAttente > 1 ? "réveils en attente" : "réveil en attente" }}
          </div>
          <div
            v-for="q in props.fileReveil"
            :key="q.chat_id"
            class="flex items-center gap-1 text-slate-500"
            data-jobs-queued
          >
            <i class="ph ph-hourglass text-sm"></i>
            <span class="min-w-0 break-words">{{ q.chat_title || "Conversation" }}</span>
            <span class="ml-auto shrink-0 tabular-nums">{{ q.events }}</span>
          </div>
        </div>

        <label
          v-if="props.chatId"
          class="px-3 py-2 border-t border-slate-100 flex items-center gap-2 text-xs text-slate-700 cursor-pointer select-none"
        >
          <input
            type="checkbox"
            data-jobs-nowake
            :checked="props.reveilDesactive"
            @change="emit('interrupteur')"
          />
          <span>Ne pas me réveiller dans cette conversation</span>
        </label>
      </div>
    </Transition>
  </div>
</template>
