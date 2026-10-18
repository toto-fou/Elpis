<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/routines/VueRoutine.vue — vue lecture seule d'une routine : résumé de configuration et journal des exécutions. -->
<script setup lang="ts">
import { computed } from "vue";

import type { RoutineListee } from "../../features/routines/api";
import { domaineRoutines } from "../../features/routines/domaine";

const rt = domaineRoutines();
const vu = computed(() => rt.viewed as RoutineListee);
</script>

<!-- eslint-disable vue/no-v-html -- Markdown de la réponse du run rendu par le moteur du chat (purifié par DOMPurify). -->
<template>
  <!-- VUE LECTURE SEULE : infos de la routine + journal des runs -->
  <!-- Pleine largeur (max-w-6xl) : résumé de config en COLONNE LATÉRALE sticky, journal des exécutions = contenu -->
  <div class="flex-1 flex flex-col min-h-0">
    <!-- Le SCROLLER est pleine largeur (la colonne max-w-6xl vit DEDANS) : une éventuelle barre colle au bord du -->
    <div class="flex-1 overflow-y-auto custom-scrollbar min-h-0">
      <div class="px-5 py-4 max-w-6xl w-full mx-auto">
        <!-- En-tête -->
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <h3 class="font-semibold text-slate-900 text-lg truncate tracking-tight">
                {{ vu.name }}
              </h3>
              <span
                class="text-[10px] font-semibold px-1.5 py-0.5 rounded shrink-0"
                :class="vu.enabled ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-500'"
              >
                {{ vu.enabled ? "Active" : "En pause" }}
              </span>
            </div>
            <p class="text-sm text-slate-500 mt-0.5 flex items-center gap-1.5 flex-wrap">
              <i class="ph ph-clock text-blue-500"></i> {{ rt.cronToHuman(vu.cron_expr) }}
              <span class="text-[11px] text-slate-400 font-mono">{{ vu.cron_expr }}</span>
              <!-- État du déclencheur webhook visible SANS entrer en édition (la config vit dans Configurer → Déclencheurs). -->
              <span
                v-if="vu.webhook_enabled"
                class="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 inline-flex items-center gap-0.5"
                title="Déclenchable par webhook — config dans Configurer → Déclencheurs"
              >
                <i class="ph ph-lightning" style="font-size: 10px"></i> webhook
              </span>
              <span
                v-if="vu.trigger_after_id"
                class="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 inline-flex items-center gap-0.5"
                :title="
                  'Se lance après « ' +
                  rt.routineNameById(vu.trigger_after_id) +
                  ' » (' +
                  ({ ok: 'si succès', error: 'si échec', always: 'toujours' }[vu.trigger_after_on] || '') +
                  ')'
                "
              >
                <i class="ph ph-link" style="font-size: 10px"></i> après
                {{ rt.routineNameById(vu.trigger_after_id) }}
              </span>
            </p>
          </div>
          <div class="flex items-center gap-1.5 shrink-0">
            <button
              :disabled="rt.routinesBusy || !vu.enabled"
              :title="vu.enabled ? 'Exécuter maintenant' : 'Routine en pause — réactivez-la pour l\'exécuter'"
              class="text-xs px-3 py-1.5 rounded-md bg-emerald-50 hover:bg-emerald-100 text-emerald-700 transition-colors flex items-center gap-1.5 disabled:opacity-50"
              @click="rt.runRoutineNow"
            >
              <i class="ph ph-play"></i> Exécuter
            </button>
            <button
              class="text-xs px-3 py-1.5 rounded-md bg-blue-600 text-white hover:bg-blue-700 transition-colors flex items-center gap-1.5"
              @click="rt.editRoutine(vu)"
            >
              <i class="ph ph-gear"></i> Configurer
            </button>
          </div>
        </div>

        <div class="mt-4 grid gap-6 items-start xl:grid-cols-[minmax(17rem,21rem)_1fr]">
          <!-- Résumé config (lecture seule) — UN seul bloc, champs séparés par des filets -->
          <aside class="set-block space-y-3 text-sm xl:sticky xl:top-4 min-w-0">
            <div class="grid grid-cols-2 gap-x-4 gap-y-3">
              <div>
                <div class="text-[11px] font-semibold text-slate-500 mb-0.5">Modèle</div>
                <div class="text-slate-700 truncate">{{ vu.model || "Par défaut" }}</div>
              </div>
              <div>
                <div class="text-[11px] font-semibold text-slate-500 mb-0.5">Réflexion</div>
                <div class="text-slate-700">{{ vu.thinking_mode ? "Activée" : "Désactivée" }}</div>
              </div>
              <!-- Sous-agents : lisible SANS ouvrir l'éditeur — un réglage qui change ce que la routine fait toute seule doit -->
              <div>
                <div class="text-[11px] font-semibold text-slate-500 mb-0.5">Sous-agents</div>
                <div :class="vu.agents_enabled ? 'text-slate-700' : 'text-slate-400'">
                  {{ vu.agents_enabled ? "Activés" : "Désactivés" }}
                </div>
              </div>
              <!-- Historique : ce que la routine garde (journal) et ce qu'elle pousse au centre de notifications — lisible sans -->
              <div data-routine-history-view>
                <div class="text-[11px] font-semibold text-slate-500 mb-0.5">Journal</div>
                <div class="text-slate-700">{{ rt.keepLabel(vu.runs_keep) }}</div>
              </div>
              <div>
                <div class="text-[11px] font-semibold text-slate-500 mb-0.5">Notifications</div>
                <div :class="vu.notify_on === 'none' ? 'text-slate-400' : 'text-slate-700'">
                  {{ rt.notifyOnLabel(vu.notify_on)
                  }}<span v-if="vu.notify_on !== 'none' && vu.notify_keep > 0" class="text-slate-400"
                    >&nbsp;· {{ vu.notify_keep }} gardées</span
                  >
                </div>
              </div>
            </div>
            <div class="pt-3 border-t border-slate-100">
              <div class="text-[11px] font-semibold text-slate-500 mb-1">Serveurs MCP</div>
              <div
                v-if="rt.mcpSummary(vu.mcp_snapshot, rt.mcpUserCategories).length"
                class="flex flex-wrap gap-1"
              >
                <!-- clé indexée : deux serveurs externes homonymes cassaient le v-for -->
                <span
                  v-for="(lbl, i) in rt.mcpSummary(vu.mcp_snapshot, rt.mcpUserCategories)"
                  :key="i + ':' + lbl"
                  class="text-[11px] px-1.5 py-0.5 rounded bg-white border border-slate-200 text-slate-600"
                  >{{ lbl }}</span
                >
              </div>
              <div v-else class="text-[11px] text-slate-400 italic">Aucun outil sélectionné.</div>
            </div>
            <!-- Skills attachés : corps injectés dans le system prompt du run -->
            <div class="pt-3 border-t border-slate-100">
              <div class="text-[11px] font-semibold text-slate-500 mb-1">Skills</div>
              <div v-if="(vu.skills || []).length" class="flex flex-wrap gap-1">
                <!-- « +n » : paquet → n sous-skills embarqués au run. -->
                <span
                  v-for="sid in vu.skills"
                  :key="sid"
                  :title="rt.skillTooltip(sid)"
                  class="text-[11px] px-1.5 py-0.5 rounded border flex items-center gap-1"
                  :class="
                    rt.isKnownSkill(sid)
                      ? 'bg-white border-slate-200 text-slate-600'
                      : 'bg-amber-50 border-amber-200 text-amber-700'
                  "
                >
                  <i
                    class="ph ph-graduation-cap text-[11px]"
                    :class="rt.isKnownSkill(sid) ? 'text-slate-400' : 'text-amber-500'"
                  ></i>
                  {{ sid
                  }}<span v-if="rt.skillDescendantCount(sid)" class="text-slate-400"
                    >&nbsp;+{{ rt.skillDescendantCount(sid) }}</span
                  ><span v-if="!rt.isKnownSkill(sid)">&nbsp;⚠</span>
                </span>
              </div>
              <div v-else class="text-[11px] text-slate-400 italic">Aucun skill attaché.</div>
            </div>
            <div class="pt-3 border-t border-slate-100">
              <div class="text-[11px] font-semibold text-slate-500 mb-0.5">Tâche</div>
              <p
                class="text-sm text-slate-600 whitespace-pre-wrap break-words max-h-40 overflow-y-auto custom-scrollbar"
              >
                {{ vu.task_prompt || "—" }}
              </p>
            </div>
          </aside>

          <!-- Journal des runs (contenu principal, colonne large) -->
          <div class="min-w-0">
            <div class="flex items-center justify-between mb-2">
              <div class="flex items-center gap-2">
                <h4 class="text-sm font-semibold text-slate-700">Exécutions</h4>
                <span
                  v-if="rt.anyRunActive"
                  role="status"
                  aria-live="polite"
                  class="flex items-center gap-1 text-[10px] font-medium text-blue-600"
                >
                  <span class="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse"></span> en cours…
                </span>
                <!-- Au plus UN run actif par routine (garde serveur) : le bouton du header arrête celui-là sans devoir déplier. -->
                <button
                  v-if="rt.anyRunActive"
                  type="button"
                  :disabled="rt.activeRunStopping"
                  title="Arrêter l'exécution en cours"
                  class="text-[10px] px-2 py-0.5 rounded-md bg-red-50 hover:bg-red-100 text-red-600 transition-colors flex items-center gap-1 disabled:opacity-60 focus:outline-none focus-visible:ring-1 focus-visible:ring-red-400"
                  @click="rt.stopActiveRun"
                >
                  <i
                    class="ph"
                    :class="rt.activeRunStopping ? 'ph-spinner animate-spin' : 'ph-stop-circle'"
                  ></i>
                  {{ rt.activeRunStopping ? "Arrêt…" : "Arrêter" }}
                </button>
              </div>
              <button
                title="Rafraîchir"
                class="text-[11px] text-slate-500 hover:text-slate-700 flex items-center gap-1"
                @click="rt.loadRuns(rt.selectedRoutineId)"
              >
                <i class="ph ph-arrow-clockwise" :class="rt.routineRunsLoading && 'animate-spin'"></i>
                Rafraîchir
              </button>
            </div>
            <div v-if="rt.routineRunsLoading && !rt.routineRuns.length" class="text-center py-6">
              <i class="ph ph-spinner animate-spin text-slate-300 text-xl"></i>
            </div>
            <div
              v-else-if="rt.routineRuns.length === 0"
              class="text-center py-8 border border-dashed border-slate-200 rounded-lg"
            >
              <i class="ph ph-clock-countdown text-slate-300 text-2xl block mb-1"></i>
              <p class="text-xs text-slate-400">Aucune exécution pour l'instant.</p>
              <p class="text-[11px] text-slate-400 mt-0.5">
                Elle se lancera selon la planification, ou via « Exécuter ».
              </p>
            </div>
            <div v-else class="space-y-1">
              <div
                v-for="run in rt.routineRuns"
                :key="run.id"
                class="rounded-lg border border-slate-100 bg-slate-50/50 overflow-hidden"
              >
                <button
                  type="button"
                  data-run-row
                  :data-run-status="run.status"
                  :aria-expanded="rt.expandedRunId === run.id ? 'true' : 'false'"
                  class="w-full flex items-center gap-2 text-[11px] px-2 py-1.5 text-left hover:bg-slate-50 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-blue-500"
                  @click="rt.toggleRunExpand(run.id)"
                >
                  <span
                    class="px-1.5 py-0.5 rounded font-medium shrink-0 flex items-center gap-1"
                    :class="rt.runStatusClass(run.status)"
                  >
                    <span
                      v-if="run.status === 'running'"
                      class="w-1.5 h-1.5 rounded-full bg-current animate-pulse"
                    ></span>
                    {{ rt.runStatusLabel(run.status) }}
                  </span>
                  <!-- AUDIT 2026-08-30 (S10) — ex-pictogrammes ▶ ⚡ ⛓ ⏱ : rendus en emoji coloré par la plupart des plateformes -->
                  <span
                    class="text-slate-400 shrink-0"
                    :title="
                      {
                        manual: 'Déclenché manuellement',
                        webhook: 'Déclenché par webhook',
                        chain: 'Déclenché par enchaînement',
                      }[run.trigger] || 'Planifié'
                    "
                    ><i
                      class="ph"
                      :class="
                        { manual: 'ph-play', webhook: 'ph-lightning', chain: 'ph-link' }[run.trigger] ||
                        'ph-clock'
                      "
                    ></i
                  ></span>
                  <span class="text-slate-600 shrink-0">{{ rt.fmtRunTime(run.started_at) }}</span>
                  <span class="text-slate-400 shrink-0">{{ rt.fmtDuration(run.duration_ms) }}</span>
                  <!-- gate sur ENTRÉE+SORTIE : un run interrompu (0 tk de sortie, 30k d'entrée) n'affichait aucune consommation -->
                  <span
                    v-if="run.input_tokens || run.output_tokens"
                    class="text-slate-400 shrink-0 hidden sm:inline"
                    >{{ (run.input_tokens || 0) + (run.output_tokens || 0) }} tk</span
                  >
                  <!-- « ce run a produit quelque chose » repérable sans déplier -->
                  <span
                    v-if="rt.runFiles(run).length"
                    class="text-slate-400 shrink-0 inline-flex items-center gap-0.5"
                    :title="rt.runFiles(run).length + ' fichier(s) écrit(s)'"
                  >
                    <i class="ph ph-file-code" style="font-size: 11px"></i>{{ rt.runFiles(run).length }}
                  </span>
                  <span
                    class="truncate flex-1 min-w-0"
                    :class="
                      run.status === 'error' || run.status === 'orphaned' ? 'text-red-500' : 'text-slate-500'
                    "
                    >{{ rt.runPreviewText(run) || (run.status === "running" ? "…" : "") }}</span
                  >
                  <i
                    class="ph shrink-0 text-slate-400"
                    :class="rt.expandedRunId === run.id ? 'ph-caret-up' : 'ph-caret-down'"
                  ></i>
                </button>
                <div
                  v-if="rt.expandedRunId === run.id"
                  class="px-2.5 pb-2.5 pt-1 border-t border-slate-100 space-y-2"
                >
                  <!-- Fichiers produits par le run : un clic les ouvre dans l'éditeur -->
                  <div v-if="rt.runFiles(run).length" class="flex flex-wrap items-center gap-1 pt-0.5">
                    <span class="text-[10px] font-semibold text-slate-500 mr-0.5">Fichiers produits</span>
                    <button
                      v-for="f in rt.runFiles(run)"
                      :key="f"
                      type="button"
                      :title="f"
                      class="max-w-[15rem] text-[11px] px-1.5 py-0.5 rounded border border-slate-200 bg-white text-slate-600 hover:border-blue-300 hover:text-blue-700 hover:bg-blue-50 transition-colors flex items-center gap-1 focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-500"
                      @click.stop="rt.openRunFile(f)"
                    >
                      <i class="ph ph-file-code text-slate-400 shrink-0" style="font-size: 11px"></i>
                      <span class="truncate font-mono">{{ rt.fileBaseName(f) }}</span>
                    </button>
                  </div>
                  <!-- Réponse finale : du Markdown, rendu comme dans le chat (titres/listes/tableaux/code) -->
                  <div v-if="rt.runDetailText(run)" class="relative group/detail">
                    <button
                      type="button"
                      title="Copier la réponse"
                      class="absolute top-1 right-1 z-10 w-6 h-6 rounded-md bg-white/90 border border-slate-200 text-slate-400 hover:text-blue-600 hover:border-blue-300 opacity-0 group-hover/detail:opacity-100 focus-visible:opacity-100 transition-opacity flex items-center justify-center"
                      @click.stop="rt.copyRunDetail(run)"
                    >
                      <i class="ph ph-copy" style="font-size: 11px"></i>
                    </button>
                    <div
                      v-if="rt.runIsMarkdown(run)"
                      class="markdown-body text-[12px] leading-relaxed max-h-96 overflow-y-auto custom-scrollbar rounded-md px-2.5 py-2 bg-white border border-slate-100"
                      v-html="rt.renderMarkdown(rt.runDetailText(run))"
                    ></div>
                    <!-- skipped = raison neutre, pas une erreur rouge -->
                    <div
                      v-else
                      class="text-[11px] leading-relaxed whitespace-pre-wrap break-words max-h-96 overflow-y-auto custom-scrollbar rounded-md px-2.5 py-2"
                      :class="
                        run.status === 'skipped' ? 'bg-slate-50 text-slate-500' : 'bg-red-50 text-red-700'
                      "
                    >
                      {{ rt.runDetailText(run) }}
                    </div>
                    <p v-if="rt.runIsTruncated(run)" class="text-[10px] text-slate-400 italic mt-1">
                      Réponse tronquée à 4000 caractères dans le journal.
                    </p>
                  </div>
                  <div v-else class="text-[11px] text-slate-400 italic py-1">
                    {{
                      run.status === "running"
                        ? "Exécution en cours…"
                        : run.status === "skipped"
                          ? "Run non lancé (cap atteint ou routine désactivée)."
                          : run.status === "cancelled"
                            ? "Exécution arrêtée à la demande."
                            : "Aucune réponse enregistrée."
                    }}
                  </div>
                  <!-- Stop par-run (le run déplié est forcément visible ici : la ligne elle-même est un bouton, pas d'imbrication). -->
                  <button
                    v-if="run.status === 'running'"
                    type="button"
                    :disabled="rt.runStopping(run)"
                    class="text-[11px] px-2.5 py-1 rounded-md bg-red-50 hover:bg-red-100 text-red-600 transition-colors flex items-center gap-1.5 disabled:opacity-60 focus:outline-none focus-visible:ring-1 focus-visible:ring-red-400"
                    @click.stop="rt.stopRoutineRun(run)"
                  >
                    <i
                      class="ph"
                      :class="rt.runStopping(run) ? 'ph-spinner animate-spin' : 'ph-stop-circle'"
                    ></i>
                    {{ rt.runStopping(run) ? "Arrêt en cours…" : "Arrêter ce run" }}
                  </button>
                  <div class="flex items-center flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-slate-400">
                    <!-- même map que la ligne repliée : webhook/chain s'affichaient « Planifié » -->
                    <span>{{
                      {
                        manual: "Déclenché manuellement",
                        webhook: "Déclenché par webhook",
                        chain: "Déclenché par enchaînement",
                      }[run.trigger] || "Planifié"
                    }}</span>
                    <span v-if="run.input_tokens || run.output_tokens"
                      >{{ run.input_tokens || 0 }} entrée / {{ run.output_tokens || 0 }} sortie tk</span
                    >
                    <span v-if="run.tool_limit_reached" class="text-amber-600">limite d'outils atteinte</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <!-- /grid résumé+journal -->
      </div>
    </div>
    <!-- /scroller pleine largeur -->
  </div>
</template>
