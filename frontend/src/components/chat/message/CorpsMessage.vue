<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/message/CorpsMessage.vue — corps d'un message du fil : réflexion, travail, captures, sous-agents, effets, statut, contenu et pièces jointes, fichiers modifiés, pied, incidents. -->
<script setup lang="ts">
import { computed } from "vue";

import { CLE_FIL, domaine } from "../../../features/chat/page/domaines";
import { domaineRagOptionnel } from "../../../features/rag/domaine";

import ReflexionMessage from "./ReflexionMessage.vue";
import TravailAssistant from "./TravailAssistant.vue";
import ContenuMarkdown from "../ContenuMarkdown.vue";
import SousAgents from "../outils/SousAgents.vue";
import CapturesWeb from "./CapturesWeb.vue";
import EffetsMessage from "./EffetsMessage.vue";
import FichiersModifies from "./FichiersModifies.vue";
import ImageGrid from "../../images/ImageGrid.vue";
import ImageTile from "../../images/ImageTile.vue";
import PiedMessage from "./PiedMessage.vue";
import PiedSources from "../../rag/PiedSources.vue";

import type { EntreeMessage, FichierJoint } from "../../../features/chat/message/types";

const props = withDefaults(defineProps<{ entry: EntreeMessage; pied?: boolean; texte?: string }>(), {
  pied: true,
  texte: undefined,
});
const fil = domaine(CLE_FIL);
const rag = domaineRagOptionnel();
// Renvois [n] : seulement une réponse de l'assistant dans une conversation qui a affaire au RAG.
const renvois = computed(() =>
  props.entry.msg.role === "assistant" ? (rag?.sources.renvoisPour(props.entry.idx) ?? null) : null,
);
const emit = defineEmits<{ "zoom-image": [url: string] }>();

const phase = computed(() =>
  props.entry.msg.isStreaming && props.entry.idx === fil.lastAssistantIdx && !fil.compressionStatus
    ? fil.statusPhase(props.entry.msg)
    : null,
);

function cleFichier(f: string | FichierJoint, i: number): string {
  return ((typeof f === "string" ? "" : f.name) || "file") + ":" + i;
}

function masquerBouton(e: Event): void {
  const b = (e.target as Element).closest("button");
  if (b) b.hidden = true;
}
</script>

