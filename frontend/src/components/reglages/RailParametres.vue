<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/reglages/RailParametres.vue — rail des Paramètres en quatre groupes avec recherche. -->
<script setup lang="ts">
import { computed, ref } from "vue";

import { domaineReglages } from "../../features/reglages/domaine";
import { GROUPES_RAIL, filtrerRail } from "../../features/reglages/rail";

const rg = domaineReglages();
const requete = ref("");
const avanceOuvert = ref(false);

const groupes = computed(() => filtrerRail(requete.value));
const enRecherche = computed(() => requete.value.trim() !== "");

function groupeOuvert(titre: string, replie?: boolean): boolean {
  if (!replie || enRecherche.value) return true;
  const groupe = GROUPES_RAIL.find((g) => g.titre === titre);
  return avanceOuvert.value || (groupe?.entrees.some((e) => e.id === rg.settingsTab) ?? false);
}

function choisir(id: string): void {
  rg.settingsTab = id;
  const charger: Record<string, (() => unknown) | undefined> = {
    ai_models: () => rg.loadLlmConnectors(),
    usage: () => rg.loadUsageData(),
    connexions: () => rg.loadConnexions(),
    memory: () => rg.loadUserMemory(),
    agents: () => {
      void rg.loadMcpUserCategories();
      void rg.loadAgentTemplates();
    },
    prompts: () => {
      void rg.loadSavedPrompts();
      void rg.loadPromptTemplates();
    },
    skills: () => rg.openSkillsTab(),
    archives: () => rg.loadArchives && rg.loadArchives(),
    sandbox: () => rg.loadSandboxState(),
    connectors: () => rg.loadGitConnectors(),
  };
  void charger[id]?.();
}

function choisirDepuisListe(ev: Event): void {
  choisir((ev.target as HTMLSelectElement).value);
}
</script>

<template>
  <aside
    class="w-full md:w-52 shrink-0 bg-slate-50 border-b md:border-b-0 md:border-r border-slate-200 md:overflow-y-auto custom-scrollbar p-3"
    data-rail-parametres
  >
    <div class="relative mb-2">
      <i
        class="ph ph-magnifying-glass absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 text-sm"
        aria-hidden="true"
      ></i>
      <input
        v-model="requete"
        type="search"
        placeholder="Rechercher (ex. token)"
        aria-label="Rechercher un réglage"
        class="w-full h-8 pl-7 pr-2 text-sm rounded-md border border-slate-200 bg-white text-slate-800 placeholder:text-slate-400"
        data-rail-recherche
      />
    </div>

    <select
      class="md:hidden w-full h-8 text-sm rounded-md border border-slate-200 bg-white text-slate-800"
      aria-label="Section des paramètres"
      :value="rg.settingsTab"
      @change="choisirDepuisListe"
    >
      <optgroup v-for="g in groupes" :key="g.titre" :label="g.titre">
        <option v-for="e in g.entrees" :key="e.id" :value="e.id">{{ e.libelle }}</option>
      </optgroup>
    </select>

    <nav class="hidden md:block" aria-label="Sections des paramètres">
      <p v-if="!groupes.length" class="text-xs text-slate-500 px-2.5 py-1.5" role="status">
        Aucun réglage trouvé.
      </p>
      <div v-for="g in groupes" :key="g.titre" class="mb-2">
        <button
          v-if="g.replie && !enRecherche"
          type="button"
          class="w-full flex items-center gap-1 text-xs font-semibold text-slate-500 px-2.5 mb-1.5 mt-1"
          :aria-expanded="groupeOuvert(g.titre, g.replie) ? 'true' : 'false'"
          @click="avanceOuvert = !avanceOuvert"
        >
          <i
            class="ph text-xs"
            :class="groupeOuvert(g.titre, g.replie) ? 'ph-caret-down' : 'ph-caret-right'"
            aria-hidden="true"
          ></i>
          {{ g.titre }}
          <span class="ml-auto font-normal">{{ g.entrees.length }}</span>
        </button>
        <div v-else class="text-xs font-semibold text-slate-500 px-2.5 mb-1.5 mt-1">{{ g.titre }}</div>
        <template v-if="groupeOuvert(g.titre, g.replie)">
          <button
            v-for="e in g.entrees"
            :key="e.id"
            type="button"
            :aria-current="rg.settingsTab === e.id ? 'page' : undefined"
            :class="
              rg.settingsTab === e.id
                ? 'bg-white text-blue-600 shadow-sm font-medium'
                : 'text-slate-600 hover:bg-white/60 hover:text-slate-800'
            "
            class="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-sm transition-colors mb-0.5"
            @click="choisir(e.id)"
          >
            <i class="ph text-base" :class="e.icone" aria-hidden="true"></i>
            {{ e.libelle }}
          </button>
        </template>
      </div>
    </nav>
  </aside>
</template>
