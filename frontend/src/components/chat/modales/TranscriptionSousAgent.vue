<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/modales/TranscriptionSousAgent.vue — déroulé complet d'un sous-agent (fenêtre « œil ») : brief, bilan du harnais, résultat, étapes outils dépliables, narration ; le run est relu à chaque rendu pour suivre le direct. -->
<script setup lang="ts">
import { computed } from "vue";

import {
  classeStatutTache,
  fmtAppelsTache,
  fmtDureeTache,
  libelleEtatRun,
  libelleStatutTache,
} from "../../../features/chat/outils/bilan-tache";
import { domaineModales } from "../../../features/chat/modales/domaine";
import { interfaceApp } from "../../../features/reglages/interface";
import DetailsSousAgent from "../outils/DetailsSousAgent.vue";

const m = domaineModales();
const ui = interfaceApp();
// Run relu à chaque patch du message : le déroulé suit le direct.
const run = computed(() => m.taskModalRun());
const titre = computed(() => {
  const r = run.value;
  return r ? (r.agent ?? "") + (r.label ? " — " + r.label : "") : "Agent";
});
// État, appels, jetons et durée, séparés par « · ».
const meta = computed(() => {
  const r = run.value;
  if (!r) return "";
  let t = r.harness
    ? libelleStatutTache(r.harness.status)
    : r.state === "running"
      ? "en cours…"
      : libelleEtatRun(r.state);
  if (r.steps_total) t += ` · ${r.steps_total} appel${r.steps_total > 1 ? "s" : ""}`;
  if (typeof r.tokens === "number" && r.tokens > 0) t += ` · ${m.fmtTokens(r.tokens)} jetons`;
  if (r.duration_ms) t += ` · ${m.fmtToolMs(r.duration_ms)}`;
  return t;
});
</script>

