<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/modales/VoletAgent.vue — volet non modal d'un sous-agent, à droite du fil : nom, état, horloge, Arrêter ; dans l'ordre réel, la consigne reçue, sa chronologie dans la grammaire du fil, puis « Rendu à l'assistant » une fois fini. -->
<script setup lang="ts">
import { computed, inject, nextTick, onUnmounted, reactive, ref, useTemplateRef, watch } from "vue";

import { domaineModales } from "../../../features/chat/modales/domaine";
import { bilanCourtAgent, chronologieAgent } from "../../../features/chat/outils/agents";
import { libelleEtatRun } from "../../../features/chat/outils/bilan-tache";
import { fmtDuree } from "../../../features/chat/outils/format";
import type { ExecutionSousAgent } from "../../../features/chat/outils/types";
import { CLE_FIL } from "../../../features/chat/page/domaines";
import { interfaceApp } from "../../../features/reglages/interface";
import { fmtTokenCount } from "../../../utils/utils-purs";
import LigneEtapes from "../outils/LigneEtapes.vue";

const m = domaineModales();
const fil = inject(CLE_FIL, null);
const ui = interfaceApp();

// Run relu à chaque patch du message : le volet suit le direct.
const run = computed<ExecutionSousAgent | null>(() => (ui.classique ? null : m.taskModalRun()));
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

// Ouverture (ou autre agent) : le volet repart replié, le focus va au titre et reviendra à la ligne cliquée.
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
  if (r.state === "running") return r.id ? "en cours" : "en attente";
  return r.state === "completed" ? "fini" : libelleEtatRun(r.state);
});
const infobulle = computed(() => {
  const r = run.value;
  if (!r) return "";
  const t = typeof r.tokens === "number" && r.tokens > 0 ? fmtTokenCount(r.tokens) + " jetons" : "";
  return [bilanCourtAgent(r), t].filter(Boolean).join(" · ");
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
  const t = run.value?.result || "";
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
  <aside
    v-if="run"
    class="h-full w-[min(380px,100%)] shrink-0 flex flex-col bg-white border-l border-slate-200 z-20 max-lg:fixed max-lg:inset-y-0 max-lg:right-0 max-lg:shadow-xl"
    role="complementary"
    :aria-label="'Agent ' + (run.agent || '')"
    data-volet-agent
    @keydown.esc.stop="fermer"
  >
    <div class="h-14 flex items-center gap-2 px-3 border-b border-slate-200 shrink-0">
      <i class="ph ph-robot text-[16px] text-slate-500 shrink-0" aria-hidden="true"></i>
      <h3
        ref="titre"
        tabindex="-1"
        class="flex-1 min-w-0 truncate text-sm font-semibold text-slate-800 outline-none"
      >
        Agent {{ run.agent || "" }}
      </h3>
      <span
        class="shrink-0 inline-flex items-center gap-1 text-[12px] text-slate-600 tabular-nums"
        :title="infobulle || undefined"
        data-etat-agent
      >
        <i
          v-if="run.state === 'running'"
          class="ph ph-spinner-gap animate-spin text-blue-500"
          aria-hidden="true"
        ></i>
        <i v-else-if="run.state === 'completed'" class="ph ph-check text-emerald-600" aria-hidden="true"></i>
        {{ etat }}<template v-if="horloge"> · {{ horloge }}</template>
      </span>
      <button
        v-if="run.state === 'running' && !run.cancelRequested"
        type="button"
        class="shrink-0 min-h-6 inline-flex items-center gap-1 px-2 rounded-lg border border-slate-200 text-xs font-semibold text-slate-700 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        :title="run.id ? 'Arrêter cet agent (la génération continue)' : 'Annuler cet agent en attente'"
        data-arreter-agent
        @click="arreter"
      >
        <i class="ph ph-stop text-[12px]" aria-hidden="true"></i> Arrêter
      </button>
      <button
        type="button"
        class="shrink-0 w-7 h-7 flex items-center justify-center rounded-md text-slate-400 hover:text-slate-700 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        aria-label="Fermer le volet"
        title="Fermer"
        @click="fermer"
      >
        <i class="ph ph-x text-base" aria-hidden="true"></i>
      </button>
    </div>

    <div class="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-3 py-3 flex flex-col gap-2">
      <div
        v-if="run.prompt"
        class="self-end max-w-[90%] rounded-2xl bg-slate-100 px-3 py-2"
        data-consigne-agent
      >
        <div class="text-[11.5px] text-slate-500 mb-0.5">Consigne reçue</div>
        <div class="markdown-body bg-transparent text-[13px]" v-html="m.renderMarkdown(run.prompt)"></div>
      </div>

      <div class="flex flex-col">
        <template v-for="b in blocs" :key="b.cle">
          <div
            v-if="b.k === 'texte'"
            class="markdown-body bg-transparent text-[13px] mb-1.5"
            v-html="m.renderMarkdown(b.texte)"
          ></div>
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
        <p
          v-if="!blocs.length && run.state !== 'running'"
          class="text-[12.5px] text-slate-500 py-4 text-center"
        >
          Aucun déroulé enregistré
        </p>
      </div>

      <div
        v-if="run.state !== 'running' && run.result"
        class="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2"
        data-rendu-agent
      >
        <div class="flex items-center gap-2 mb-1">
          <span class="flex-1 text-xs font-semibold text-slate-700">Rendu à l'assistant</span>
          <button
            type="button"
            class="min-h-6 px-2 rounded-md text-xs text-slate-500 hover:text-slate-700 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            @click="copierRendu"
          >
            Copier
          </button>
        </div>
        <div class="markdown-body bg-transparent text-[13px]" v-html="m.renderMarkdown(run.result)"></div>
      </div>
    </div>
  </aside>
</template>
