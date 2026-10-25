<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/message/LigneAttenteJob.vue — à la place du pied d'une bulle qui attend son réveil : « En attente de « serveur » » et l'horloge de la tâche (heure du serveur) tant qu'elle tourne, puis « Reprise… » jusqu'à la reprise. -->
<script setup lang="ts">
import { computed } from "vue";

import type { ResumeJob } from "@elpis/contracts";

import { jobActif, libelleArme } from "../../../features/chat/jobs/format";
import { utiliserHorloge } from "../../../features/chat/jobs/horloge";
import { horlogeJob } from "../../../features/chat/message/taches-fond";

const props = defineProps<{ jobs: readonly ResumeJob[] }>();

const actifs = computed(() => props.jobs.filter(jobActif));
const maintenant = utiliserHorloge(() => actifs.value.length > 0);
const nomsDe = (jobs: readonly ResumeJob[]): string =>
  jobs.map((j) => `« ${j.label || j.command} »`).join(", ");
const horloge = computed(() => {
  const departs = actifs.value.flatMap((j) => (j.started_at == null ? [] : [j.started_at]));
  return departs.length ? horlogeJob(maintenant.value - Math.min(...departs)) : "";
});
const titre = computed(() =>
  actifs.value.length
    ? "Réveil : " + [...new Set(actifs.value.flatMap((j) => j.wake_on.map(libelleArme)))].join(", ")
    : "Réveil par " + nomsDe(props.jobs),
);
</script>

<template>
  <div
    class="mt-2 flex items-center gap-1.5 text-[12px] text-slate-500 select-none"
    :title="titre"
    data-attente-job
    :data-reprise="actifs.length ? undefined : ''"
  >
    <i
      class="ph shrink-0 text-[13px] text-slate-400"
      :class="actifs.length ? 'ph-hourglass-medium' : 'ph-alarm'"
      aria-hidden="true"
    ></i>
    <template v-if="actifs.length">
      <span class="min-w-0 truncate">En attente de {{ nomsDe(actifs) }}</span>
      <span v-if="horloge" class="shrink-0 tabular-nums">{{ " · " + horloge }}</span>
    </template>
    <span v-else class="min-w-0 truncate">Reprise…</span>
  </div>
</template>
