<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/outils/LigneJob.vue — tâche de fond lancée par l'assistant, une ligne vivante comme un agent : nom, commande, état et horloge à l'heure du serveur, réveils en infobulle ; un clic ouvre son journal. -->
<script setup lang="ts">
import { computed, inject } from "vue";

import type { ResumeJob } from "@elpis/contracts";

import { jobActif } from "../../../features/chat/jobs/format";
import { utiliserHorloge } from "../../../features/chat/jobs/horloge";
import { etatJobFil, reveilDuJob } from "../../../features/chat/message/taches-fond";
import type { SigneJob } from "../../../features/chat/message/taches-fond";
import type { EtapeOutil } from "../../../features/chat/outils/types";
import { CLE_PAGE } from "../../../features/chat/page/domaines";

const props = defineProps<{ etape: EtapeOutil; job: ResumeJob | null }>();
const emit = defineEmits<{ ouvrir: [] }>();
const page = inject(CLE_PAGE, null);

const maintenant = utiliserHorloge(() => !!props.job && jobActif(props.job));
const etat = computed(() => etatJobFil(props.etape, props.job, maintenant.value));

function arg(cle: string): string {
  const v = props.etape.args?.[cle];
  return typeof v === "string" ? v.trim() : "";
}
const commande = computed(() => props.job?.command || arg("command"));
const nom = computed(() => props.job?.label || arg("label") || commande.value || "Tâche de fond");
const commandeVue = computed(() => (commande.value !== nom.value ? commande.value : ""));
const reveil = computed(() => (page && props.job ? reveilDuJob(page.messages, props.job.id) : ""));
const titre = computed(() =>
  [
    [commande.value, etat.value.duree, props.job ? "Ouvrir le journal" : "Détails de l'appel"]
      .filter(Boolean)
      .join(" · "),
    reveil.value,
  ]
    .filter(Boolean)
    .join("\n"),
);

const ICONES: Readonly<Record<SigneJob, string>> = {
  cours: "ph-spinner-gap animate-spin motion-reduce:animate-none text-blue-500",
  ok: "ph-check text-emerald-600",
  echec: "ph-x-circle text-red-500",
  arret: "ph-stop-circle text-slate-400",
  perdu: "ph-warning-circle text-amber-600",
  inconnu: "ph-timer text-slate-400",
};
const NOMS: Readonly<Record<SigneJob, string>> = {
  cours: "En cours",
  ok: "Terminée",
  echec: "Échec",
  arret: "Arrêtée",
  perdu: "Perdue",
  inconnu: "Tâche de fond",
};
</script>

<template>
  <button
    type="button"
    class="w-full flex items-center gap-2 px-1.5 py-1 -mx-1.5 rounded-md text-left text-[13px] text-slate-700 hover:bg-slate-100 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
    :data-etape="etape.callId || undefined"
    :data-job="job?.id"
    :title="titre"
    data-ligne-job
    data-jobs-flyout
    @click="emit('ouvrir')"
  >
    <i
      class="ph shrink-0 text-[14px]"
      :class="ICONES[etat.signe]"
      role="img"
      :aria-label="NOMS[etat.signe]"
    ></i>
    <span class="flex-1 min-w-0 truncate"
      ><b class="font-semibold">{{ nom }}</b
      ><span v-if="commandeVue" class="font-mono text-[12px] text-slate-500">{{
        " · " + commandeVue
      }}</span></span
    >
    <span class="shrink-0 text-[12px] text-slate-500 tabular-nums" data-etat-job>{{ etat.texte }}</span>
    <i class="ph ph-file-text shrink-0 text-[12px] text-slate-400" aria-hidden="true"></i>
  </button>
</template>
