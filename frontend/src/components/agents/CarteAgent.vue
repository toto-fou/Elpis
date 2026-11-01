<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/agents/CarteAgent.vue — carte d'un agent dans la grille : tuile, nom (ouvre la fiche, carte entière cliquable), état écrit avec son interrupteur, description, bande de capacités, budget. -->
<script setup lang="ts">
import { computed } from "vue";

import { bandeDeRangee, etiquetteAgent, metaAgent } from "../../features/agents/page";
import { domaineReglages } from "../../features/reglages/domaine";
import { socleAgentPersonnel } from "../../features/reglages/agents";
import type { RangeeAgent } from "../../features/reglages/agents";
import BandeCapacites from "./BandeCapacites.vue";

const props = defineProps<{ agent: RangeeAgent }>();
const rg = domaineReglages();

const bande = computed(() => bandeDeRangee(props.agent, socleAgentPersonnel(rg.mcpUserCategories)));
const etat = computed(() => (props.agent.enabled ? "Actif" : "Inactif"));
</script>

<template>
  <li
    class="relative flex flex-col gap-2.5 p-4 rounded-2xl border border-slate-200 bg-white hover:border-blue-300 transition-colors"
    :data-agent-card="props.agent.name"
  >
    <div class="flex items-center gap-3">
      <span class="w-9 h-9 rounded-lg bg-slate-100 text-slate-600 flex items-center justify-center shrink-0">
        <i class="ph text-lg" :class="props.agent.icon" aria-hidden="true"></i>
      </span>
      <span class="flex-1 min-w-0 flex flex-col">
        <button
          type="button"
          class="self-start max-w-full truncate text-left font-mono text-[14.5px] font-bold text-slate-900 rounded focus:outline-none after:content-[''] after:absolute after:inset-0 after:rounded-2xl focus-visible:after:ring-2 focus-visible:after:ring-blue-500"
          :data-agent-open="props.agent.name"
          @click="rg.startEditAgent(props.agent)"
        >
          {{ props.agent.name }}
        </button>
        <span class="text-xs text-slate-500" data-agent-genre>{{ etiquetteAgent(props.agent) }}</span>
      </span>
      <label
        class="relative z-10 inline-flex items-center gap-1.5 h-7 shrink-0 cursor-pointer text-xs text-slate-600"
        :title="props.agent.enabled ? 'Actif' : 'Inactif : l\'assistant ne le lance pas'"
      >
        <span data-agent-etat>{{ etat }}</span>
        <input
          type="checkbox"
          role="switch"
          :checked="props.agent.enabled"
          :aria-checked="props.agent.enabled ? 'true' : 'false'"
          class="sr-only peer"
          :aria-label="props.agent.name + ' : ' + etat.toLowerCase()"
          :data-agent-enabled="props.agent.name"
          @change="rg.toggleAgentEnabled(props.agent)"
        />
        <span class="set-switch-track block peer-checked:bg-blue-600 peer-checked:border-blue-600"></span>
      </label>
    </div>
    <p class="line-clamp-2 min-h-[2.4rem] text-[13px] leading-snug text-slate-600" data-agent-desc>
      {{ props.agent.description }}
    </p>
    <div class="flex items-center gap-2">
      <BandeCapacites :bande="bande" />
      <span class="flex-1 text-right text-xs text-slate-500 tabular-nums" data-agent-meta>{{
        metaAgent(props.agent)
      }}</span>
    </div>
  </li>
</template>
