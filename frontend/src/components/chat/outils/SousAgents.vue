<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/outils/SousAgents.vue — lignes persistantes des sous-agents (outil task) : état, jetons, étape, bilan du harnais (statut, appels, durée, lecture seule, détails dépliables), déroulé et arrêt. -->
<script setup lang="ts">
import { computed, ref, useId } from "vue";

import {
  aReflechi,
  arretSurBudget,
  classeStatutTache,
  detailsTache,
  fmtAppelsTache,
  fmtDureeTache,
  libelleEtatRun,
  libelleSourceLectureSeule,
  libelleStatutTache,
  resumeDetailsTache,
  signeEtatRun,
} from "../../../features/chat/outils/bilan-tache";
import { fmtTokensCourt } from "../../../features/chat/outils/format";
import type { ExecutionSousAgent } from "../../../features/chat/outils/types";
import DetailsSousAgent from "./DetailsSousAgent.vue";

const props = defineProps<{ runs: readonly ExecutionSousAgent[]; logoApp: string }>();
const emit = defineEmits<{ deroule: [index: number]; arreter: [run: ExecutionSousAgent] }>();

const SIGNES = {
  ok: "ph-check-circle is-done",
  echec: "ph-warning-circle is-error",
  incomplet: "ph-warning-circle is-warn",
  arret: "ph-stop-circle is-neutral",
} as const;
const base = useId();
const ouverts = ref<ReadonlySet<number>>(new Set());
function basculer(i: number): void {
  const s = new Set(ouverts.value);
  if (!s.delete(i)) s.add(i);
  ouverts.value = s;
}
// Bilan affiché une fois le run fini : pendant le direct, la ligne garde son étape.
const lignes = computed(() =>
  props.runs.map((run) => ({ run, bilan: run.state !== "running" && run.harness ? run.harness : null })),
);
</script>

<template>
  <div class="task-runs" role="status" aria-live="polite">
    <div
      v-for="({ run, bilan }, rui) in lignes"
      :key="'trun' + rui"
      :style="run.depth ? { paddingLeft: run.depth * 1.25 + 'rem' } : null"
    >
      <div class="task-run">
        <span class="task-branch" aria-hidden="true">└─</span>
        <i
          class="ph task-run-ico"
          :class="
            run.state === 'running' && !run.id
              ? 'ph-hourglass-medium'
              : run.state === 'running'
                ? 'ph-spinner-gap animate-spin is-running'
                : SIGNES[signeEtatRun(run.state)]
          "
        ></i>
        <img
          :src="props.logoApp"
          alt=""
          data-logo-sous-agent
          class="w-4 h-4 rounded-full object-cover shrink-0"
        />
        <span class="task-run-title"
          >{{ run.agent }}<template v-if="run.label"> — {{ run.label }}</template></span
        >
        <span
          v-if="typeof run.tokens === 'number'"
          class="task-run-tokens"
          :class="{ 'is-live': run.state === 'running' }"
        >
          {{ fmtTokensCourt(run.tokens) }} jetons
        </span>
        <span v-if="run.state === 'running' && !run.id" class="task-run-meta">· En attente</span>
        <span v-else-if="run.state === 'running' && run.progress" class="task-run-meta">
          · étape {{ run.progress.step
          }}<template v-if="run.progress.max_steps">/{{ run.progress.max_steps }}</template>
        </span>
        <span v-else-if="run.state && run.state !== 'running' && !bilan" class="task-run-meta" data-etat-run>
          <template v-if="run.state !== 'completed'">· {{ libelleEtatRun(run.state) }}</template
          ><template v-else-if="run.steps_total"
            >· {{ run.steps_total }} appel{{ run.steps_total > 1 ? "s" : "" }}</template
          >
        </span>
        <button
          v-if="run.state === 'running' || (run.transcript && run.transcript.length)"
          class="task-run-eye"
          title="Voir le déroulé de l'agent"
          aria-label="Voir le déroulé de l'agent"
          @click="emit('deroule', rui)"
        >
          <i class="ph ph-eye"></i>
        </button>
        <button
          v-if="run.state === 'running' && !run.cancelRequested"
          class="task-run-cancel"
          :title="run.id ? 'Arrêter cet agent (la génération continue)' : 'Annuler cet agent en attente'"
          aria-label="Arrêter cet agent"
          @click="emit('arreter', run)"
        >
          <i class="ph ph-x"></i>
        </button>
        <span v-else-if="run.state === 'running' && run.cancelRequested" class="task-run-meta"
          >· annulation…</span
        >
      </div>
      <div v-if="bilan" class="task-run-bilan">
        <span class="task-run-badge" :class="classeStatutTache(bilan.status)" data-task-status>{{
          libelleStatutTache(bilan.status)
        }}</span>
        <span class="task-run-meta" title="Appels d'outils de ce lancement sur son budget" data-task-calls
          >{{ fmtAppelsTache(bilan) }} appels</span
        >
        <span class="task-run-meta" data-task-duration>· {{ fmtDureeTache(bilan) }}</span>
        <span
          v-if="aReflechi(run, bilan)"
          class="task-run-meta"
          title="L'agent a réfléchi avant d'agir ; sa réflexion ne remonte pas dans le chat"
          data-task-thinking
          >· réflexion</span
        >
        <span
          v-if="bilan.context === 'fork'"
          class="task-run-meta"
          title="L'agent est parti de toute la conversation (contexte du parent), sans page blanche"
          data-task-fork
          >· fork</span
        >
        <span
          v-if="bilan.browser_session === 'user'"
          class="task-run-meta"
          title="L'agent a utilisé votre session de navigateur (vos connexions), partagée avec vous"
          data-task-navigateur-compte
          >· votre session web</span
        >
        <span
          v-if="arretSurBudget(bilan)"
          class="task-run-meta"
          title="L'agent a conclu de lui-même après l'avertissement de fin de budget"
          data-task-arret
          >· arrêt sur budget</span
        >
        <span
          v-if="bilan.read_only"
          class="task-run-ro"
          :title="
            bilan.read_only_source
              ? 'Lecture seule : ' + libelleSourceLectureSeule(bilan.read_only_source)
              : 'Lecture seule'
          "
          data-task-ro
          ><i class="ph ph-lock-simple" aria-hidden="true"></i>lecture seule</span
        >
        <button
          v-if="detailsTache(bilan)"
          type="button"
          class="task-run-more"
          :aria-expanded="ouverts.has(rui)"
          :aria-controls="base + '-' + rui"
          data-task-more
          @click="basculer(rui)"
        >
          <i
            class="ph ph-caret-right task-run-caret"
            :class="{ 'is-open': ouverts.has(rui) }"
            aria-hidden="true"
          ></i
          >{{ resumeDetailsTache(bilan) || "Détails" }}
        </button>
      </div>
      <p
        v-if="bilan?.remaining_work"
        class="task-run-reste"
        :class="{ 'is-open': ouverts.has(rui) }"
        data-task-reste
      >
        Reste : {{ bilan.remaining_work }}
      </p>
      <div v-if="bilan" v-show="ouverts.has(rui)" :id="base + '-' + rui" class="task-run-details">
        <DetailsSousAgent :bilan="bilan" :avec-reste="false" />
      </div>
    </div>
  </div>
</template>
