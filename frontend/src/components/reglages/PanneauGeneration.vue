<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/reglages/PanneauGeneration.vue — panneau « Génération » du chat : place dans la fenêtre, sections Sortie, Réflexion, Outils et Avancé, valeurs du modèle en indication, réglages modifiés signalés et rétablissables. -->
<script setup lang="ts">
import { computed, useId } from "vue";

import { nomLisible } from "../../features/chat/page/menu-modele";
import { libelleEffort } from "../../features/chat/page/puces";
import { domaineReglages } from "../../features/reglages/domaine";
import { clesModifiees, valeurReference } from "../../features/reglages/echantillonnage";
import type { CleNombre, CleSurcharge, ModeLongueur } from "../../features/reglages/echantillonnage";
import LigneGeneration from "./LigneGeneration.vue";

interface Champ {
  cle: CleNombre;
  libelle: string;
  min: number;
  max: number;
  pas: number;
  aide?: string;
}

const TEMPERATURE: Champ = {
  cle: "temperature",
  libelle: "Température",
  min: 0,
  max: 2,
  pas: 0.05,
  aide: "Plus haut : réponses plus variées",
};
const LONGUEURS: readonly { mode: ModeLongueur; libelle: string }[] = [
  { mode: "auto", libelle: "Auto" },
  { mode: "limit", libelle: "Limiter" },
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
    libelle: "Tours d'outils",
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
  d.value?.model_id ? `Vos réglages · ${nomLisible(d.value.model_id)}` : "Vos réglages",
);
const noteLongueur = computed(() =>
  rg.modeLongueur === "auto"
    ? "Choisie par Elpis selon la fenêtre, réflexion comprise."
    : "Réflexion comprise. Si la fenêtre manque de place, Elpis réduit la valeur à l'envoi.",
);

const kilo = (n: number): string =>
  n >= 1000 ? `${Math.round(n / 1000).toLocaleString("fr-FR")} k` : String(n);
const pourcent = (n: number, total: number): string =>
  `${Math.min(100, Math.max(0, (n * 100) / total)).toFixed(2)}%`;
const jauge = computed(() => {
  const f = rg.placeFenetre;
  if (!f) return null;
  const garde = Math.min(f.total, f.reserve + f.marge);
  return {
    rempli: pourcent(f.utilise, f.total),
    garde: pourcent(f.total - garde, f.total),
    repere: f.compaction > 0 ? pourcent(f.compaction, f.total) : null,
    gauche: f.utilise > 0 ? `${kilo(f.utilise)} sur ${kilo(f.total)}` : `Fenêtre de ${kilo(f.total)}`,
    droite: f.compaction > 0 ? `Compaction à ${kilo(f.compaction)}` : "Compaction coupée",
    legende: `Hachures : place gardée pour la sortie (${kilo(f.reserve)}) et la marge (${kilo(f.marge)}).`,
    libelle:
      `${f.utilise > 0 ? `${kilo(f.utilise)} utilisés sur ${kilo(f.total)}` : `Fenêtre de ${kilo(f.total)}`}` +
      `${f.compaction > 0 ? ` ; compaction à ${kilo(f.compaction)}` : ""} ; sortie et marge ${kilo(garde)}`,
  };
});
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
const ignore = (c: CleNombre): string | undefined => rg.raisonIgnore(c) ?? undefined;

// Groupe radio : les flèches déplacent le choix et le focus.
function naviguerRadio<T>(e: KeyboardEvent, liste: readonly T[], courant: T, choisir: (v: T) => void): void {
  const pas =
    e.key === "ArrowRight" || e.key === "ArrowDown"
      ? 1
      : e.key === "ArrowLeft" || e.key === "ArrowUp"
        ? -1
        : 0;
  if (!pas || !liste.length) return;
  e.preventDefault();
  const i = (liste.indexOf(courant) + pas + liste.length) % liste.length;
  const suivant = liste[i] as T;
  choisir(suivant);
  (e.currentTarget as HTMLElement | null)?.querySelectorAll<HTMLElement>('[role="radio"]')[i]?.focus();
}
const surToucheEffort = (e: KeyboardEvent): void =>
  naviguerRadio(e, efforts.value, rg.samplingOverride.reasoning_effort ?? null, (v) =>
    rg.pickReasoningEffort(v),
  );
const surToucheLongueur = (e: KeyboardEvent): void =>
  naviguerRadio(
    e,
    LONGUEURS.map((l) => l.mode),
    rg.modeLongueur,
    (m) => rg.choisirModeLongueur(m),
  );

const CHAMP =
  "w-16 h-7 px-1.5 rounded-md border border-slate-200 bg-white text-xs text-right text-slate-800 placeholder:text-slate-400 focus:outline-none focus:border-blue-500 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500";
