<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/reglages/PanneauEchantillonnage.vue — panneau des réglages de génération (échantillonnage) de la page de chat. -->
<script setup lang="ts">
import AideLigne from "./AideLigne.vue";
import { domaineReglages } from "../../features/reglages/domaine";

const rg = domaineReglages();
</script>

<template>
  <div
    class="elpis-slide-panel h-full shrink-0 flex flex-col bg-slate-50 z-20 border-l border-slate-200"
    :class="
      rg.showSamplingPanel ? 'w-[320px] opacity-100' : 'w-0 opacity-0 overflow-hidden pointer-events-none'
    "
  >
    <div class="h-16 flex items-center justify-between px-4 border-b border-slate-200 shrink-0 bg-white">
      <h3 class="font-bold text-slate-800 flex items-baseline gap-2 text-sm">
        <i class="ph ph-sliders-horizontal text-blue-600 text-lg self-center"></i> Paramètres de génération
        <span class="text-xs font-normal text-slate-400">sampling</span>
      </h3>
      <button
        class="text-slate-400 hover:text-slate-800 p-1 hover:bg-slate-100 rounded-md transition-colors"
        @click="rg.showSamplingPanel = false"
      >
        <i class="ph ph-x text-base"></i>
      </button>
    </div>

    <div class="flex-1 overflow-y-auto px-4 py-3 custom-scrollbar">
      <div
        v-if="rg.effectiveParamsData"
        class="flex items-baseline justify-between gap-3 pb-2.5 border-b border-slate-200/70"
      >
        <span class="text-xs font-semibold text-slate-500 shrink-0">Modèle</span>
        <span
          class="text-xs font-mono text-slate-600 truncate"
          :title="rg.effectiveParamsData.model_id ?? undefined"
          >{{ rg.effectiveParamsData.model_id }}</span
        >
      </div>

      <div class="py-2.5 border-b border-slate-200/70">
        <AideLigne>
          Les valeurs en gris viennent du modèle. Laisser un champ vide garde la valeur du modèle.
        </AideLigne>
      </div>

      <div
        v-if="rg.effectiveParamsData && rg.effectiveParamsData.degraded"
        class="flex gap-1.5 text-xs text-amber-700 bg-amber-50 border border-amber-200/60 rounded-md px-2.5 py-2 mt-2.5 leading-relaxed"
      >
        <i
          class="ph text-xs mt-px shrink-0"
          :class="rg.selectedConnector ? 'ph-plugs-connected' : 'ph-power'"
        ></i>
        <span v-if="rg.selectedConnector"
          >Moteur externe : les valeurs internes du modèle ne sont pas exposées.
          <span class="font-medium">temperature</span>, <span class="font-medium">top_p</span>,
          <span class="font-medium">max_tokens</span> et
          <span class="font-medium">max_tool_iterations</span> s'appliquent ; les réglages propres à llama.cpp
          (grisés ci-dessous) sont ignorés par ce moteur.</span
        >
        <span v-else
          >Modèle non chargé : valeurs du modèle indisponibles (chargez-le avec ▶ pour les voir) — vos
          réglages s'appliquent quand même.</span
        >
      </div>

      <div v-if="rg.effectiveParamsLoading" class="py-10 text-center text-xs text-slate-400">
        <i class="ph ph-spinner-gap animate-spin text-xl"></i>
        <div class="mt-2">Chargement...</div>
      </div>

      <div v-else-if="rg.effectiveParamsData">
        <div class="py-2.5 border-b border-slate-200/70">
          <div class="flex items-baseline justify-between gap-2 mb-1.5">
            <label class="text-[13px] text-slate-600">temperature</label>
            <div class="flex items-baseline gap-2 shrink-0">
              <span class="text-xs text-slate-400 font-mono"
                >{{ rg.effectiveParamsData.props_unavailable ? "défaut" : "modèle" }}
                <span class="font-bold text-slate-500">{{
                  rg.fmtPropVal(rg.effectiveParamsData.sources?.props?.temperature)
                }}</span></span
              >
              <input
                v-model.number="rg.samplingOverride.temperature"
                type="number"
                min="0"
                max="2"
                step="0.05"
                placeholder="auto"
                class="w-16 text-[12px] text-right font-medium text-slate-800 bg-transparent border-0 border-b border-slate-200 px-1 py-0.5 focus:outline-none focus:border-blue-500 placeholder:text-slate-300 placeholder:font-normal"
              />
            </div>
          </div>
          <input
            type="range"
            min="0"
            max="2"
            step="0.05"
            :value="
              rg.samplingOverride.temperature ?? rg.effectiveParamsData.sources?.props?.temperature ?? 0.7
            "
            class="set-range w-full"
            @input="rg.samplingOverride.temperature = parseFloat(($event.target as HTMLInputElement).value)"
          />
        </div>

        <div
          v-if="
            rg.effectiveParamsData.supports_thinking ||
            (rg.effectiveParamsData.degraded && rg.selectedConnector)
          "
          class="py-2.5 border-b border-slate-200/70"
        >
          <label class="flex items-center justify-between gap-2 cursor-pointer">
            <span class="text-[13px] text-slate-600 flex items-center gap-1.5">
              <i
                class="ph ph-brain text-[13px]"
                :class="rg.thinkingEnabled ? 'text-blue-500' : 'text-slate-400'"
              ></i>
              <span>Réflexion</span>
            </span>
            <span class="relative inline-flex items-center shrink-0">
              <input v-model="rg.thinkingEnabled" type="checkbox" class="sr-only peer" />
              <div class="set-switch-track peer-checked:bg-blue-600 peer-checked:border-blue-600"></div>
            </span>
          </label>
          <p class="text-xs text-slate-500 mt-1 leading-tight">
            <template v-if="rg.thinkingEnabled">Activée · budget dans « Avancé » (chat simple).</template>
            <template v-else>Désactivée.</template>
          </p>
        </div>

        <div v-if="rg.preserveReasoningSupported" class="py-2.5 border-b border-slate-200/70">
          <label class="flex items-center justify-between gap-2 cursor-pointer">
            <span class="text-[13px] text-slate-600 flex items-center gap-1.5">
              <i
                class="ph ph-clock-counter-clockwise text-[13px]"
                :class="rg.preserveReasoningEnabled ? 'text-blue-500' : 'text-slate-400'"
              ></i>
              <span>Raisonnement conservé</span>
            </span>
            <span class="relative inline-flex items-center shrink-0">
              <input v-model="rg.preserveReasoningEnabled" type="checkbox" class="sr-only peer" />
              <div class="set-switch-track peer-checked:bg-blue-600 peer-checked:border-blue-600"></div>
            </span>
          </label>
          <p class="text-xs text-slate-500 mt-1 leading-tight">
            <template v-if="rg.preserveReasoningEnabled">
              Activé · la réflexion déjà produite est rendue au modèle, son gabarit décide de ce qu'il garde.
              Plus cohérent, prompt plus long ; avec SGLang, la question suivante recalcule les appels
              d'outils du tour.
            </template>
            <template v-else> Désactivé · seule la réflexion en cours compte. Prompt plus court. </template>
            Changer en cours de conversation force un re-calcul du cache une fois.
          </p>
        </div>

        <div class="py-2.5 border-b border-slate-200/70">
          <div class="flex items-baseline justify-between gap-2 mb-1.5">
            <label class="text-[13px] text-slate-600">max_tokens</label>
            <input
              v-model.number="rg.samplingOverride.max_tokens"
              type="number"
              min="1"
              max="24576"
              step="128"
              placeholder="illimité"
              class="w-24 text-[12px] text-right font-medium text-slate-800 bg-transparent border-0 border-b border-slate-200 px-1 py-0.5 focus:outline-none focus:border-blue-500 placeholder:text-slate-300 placeholder:font-normal"
            />
          </div>
          <AideLigne>Limite de réponse (vide = illimité), plafonnée par la fenêtre de contexte.</AideLigne>
        </div>

        <div class="py-2.5 border-b border-slate-200/70">
          <div class="flex items-baseline justify-between gap-2 mb-1.5">
            <label
              class="text-[13px] text-slate-600"
              title="Nombre maximum de tours d'outils dans une même réponse. Un tour = un appel au modèle, qui peut lancer plusieurs outils en parallèle : le nombre d'appels d'outils peut dépasser ce budget."
              >max_tool_iterations</label
            >
            <div class="flex items-baseline gap-2 shrink-0">
              <span class="text-xs text-slate-400 font-mono"
                >défaut
                <span class="font-bold text-slate-500">{{
                  rg.effectiveParamsData.agent_defaults?.max_tool_iterations ?? 200
                }}</span></span
              >
              <input
                v-model.number="rg.samplingOverride.max_tool_iterations"
                type="number"
                min="1"
                max="500"
                step="1"
                placeholder="auto"
                class="w-16 text-[12px] text-right font-medium text-slate-800 bg-transparent border-0 border-b border-slate-200 px-1 py-0.5 focus:outline-none focus:border-blue-500 placeholder:text-slate-300 placeholder:font-normal"
              />
            </div>
          </div>
          <input
            type="range"
            min="1"
            max="500"
            step="1"
            :value="
              rg.samplingOverride.max_tool_iterations ??
              rg.effectiveParamsData.agent_defaults?.max_tool_iterations ??
              200
            "
            class="set-range w-full"
            @input="
              rg.samplingOverride.max_tool_iterations = parseInt(($event.target as HTMLInputElement).value)
            "
          />
          <AideLigne>
            Tours d'outils maximum ; un tour peut lancer plusieurs outils (web scraping : 100-150).
          </AideLigne>
        </div>

        <details class="group mt-4">
          <summary
            class="cursor-pointer text-xs font-semibold text-slate-500 hover:text-slate-700 select-none flex items-center gap-1 py-1"
          >
            <i class="ph ph-caret-right group-open:rotate-90 transition-transform inline-block text-xs"></i>
            Avancé
          </summary>

          <div class="mt-1">
            <div class="py-2.5 border-b border-slate-200/70">
              <div class="flex items-baseline justify-between gap-2 mb-1.5">
                <label class="text-[13px] text-slate-600">top_p</label>
                <div class="flex items-baseline gap-2 shrink-0">
                  <span class="text-xs text-slate-400 font-mono"
                    >{{ rg.effectiveParamsData.props_unavailable ? "défaut" : "modèle" }}
                    <span class="font-bold text-slate-500">{{
                      rg.fmtPropVal(rg.effectiveParamsData.sources?.props?.top_p)
                    }}</span></span
                  >
                  <input
                    v-model.number="rg.samplingOverride.top_p"
                    type="number"
                    min="0"
                    max="1"
                    step="0.01"
                    placeholder="auto"
                    class="w-16 text-[12px] text-right font-medium text-slate-800 bg-transparent border-0 border-b border-slate-200 px-1 py-0.5 focus:outline-none focus:border-blue-500 placeholder:text-slate-300 placeholder:font-normal"
                  />
                </div>
              </div>
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                :value="rg.samplingOverride.top_p ?? rg.effectiveParamsData.sources?.props?.top_p ?? 0.9"
                class="set-range w-full"
                @input="rg.samplingOverride.top_p = parseFloat(($event.target as HTMLInputElement).value)"
              />
            </div>

            <div
              class="py-2.5 border-b border-slate-200/70"
              :class="rg.isIgnoredByEngine('top_k') ? 'opacity-45' : ''"
            >
              <div class="flex items-baseline justify-between gap-2 mb-1.5">
                <label class="text-[13px] text-slate-600">top_k</label>
                <span
                  v-if="rg.isIgnoredByEngine('top_k')"
                  class="text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200/70 rounded px-1 py-px"
                  title="Ce réglage est propre à llama.cpp : le moteur externe sélectionné l'ignore (retiré du payload)."
                  >sans effet</span
                >
                <div class="flex items-baseline gap-2 shrink-0">
                  <span class="text-xs text-slate-400 font-mono"
                    >{{ rg.effectiveParamsData.props_unavailable ? "défaut" : "modèle" }}
                    <span class="font-bold text-slate-500">{{
                      rg.fmtPropVal(rg.effectiveParamsData.sources?.props?.top_k)
                    }}</span></span
                  >
                  <input
                    v-model.number="rg.samplingOverride.top_k"
                    type="number"
                    min="0"
                    max="1000"
                    step="1"
                    placeholder="auto"
                    :disabled="rg.isIgnoredByEngine('top_k')"
                    class="w-16 text-[12px] text-right font-medium text-slate-800 bg-transparent border-0 border-b border-slate-200 px-1 py-0.5 focus:outline-none focus:border-blue-500 placeholder:text-slate-300 placeholder:font-normal"
                  />
                </div>
              </div>
              <input
                type="range"
                min="0"
                max="200"
                step="1"
                :value="rg.samplingOverride.top_k ?? rg.effectiveParamsData.sources?.props?.top_k ?? 40"
                :disabled="rg.isIgnoredByEngine('top_k')"
                class="set-range w-full"
                @input="rg.samplingOverride.top_k = parseInt(($event.target as HTMLInputElement).value)"
              />
            </div>

            <div
              class="py-2.5 border-b border-slate-200/70"
              :class="rg.isIgnoredByEngine('min_p') ? 'opacity-45' : ''"
            >
              <div class="flex items-baseline justify-between gap-2 mb-1.5">
                <label class="text-[13px] text-slate-600">min_p</label>
                <span
                  v-if="rg.isIgnoredByEngine('min_p')"
                  class="text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200/70 rounded px-1 py-px"
                  title="Ce réglage est propre à llama.cpp : le moteur externe sélectionné l'ignore (retiré du payload)."
                  >sans effet</span
                >
                <div class="flex items-baseline gap-2 shrink-0">
                  <span class="text-xs text-slate-400 font-mono"
                    >{{ rg.effectiveParamsData.props_unavailable ? "défaut" : "modèle" }}
                    <span class="font-bold text-slate-500">{{
                      rg.fmtPropVal(rg.effectiveParamsData.sources?.props?.min_p)
                    }}</span></span
                  >
                  <input
                    v-model.number="rg.samplingOverride.min_p"
                    type="number"
                    min="0"
                    max="1"
                    step="0.01"
                    placeholder="auto"
                    :disabled="rg.isIgnoredByEngine('min_p')"
                    class="w-16 text-[12px] text-right font-medium text-slate-800 bg-transparent border-0 border-b border-slate-200 px-1 py-0.5 focus:outline-none focus:border-blue-500 placeholder:text-slate-300 placeholder:font-normal"
                  />
                </div>
              </div>
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                :value="rg.samplingOverride.min_p ?? rg.effectiveParamsData.sources?.props?.min_p ?? 0.05"
                :disabled="rg.isIgnoredByEngine('min_p')"
                class="set-range w-full"
                @input="rg.samplingOverride.min_p = parseFloat(($event.target as HTMLInputElement).value)"
              />
            </div>

            <div
              class="py-2.5 border-b border-slate-200/70"
              :class="rg.isIgnoredByEngine('repeat_penalty') ? 'opacity-45' : ''"
            >
              <div class="flex items-baseline justify-between gap-2 mb-1.5">
                <label class="text-[13px] text-slate-600">repeat_penalty</label>
                <span
                  v-if="rg.isIgnoredByEngine('repeat_penalty')"
                  class="text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200/70 rounded px-1 py-px"
                  title="Ce réglage est propre à llama.cpp : le moteur externe sélectionné l'ignore (retiré du payload)."
                  >sans effet</span
                >
                <div class="flex items-baseline gap-2 shrink-0">
                  <span class="text-xs text-slate-400 font-mono"
                    >{{ rg.effectiveParamsData.props_unavailable ? "défaut" : "modèle" }}
                    <span class="font-bold text-slate-500">{{
                      rg.fmtPropVal(rg.effectiveParamsData.sources?.props?.repeat_penalty)
                    }}</span></span
                  >
                  <input
                    v-model.number="rg.samplingOverride.repeat_penalty"
                    type="number"
                    min="0.5"
                    max="2"
                    step="0.01"
                    placeholder="auto"
                    :disabled="rg.isIgnoredByEngine('repeat_penalty')"
                    class="w-16 text-[12px] text-right font-medium text-slate-800 bg-transparent border-0 border-b border-slate-200 px-1 py-0.5 focus:outline-none focus:border-blue-500 placeholder:text-slate-300 placeholder:font-normal"
                  />
                </div>
              </div>
              <input
                type="range"
                min="0.5"
                max="2"
                step="0.01"
                :value="
                  rg.samplingOverride.repeat_penalty ??
                  rg.effectiveParamsData.sources?.props?.repeat_penalty ??
                  1.0
                "
                :disabled="rg.isIgnoredByEngine('repeat_penalty')"
                class="set-range w-full"
                @input="
                  rg.samplingOverride.repeat_penalty = parseFloat(($event.target as HTMLInputElement).value)
                "
              />
            </div>

            <div
              v-if="
                rg.effectiveParamsData.supports_thinking ||
                (rg.effectiveParamsData.degraded && rg.selectedConnector)
              "
              class="py-2.5"
            >
              <div class="flex items-baseline justify-between gap-2 mb-1.5">
                <label class="text-[13px] text-slate-600 flex items-center gap-1.5">
                  <i class="ph ph-brain text-[13px] text-slate-400"></i>
                  <span>Budget de réflexion</span>
                </label>
                <div class="flex items-baseline gap-2 shrink-0">
                  <span class="text-xs text-slate-400 font-mono"
                    >défaut
                    <span class="font-bold text-slate-500">{{
                      rg.effectiveParamsData.agent_defaults?.thinking_budget_tokens ?? 8192
                    }}</span></span
                  >
                  <input
                    v-model.number="rg.samplingOverride.thinking_budget_tokens"
                    type="number"
                    min="0"
                    max="131072"
                    step="512"
                    placeholder="off"
                    class="w-20 text-[12px] text-right font-medium text-slate-800 bg-transparent border-0 border-b border-slate-200 px-1 py-0.5 focus:outline-none focus:border-blue-500 placeholder:text-slate-300 placeholder:font-normal"
                    @change="rg.clampThinkingBudget"
                  />
                </div>
              </div>
              <AideLigne>
                Budget de réflexion en jetons (min 512), seulement en chat simple ; 0 = désactivé.
              </AideLigne>
            </div>
          </div>
        </details>
      </div>

      <div v-else class="py-10 text-center text-xs text-slate-400">
        <i class="ph ph-warning-circle text-xl"></i>
        <div class="mt-2">Impossible de charger les paramètres</div>
      </div>
    </div>

    <div class="px-4 py-3 border-t border-slate-200 bg-white flex items-center justify-between shrink-0">
      <button
        class="text-xs text-slate-500 hover:text-red-600 transition-colors flex items-center gap-1"
        @click="rg.resetSamplingOverride"
      >
        <i class="ph ph-arrow-counter-clockwise text-xs"></i>
        Réinitialiser
      </button>
      <span class="text-xs text-slate-500" title="Ces réglages ne s'appliquent qu'à la conversation en cours"
        >Appliqué à ce chat</span
      >
    </div>
  </div>
</template>