<!-- eslint-disable vue/no-v-html -- HTML produit par le moteur Markdown : purifié (crochet de marked) ou échappé. -->
<template>
  <Transition name="modal">
    <div
      v-if="m.taskModal && ui.classique"
      data-a11y-modal
      role="dialog"
      aria-modal="true"
      aria-label="Déroulé de l'agent"
      class="fixed inset-0 z-[6000] flex items-center justify-center bg-slate-900/80 p-4"
      @click.self="m.closeTaskModal()"
    >
      <div
        class="bg-white rounded-2xl shadow-2xl ring-1 ring-slate-200 w-full max-w-4xl overflow-hidden flex flex-col h-[85vh]"
      >
        <!-- ── En-tête (idiome modale app : icône carrée + titre + méta) ── -->
        <div class="px-5 py-4 border-b border-slate-100 flex items-center justify-between shrink-0">
          <div class="flex items-center gap-2.5 min-w-0">
            <img
              :src="m.logoApp"
              alt=""
              data-logo-sous-agent
              class="w-8 h-8 rounded-lg object-cover shrink-0"
            />
            <div class="min-w-0">
              <h3 class="font-bold text-slate-800 text-sm truncate">{{ titre }}</h3>
              <p v-if="run" class="text-[10px] text-slate-400 font-mono truncate">{{ meta }}</p>
            </div>
          </div>
          <button
            title="Fermer"
            aria-label="Fermer"
            class="w-8 h-8 rounded-lg hover:bg-slate-100 text-slate-400 transition-colors flex items-center justify-center shrink-0"
            @click="m.closeTaskModal()"
          >
            <i class="ph ph-x text-lg"></i>
          </button>
        </div>

        <div class="flex-1 overflow-y-auto p-5 custom-scrollbar">
          <!-- ── Instructions données à l'agent : affichées d'emblée en
                       tête, rendues comme une réponse (markdown plein), filet
                       de séparation avant le déroulé. ── -->
          <div v-if="run && run.prompt" class="mb-4 pb-4 border-b border-slate-100" data-task-brief>
            <div class="text-xs font-semibold text-slate-500 mb-1.5">Instructions</div>
            <div class="markdown-body bg-transparent" v-html="m.renderMarkdown(run.prompt)"></div>
          </div>

          <!-- ── Résultat FINAL de l'agent, en ENTIER ────────────────
                       Placé AVANT le déroulé, à dessein : c'est la réponse, et
                       on ne devrait pas scroller 120 étapes pour l'atteindre.
                       Le déroulé reste dessous pour comprendre COMMENT elle a
                       été obtenue.

                       ⚠ ``run.result`` n'existe que pour les runs enregistrés à
                       partir du 2026-08-30 : sur un run antérieur le bloc reste
                       masqué et le déroulé (dont la coupe à 1500 c) fait foi,
                       comme avant. -->
          <div v-if="run && run.harness" class="mb-4 pb-4 border-b border-slate-100" data-task-harness>
            <div class="text-xs font-semibold text-slate-500 mb-1.5 flex items-center gap-1.5 flex-wrap">
              <i class="ph ph-list-checks text-slate-400" aria-hidden="true"></i> Bilan
              <span class="task-run-badge" :class="classeStatutTache(run.harness.status)">{{
                libelleStatutTache(run.harness.status)
              }}</span>
              <span class="font-mono font-normal"
                >{{ fmtAppelsTache(run.harness) }} appels · {{ fmtDureeTache(run.harness) }}</span
              >
            </div>
            <DetailsSousAgent :bilan="run.harness" />
          </div>

          <div v-if="run && run.result" class="mb-4 pb-4 border-b border-slate-100" data-task-result>
            <div class="text-xs font-semibold text-slate-500 mb-1.5 flex items-center gap-1.5">
              <i class="ph ph-flag-checkered text-slate-400"></i> Résultat
            </div>
            <div class="markdown-body bg-transparent" v-html="m.renderMarkdown(run.result)"></div>
          </div>

          <!-- ── Déroulé chronologique ── -->
          <template v-if="run && run.transcript && run.transcript.length">
            <div class="flex flex-col">
              <!-- AUDIT 2026-08-31 (passe 4, F9) — v-memo : la modale vit
                           dans le template RACINE, re-diffé à chaque flush de
                           stream (40-120 ms) + tick liveGen. Sans memo, ~1 200
                           vnodes de déroulé étaient re-diffés à chaque passe.
                           Deps : l'entrée (référence), son statut/texte (mutations
                           live) et l'état ouvert/fermé de SA carte détail. -->
              <!-- eslint-disable vue/no-useless-template-attributes -- v-memo d'un template v-for : porté par le fragment de chaque entrée (compilateur Vue), gain PERF.md. -->
              <template
                v-for="(en, ei) in run.transcript"
                :key="ei"
                v-memo="[en, en.status, en.text, m.taskModalStep === ei]"
              >
                <!-- Narration de l'agent : markdown atténué (journal de travail) -->
                <div
                  v-if="en.text"
                  class="markdown-body markdown-body--worklog bg-transparent my-1.5"
                  v-html="m.renderMarkdown(en.text)"
                ></div>

                <!-- Étape outil : ligne pill + carte détail (idiome chat principal) -->
                <div v-else>
                  <div class="flex items-baseline gap-2 flex-wrap">
                    <button
                      class="inline-flex items-center gap-1.5 group/toolbtn text-left"
                      @click="m.taskModalStep = m.taskModalStep === ei ? null : ei"
                    >
                      <i
                        v-if="en.status === 'running'"
                        class="ph ph-spinner-gap animate-spin text-blue-500"
                        style="font-size: 11px"
                      ></i>
                      <i
                        v-else-if="en.status === 'error'"
                        class="ph ph-x-circle text-red-500"
                        style="font-size: 11px"
                        aria-label="Erreur"
                      ></i>
                      <i v-else class="ph ph-check-circle text-slate-400/80" style="font-size: 11px"></i>
                      <span
                        class="font-mono text-[12.5px] font-semibold leading-snug"
                        :class="
                          en.status === 'error'
                            ? 'text-red-600 group-hover/toolbtn:text-red-700'
                            : en.status === 'running'
                              ? 'text-blue-600'
                              : 'text-slate-600 group-hover/toolbtn:text-blue-600'
                        "
                        style="transition: color 0.15s"
                        >{{ en.tool }}</span
                      >
                      <span
                        v-if="en.args_preview"
                        class="text-slate-400 text-[11px] font-normal font-mono truncate max-w-[280px]"
                        >{{ en.args_preview }}</span
                      >
                      <i
                        class="ph ph-caret-right text-slate-300 transition-transform"
                        style="font-size: 9px"
                        :class="m.taskModalStep === ei ? 'rotate-90' : ''"
                      ></i>
                    </button>
                  </div>

                  <!-- Carte détail Paramètres / Résultat (idiome carte outil) -->
                  <div
                    v-if="m.taskModalStep === ei"
                    class="mt-2 mb-1.5 rounded-xl border border-slate-200/80 bg-white/60 overflow-hidden text-[11px] shadow-sm"
                  >
                    <div class="flex items-center gap-2 px-3 py-2 border-b border-slate-100 bg-slate-50/80">
                      <i class="ph ph-terminal-window text-slate-400" style="font-size: 12px"></i>
                      <span class="font-mono font-semibold truncate text-slate-600">{{ en.tool }}</span>
                      <!-- Numéro d'APPEL : ne compte que les entrées outil (la
                                           narration intercalée ne décale pas la numérotation). -->
                      <span class="ml-auto text-[10px] text-slate-300 shrink-0"
                        >appel #{{ run.transcript.slice(0, ei + 1).filter((e) => e.tool).length }}</span
                      >
                      <button
                        class="text-slate-300 hover:text-slate-500 ml-1 transition-colors"
                        @click="m.taskModalStep = null"
                      >
                        <i class="ph ph-x" style="font-size: 10px"></i>
                      </button>
                    </div>
                    <div v-if="en.args_preview" class="px-3 py-2 border-b border-slate-100/80">
                      <div class="text-xs font-semibold text-slate-500 mb-1.5">Paramètres</div>
                      <div class="font-mono leading-relaxed text-slate-600 break-words whitespace-pre-wrap">
                        {{ en.args_preview }}
                      </div>
                    </div>
                    <div class="px-3 py-2">
                      <div class="text-xs font-semibold text-slate-500 mb-1.5">Résultat</div>
                      <div
                        v-if="en.status === 'running'"
                        class="text-slate-300 italic flex items-center gap-1"
                      >
                        <i class="ph ph-spinner-gap animate-spin text-xs"></i> en cours...
                      </div>
                      <div
                        v-else-if="en.result_preview"
                        class="font-mono leading-relaxed break-words whitespace-pre-wrap"
                        :class="en.status === 'error' ? 'text-red-600' : 'text-slate-600'"
                      >
                        {{ en.result_preview }}
                      </div>
                      <div v-else class="text-slate-300 italic">aperçu indisponible</div>
                    </div>
                  </div>
                </div>
              </template>
              <!-- eslint-enable vue/no-useless-template-attributes -->
            </div>
          </template>
          <!-- Run d'avant la fonctionnalité (ou aucune donnée encore) -->
          <p v-else class="text-[12.5px] text-slate-400 text-center py-8">
            Aucun déroulé disponible pour cet agent.
          </p>

          <!-- Activité en cours : l'agent travaille, la suite arrive en direct. -->
          <div
            v-if="run && run.state === 'running'"
            class="flex items-center gap-2 text-slate-400 text-[12px] select-none mt-2"
          >
            <i class="ph ph-spinner-gap animate-spin"></i>
            <span class="mem-wave">L'agent travaille…</span>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>
