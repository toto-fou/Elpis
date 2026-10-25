<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/reglages/PanneauGeneration.vue — panneau « Génération » du chat : sections Réponse, Réflexion, Outils et Avancé, valeurs du modèle en indication, réglages modifiés signalés et rétablissables. -->
<script setup lang="ts">
import { computed, useId } from "vue";

import { nomLisible } from "../../features/chat/page/menu-modele";
import { libelleEffort } from "../../features/chat/page/puces";
import { domaineReglages } from "../../features/reglages/domaine";
import { clesModifiees, valeurReference } from "../../features/reglages/echantillonnage";
import type { CleNombre, CleSurcharge } from "../../features/reglages/echantillonnage";
import LigneGeneration from "./LigneGeneration.vue";

interface Champ {
  cle: CleNombre;
  libelle: string;
  min: number;
  max: number;
  pas: number;
  aide?: string;
}

const REPONSE: readonly Champ[] = [
  {
    cle: "temperature",
    libelle: "Température",
    min: 0,
    max: 2,
    pas: 0.05,
    aide: "Plus haut : réponses plus variées",
  },
  {
    cle: "max_tokens",
    libelle: "Longueur max",
    min: 1,
    max: 24576,
    pas: 128,
    aide: "Limite de la réponse en jetons, plafonnée par la fenêtre de contexte",
  },
];
const BUDGET: Champ = {
  cle: "thinking_budget_tokens",
  libelle: "Budget",
  min: 0,
  max: 131072,
  pas: 512,
  aide: "Jetons de réflexion (512 au moins), en chat simple ; 0 coupe la réflexion",
};
const OUTILS: readonly Champ[] = [
  {
    cle: "max_tool_iterations",
    libelle: "Tours d'outils max",
    min: 1,
    max: 500,
    pas: 1,
    aide: "Appels au modèle dans une même réponse ; un tour peut lancer plusieurs outils",
  },
];
const AVANCE: readonly Champ[] = [
  { cle: "top_p", libelle: "Top P", min: 0, max: 1, pas: 0.01 },
  { cle: "top_k", libelle: "Top K", min: 0, max: 1000, pas: 1 },
  { cle: "min_p", libelle: "Min P", min: 0, max: 1, pas: 0.01 },
  { cle: "repeat_penalty", libelle: "Pénalité de répétition", min: 0.5, max: 2, pas: 0.01 },
];

const rg = domaineReglages();
const id = useId();
const d = computed(() => rg.effectiveParamsData);
const modifiees = computed(() => new Set<CleSurcharge>(clesModifiees(rg.samplingOverride)));
const compteur = computed(() => {
  const n = modifiees.value.size;
  return n === 0 ? "Valeurs du modèle" : n === 1 ? "1 modifié" : `${n} modifiés`;
});
const sousTitre = computed(() =>
  d.value?.model_id ? `Pour ce chat · ${nomLisible(d.value.model_id)}` : "Pour ce chat",
);
const reflexion = computed(
  () => !!d.value && (!!d.value.supports_thinking || (!!d.value.degraded && !!rg.selectedConnector)),
);
const sectionReflexion = computed(
  () => reflexion.value || rg.reasoningEffortValues.length > 0 || rg.preserveReasoningSupported,
);
const conserveParDefaut = computed(() => d.value?.preserve_reasoning_default ?? true);
const aideConserve = computed(
  () =>
    (rg.preserveReasoningEnabled
      ? "Activé · la réflexion déjà produite est rendue au modèle, son gabarit décide de ce qu'il garde. Plus cohérent, prompt plus long ; avec SGLang, la question suivante recalcule les appels d'outils du tour."
      : "Désactivé · seule la réflexion en cours compte. Prompt plus court.") +
    " Changer en cours de conversation force un re-calcul du cache une fois.",
);
const efforts = computed<readonly (string | null)[]>(() => [null, ...rg.reasoningEffortValues]);

const nombre = (n: number): string => n.toLocaleString("fr-FR", { maximumFractionDigits: 2 });
function reference(c: Champ): string {
  const v = valeurReference(d.value, c.cle);
  return v === null ? "auto" : nombre(v);
}
const ignore = (c: CleNombre): string | undefined =>
  rg.isIgnoredByEngine(c) ? "Ignoré par ce moteur : réglage propre à llama.cpp" : undefined;

function choisirEffort(v: string | null): void {
  rg.pickReasoningEffort(v);
}

// Groupe radio : les flèches déplacent le choix et le focus.
function surToucheEffort(e: KeyboardEvent): void {
  const pas =
    e.key === "ArrowRight" || e.key === "ArrowDown"
      ? 1
      : e.key === "ArrowLeft" || e.key === "ArrowUp"
        ? -1
        : 0;
  if (!pas) return;
  e.preventDefault();
  const liste = efforts.value;
  const i = liste.indexOf(rg.samplingOverride.reasoning_effort ?? null);
  const suivant = liste[(i + pas + liste.length) % liste.length] ?? null;
  choisirEffort(suivant);
  const groupe = (e.currentTarget as HTMLElement | null) ?? null;
  groupe?.querySelectorAll<HTMLElement>('[role="radio"]')[liste.indexOf(suivant)]?.focus();
}

