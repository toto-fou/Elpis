<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/agents/GrilleAgents.vue — vue grille de la page Agents : avertissements, groupes « Livrés » et « Personnels », carte « Nouvel agent ». -->
<script setup lang="ts">
import { computed } from "vue";

import { groupesAgents } from "../../features/agents/page";
import { domaineReglages } from "../../features/reglages/domaine";
import CarteAgent from "./CarteAgent.vue";

const rg = domaineReglages();
const groupes = computed(() => groupesAgents(rg.agentBank, rg.agentCustomCount, rg.CUSTOM_AGENTS_MAX));
const aucunActif = computed(
  () => !!rg.settings.agents_enabled && rg.agentBank.length > 0 && !rg.agentBank.some((a) => a.enabled),
);
</script>

<template>
  <div class="flex-1 min-h-0 overflow-y-auto px-6 py-5">
    <div class="max-w-[1180px] mx-auto flex flex-col gap-3.5">
      <p
        v-if="!rg.features.agents"
        class="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2"
        data-agents-desactives
      >
        Sous-agents désactivés sur cette instance (réglage administrateur).
      </p>
      <p
        v-if="aucunActif"
        class="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2"
        data-agents-none-active
      >
        Aucun agent actif : outil task indisponible.
      </p>
      <section v-for="g in groupes" :key="g.id" :aria-labelledby="'agents-' + g.id" :data-agent-groupe="g.id">
        <h3
          :id="'agents-' + g.id"
          class="mb-2 text-[13px] font-semibold text-slate-600"
          :title="g.id === 'perso' ? 'Agents personnalisés (les modèles livrés ne comptent pas)' : undefined"
        >
          {{ g.titre }}
        </h3>
        <ul class="grid gap-3.5 grid-cols-[repeat(auto-fill,minmax(270px,1fr))]">
          <CarteAgent v-for="a in g.agents" :key="a.name" :agent="a" />
          <li v-if="g.id === 'perso'" class="flex">
            <button
              type="button"
              class="flex-1 min-h-[7.5rem] flex items-center justify-center gap-2 rounded-2xl border-[1.5px] border-dashed border-slate-300 text-[13.5px] text-slate-600 hover:bg-slate-50 hover:text-slate-800 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              data-agent-new
              @click="rg.startCreateAgent()"
            >
              <i class="ph ph-plus" aria-hidden="true"></i> Nouvel agent
            </button>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>
