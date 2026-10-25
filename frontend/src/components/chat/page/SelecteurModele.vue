<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/page/SelecteurModele.vue — sélecteur de modèle : serveur intégré et connecteurs, chargement, infos, entrées ajoutées par le parent, pied d'état. -->
<script setup lang="ts">
import { computed } from "vue";

import { CLE_MODELES, domaine } from "../../../features/chat/page/domaines";
import { resumeCharge } from "../../../features/chat/modeles/charge";
import { abregerModele } from "../../../features/chat/page/puces";

// `abrege` : nom court (colonne étroite) ; `aDroite` : menu ouvert vers la gauche depuis un bouton calé à droite.
const props = defineProps<{ abrege?: boolean; aDroite?: boolean }>();
const mod = domaine(CLE_MODELES);
const libelle = computed(() =>
  props.abrege ? abregerModele(mod.selectedModelLabel) : mod.selectedModelLabel,
);

// Jauge du cache KV du moteur visé : l'intégré, ou le connecteur choisi s'il expose ses métriques.
const jauge = computed(() => {
  if (mod.selectedConnector) {
    const kv = mod.pickerConnState[mod.selectedConnector]?.kv;
    return kv && kv.total > 0 ? kv : null;
  }
  const kv = mod.builtinAllowed ? mod.llmHealth?.kv_cache : null;
  return kv && kv.total > 0 ? kv : null;
});
const ligneCharge = computed(() =>
  resumeCharge(
    mod.selectedConnector ? mod.pickerConnState[mod.selectedConnector]?.charge : mod.llmHealth?.charge,
  ),
);
</script>

