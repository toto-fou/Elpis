<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/reglages/CaseLectureSeuleAgent.vue — case « Lecture seule » d'un agent de Paramètres › Agents : état effectif, source, imposée par l'administrateur (cochée et grisée). -->
<script setup lang="ts">
import type { RangeeAgent } from "../../features/reglages/agents";

const props = defineProps<{
  agent: Pick<RangeeAgent, "name" | "read_only" | "read_only_forced" | "read_only_source">;
  aide: string;
}>();
const emit = defineEmits<{ basculer: [] }>();

const SOURCES: Readonly<Record<RangeeAgent["read_only_source"], string>> = {
  imposee: "imposé par l'administrateur",
  compte: "votre réglage",
  defaut: "défaut de l'administrateur",
};
const IMPOSE = "Imposé par l'administrateur";
</script>

<template>
  <div class="mt-2 pl-8 flex items-center gap-2 flex-wrap">
    <label
      class="inline-flex items-center gap-1.5 text-[11px] text-slate-600"
      :class="props.agent.read_only_forced ? 'cursor-not-allowed' : 'cursor-pointer'"
      :title="props.agent.read_only_forced ? IMPOSE : undefined"
    >
      <input
        type="checkbox"
        class="accent-blue-500"
        :checked="props.agent.read_only"
        :disabled="props.agent.read_only_forced"
        :title="props.agent.read_only_forced ? IMPOSE : undefined"
        :aria-describedby="props.aide"
        :data-agent-readonly="props.agent.name"
        @change="emit('basculer')"
      />
      Lecture seule
    </label>
    <span class="text-[10.5px] text-slate-400" :data-agent-readonly-source="props.agent.name">{{
      SOURCES[props.agent.read_only_source]
    }}</span>
  </div>
</template>