const SECTION = "pt-3 pb-1 text-xs font-semibold text-slate-500";
const SEGMENTS = "flex gap-0.5 p-0.5 rounded-lg bg-slate-100";
const SEGMENT = "flex-1 px-1.5 h-6 rounded-md text-xs font-medium transition-colors";
const SEGMENT_ACTIF = "bg-white text-slate-800 shadow-sm";
const SEGMENT_INACTIF = "text-slate-600 hover:text-slate-800";
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
        <section v-if="jauge" :aria-labelledby="`${id}-contexte`" class="pt-3" data-place-fenetre>
          <div class="flex items-baseline justify-between">
            <h4 :id="`${id}-contexte`" class="pb-2 text-xs font-semibold text-slate-500">Contexte</h4>
            <button
              type="button"
              class="text-xs font-medium text-blue-600 hover:text-blue-700 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              title="Seuil de compaction, dans les Paramètres"
              @click="rg.openSettingsTab('compaction')"
            >
              Régler
            </button>
          </div>
          <div
            role="img"
            :aria-label="jauge.libelle"
            class="relative h-2 rounded bg-slate-200 overflow-hidden"
          >
            <div class="absolute inset-y-0 left-0 bg-blue-600" :style="{ width: jauge.rempli }"></div>
            <div class="absolute inset-y-0 right-0 jauge-hachures" :style="{ left: jauge.garde }"></div>
          </div>
          <div class="relative h-2.5" aria-hidden="true">
            <div
              v-if="jauge.repere"
              class="absolute -top-3 w-0.5 h-3.5 -ml-px rounded-sm bg-slate-700"
              :style="{ left: jauge.repere }"
            ></div>
          </div>
          <div class="flex justify-between text-xs text-slate-700">
            <span>{{ jauge.gauche }}</span>
            <span>{{ jauge.droite }}</span>
          </div>
          <p class="mt-1 text-xs text-slate-500">{{ jauge.legende }}</p>
        </section>

        <section :aria-labelledby="`${id}-sortie`">
          <h4 :id="`${id}-sortie`" :class="SECTION">Sortie</h4>
          <LigneGeneration
            :libelle="TEMPERATURE.libelle"
            :identifiant="TEMPERATURE.cle"
            :pour="`${id}-${TEMPERATURE.cle}`"
            :modifie="modifiees.has(TEMPERATURE.cle)"
            :reference="reference(TEMPERATURE)"
            :aide="TEMPERATURE.aide"
            @retablir="rg.retablirCle(TEMPERATURE.cle)"
          >
            <input
              :id="`${id}-${TEMPERATURE.cle}`"
              v-model.number="rg.samplingOverride.temperature"
              type="number"
              :min="TEMPERATURE.min"
              :max="TEMPERATURE.max"
              :step="TEMPERATURE.pas"
              :placeholder="reference(TEMPERATURE)"
              :class="CHAMP"
            />
          </LigneGeneration>
          <LigneGeneration
            libelle="Longueur"
            identifiant="max_tokens"
            :modifie="modifiees.has('max_tokens')"
            reference="Auto"
            dessous
            :note="noteLongueur"
            @retablir="rg.choisirModeLongueur('auto')"
          >
            <span role="radiogroup" aria-label="Longueur" :class="SEGMENTS" @keydown="surToucheLongueur">
              <button
                v-for="l in LONGUEURS"
                :key="l.mode"
                type="button"
                role="radio"
                :aria-checked="rg.modeLongueur === l.mode ? 'true' : 'false'"
                :tabindex="rg.modeLongueur === l.mode ? 0 : -1"
                :class="[SEGMENT, rg.modeLongueur === l.mode ? SEGMENT_ACTIF : SEGMENT_INACTIF]"
                @click="rg.choisirModeLongueur(l.mode)"
              >
                {{ l.libelle }}
              </button>
            </span>
            <span v-if="rg.modeLongueur === 'limit'" class="flex items-center gap-1.5">
              <label :for="`${id}-max_tokens`" class="text-xs text-slate-700">Au plus</label>
              <input
                :id="`${id}-max_tokens`"
                v-model.number="rg.samplingOverride.max_tokens"
                type="number"
                min="1"
                :max="rg.placeFenetre?.total || undefined"
                step="256"
                :class="[CHAMP, 'w-24']"
              />
              <span class="text-xs text-slate-500">jetons</span>
            </span>
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
              :class="[SEGMENTS, 'flex-wrap']"
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
                :class="[
                  SEGMENT,
                  (rg.samplingOverride.reasoning_effort ?? null) === v ? SEGMENT_ACTIF : SEGMENT_INACTIF,
                ]"
                @click="rg.pickReasoningEffort(v)"
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
