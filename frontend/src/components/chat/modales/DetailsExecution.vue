<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/modales/DetailsExecution.vue — « Détails » d'une réponse : agrégats de l'exécution puis événements horodatés dépliables (tours du modèle, outils, sous-exécutions), onglets après « Continuer », export JSON ; chat et console. -->
<script setup lang="ts">
import { computed } from "vue";

import { domaineModales } from "../../../features/chat/modales/domaine";

const m = domaineModales();
const run = computed(() => m.runDetails?.data?.run ?? null);
</script>

<template>
  <Transition name="modal">
    <div
      v-if="m.runDetails"
      data-a11y-modal
      role="dialog"
      aria-modal="true"
      aria-label="Détails de l'exécution"
      class="fixed inset-0 z-[6000] flex items-center justify-center bg-slate-900/80 p-4"
      @click.self="m.closeRunDetails()"
    >
      <div
        class="bg-white rounded-2xl shadow-2xl ring-1 ring-slate-200 w-full max-w-4xl overflow-hidden flex flex-col h-[85vh]"
      >
        <div class="px-5 py-4 border-b border-slate-100 flex items-center justify-between shrink-0">
          <div class="flex items-center gap-2.5 min-w-0">
            <div
              class="w-8 h-8 rounded-lg bg-blue-100 text-blue-600 flex items-center justify-center shrink-0"
            >
              <i class="ph ph-list-magnifying-glass"></i>
            </div>
            <div class="min-w-0">
              <h3 class="font-bold text-slate-800 text-sm truncate">Détails de l'exécution</h3>
              <div class="text-xs text-slate-500 truncate">{{ m.runDetails.runId }}</div>
            </div>
          </div>
          <div class="flex items-center gap-1 shrink-0">
            <a
              :href="m.runExportHref(m.runDetails.runId)"
              title="Exporter en JSON (secrets masqués)"
              class="h-8 px-3 rounded-lg text-xs font-semibold text-slate-600 hover:bg-slate-100 flex items-center gap-1.5 transition-colors"
            >
              <i class="ph ph-download-simple"></i> Exporter
            </a>
            <button
              aria-label="Fermer"
              class="w-8 h-8 rounded-lg text-slate-500 hover:bg-slate-100 flex items-center justify-center"
              @click="m.closeRunDetails()"
            >
              <i class="ph ph-x"></i>
            </button>
          </div>
        </div>

        <div v-if="m.runDetails.ids.length > 1" class="px-5 pt-3 flex flex-wrap gap-1 shrink-0">
          <button
            v-for="(rid, i) in m.runDetails.ids"
            :key="rid"
            class="h-7 px-2.5 rounded-md text-xs transition-colors"
            :class="
              rid === m.runDetails.runId
                ? 'bg-blue-50 text-blue-700 font-semibold'
                : 'text-slate-600 hover:bg-slate-100'
            "
            @click="m.showRunDetails(rid, m.runDetails.ids)"
          >
            {{ i === 0 ? "Réponse" : "Suite " + i }}
          </button>
        </div>

        <div class="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-5 text-sm text-slate-700">
          <div v-if="m.runDetails.loading" class="text-slate-500 flex items-center gap-2">
            <i class="ph ph-circle-notch animate-spin"></i> Chargement…
          </div>
          <div v-else-if="m.runDetails.error" class="text-slate-500">{{ m.runDetails.error }}</div>
          <template v-else-if="m.runDetails.data">
            <template v-if="run">
              <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-5">
                <div class="rounded-lg bg-slate-50 p-2.5">
                  <div class="text-[11px] text-slate-500">Statut · durée</div>
                  <div class="font-semibold">
                    {{ run.status }} ·
                    {{ m.runDuration(((run.ended_at || run.started_at) - run.started_at) * 1000) }}
                  </div>
                </div>
                <div class="rounded-lg bg-slate-50 p-2.5" :title="m.runTokensTitle(run)">
                  <div class="text-[11px] text-slate-500">Entrée</div>
                  <div class="font-semibold">{{ m.runInput(run) }}</div>
                </div>
                <div class="rounded-lg bg-slate-50 p-2.5" :title="m.runTokensTitle(run)">
                  <div class="text-[11px] text-slate-500">Sortie</div>
                  <div class="font-semibold">{{ m.runOutput(run) }}</div>
                </div>
                <div class="rounded-lg bg-slate-50 p-2.5">
                  <div class="text-[11px] text-slate-500">Appels d'outils (erreurs)</div>
                  <div class="font-semibold">{{ run.tool_calls }} ({{ run.tool_errors }})</div>
                </div>
                <div
                  class="rounded-lg bg-slate-50 p-2.5"
                  :title="
                    'Prefill ' +
                    m.runDuration(run.prefill_ms) +
                    ' · génération ' +
                    m.runDuration(run.decode_ms) +
                    (run.wait_ms ? ' · attente d\'un créneau ' + m.runDuration(run.wait_ms) : '')
                  "
                >
                  <div class="text-[11px] text-slate-500">Prefill + génération</div>
                  <div class="font-semibold">
                    {{ m.runDuration(run.prefill_ms) }} + {{ m.runDuration(run.decode_ms)
                    }}<span v-if="run.wait_ms" class="text-slate-500 font-normal">
                      · {{ m.runDuration(run.wait_ms) }} d'attente</span
                    >
                  </div>
                </div>
                <div class="rounded-lg bg-slate-50 p-2.5">
                  <div class="text-[11px] text-slate-500">Fichiers modifiés</div>
                  <div class="font-semibold">{{ run.files_changed }}</div>
                </div>
                <div class="rounded-lg bg-slate-50 p-2.5">
                  <div class="text-[11px] text-slate-500">Moteur</div>
                  <div class="font-semibold truncate" :title="run.model">{{ run.engine || "—" }}</div>
                </div>
                <div
                  class="rounded-lg bg-slate-50 p-2.5"
                  title="Pics mesurés sur tout le conteneur de la sandbox, au plus toutes les 10 s"
                >
                  <div class="text-[11px] text-slate-500">Sandbox (pics)</div>
                  <div class="font-semibold">
                    {{ run.sandbox_cpu_peak != null ? Math.round(run.sandbox_cpu_peak) + " % CPU" : "—"
                    }}<span v-if="run.sandbox_mem_peak_mb != null">
                      · {{ Math.round(run.sandbox_mem_peak_mb) }} Mio</span
                    >
                  </div>
                </div>
              </div>
            </template>

            <div v-if="!m.runDetails.data.events.length" class="text-slate-500">
              Aucun événement enregistré.
            </div>
            <ol class="space-y-1">
              <li v-for="(ev, i) in m.runDetails.data.events" :key="i">
                <button
                  class="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-slate-50 text-left"
                  @click="m.toggleRunEvent(i)"
                >
                  <span class="text-[11px] text-slate-400 font-mono w-16 shrink-0">{{
                    m.runClock(ev.at)
                  }}</span>
                  <i
                    class="ph text-[14px] shrink-0"
                    :class="[
                      ev.type === 'llm' ? 'ph-brain' : ev.type === 'tool' ? 'ph-wrench' : 'ph-tree-structure',
                      m.runEventState(ev) === 'ok'
                        ? 'text-slate-500'
                        : m.runEventState(ev) === 'stop'
                          ? 'text-amber-500'
                          : 'text-red-500',
                    ]"
                  ></i>
                  <span class="font-medium text-slate-700 shrink-0">{{ m.runEventLabel(ev) }}</span>
                  <span class="text-xs text-slate-500 truncate">{{ m.runEventMeta(ev) }}</span>
                  <span class="ml-auto text-xs text-slate-400 shrink-0">{{
                    m.runDuration(ev.duration_ms)
                  }}</span>
                </button>
                <div
                  v-if="m.runDetails.open[i]"
                  class="ml-20 mb-2 rounded-lg bg-slate-50 p-3 text-xs space-y-1.5"
                >
                  <template v-if="ev.type === 'tool'">
                    <div v-if="ev.argument">
                      <span class="text-slate-500">Argument :</span>
                      <code class="break-all">{{ ev.argument }}</code>
                    </div>
                    <div v-if="ev.error_short" class="text-red-600 whitespace-pre-wrap break-words">
                      {{ ev.error_short }}
                    </div>
                    <pre
                      v-if="ev.result"
                      class="whitespace-pre-wrap break-words font-mono text-[11px] text-slate-600 max-h-60 overflow-y-auto custom-scrollbar"
                      >{{ ev.result }}</pre>
                    <div class="text-slate-400">
                      {{ ev.category || "" }} · statut {{ ev.status
                      }}<template v-if="ev.args_bytes != null"> · arguments {{ ev.args_bytes }} o</template
                      ><template v-if="ev.result_bytes != null"> · résultat {{ ev.result_bytes }} o</template>
                    </div>
                  </template>
                  <template v-else-if="ev.type === 'llm'">
                    <div>
                      Source : {{ ev.source }} · statut {{ ev.status
                      }}<template v-if="ev.error_kind"> ({{ ev.error_kind }})</template>
                    </div>
                    <div class="whitespace-pre-line">{{ m.runTokensTitle(ev) }}</div>
                    <div v-if="ev.iterations">Itérations : {{ ev.iterations }}</div>
                  </template>
                  <template v-else>
                    <button
                      class="text-blue-600 hover:underline"
                      @click="m.showRunDetails(String(ev.run_id), [String(ev.run_id)])"
                    >
                      Ouvrir {{ m.runEventLabel(ev).toLowerCase() }} ({{ ev.run_id }})
                    </button>
                  </template>
                </div>
              </li>
            </ol>
          </template>
        </div>
      </div>
    </div>
  </Transition>
</template>