<template>
  <div v-show="!mod.imageMode" class="relative shrink-0 min-w-0" data-model-manager>
    <button
      aria-haspopup="listbox"
      :aria-expanded="mod.showModelManager ? 'true' : 'false'"
      class="flex items-center gap-1 px-1.5 py-1 rounded-lg text-xs font-medium transition-colors text-slate-500 hover:text-slate-700 hover:bg-slate-100"
      :class="mod.showModelManager ? 'bg-slate-100 text-slate-700' : ''"
      @click="mod.toggleModelMenu()"
    >
      <span
        class="max-w-[150px] truncate"
        :title="
          mod.selectedConnector && mod.selectedEngineMeta?.label
            ? mod.selectedModelLabel + ' · ' + mod.selectedEngineMeta.label
            : mod.selectedModelLabel
        "
        >{{ libelle }}</span
      >
      <i
        class="ph ph-caret-down text-[10px] transition-transform"
        :class="mod.showModelManager && 'rotate-180'"
      ></i>
    </button>

    <Transition name="popover-up">
      <div
        v-if="mod.showModelManager"
        class="absolute bottom-full mb-2 w-80 max-w-[calc(100vw-2rem)] bg-white rounded-xl shadow-2xl border border-slate-200 z-[200] overflow-hidden"
        :class="props.aDroite ? 'right-0' : 'left-0'"
        @keydown="mod.onModelMenuKeydown"
        @click.stop
      >
        <div v-if="jauge" class="px-3 py-2 bg-slate-50 border-b" data-jauge-kv>
          <div class="flex items-center justify-between text-[10px] text-slate-500 mb-1">
            <span>Cache du moteur</span>
            <span class="font-mono font-semibold" :class="mod.kvTextClass(jauge.pct)"
              >{{ jauge.used }} / {{ jauge.total }}</span
            >
          </div>
          <div class="w-full h-1.5 bg-slate-200 rounded-full overflow-hidden">
            <div
              class="h-full w-full rounded-full transition-transform duration-500"
              :class="mod.kvBarClass(jauge.pct)"
              :style="{
                transformOrigin: 'left',
                transform: 'scaleX(' + jauge.pct / 100 + ')',
              }"
            ></div>
          </div>
          <div v-if="ligneCharge" class="mt-1 text-[10px] text-slate-500 font-mono" data-charge-moteur>
            {{ ligneCharge }}
          </div>
        </div>

        <div class="max-h-80 overflow-y-auto" role="listbox" aria-label="Sélection du modèle">
          <div
            v-if="mod.noEngineAllowed"
            class="px-3 py-4 text-xs text-slate-400 flex items-center gap-2"
            title="Demandez l'accès à un serveur à votre administrateur"
          >
            <i class="ph ph-lock-simple"></i> Aucun serveur autorisé
          </div>
          <template v-if="mod.builtinAllowed">
            <div
              v-if="mod.pickerConnectors && mod.pickerConnectors.length"
              class="px-3 pt-2.5 pb-1 flex items-center gap-1.5 bg-slate-50/70 border-b border-slate-100 sticky top-0"
            >
              <i class="ph ph-cpu text-[11px] text-slate-400"></i>
              <span class="text-xs font-semibold text-slate-600 truncate">Serveur intégré</span>
            </div>
            <div
              v-if="mod.modelsLoading && mod.availableModels.length === 0"
              class="px-3 py-4 text-xs text-slate-400 flex items-center gap-2"
            >
              <i class="ph ph-spinner-gap animate-spin"></i> Chargement des modèles…
            </div>
            <div
              v-else-if="mod.modelsError && mod.availableModels.length === 0"
              class="px-3 py-4 text-xs text-red-500 flex items-center gap-2"
            >
              <i class="ph ph-warning-circle"></i> {{ mod.modelsError }}
            </div>
            <div v-else-if="mod.availableModels.length === 0" class="px-3 py-4 text-xs text-slate-400">
              Aucun modèle disponible.
            </div>
            <div
              v-for="(m, _mi) in mod.availableModels"
              :key="m + '|' + _mi"
              class="flex items-center gap-1.5 px-3 py-2.5 group transition-colors border-b border-slate-50"
              :class="mod.selectedModel === m && !mod.selectedConnector ? 'bg-blue-50' : 'hover:bg-slate-50'"
            >
              <div
                role="option"
                tabindex="0"
                :aria-selected="mod.selectedModel === m && !mod.selectedConnector ? 'true' : 'false'"
                class="flex items-center gap-2 flex-1 min-w-0 cursor-pointer rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                @click="mod.pickLocalModel(m)"
                @keydown.enter.prevent="mod.pickLocalModel(m)"
                @keydown.space.prevent="mod.pickLocalModel(m)"
              >
                <div
                  class="w-1.5 h-1.5 rounded-full flex-shrink-0"
                  :class="
                    mod.selectedModel === m && !mod.selectedConnector ? 'bg-blue-500' : 'bg-transparent'
                  "
                ></div>
                <span
                  class="text-xs font-medium truncate"
                  :class="
                    mod.selectedModel === m && !mod.selectedConnector ? 'text-blue-700' : 'text-slate-700'
                  "
                  :title="m"
                  >{{ m }}</span
                >
                <i
                  v-if="mod.isModelFailed(m)"
                  class="ph ph-warning text-xs flex-shrink-0 text-amber-500"
                  title="Échec du dernier chargement : voir les journaux du serveur d'inférence"
                  aria-label="Échec du dernier chargement"
                ></i>
              </div>
              <button
                v-if="mod.isModelLoaded(m)"
                class="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-md text-xs transition-all border border-slate-200 text-slate-400 hover:bg-blue-50 hover:text-blue-600 hover:border-blue-200"
                title="Infos modèle"
                @click.stop="mod.fetchModelProps(m)"
              >
                <i class="ph ph-info text-xs"></i>
              </button>
              <button
                v-if="mod.chargementIntegre"
                class="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-md text-xs transition-all border"
                :class="
                  mod.isLoadingModel === m
                    ? '!border-blue-300 !text-blue-400'
                    : mod.isModelLoaded(m)
                      ? 'border-red-200 text-red-400 hover:bg-red-50 hover:text-red-600'
                      : 'border-green-200 text-green-500 hover:bg-green-50 hover:text-green-700'
                "
                :title="mod.isModelLoaded(m) ? 'Décharger' : 'Charger'"
                :disabled="!!mod.isLoadingModel"
                @click.stop="mod.toggleLlmModel(m)"
              >
                <i
                  class="ph text-xs"
                  :class="
                    mod.isLoadingModel === m
                      ? 'ph-spinner-gap animate-spin'
                      : mod.isModelLoaded(m)
                        ? 'ph-eject'
                        : 'ph-play'
                  "
                ></i>
              </button>
            </div>
          </template>

          <template v-for="conn in mod.pickerConnectors || []" :key="'conn' + conn.id">
            <div
              class="px-3 pt-2.5 pb-1 flex items-center gap-1.5 bg-slate-50/70 border-b border-slate-100 sticky top-0"
            >
              <i class="ph ph-plugs-connected text-[11px] text-slate-400"></i>
              <span class="text-xs font-semibold text-slate-600 truncate" :title="conn.base_url">{{
                conn.label || conn.provider_type
              }}</span>
              <span v-if="conn.scope === 'shared'" class="text-[9px] text-slate-400">(partagé)</span>
              <i
                v-if="mod.pickerConnLoading && mod.pickerConnLoading[conn.id]"
                class="ph ph-spinner-gap animate-spin text-[10px] text-slate-300 ml-auto"
              ></i>
            </div>
            <div
              v-if="
                mod.pickerConnState[conn.id] &&
                mod.pickerConnState[conn.id]?.error &&
                !(mod.pickerConnLoading && mod.pickerConnLoading[conn.id])
              "
              class="flex items-center gap-2 px-3 py-2 text-[11px] text-red-500 border-b border-slate-50"
              :title="mod.pickerConnState[conn.id]?.error"
            >
              <i class="ph ph-wifi-slash"></i> Injoignable
              <button
                class="ml-auto text-[10px] text-slate-400 hover:text-blue-600 flex items-center gap-1"
                aria-label="Réessayer"
                @click.stop="mod.retryConnModels(conn.id)"
              >
                <i class="ph ph-arrows-clockwise text-xs"></i> Réessayer
              </button>
            </div>
            <div
              v-else-if="
                mod.pickerConnModels &&
                (mod.pickerConnModels[conn.id] || []).length === 0 &&
                !(mod.pickerConnLoading && mod.pickerConnLoading[conn.id])
              "
              class="px-3 py-2 text-[11px] text-slate-400"
            >
              Aucun modèle (vérifier la clé / la connexion).
            </div>
            <div
              v-for="cm in (mod.pickerConnModels && mod.pickerConnModels[conn.id]) || []"
              :key="'conn' + conn.id + '|' + cm"
              class="flex items-center gap-1.5 px-3 py-2.5 group transition-colors border-b border-slate-50"
              :class="
                mod.selectedConnector === conn.id && mod.selectedModel === cm
                  ? 'bg-blue-50'
                  : 'hover:bg-slate-50'
              "
            >
              <div
                role="option"
                tabindex="0"
                :aria-selected="
                  mod.selectedConnector === conn.id && mod.selectedModel === cm ? 'true' : 'false'
                "
                class="flex items-center gap-2 flex-1 min-w-0 cursor-pointer rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                @click="mod.pickConnectorModel(conn, cm)"
                @keydown.enter.prevent="mod.pickConnectorModel(conn, cm)"
                @keydown.space.prevent="mod.pickConnectorModel(conn, cm)"
              >
                <div
                  class="w-1.5 h-1.5 rounded-full flex-shrink-0"
                  :class="
                    mod.selectedConnector === conn.id && mod.selectedModel === cm
                      ? 'bg-blue-500'
                      : 'bg-transparent'
                  "
                ></div>
                <span
                  class="text-xs font-medium truncate"
                  :class="
                    mod.selectedConnector === conn.id && mod.selectedModel === cm
                      ? 'text-blue-700'
                      : 'text-slate-700'
                  "
                  :title="cm"
                  >{{ cm }}</span
                >
                <span
                  v-if="
                    mod.pickerConnFree && mod.pickerConnFree[conn.id] && mod.pickerConnFree[conn.id]?.[cm]
                  "
                  class="ml-auto shrink-0 text-[10px] px-1.5 py-0.5 rounded border border-emerald-200 bg-emerald-50 text-emerald-700"
                  title="Modèle sans facturation chez ce fournisseur"
                  >gratuit</span
                >
              </div>
              <button
                v-if="mod.isConnModelLoaded(conn.id, cm)"
                class="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-md text-xs transition-all border border-slate-200 text-slate-400 hover:bg-blue-50 hover:text-blue-600 hover:border-blue-200"
                title="Infos modèle"
                @click.stop="mod.fetchModelProps(cm, 'conn:' + conn.id)"
              >
                <i class="ph ph-info text-xs"></i>
              </button>
              <template v-if="mod.pickerConnState[conn.id] && mod.pickerConnState[conn.id]?.router">
                <button
                  v-if="mod.pickerConnState[conn.id]?.canManage"
                  class="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-md text-xs transition-all border"
                  :class="
                    mod.isLoadingModel === 'conn:' + conn.id + '|' + cm
                      ? '!border-blue-300 !text-blue-400'
                      : mod.isConnModelLoaded(conn.id, cm)
                        ? 'border-red-200 text-red-400 hover:bg-red-50 hover:text-red-600'
                        : 'border-green-200 text-green-500 hover:bg-green-50 hover:text-green-700'
                  "
                  :title="mod.isConnModelLoaded(conn.id, cm) ? 'Décharger' : 'Charger'"
                  :disabled="!!mod.isLoadingModel"
                  @click.stop="mod.toggleConnModel(conn, cm)"
                >
                  <i
                    class="ph text-xs"
                    :class="
                      mod.isLoadingModel === 'conn:' + conn.id + '|' + cm
                        ? 'ph-spinner-gap animate-spin'
                        : mod.isConnModelLoaded(conn.id, cm)
                          ? 'ph-eject'
                          : 'ph-play'
                    "
                  ></i>
                </button>
              </template>
            </div>
          </template>
        </div>

        <slot name="pied"></slot>

        <div class="px-3 py-1.5 bg-slate-50 border-t flex items-center justify-between">
          <template v-if="!mod.selectedConnector">
            <span
              v-if="mod.llmHealth && mod.builtinAllowed"
              class="text-[10px]"
              :class="mod.llmHealth.server_reachable ? 'text-green-600' : 'text-red-500'"
            >
              <i class="ph" :class="mod.llmHealth.server_reachable ? 'ph-check-circle' : 'ph-wifi-slash'"></i>
              {{ mod.llmHealth.status === "ok" ? "En ligne" : mod.llmHealth.status || "" }}
              <template v-if="mod.moteurIntegre"> · {{ mod.moteurIntegre.libelle }}</template>
            </span>
            <span
              v-if="mod.builtinAllowed && mod.llmHealth && mod.llmHealth.props && mod.llmHealth.props.n_ctx"
              class="text-[10px] text-blue-500 font-mono font-semibold"
            >
              <i class="ph ph-brackets-angle text-[9px]"></i>
              {{ mod.llmHealth.props.n_ctx.toLocaleString("fr-FR") }} jetons de contexte
            </span>
          </template>
          <template v-else>
            <span
              v-if="mod.pickerConnState[mod.selectedConnector]"
              class="text-[10px] truncate"
              :class="mod.pickerConnState[mod.selectedConnector]?.ok ? 'text-green-600' : 'text-red-500'"
            >
              <i
                class="ph"
                :class="mod.pickerConnState[mod.selectedConnector]?.ok ? 'ph-check-circle' : 'ph-wifi-slash'"
              ></i>
              {{ mod.pickerConnState[mod.selectedConnector]?.ok ? "En ligne" : "Injoignable" }} ·
              {{ mod.selectedEngineMeta?.label }}
            </span>
            <span
              v-if="mod.selectedEngineMeta && mod.selectedEngineMeta.n_ctx"
              class="text-[10px] text-blue-500 font-mono font-semibold"
            >
              <i class="ph ph-brackets-angle text-[9px]"></i>
              {{ mod.selectedEngineMeta.n_ctx.toLocaleString("fr-FR") }} jetons de contexte
            </span>
          </template>
          <button
            title="Rafraîchir les modèles"
            aria-label="Rafraîchir les modèles"
            class="text-[10px] text-slate-400 hover:text-blue-600 flex items-center gap-1"
            @click="mod.loadAvailableModels"
          >
            <i class="ph ph-arrows-clockwise text-xs"></i>
          </button>
        </div>
      </div>
    </Transition>
  </div>
</template>
