<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/modales/ModaleAgent.vue — fenêtre d'un sous-agent, large et centrée : nom, état, horloge, jetons consommés, Arrêter ; la consigne reçue, puis son bilan (statut, appels, reste à faire) et « Rendu à l'assistant » une fois fini, enfin sa chronologie dans la grammaire du fil. -->
<script setup lang="ts">
import { restaurerMarqueursTour } from "@elpis/commun/marqueurs-tour";
import { computed, inject, nextTick, onUnmounted, reactive, ref, useTemplateRef, watch } from "vue";

import { domaineModales } from "../../../features/chat/modales/domaine";
import {
  avecJobFond,
  bilanCourtAgent,
  chronologieAgent,
  jetonsAgent,
} from "../../../features/chat/outils/agents";
import {
  classeStatutTache,
  classeVerdictTache,
  fmtAppelsTache,
  fmtDureeTache,
  libelleEtatRun,
  libelleReserve,
  libelleStatutTache,
  libelleVerdictTache,
  statutReserve,
} from "../../../features/chat/outils/bilan-tache";
import { fmtDuree } from "../../../features/chat/outils/format";
import type { ExecutionSousAgent } from "../../../features/chat/outils/types";
import { CLE_FIL, CLE_PAGE } from "../../../features/chat/page/domaines";
import DetailsSousAgent from "../outils/DetailsSousAgent.vue";
import LigneEtapes from "../outils/LigneEtapes.vue";

const m = domaineModales();
const fil = inject(CLE_FIL, null);

// Run relu à chaque patch du message : la fenêtre suit le direct.
const page = inject(CLE_PAGE, null);
// Agent en fond : son état suit son job une fois le tour fini.
const run = computed<ExecutionSousAgent | null>(() => {
  const r = m.taskModalRun();
  return r ? avecJobFond(r, page?.jobsChat ?? []) : null;
});
const blocs = computed(() => (run.value ? chronologieAgent(run.value) : []));
const ouverts = reactive<Record<string, boolean>>({});
const detail = ref<number | null>(null);
const titre = useTemplateRef<HTMLElement>("titre");
let retour: HTMLElement | null = null;

const maintenant = ref(Date.now());
let minuterie: ReturnType<typeof globalThis.setInterval> | null = null;
watch(
  () => run.value?.state === "running",
  (vivant) => {
    if (minuterie) globalThis.clearInterval(minuterie);
    minuterie = vivant ? globalThis.setInterval(() => (maintenant.value = Date.now()), 1000) : null;
  },
  { immediate: true },
);
onUnmounted(() => {
  if (minuterie) globalThis.clearInterval(minuterie);
});

// Ouverture (ou autre agent) : la fenêtre repart repliée, le focus va au titre et reviendra à la ligne cliquée.
watch(
  () => m.taskModal,
  (tm, avant) => {
    if (!tm) return;
    for (const k of Object.keys(ouverts)) delete ouverts[k];
    detail.value = null;
    if (!avant)
      retour =
        globalThis.document.activeElement instanceof HTMLElement ? globalThis.document.activeElement : null;
    void nextTick(() => titre.value?.focus());
  },
);

const horloge = computed(() => {
  const r = run.value;
  if (!r) return "";
  if (r.state === "running")
    return typeof r.startedAt === "number" ? fmtDuree(maintenant.value - r.startedAt) : "";
  return typeof r.duration_ms === "number" && r.duration_ms > 0 ? fmtDuree(r.duration_ms) : "";
});
const etat = computed(() => {
  const r = run.value;
  if (!r) return "";
  if (r.state === "running") return r.id ? (r.background ? "en cours, en fond" : "en cours") : "en attente";
  const reserve = statutReserve(r);
  if (reserve !== null) return libelleReserve(reserve);
  return r.state === "completed" ? "fini" : libelleEtatRun(r.state);
});
const jetons = computed(() => (run.value ? jetonsAgent(run.value) : null));
const infobulle = computed(() => {
  const r = run.value;
  return r ? [bilanCourtAgent(r), jetons.value?.detail ?? ""].filter(Boolean).join("\n") : "";
});

function fermer(): void {
  m.closeTaskModal();
  const cible = retour;
  retour = null;
  if (cible?.isConnected) cible.focus();
}

function arreter(): void {
  if (run.value) void fil?.cancelTaskRun(run.value);
}

async function copierRendu(): Promise<void> {
  const t = restaurerMarqueursTour(run.value?.result || "");
  if (!t) return;
  try {
    await globalThis.navigator.clipboard.writeText(t);
    fil?.showToast("Copié");
  } catch {
    fil?.showToast("Copie impossible", "error");
  }
}
</script>

