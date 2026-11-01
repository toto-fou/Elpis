<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/agents/FicheAgent.vue — vue agent de la page Agents : bandeau d'identité, onglets Général / Droits / Outils / Instructions et leur panneau. -->
<script setup lang="ts">
import { computed, ref, useTemplateRef } from "vue";

import { bandeDeFormulaire, ONGLETS_FICHE, rangeeDuFormulaire } from "../../features/agents/page";
import type { OngletFiche } from "../../features/agents/page";
import { socleAgentPersonnel } from "../../features/reglages/agents";
import { domaineReglages } from "../../features/reglages/domaine";
import BandeCapacites from "./BandeCapacites.vue";
import PanneauDroits from "./PanneauDroits.vue";
import PanneauGeneral from "./PanneauGeneral.vue";
import PanneauInstructions from "./PanneauInstructions.vue";
import PanneauOutils from "./PanneauOutils.vue";

const rg = domaineReglages();
const onglet = ref<OngletFiche>("general");
const liste = useTemplateRef<HTMLElement>("liste");

const rangee = computed(() => rangeeDuFormulaire(rg.agentBank, rg.agentForm));
const bande = computed(() =>
  rg.agentForm
    ? bandeDeFormulaire(
        rg.agentForm,
        rg.agentFormChoix.lectureSeule.valeur,
        socleAgentPersonnel(rg.mcpUserCategories),
      )
    : null,
);
/** Le groupe Navigateur des droits n'a de sens qu'avec la case Web accordée, ou des capacités inconnues. */
const navigateur = computed(
  () =>
    !bande.value || bande.value.inconnu || bande.value.cases.some((c) => c.cle === "web" && c.etat === "oui"),
);
const icone = computed(() => rangee.value?.icon ?? "ph-robot");
const nom = computed(() => rg.agentForm?.name.trim() || "Nouvel agent");
const description = computed(() => rg.agentForm?.description || rg.agentForm?._tplSummary || "");
const etat = computed(() => (!rangee.value ? "Nouveau" : rangee.value.enabled ? "Actif" : "Inactif"));
const CLASSES_ETAT: Readonly<Record<string, string>> = {
  Actif: "bg-emerald-50 text-emerald-700",
  Inactif: "bg-slate-100 text-slate-600",
  Nouveau: "bg-blue-50 text-blue-700",
};

/** Flèches, Début et Fin entre les onglets : le focus et la sélection suivent. */
function surClavier(e: KeyboardEvent): void {
  const i = ONGLETS_FICHE.findIndex((o) => o.id === onglet.value);
  const cible: Record<string, number> = {
    ArrowRight: (i + 1) % ONGLETS_FICHE.length,
    ArrowLeft: (i + ONGLETS_FICHE.length - 1) % ONGLETS_FICHE.length,
    Home: 0,
    End: ONGLETS_FICHE.length - 1,
  };
  const n = cible[e.key];
  if (n === undefined) return;
  e.preventDefault();
  onglet.value = ONGLETS_FICHE[n]?.id ?? "general";
  liste.value?.querySelectorAll<HTMLElement>('[role="tab"]')[n]?.focus();
}
</script>

<template>
  <div v-if="rg.agentForm" class="flex-1 min-h-0 overflow-y-auto px-6 py-5" data-agent-fiche>
    <div class="max-w-[860px] mx-auto flex flex-col gap-4">
      <div class="flex flex-wrap items-center gap-3.5 px-4 py-4 rounded-2xl border border-slate-200 bg-white">
        <span
          class="w-11 h-11 rounded-xl bg-slate-100 text-slate-600 flex items-center justify-center shrink-0"
        >
          <i class="ph text-[22px]" :class="icone" aria-hidden="true"></i>
        </span>
        <div class="flex-1 min-w-[15rem]">
          <div class="flex items-center gap-2">
            <b class="font-mono text-[17px] text-slate-900" data-agent-nom-bandeau>{{ nom }}</b>
            <span
              class="px-2 py-0.5 rounded-md text-xs font-semibold"
              :class="CLASSES_ETAT[etat]"
              data-agent-etat-bandeau
              >{{ etat }}</span
            >
          </div>
          <p v-if="description" class="mt-0.5 text-[13px] text-slate-600 line-clamp-2">{{ description }}</p>
        </div>
        <BandeCapacites v-if="bande" :bande="bande" />
      </div>

      <div
        v-if="rg.agentFormError"
        class="text-xs text-red-700 bg-red-500/10 rounded-lg px-3 py-2"
        role="alert"
        data-agent-erreur
      >
        {{ rg.agentFormError }}
      </div>

      <div
        ref="liste"
        role="tablist"
        aria-label="Sections de l'agent"
        class="flex gap-1 border-b border-slate-200"
        @keydown="surClavier"
      >
        <button
          v-for="o in ONGLETS_FICHE"
          :id="'agent-onglet-' + o.id"
          :key="o.id"
          type="button"
          role="tab"
          class="min-h-10 px-3.5 -mb-px border-b-2 text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded-t"
          :class="
            onglet === o.id
              ? 'border-blue-600 font-semibold text-slate-900'
              : 'border-transparent font-medium text-slate-600 hover:text-slate-800'
          "
          :aria-selected="onglet === o.id ? 'true' : 'false'"
          :aria-controls="'agent-panneau-' + o.id"
          :tabindex="onglet === o.id ? 0 : -1"
          :title="o.info"
          :data-agent-onglet="o.id"
          @click="onglet = o.id"
        >
          {{ o.libelle }}
        </button>
      </div>

      <div
        :id="'agent-panneau-' + onglet"
        role="tabpanel"
        :aria-labelledby="'agent-onglet-' + onglet"
        class="px-5 py-4 rounded-2xl border border-slate-200 bg-white"
        :data-agent-panneau="onglet"
      >
        <PanneauGeneral v-if="onglet === 'general'" />
        <PanneauDroits v-else-if="onglet === 'droits'" :navigateur="navigateur" />
        <PanneauOutils v-else-if="onglet === 'outils'" />
        <PanneauInstructions v-else />
      </div>
    </div>
  </div>
</template>
