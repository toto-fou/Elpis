<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/outils/DetailsSousAgent.vue — détails du bloc du harnais d'un sous-agent : fichiers modifiés (autre agent du compte en même temps), git (index compris), lecture seule, reste à faire, cause d'arrêt, avertissements de budget, rapport, reprise. -->
<script setup lang="ts">
import { computed } from "vue";

import { libelleArretTache, libelleChangement } from "../../../features/chat/outils/bilan-tache";
import type { BilanTache } from "../../../features/chat/outils/bilan-tache";

const props = withDefaults(defineProps<{ bilan: BilanTache; avecReste?: boolean }>(), { avecReste: true });

const indexes = computed(() =>
  (props.bilan.git.staged ?? []).map((c) => (c === "." ? "toutes les modifications" : c)).join(", "),
);
const reprise = computed(() => `Reprise : ${props.bilan.tool_calls_total} appels en tout`);
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
        <p v-if="props.bilan.concurrent" class="task-bilan-note" data-task-bilan-concurrent>
          <i class="ph ph-warning-circle" aria-hidden="true"></i>
          Un autre agent du compte tournait en même temps : certains de ces fichiers peuvent être les siens.
        </p>
      </dd>
    </template>
    <template
      v-if="props.bilan.git.branch || props.bilan.git.commits.length || props.bilan.git.index_changed"
    >
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
        <div v-if="props.bilan.git.index_changed" data-task-bilan-index>
          Index modifié
          <span v-if="indexes"
            >: <span class="task-bilan-path">{{ indexes }}</span></span
          >
        </div>
      </dd>
    </template>
    <template v-if="props.bilan.read_only">
      <dt>Droits</dt>
      <dd data-task-bilan-ro>Lecture seule</dd>
    </template>
    <template v-if="props.avecReste && props.bilan.remaining_work">
      <dt>Reste à faire</dt>
      <dd class="task-bilan-text" data-task-bilan-reste>{{ props.bilan.remaining_work }}</dd>
    </template>
    <template v-if="props.bilan.stop_reason">
      <dt>Cause</dt>
      <dd data-task-bilan-cause>
        {{ libelleArretTache(props.bilan.stop_reason ?? "") }}
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
