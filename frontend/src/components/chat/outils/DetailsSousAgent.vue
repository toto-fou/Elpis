<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/outils/DetailsSousAgent.vue — détails du bloc du harnais d'un sous-agent : fichiers sûrs puis peut-être modifiés par un autre agent, git, lecture seule et sa source, chemins écrivables, reste à faire, cause d'arrêt, avertissements de budget, rapport, reprise. -->
<script setup lang="ts">
import { computed } from "vue";

import {
  libelleArretTache,
  libelleChangement,
  libelleSourceLectureSeule,
} from "../../../features/chat/outils/bilan-tache";
import type { BilanTache } from "../../../features/chat/outils/bilan-tache";

const props = withDefaults(defineProps<{ bilan: BilanTache; avecReste?: boolean }>(), { avecReste: true });

const incertain = computed(() => {
  const autres = props.bilan.overlapped_with ?? [];
  const qui = autres.length ? ` (${autres.join(", ")})` : "";
  return `Relevés par le shell pendant qu'un autre agent du compte tournait${qui} : l'auteur est incertain.`;
});
const lectureSeule = computed(() => {
  const src = props.bilan.read_only_source;
  return src ? "Lecture seule : " + libelleSourceLectureSeule(src) : "Lecture seule";
});
const reprise = computed(
  () =>
    `Reprise : ${props.bilan.tool_calls_total} appels en tout` +
    (props.bilan.budget_reset ? ", budget remis à zéro" : ""),
);
</script>

<template>
  <dl class="task-bilan" data-task-bilan>
    <template v-if="props.bilan.files_changed.length">
      <dt>Fichiers modifiés ({{ props.bilan.files_changed.length }})</dt>
      <dd>
        <ul class="task-bilan-files">
          <li v-for="f in props.bilan.files_changed" :key="f.path" data-task-bilan-file>
            <span class="task-bilan-path">{{ f.path }}</span>
            <span class="task-bilan-muted">{{ libelleChangement(f.change) }}</span>
            <span v-if="f.added" class="task-bilan-add">+{{ f.added }}</span>
            <span v-if="f.removed" class="task-bilan-del">−{{ f.removed }}</span>
          </li>
        </ul>
      </dd>
    </template>
    <template v-if="props.bilan.files_changed_candidates && props.bilan.files_changed_candidates.length">
      <dt>Peut-être modifiés par un autre agent ({{ props.bilan.files_changed_candidates.length }})</dt>
      <dd>
        <ul class="task-bilan-files">
          <li v-for="f in props.bilan.files_changed_candidates" :key="f.path" data-task-bilan-candidat>
            <span class="task-bilan-path">{{ f.path }}</span>
            <span class="task-bilan-muted">{{ libelleChangement(f.change) }}</span>
            <span v-if="f.added" class="task-bilan-add">+{{ f.added }}</span>
            <span v-if="f.removed" class="task-bilan-del">−{{ f.removed }}</span>
          </li>
        </ul>
        <p class="task-bilan-note" data-task-bilan-incertain>
          <i class="ph ph-warning-circle" aria-hidden="true"></i>
          {{ incertain }}
        </p>
      </dd>
    </template>
    <template v-if="props.bilan.git.branch || props.bilan.git.commits.length || props.bilan.git.pr_url">
      <dt>Git</dt>
      <dd>
        <div v-if="props.bilan.git.branch">
          Branche <span class="task-bilan-path">{{ props.bilan.git.branch }}</span>
        </div>
        <ul v-if="props.bilan.git.commits.length" class="task-bilan-files">
          <li v-for="c in props.bilan.git.commits" :key="c" class="task-bilan-path" data-task-bilan-commit>
            {{ c }}
          </li>
        </ul>
        <div v-if="props.bilan.git.pr_url">
          Demande de fusion <span class="task-bilan-path">{{ props.bilan.git.pr_url }}</span>
        </div>
      </dd>
    </template>
    <template
      v-if="props.bilan.read_only || (props.bilan.writable_paths && props.bilan.writable_paths.length)"
    >
      <dt>Droits</dt>
      <dd>
        <div v-if="props.bilan.read_only" data-task-bilan-ro>
          {{ lectureSeule }}
        </div>
        <div v-if="props.bilan.writable_paths && props.bilan.writable_paths.length">
          Écriture limitée à
          <span class="task-bilan-path">{{ props.bilan.writable_paths.join(", ") }}</span>
          <span v-if="props.bilan.writable_paths_scope === 'file_tools_only'" class="task-bilan-muted">
            (outils de fichiers seulement, le shell n'est pas borné)</span
          >
        </div>
      </dd>
    </template>
    <template v-if="props.avecReste && props.bilan.remaining_work">
      <dt>Reste à faire</dt>
      <dd class="task-bilan-text" data-task-bilan-reste>{{ props.bilan.remaining_work }}</dd>
    </template>
    <template v-if="props.bilan.missing_fields && props.bilan.missing_fields.length">
      <dt>Champs absents du rapport</dt>
      <dd class="task-bilan-path">{{ props.bilan.missing_fields.join(", ") }}</dd>
    </template>
    <template v-if="props.bilan.reason || props.bilan.stop_reason">
      <dt>Cause</dt>
      <dd data-task-bilan-cause>
        {{ props.bilan.reason || libelleArretTache(props.bilan.stop_reason ?? "") }}
      </dd>
    </template>
    <template v-if="props.bilan.budget_warnings && props.bilan.budget_warnings.length">
      <dt>Avertissements de budget ({{ props.bilan.budget_warnings.length }})</dt>
      <dd>
        <ul class="task-bilan-files">
          <li v-for="(a, i) in props.bilan.budget_warnings" :key="i" data-task-bilan-avertissement>
            <span class="task-bilan-muted">après {{ a.at }} appel{{ a.at > 1 ? "s" : "" }}</span>
            {{ a.text }}
          </li>
        </ul>
      </dd>
    </template>
    <template
      v-if="
        props.bilan.resumed || props.bilan.errors || props.bilan.report_saved_to || props.bilan.secrets_masked
      "
    >
      <dt>Exécution</dt>
      <dd>
        <div v-if="props.bilan.resumed">
          {{ reprise }}
        </div>
        <div v-if="props.bilan.errors">
          {{ props.bilan.errors }} appel{{ props.bilan.errors > 1 ? "s" : "" }} en erreur
        </div>
        <div v-if="props.bilan.report_saved_to">
          Rapport complet dans <span class="task-bilan-path">{{ props.bilan.report_saved_to }}</span>
        </div>
        <div v-if="props.bilan.secrets_masked">
          {{ props.bilan.secrets_masked }} secret{{ props.bilan.secrets_masked > 1 ? "s" : "" }} masqué{{
            props.bilan.secrets_masked > 1 ? "s" : ""
          }}
          dans le rapport
        </div>
      </dd>
    </template>
  </dl>
</template>
