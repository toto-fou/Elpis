<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/message/FilTour.vue — le tour d'un message assistant en une liste chronologique : réflexions, textes à leur place, étapes groupées en ligne riche (et leurs captures, aperçu en direct pendant la navigation, graphique que la réponse oublie de citer), sous-agents, tâches de fond, mémoire, compression, puis le texte qui s'écrit. -->
<script setup lang="ts">
import { computed } from "vue";

import type { EntreeMessage } from "../../../features/chat/message/types";
import { resumeCompression, utiliserTour } from "../../../features/chat/message/tour-affiche";

import ContenuMarkdown from "../ContenuMarkdown.vue";
import CarteOutil from "../outils/CarteOutil.vue";
import LigneEtapes from "../outils/LigneEtapes.vue";
import LigneJob from "../outils/LigneJob.vue";
import LignesAgents from "../outils/LignesAgents.vue";
import EffetMemoire from "./EffetMemoire.vue";
import LigneReflexion from "./LigneReflexion.vue";

const props = defineProps<{ entry: EntreeMessage }>();
const {
  fil,
  maintenant,
  blocs,
  ouverts,
  detail,
  lignesMemoire,
  dernier,
  vivant,
  visionneuse,
  apercu,
  voirCapture,
  basculer,
  reflexionOuverte,
  basculerReflexion,
  basculerDetail,
  agentsDe,
  jobDe,
  ouvrirJob,
  agentActif,
} = utiliserTour(() => props.entry);

// Un nouvel appel du modèle (sa réflexion, ou son texte s'il n'en a pas) se détache du précédent ; dans un appel, tout se suit.
function nouvelAppel(i: number): boolean {
  const b = blocs.value[i];
  const avant = blocs.value[i - 1];
  return !!b && !!avant && (b.k === "reflexion" || (b.k === "texte" && avant.k !== "reflexion"));
}
// Ce qui suit le fil (texte vivant, réponse) : collé à la réflexion de son appel, détaché d'un appel précédent.
const suiteDetachee = computed(() => {
  const d = blocs.value[blocs.value.length - 1];
  return !!d && d.k !== "reflexion";
});
</script>

<template>
  <div
    v-if="blocs.length || vivant"
    class="flex flex-col"
    :class="!vivant && suiteDetachee ? 'mb-3' : ''"
    data-fil-tour
  >
    <template v-for="(b, i) in blocs" :key="b.cle">
      <ContenuMarkdown
        v-if="b.k === 'texte'"
        class="mb-1"
        :class="nouvelAppel(i) ? 'mt-3' : ''"
        :msg="{ content: b.texte }"
        data-texte-tour
        data-sans-graphiques
        @click-markdown="fil.handleMarkdownClick"
      ></ContenuMarkdown>
      <LigneReflexion
        v-else-if="b.k === 'reflexion'"
        :class="nouvelAppel(i) ? 'mt-3' : ''"
        :texte="b.texte"
        :ms="b.ms"
        :vivante="b.vivante"
        :ouvert="reflexionOuverte(b.cle)"
        :verrouillee="false"
        :repondre="b.vivante && dernier && !!entry.msg.isStreaming"
        @basculer="basculerReflexion(b.cle)"
        @repondre="fil.respondNow(entry.idx)"
      />
      <template v-else-if="b.k === 'etapes'">
        <LigneEtapes
          :etapes="b.etapes"
          :ouvert="!!ouverts[b.cle]"
          :detail="detail"
          :maintenant="maintenant"
          :compact-ouvert="!!entry.msg._compactOpen"
          :captures="visionneuse.parEtape"
          @basculer="basculer(b.cle)"
          @detail="basculerDetail"
          @compact="(o: boolean) => fil.setMsgUi(entry, { _compactOpen: o })"
          @capture="voirCapture"
        />
        <div v-if="apercu && apercu.cle === b.cle" class="pl-6 mb-1.5" data-apercu-direct>
          <div
            class="elpis-on-media elpis-media-canvas relative rounded-xl overflow-hidden ring-1 ring-slate-900/5"
            style="width: 260px; max-width: 100%; aspect-ratio: 16 / 10"
            role="img"
            aria-label="Aperçu du navigateur en direct"
          >
            <img
              v-if="apercu.url"
              :src="apercu.url"
              alt=""
              class="absolute inset-0 w-full h-full object-cover object-top"
            />
            <span
              class="absolute top-1.5 right-1.5 flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-black/40 text-[10px] text-white/90"
            >
              <span class="relative flex h-1.5 w-1.5 shrink-0">
                <span
                  class="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-300 opacity-75"
                ></span>
                <span class="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-400"></span>
              </span>
              En direct
            </span>
            <div
              v-if="apercu.attente"
              class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/90 shadow-lg border border-white/50"
            >
              <i class="ph ph-spinner-gap animate-spin text-blue-500" style="font-size: 10px"></i>
              <span class="text-[10px] font-medium text-slate-700">capture...</span>
            </div>
          </div>
        </div>
      </template>
      <LignesAgents
        v-else-if="b.k === 'agents'"
        :agents="agentsDe(b)"
        :maintenant="maintenant"
        :actif="agentActif"
        @ouvrir="(ri: number) => fil.openTaskModal(entry, ri)"
      />
      <div v-else-if="b.k === 'job'" class="mb-1">
        <LigneJob :etape="b.etape" :job="jobDe(b)" @ouvrir="ouvrirJob(b)" />
        <CarteOutil
          v-if="detail === b.flat"
          :step="b.etape"
          :numero="0"
          :compact-ouvert="!!entry.msg._compactOpen"
          @fermer="basculerDetail(b.flat)"
          @compact="(o: boolean) => fil.setMsgUi(entry, { _compactOpen: o })"
        />
      </div>
      <div v-else-if="b.k === 'memoire' && lignesMemoire[b.rang]" class="elpis-effects mb-1" data-effects>
        <EffetMemoire :line="lignesMemoire[b.rang]!" />
      </div>
      <div v-else-if="b.k === 'compression'" class="mb-1" :data-etape="b.etape.callId || undefined">
        <button
          type="button"
          class="w-full flex items-center gap-2 px-1.5 py-1 -mx-1.5 rounded-md text-left text-[13px] text-slate-600 hover:bg-slate-100 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          :aria-expanded="detail === b.flat ? 'true' : 'false'"
          data-ligne-compression
          @click="basculerDetail(b.flat)"
        >
          <i
            class="ph shrink-0 text-[14px]"
            :class="
              b.etape.status === 'running'
                ? 'ph-arrows-in-simple animate-pulse text-blue-500'
                : 'ph-arrows-in-simple text-slate-400'
            "
            aria-hidden="true"
          ></i>
          <span class="flex-1 min-w-0 truncate">Compression du contexte</span>
          <span class="shrink-0 text-[12px] text-slate-500 tabular-nums">{{
            resumeCompression(b.etape)
          }}</span>
        </button>
        <CarteOutil
          v-if="detail === b.flat"
          :step="b.etape"
          :numero="0"
          :compact-ouvert="!!entry.msg._compactOpen"
          @fermer="basculerDetail(b.flat)"
          @compact="(o: boolean) => fil.setMsgUi(entry, { _compactOpen: o })"
        />
      </div>
    </template>
    <ContenuMarkdown
      v-if="vivant"
      class="mb-1"
      :class="suiteDetachee ? 'mt-3' : ''"
      :msg="vivant"
      data-texte-vivant
      data-sans-graphiques
      @click-markdown="fil.handleMarkdownClick"
    ></ContenuMarkdown>
  </div>
</template>