<template>
  <ReflexionMessage :entry="entry" />

  <TravailAssistant :entry="entry" />

  <CapturesWeb :entry="entry" />

  <SousAgents
    v-if="entry.msg.taskRuns && entry.msg.taskRuns.length"
    :runs="entry.msg.taskRuns"
    :logo-app="fil.logoApp"
    @deroule="fil.openTaskModal(entry, $event)"
    @arreter="fil.cancelTaskRun"
  ></SousAgents>

  <EffetsMessage :entry="entry" />

  <template v-if="phase">
    <div
      v-if="phase && !((phase.kind === 'tool' || phase.kind === 'rag') && fil.pipelineFor(entry.msg).show)"
      role="status"
      aria-live="polite"
      class="flex items-center gap-2 mb-2 select-none"
    >
      <span class="relative flex h-2 w-2 shrink-0">
        <span
          class="absolute inline-flex h-full w-full rounded-full opacity-60 animate-ping"
          :class="fil.statusDotClass(phase.kind)"
        ></span>
        <span
          class="relative inline-flex h-2 w-2 rounded-full"
          :class="fil.statusDotClass(phase.kind)"
        ></span>
      </span>
      <span class="text-[12.5px] font-medium truncate mem-wave">{{ phase.label }}</span>
    </div>
  </template>

  <div v-if="!entry.msg.isError">
    <div v-if="entry.msg.images && entry.msg.images.length > 0" class="mb-2.5">
      <div class="flex flex-wrap gap-2">
        <img
          v-for="(img, ii) in entry.msg.images"
          :key="img.dataUrl || 'img' + ii"
          :src="img.dataUrl"
          :alt="img.name"
          class="max-h-64 max-w-xs rounded-xl object-cover border border-slate-200 shadow-sm cursor-zoom-in hover:opacity-90 transition-opacity"
          @click="emit('zoom-image', img.dataUrl)"
        />
      </div>
    </div>
    <div v-if="entry.msg.files && entry.msg.files.length > 0" class="mb-2.5">
      <div class="flex flex-wrap gap-2">
        <template v-for="(f, fi) in entry.msg.files.slice(0, 6)" :key="cleFichier(f, fi)">
          <div
            class="file-chip w-20 h-24 bg-white border border-slate-200 shadow-sm overflow-hidden hover:border-slate-300 transition-colors flex flex-col"
          >
            <div class="flex-1 flex items-center justify-center pt-3">
              <i class="ph ph-file-text text-slate-400 text-2xl"></i>
            </div>
            <div class="px-2 pt-1.5">
              <span
                class="block text-[10px] font-medium text-slate-800 leading-tight truncate text-center"
                :title="typeof f === 'string' ? f : f.name"
                >{{ (typeof f === "string" ? f : f.name).replace(/\.[^.]+$/, "") }}</span
              >
            </div>
            <div class="flex items-center justify-between px-2 pb-1.5 pt-1">
              <span class="text-[10px] font-medium uppercase text-slate-500">{{
                (typeof f === "string" ? f : f.name).split(".").pop()
              }}</span>
              <span
                v-if="typeof f === 'object' && f.lines && f.lines <= 10000"
                class="text-[9px] text-slate-400 font-mono"
                >{{ f.lines }}L</span
              >
            </div>
          </div>
        </template>
        <div
          v-if="entry.msg.files.length > 6"
          class="w-20 h-24 bg-white border border-slate-200 rounded-md shadow-sm flex items-center justify-center"
        >
          <span class="text-xs font-bold text-slate-400">+{{ entry.msg.files.length - 6 }}</span>
        </div>
      </div>
    </div>
    <template v-if="entry.msg.role === 'assistant' && fil.isImageMessage(entry.msg)">
      <image-grid
        v-if="entry.msg.generated_images && entry.msg.generated_images.length"
        :items="entry.msg.generated_images"
        :prompt="fil.imagePromptFor(entry.idx)"
        :revised="entry.msg.revised_prompt || ''"
        :meta="entry.msg.image_meta || null"
        :reveal="entry.idx === fil.lastAssistantIdx"
        :variants="!fil.isStreaming"
        @variants="fil.imageVariants(entry.idx)"
      ></image-grid>
      <image-tile
        v-else-if="entry.msg.isStreaming"
        :progress="entry.msg._imageProgress"
        :stoppable="entry.idx === fil.lastAssistantIdx"
        @stop="fil.stopGeneration()"
      ></image-tile>
      <image-tile
        v-else-if="entry.msg.image_error"
        :error="entry.msg.image_error"
        :live="!!entry.msg._imageErrorLive"
        :dims="fil.imageReqDims(fil.imageRequestFor(entry.idx))"
        @retry="fil.retryGeneration(entry.idx)"
      ></image-tile>
      <ContenuMarkdown
        v-else
        :msg="{ content: entry.msg.content || '' }"
        @click-markdown="fil.handleMarkdownClick"
      ></ContenuMarkdown>
    </template>
    <ContenuMarkdown
      v-else
      :msg="entry.msg"
      :recherche="fil.messageSearchQ && fil.messageSearchActive ? fil.messageSearchQ : ''"
      :renvois="renvois"
      @click-markdown="fil.handleMarkdownClick"
    ></ContenuMarkdown>
    <div
      v-if="entry.msg.role === 'user' && entry.msg.image_request"
      class="elpis-img-reqline"
      data-image-request
    >
      <button
        v-if="entry.msg.image_request.ref_image_id"
        type="button"
        class="elpis-img-reqline__ref"
        title="Image modifiée"
        aria-label="Voir l’image modifiée"
        @click="
          fil.openImageViewer(
            [
              {
                id: entry.msg.image_request.ref_image_id,
                url: '/api/images/' + entry.msg.image_request.ref_image_id,
              },
            ],
            0,
            {},
          )
        "
      >
        <img
          :src="'/api/images/' + entry.msg.image_request.ref_image_id + '?thumb=1'"
          alt=""
          @error="masquerBouton"
        />
      </button>
      <i class="ph ph-image" aria-hidden="true"></i>
      <span>{{ fil.imageRequestLabel(entry.msg.image_request) }}</span>
    </div>
    <div v-if="entry.msg.role === 'assistant' && entry.msg._toolImageProgress" class="mt-3">
      <image-tile
        :progress="entry.msg._toolImageProgress"
        :stoppable="entry.idx === fil.lastAssistantIdx"
        @stop="fil.stopGeneration()"
      ></image-tile>
    </div>
    <div
      v-if="entry.msg.role === 'assistant' && entry.msg.tool_images && entry.msg.tool_images.length"
      class="mt-3"
    >
      <image-grid
        tool
        :items="entry.msg.tool_images"
        :reveal="entry.idx === fil.lastAssistantIdx"
      ></image-grid>
    </div>
  </div>

  <PiedSources v-if="rag && entry.msg.role === 'assistant' && entry.msg.rag_sources?.length" :entry="entry" />

  <FichiersModifies :entry="entry" />

  <PiedMessage v-if="pied" :entry="entry" :texte="texte" />

  <div
    v-if="entry.msg._journalTruncated && entry.msg.isStreaming"
    role="status"
    class="mt-2 flex items-start gap-1.5 text-[11.5px] text-slate-500"
    title="Le journal de cette génération est plein : une partie du direct n'a pas été conservée. La réponse complète s'affichera à la fin."
  >
    <i class="ph ph-info text-[13px] text-slate-400 shrink-0 mt-px" aria-hidden="true"></i>
    <span class="min-w-0">Direct incomplet : réponse complète à la fin</span>
  </div>

  <div
    v-if="!rag && entry.msg._ragSources && entry.msg._ragSources.length"
    class="mt-2 flex items-start gap-1.5 text-[11.5px] text-slate-500"
    :title="entry.msg._ragSources.join('\n')"
  >
    <i class="ph ph-books text-[13px] text-slate-400 shrink-0 mt-px" aria-hidden="true"></i>
    <span class="min-w-0 truncate">Sources : {{ entry.msg._ragSources.join(" · ") }}</span>
  </div>

  <div v-if="entry.msg.isTruncated && entry.idx === fil.lastAssistantIdx && !fil.isStreaming" class="mt-3">
    <div
      v-if="entry.msg.toolLoopTruncated"
      role="status"
      class="flex items-center gap-2.5 px-3 py-2 rounded-xl border border-slate-200 bg-slate-50"
    >
      <i class="ph ph-stack text-base text-slate-400 shrink-0" aria-hidden="true"></i>
      <span class="text-xs text-slate-600 font-medium flex-1 min-w-0"
        >{{ fil.toolLimitLabel(entry.msg.toolLoopStats)
        }}<span
          v-if="entry.msg.toolLoopStats && entry.msg.toolLoopStats.max_iterations"
          class="text-slate-500"
          title="Tours d'outils productifs consommés sur le budget (un tour = un appel au modèle)"
        >
          · {{ entry.msg.toolLoopStats.iterations }}/{{ entry.msg.toolLoopStats.max_iterations }} tours</span
        ><span
          v-if="entry.msg.toolLoopStats && entry.msg.toolLoopStats.tool_calls_done"
          class="text-slate-500"
          title="Appels d'outils exécutés — un tour peut en lancer plusieurs en parallèle"
        >
          · {{ entry.msg.toolLoopStats.tool_calls_done }} appels d'outils</span
        ></span
      >
      <button
        title="Reprendre l'exécution des outils là où elle s'est arrêtée (limite d'itérations atteinte)"
        aria-label="Reprendre l'exécution des outils (limite atteinte)"
        class="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-semibold shadow-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 shrink-0"
        @click="fil.continueGeneration()"
      >
        <i class="ph ph-arrow-right text-sm" aria-hidden="true"></i> Reprendre
      </button>
    </div>
    <div
      v-else
      role="status"
      class="flex items-center gap-2.5 px-3 py-2 rounded-xl border border-slate-200 bg-slate-50"
    >
      <i class="ph ph-dots-three-outline text-base text-slate-400 shrink-0" aria-hidden="true"></i>
      <span class="text-xs text-slate-600 font-medium flex-1 min-w-0">{{
        entry.msg.thinkingTruncated && !entry.msg.content ? "Réflexion interrompue" : "Réponse interrompue"
      }}</span>
      <button
        :title="
          entry.msg.thinkingTruncated && !entry.msg.content
            ? 'Reprendre : le modèle conclut à partir du raisonnement déjà produit (ne re-raisonne pas de zéro)'
            : 'Continuer la réponse interrompue : le modèle COMPLÈTE le texte existant (ne régénère pas)'
        "
        aria-label="Continuer la génération interrompue"
        class="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-semibold shadow-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 shrink-0"
        @click="fil.continueGeneration()"
      >
        <i class="ph ph-arrow-right text-sm" aria-hidden="true"></i> Continuer
      </button>
    </div>
  </div>

  <div v-if="entry.msg.isError" class="elpis-error-card rounded-xl p-4 mt-2 shadow-sm">
    <div class="elpis-error-title font-bold flex items-center gap-2 mb-2 text-sm">
      <i class="ph ph-warning-circle"></i> Erreur d'exécution
    </div>
    <div class="elpis-error-detail text-xs font-mono mb-3 p-2.5 rounded-lg">
      {{ entry.msg.errorMessage || "Erreur inconnue" }}
    </div>
    <button
      v-if="entry.msg.tool_history && entry.msg.tool_history.length"
      title="Reprendre après l'erreur en gardant les outils déjà exécutés (ne relance pas tout le tour)"
      aria-label="Reprendre : garde les outils déjà exécutés et poursuit"
      class="elpis-error-btn px-3 py-1.5 rounded-lg text-xs font-bold shadow-sm transition-colors flex items-center gap-1.5 w-max"
      @click="fil.resumeAfterError(entry.idx)"
    >
      <i class="ph ph-arrow-right"></i> Reprendre
    </button>
    <button
      v-else
      title="Régénérer la réponse après l'erreur : le message en erreur est remplacé"
      aria-label="Réessayer : régénérer la réponse après l'erreur"
      class="elpis-error-btn px-3 py-1.5 rounded-lg text-xs font-bold shadow-sm transition-colors flex items-center gap-1.5 w-max"
      @click="fil.retryGeneration(entry.idx)"
    >
      <i class="ph ph-arrow-clockwise"></i> Réessayer
    </button>
  </div>
</template>