const CHAMP =
  "w-16 h-7 px-1.5 rounded-md border border-slate-200 bg-white text-xs text-right text-slate-800 placeholder:text-slate-400 focus:outline-none focus:border-blue-500 disabled:cursor-not-allowed";
const SECTION = "pt-3 pb-1 text-xs font-semibold text-slate-500";
</script>

<template>
  <div
    class="elpis-slide-panel h-full shrink-0 flex flex-col bg-slate-50 z-20 border-l border-slate-200"
    :class="
      rg.showSamplingPanel ? 'w-[320px] opacity-100' : 'w-0 opacity-0 overflow-hidden pointer-events-none'
    "
    :inert="rg.showSamplingPanel ? undefined : true"
    data-panneau-generation
  >
    <div class="h-16 flex items-center gap-2.5 px-4 border-b border-slate-200 shrink-0 bg-white">
      <i class="ph ph-sliders-horizontal text-lg text-slate-500" aria-hidden="true"></i>
      <div class="min-w-0 flex-1 flex flex-col leading-tight">
        <h3 class="font-bold text-sm text-slate-800">Génération</h3>
        <span class="text-xs text-slate-500 truncate" :title="d?.model_id ?? undefined" data-portee>{{
          sousTitre
        }}</span>
      </div>
      <button
        type="button"
        aria-label="Fermer"
        title="Fermer"
        class="w-7 h-7 flex items-center justify-center text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-md transition-colors"
        @click="rg.showSamplingPanel = false"
      >
        <i class="ph ph-x text-base" aria-hidden="true"></i>
      </button>
    </div>

    <div class="flex-1 overflow-y-auto px-4 pb-3 custom-scrollbar">
      <p
        v-if="d?.degraded"
        class="flex items-center gap-1.5 pt-2.5 text-xs text-slate-500"
        :title="
          rg.selectedConnector
            ? 'Les réglages grisés sont ignorés par ce moteur ; les autres s\'appliquent.'
            : 'Chargez le modèle pour voir ses valeurs ; vos réglages s\'appliquent quand même.'
        "
        data-info-moteur
      >
        <i class="ph ph-info shrink-0" aria-hidden="true"></i>
        <span class="truncate">{{
          rg.selectedConnector
            ? "Valeurs du modèle non exposées par ce moteur"
            : "Modèle non chargé : valeurs du modèle indisponibles"
        }}</span>
      </p>

      <div v-if="rg.effectiveParamsLoading" class="py-10 text-center text-xs text-slate-500">
        <i class="ph ph-spinner-gap animate-spin motion-reduce:animate-none text-xl" aria-hidden="true"></i>
        <div class="mt-2">Chargement…</div>
      </div>

      <template v-else-if="d">
        <section :aria-labelledby="`${id}-reponse`">
          <h4 :id="`${id}-reponse`" :class="SECTION">Réponse</h4>
          <LigneGeneration
            v-for="c in REPONSE"
            :key="c.cle"
            :libelle="c.libelle"
            :identifiant="c.cle"
            :pour="`${id}-${c.cle}`"
            :modifie="modifiees.has(c.cle)"
            :reference="reference(c)"
            :aide="c.aide"
            @retablir="rg.retablirCle(c.cle)"
          >
            <input
              :id="`${id}-${c.cle}`"
              v-model.number="rg.samplingOverride[c.cle]"
              type="number"
              :min="c.min"
              :max="c.max"
              :step="c.pas"
              :placeholder="reference(c)"
              :class="CHAMP"
            />
          </LigneGeneration>
        </section>

        <section v-if="sectionReflexion" :aria-labelledby="`${id}-reflexion`">
          <h4 :id="`${id}-reflexion`" :class="SECTION">Réflexion</h4>
          <LigneGeneration v-if="reflexion" libelle="Réflexion" :pour="`${id}-penser`">
            <span class="relative inline-flex items-center shrink-0">
              <input
                :id="`${id}-penser`"
                v-model="rg.thinkingEnabled"
                type="checkbox"
                role="switch"
                class="sr-only peer"
              />
              <span class="set-switch-track peer-checked:bg-blue-600 peer-checked:border-blue-600"></span>
            </span>
          </LigneGeneration>
          <LigneGeneration
            v-if="rg.reasoningEffortValues.length"
            libelle="Effort"
            identifiant="reasoning_effort"
            :modifie="modifiees.has('reasoning_effort')"
            reference="Auto"
            dessous
            @retablir="rg.retablirCle('reasoning_effort')"
          >
            <span
              role="radiogroup"
              aria-label="Effort"
              class="flex-1 flex flex-wrap gap-0.5 p-0.5 rounded-lg bg-slate-100"
              @keydown="surToucheEffort"
            >
              <button
                v-for="v in efforts"
                :key="v ?? 'auto'"
                type="button"
                role="radio"
                :aria-checked="(rg.samplingOverride.reasoning_effort ?? null) === v ? 'true' : 'false'"
                :tabindex="(rg.samplingOverride.reasoning_effort ?? null) === v ? 0 : -1"
                :title="v ?? undefined"
                class="flex-1 px-1.5 h-6 rounded-md text-xs font-medium transition-colors"
                :class="
                  (rg.samplingOverride.reasoning_effort ?? null) === v
                    ? 'bg-white text-slate-800 shadow-sm'
                    : 'text-slate-600 hover:text-slate-800'
                "
                @click="choisirEffort(v)"
              >
                {{ v ? libelleEffort(v) : "Auto" }}
              </button>
            </span>
          </LigneGeneration>
          <LigneGeneration
            v-if="reflexion"
            :libelle="BUDGET.libelle"
            :identifiant="BUDGET.cle"
            :pour="`${id}-budget`"
            :modifie="modifiees.has(BUDGET.cle)"
            :reference="reference(BUDGET)"
            :ignore="ignore(BUDGET.cle)"
            :aide="BUDGET.aide"
            @retablir="rg.retablirCle(BUDGET.cle)"
          >
            <input
              :id="`${id}-budget`"
              v-model.number="rg.samplingOverride.thinking_budget_tokens"
              type="number"
              :min="BUDGET.min"
              :max="BUDGET.max"
              :step="BUDGET.pas"
              :placeholder="reference(BUDGET)"
              :disabled="!!ignore(BUDGET.cle)"
              :class="[CHAMP, 'w-20']"
              @change="rg.clampThinkingBudget"
            />
          </LigneGeneration>
          <LigneGeneration
            v-if="rg.preserveReasoningSupported"
            libelle="Raisonnement conservé"
            :pour="`${id}-conserve`"
            :modifie="modifiees.has('preserve_reasoning')"
            :reference="conserveParDefaut ? 'Activé' : 'Désactivé'"
            :aide="aideConserve"
            @retablir="rg.retablirCle('preserve_reasoning')"
          >
            <span class="relative inline-flex items-center shrink-0">
              <input
                :id="`${id}-conserve`"
                v-model="rg.preserveReasoningEnabled"
                type="checkbox"
                role="switch"
                class="sr-only peer"
                :aria-describedby="`${id}-conserve-aide`"
              />
              <span class="set-switch-track peer-checked:bg-blue-600 peer-checked:border-blue-600"></span>
            </span>
            <span :id="`${id}-conserve-aide`" class="sr-only">{{ aideConserve }}</span>
          </LigneGeneration>
        </section>

        <section :aria-labelledby="`${id}-outils`">
          <h4 :id="`${id}-outils`" :class="SECTION">Outils</h4>
          <LigneGeneration
            v-for="c in OUTILS"
            :key="c.cle"
            :libelle="c.libelle"
            :identifiant="c.cle"
            :pour="`${id}-${c.cle}`"
            :modifie="modifiees.has(c.cle)"
            :reference="reference(c)"
            :aide="c.aide"
            @retablir="rg.retablirCle(c.cle)"
          >
            <input
              :id="`${id}-${c.cle}`"
              v-model.number="rg.samplingOverride[c.cle]"
              type="number"
              :min="c.min"
              :max="c.max"
              :step="c.pas"
              :placeholder="reference(c)"
              :class="CHAMP"
            />
          </LigneGeneration>
        </section>

        <details class="group" data-avance>
          <summary
            :class="SECTION"
            class="cursor-pointer select-none flex items-center gap-1 hover:text-slate-700 list-none"
          >
            <i
              class="ph ph-caret-right text-xs transition-transform group-open:rotate-90 motion-reduce:transition-none"
              aria-hidden="true"
            ></i>
            Avancé
          </summary>
          <LigneGeneration
            v-for="c in AVANCE"
            :key="c.cle"
            :libelle="c.libelle"
            :identifiant="c.cle"
            :pour="`${id}-${c.cle}`"
            :modifie="modifiees.has(c.cle)"
            :reference="reference(c)"
            :ignore="ignore(c.cle)"
            :aide="c.aide"
            @retablir="rg.retablirCle(c.cle)"
          >
            <input
              :id="`${id}-${c.cle}`"
              v-model.number="rg.samplingOverride[c.cle]"
              type="number"
              :min="c.min"
              :max="c.max"
              :step="c.pas"
              :placeholder="reference(c)"
              :disabled="!!ignore(c.cle)"
              :class="CHAMP"
            />
          </LigneGeneration>
        </details>
      </template>

      <div v-else class="py-10 text-center text-xs text-slate-500">
        <i class="ph ph-warning-circle text-xl" aria-hidden="true"></i>
        <div class="mt-2">Impossible de charger les paramètres</div>
      </div>
    </div>

    <div class="px-4 py-2.5 border-t border-slate-200 bg-white flex items-center gap-2 shrink-0">
      <span class="text-xs text-slate-500" data-compteur-modifies>{{ compteur }}</span>
      <button
        type="button"
        class="ml-auto px-2 py-1 rounded-md text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50 disabled:cursor-not-allowed"
        :disabled="modifiees.size === 0"
        data-retablir-modele
        @click="rg.retablirModele()"
      >
        Rétablir le modèle
      </button>
    </div>
  </div>
</template>
