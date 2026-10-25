<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/outils/CarteOutil.vue — carte détail d'une étape : statistiques de compression, ou paramètres et résultat d'un outil. -->
<script setup lang="ts">
import { fmtDuree, fmtToolArgVal, formatToolResult } from "../../../features/chat/outils/format";
import { RESULTAT_RECHARGE_MAX } from "../../../features/chat/outils/segments";
import type { EtapeOutil } from "../../../features/chat/outils/types";

const props = defineProps<{ step: EtapeOutil; numero: number; compactOuvert: boolean }>();
const emit = defineEmits<{ fermer: []; compact: [ouvert: boolean] }>();

function basculerCompact(ev: Event): void {
  emit("compact", (ev.target as HTMLDetailsElement).open);
}
</script>

<template>
  <div class="mt-2 rounded-xl border border-slate-200/80 bg-white/60 overflow-hidden text-[11px] shadow-sm">
    <div
      class="flex items-center gap-2 px-3 py-2 border-b"
      :class="
        step._kind === 'compression' ? 'border-slate-100 bg-slate-50/60' : 'border-slate-100 bg-slate-50/80'
      "
    >
      <i
        :class="
          step._kind === 'compression'
            ? 'ph ph-arrows-in-simple text-slate-400'
            : step.name.startsWith('rag_')
              ? 'ph ph-database text-slate-400'
              : 'ph ph-terminal-window text-slate-400'
        "
        style="font-size: 12px"
      ></i>
      <span class="font-mono font-semibold truncate text-slate-600">
        <template v-if="step._kind === 'compression'">Compression du contexte</template>
        <template v-else>{{ step.ragLabel || step.name }}</template>
      </span>
      <button
        type="button"
        class="ml-auto w-6 h-6 flex items-center justify-center rounded-md text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
        aria-label="Fermer le détail"
        @click="emit('fermer')"
      >
        <i class="ph ph-x" style="font-size: 11px" aria-hidden="true"></i>
      </button>
    </div>

    <template v-if="step._kind === 'compression'">
      <div class="px-3 py-2.5">
        <div v-if="step.status === 'running'" class="text-slate-400 italic flex items-center gap-1.5">
          <i class="ph ph-arrows-in-simple animate-pulse text-xs"></i>
          <span>Compression du contexte en cours…</span>
          <span
            v-if="step.est_ms"
            class="ml-auto text-[10px] font-mono tabular-nums text-slate-400"
            :title="'Médiane moving-window sur ' + step.path"
          >
            ~{{ Math.round(step.est_ms / 1000) }}s
          </span>
        </div>
        <div v-else>
          <div class="text-xs font-semibold text-slate-500 mb-2">Compression du contexte</div>
          <div class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono leading-relaxed">
            <template v-if="step.reason">
              <span class="text-slate-400 select-none">déclenchement</span>
              <span class="text-slate-700">
                <template v-if="step.reason === 'manual'">manuel</template>
                <template v-else-if="step.reason === 'overflow'">contexte dépassé</template>
                <template v-else
                  >seuil atteint<template v-if="step.threshold">
                    ({{ step.threshold }} jetons<template v-if="step.ctx_size">
                      sur {{ step.ctx_size }}</template
                    >)</template
                  ></template
                >
              </span>
            </template>
            <span class="text-slate-400 select-none">jetons</span>
            <span class="text-slate-700">
              <template v-if="step.stats">
                {{ step.stats.tokens_before }}
                →
                {{ step.stats.tokens_after }}
                <span v-if="step.stats.tokens_saved" class="text-slate-400">
                  (−{{ step.stats.tokens_saved }})
                </span>
              </template>
            </span>

            <span class="text-slate-400 select-none">messages</span>
            <span class="text-slate-700">
              <template v-if="step.stats">
                {{ step.stats.messages_before }}
                →
                {{ step.stats.messages_after }}
              </template>
            </span>

            <span class="text-slate-400 select-none">ratio</span>
            <span class="text-slate-700">
              <template v-if="step.stats">
                {{ Math.round((step.stats.ratio || 0) * 100) }}% de la taille initiale
              </template>
            </span>

            <span class="text-slate-400 select-none">tours résumés</span>
            <span class="text-slate-700">
              <template v-if="step.stats">
                {{ step.stats.turns_compressed }}
              </template>
            </span>

            <span class="text-slate-400 select-none">durée</span>
            <span class="text-slate-700 tabular-nums">
              <template v-if="step.stats && step.stats.duration_ms">
                {{ fmtDuree(step.stats.duration_ms) }}
              </template>
            </span>

            <span class="text-slate-400 select-none">modèle</span>
            <span class="text-slate-700 truncate">
              <template v-if="step.stats && step.stats.model_used">
                {{ step.stats.model_used }}
              </template>
              <template v-else-if="step.model">
                {{ step.model }}
              </template>
            </span>

            <span class="text-slate-400 select-none">chemin</span>
            <span class="text-slate-700">
              <template v-if="step.stats">
                <template v-if="step.stats.path === 'endpoint'">endpoint dédié</template>
                <template v-else-if="step.stats.path === 'external_model'">modèle alternatif</template>
                <template v-else>modèle courant</template>
              </template>
            </span>

            <span class="text-slate-400 select-none">cumulatif</span>
            <span class="text-slate-700">
              <template v-if="step.stats">
                <template v-if="step.stats.had_previous_summary">fusion avec résumé précédent</template>
                <template v-else>première compression</template>
              </template>
            </span>
          </div>
          <details
            v-if="step.stats && step.stats.new_state && step.stats.new_state.summary_xml"
            class="mt-2 group/compact"
            :open="props.compactOuvert"
            @toggle="basculerCompact"
          >
            <summary
              class="list-none flex items-center gap-1.5 cursor-pointer select-none w-fit py-0.5 text-slate-400 hover:text-slate-600 transition-colors"
            >
              <span class="text-[11px] font-medium">Voir le résumé</span>
              <i
                class="ph ph-caret-right text-slate-300 transition-transform group-open/compact:rotate-90 shrink-0"
                style="font-size: 9px"
              ></i>
            </summary>
            <pre
              class="mt-1 pl-3 border-l-2 border-slate-200 text-[11px] leading-relaxed text-slate-500 whitespace-pre-wrap break-words max-h-56 overflow-y-auto custom-scrollbar"
              >{{ step.stats.new_state.summary_xml }}</pre>
          </details>
        </div>
      </div>
    </template>

    <template v-else>
      <div
        v-if="step.args && Object.keys(step.args).length > 0"
        class="px-3 py-2 border-b border-slate-100/80"
      >
        <div class="text-xs font-semibold text-slate-500 mb-1.5">Paramètres</div>
        <div v-for="(val, key) in step.args" :key="key" class="flex gap-2 mb-0.5 font-mono leading-relaxed">
          <span class="text-slate-400 shrink-0 select-none" style="min-width: 80px">{{ key }}</span>
          <span class="text-slate-600 break-words whitespace-pre-wrap">{{ fmtToolArgVal(val) }}</span>
        </div>
      </div>

      <div class="px-3 py-2">
        <div class="text-xs font-semibold text-slate-500 mb-1.5">Résultat</div>
        <div v-if="step.status === 'running'" class="text-slate-500 flex items-center gap-1">
          <i class="ph ph-spinner-gap animate-spin text-xs text-blue-500" aria-hidden="true"></i> en cours…
        </div>
        <div v-else-if="step.status === 'stopped' && !step.result" class="text-slate-500">Arrêtée</div>
        <pre
          v-else
          class="font-mono text-slate-600 whitespace-pre-wrap break-all leading-relaxed max-h-48 overflow-y-auto custom-scrollbar m-0 bg-transparent"
          >{{ formatToolResult(step.result) }}</pre>
        <p
          v-if="step.resultLength"
          class="mt-1.5 text-slate-500"
          :title="'Résultat complet : ' + step.resultLength.toLocaleString('fr-FR') + ' caractères'"
          data-resultat-tronque
        >
          Résultat tronqué à {{ RESULTAT_RECHARGE_MAX.toLocaleString("fr-FR") }} caractères
        </p>
      </div>
    </template>
  </div>
</template>