<!-- eslint-disable vue/no-v-html -- HTML produit par le moteur Markdown : purifié (crochet de marked) ou échappé. -->
<template>
  <Transition name="modal">
    <div
      v-if="run"
      data-a11y-modal
      role="dialog"
      aria-modal="true"
      :aria-label="'Agent ' + (run.agent || '')"
      class="fixed inset-0 z-[6000] flex items-center justify-center bg-slate-900/80 p-4"
      data-modale-agent
      data-sans-graphiques
      @click.self="fermer"
      @keydown.esc.stop="fermer"
    >
      <div
        class="bg-white rounded-2xl shadow-2xl ring-1 ring-slate-200 w-full max-w-4xl overflow-hidden flex flex-col h-[85vh]"
      >
        <div class="px-5 py-4 border-b border-slate-100 flex items-center gap-2.5 shrink-0">
          <i class="ph ph-robot text-[20px] text-slate-500 shrink-0" aria-hidden="true"></i>
          <div class="flex-1 min-w-0">
            <h3 ref="titre" tabindex="-1" class="truncate text-sm font-bold text-slate-800 outline-none">
              Agent {{ run.agent || "" }}<template v-if="run.label"> — {{ run.label }}</template>
            </h3>
            <p
              class="flex items-center gap-1 text-[12px] text-slate-500 tabular-nums truncate"
              :title="infobulle || undefined"
              data-etat-agent
            >
              <i
                v-if="run.state === 'running'"
                class="ph ph-spinner-gap animate-spin text-blue-500"
                aria-hidden="true"
              ></i>
              <i
                v-else-if="run.state === 'completed'"
                class="ph"
                :class="
                  statutReserve(run) === null
                    ? 'ph-check text-emerald-600'
                    : 'ph-warning-circle text-amber-600'
                "
                aria-hidden="true"
              ></i>
              {{ etat }}<template v-if="horloge"> · {{ horloge }}</template
              ><template v-if="jetons?.conso"> · {{ jetons.conso }}</template>
            </p>
          </div>
          <button
            v-if="run.state === 'running' && !run.cancelRequested"
            type="button"
            class="shrink-0 min-h-7 inline-flex items-center gap-1 px-2.5 rounded-lg border border-slate-200 text-xs font-semibold text-slate-700 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            :title="run.id ? 'Arrêter cet agent (la génération continue)' : 'Annuler cet agent en attente'"
            data-arreter-agent
            @click="arreter"
          >
            <i class="ph ph-stop text-[12px]" aria-hidden="true"></i> Arrêter
          </button>
          <button
            type="button"
            class="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            aria-label="Fermer"
            title="Fermer"
            @click="fermer"
          >
            <i class="ph ph-x text-lg" aria-hidden="true"></i>
          </button>
        </div>

        <div class="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-5 flex flex-col gap-4">
          <section v-if="run.prompt" class="pb-4 border-b border-slate-100" data-consigne-agent>
            <div class="text-xs font-semibold text-slate-500 mb-1.5">Consigne reçue</div>
            <div class="markdown-body bg-transparent" v-html="m.renderMarkdown(run.prompt)"></div>
          </section>

          <section v-if="run.harness" class="pb-4 border-b border-slate-100" data-task-harness>
            <div class="flex items-center gap-2 flex-wrap mb-1.5 text-xs">
              <span class="font-semibold text-slate-500">Bilan</span>
              <span class="task-run-badge" :class="classeStatutTache(run.harness.status)">{{
                libelleStatutTache(run.harness.status)
              }}</span>
              <span
                v-if="run.harness.verdict"
                class="task-run-badge"
                :class="classeVerdictTache(run.harness.verdict)"
                data-task-verdict
                >{{ libelleVerdictTache(run.harness.verdict) }}</span
              >
              <span class="font-mono text-slate-500"
                >{{ fmtAppelsTache(run.harness) }} appels · {{ fmtDureeTache(run.harness) }}</span
              >
            </div>
            <DetailsSousAgent :bilan="run.harness" />
          </section>

          <section
            v-if="run.state !== 'running' && run.result"
            class="pb-4 border-b border-slate-100"
            data-rendu-agent
          >
            <div class="flex items-center gap-2 mb-1.5">
              <span class="flex-1 text-xs font-semibold text-slate-500">Rendu à l'assistant</span>
              <button
                type="button"
                class="min-h-6 px-2 rounded-md text-xs text-slate-500 hover:text-slate-700 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                @click="copierRendu"
              >
                Copier
              </button>
            </div>
            <div class="markdown-body bg-transparent" v-html="m.renderMarkdown(run.result)"></div>
          </section>

          <section class="flex flex-col" data-deroule-agent>
            <div class="text-xs font-semibold text-slate-500 mb-1.5">Déroulé</div>
            <template v-for="b in blocs" :key="b.cle">
              <div
                v-if="b.k === 'texte'"
                class="markdown-body markdown-body--worklog bg-transparent mb-1.5"
                v-html="m.renderMarkdown(b.texte)"
              ></div>
              <div
                v-else-if="b.k === 'parent'"
                class="mb-1.5 pl-3 border-l-2 border-blue-200"
                data-message-parent
              >
                <div class="text-xs font-semibold text-slate-500 mb-0.5">Message de l'assistant</div>
                <div class="markdown-body bg-transparent" v-html="m.renderMarkdown(b.texte)"></div>
              </div>
              <LigneEtapes
                v-else
                :etapes="b.etapes"
                :ouvert="!!ouverts[b.cle]"
                :detail="detail"
                :maintenant="maintenant"
                :compact-ouvert="false"
                @basculer="ouverts[b.cle] = !ouverts[b.cle]"
                @detail="(f: number) => (detail = detail === f ? null : f)"
              />
            </template>
            <p v-if="!blocs.length" class="text-[12.5px] text-slate-500 py-4 text-center">
              {{ run.state === "running" ? "Pas encore d'étape" : "Aucun déroulé enregistré" }}
            </p>
          </section>
        </div>
      </div>
    </div>
  </Transition>
</template>
