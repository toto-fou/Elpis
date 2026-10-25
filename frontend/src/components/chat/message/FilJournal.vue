<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/message/FilJournal.vue — déroulé « Journal » : une ligne par geste façon terminal (texte, outil et argument en police fixe, résultat en retrait sous ⎿, réflexion en ligne grise), dans l'ordre d'arrivée ; un clic sur un outil ouvre son détail. -->
<script setup lang="ts">
import { resumeCompression, utiliserTour } from "../../../features/chat/message/tour-affiche";
import type { EntreeMessage } from "../../../features/chat/message/types";
import { fmtDuree } from "../../../features/chat/outils/format";
import { dernieresLignes, resumeResultat } from "../../../features/chat/outils/sortie";
import type { EtapeOutil } from "../../../features/chat/outils/types";
import { libelleEtape } from "../../../features/chat/outils/verbes";

import ContenuMarkdown from "../ContenuMarkdown.vue";
import CarteOutil from "../outils/CarteOutil.vue";
import LigneJob from "../outils/LigneJob.vue";
import LignesAgents from "../outils/LignesAgents.vue";
import EffetMemoire from "./EffetMemoire.vue";

const props = defineProps<{ entry: EntreeMessage }>();
const {
  fil,
  maintenant,
  blocs,
  detail,
  lignesMemoire,
  dernier,
  vivant,
  visionneuse,
  voirCapture,
  reflexionOuverte,
  basculerReflexion,
  basculerDetail,
  agentsDe,
  jobDe,
  ouvrirJob,
  agentActif,
} = utiliserTour(() => props.entry);

/** « Verbe(objet) » : le geste et son argument, comme une commande. */
function geste(s: EtapeOutil): { verbe: string; objet: string } {
  const l = libelleEtape(s);
  return { verbe: l.verbe || l.outil, objet: l.objet };
}
function duree(s: EtapeOutil): string {
  if (s.status === "running")
    return typeof s.startedAt === "number" ? fmtDuree(maintenant.value - s.startedAt) : "";
  return typeof s.durationMs === "number" ? fmtDuree(s.durationMs) : "";
}
function puce(s: EtapeOutil): string {
  if (s.status === "running") return "text-blue-500 animate-pulse";
  if (s._is_error) return "text-red-500";
  if (s.status === "stopped") return "text-slate-400";
  return "text-emerald-600";
}
</script>

<template>
  <div v-if="blocs.length || vivant" class="mb-2 flex flex-col gap-1 elpis-journal" data-fil-journal>
    <template v-for="b in blocs" :key="b.cle">
      <div v-if="b.k === 'reflexion'" class="elpis-journal__ligne" data-reflexion>
        <span class="elpis-journal__puce text-slate-400" aria-hidden="true">✻</span>
        <div class="min-w-0">
          <button
            type="button"
            class="text-[12px] italic text-slate-400 hover:text-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded"
            :aria-expanded="reflexionOuverte(b.cle) ? 'true' : 'false'"
            @click="basculerReflexion(b.cle)"
          >
            {{ b.vivante ? "Réflexion…" : "Réflexion" + (b.ms ? " · " + fmtDuree(b.ms) : "") }}
          </button>
          <button
            v-if="b.vivante && dernier && entry.msg.isStreaming"
            type="button"
            class="ml-2 text-[11px] text-slate-400 hover:text-slate-700"
            @click="fil.respondNow(entry.idx)"
          >
            Répondre maintenant
          </button>
          <pre
            v-if="reflexionOuverte(b.cle)"
            class="mt-0.5 text-[11.5px] text-slate-500 leading-relaxed whitespace-pre-wrap break-words font-mono max-h-52 overflow-y-auto m-0 bg-transparent"
            >{{ b.texte }}</pre>
        </div>
      </div>

      <div v-else-if="b.k === 'texte'" class="elpis-journal__ligne mt-1">
        <span class="elpis-journal__puce text-slate-700" aria-hidden="true">●</span>
        <ContenuMarkdown
          class="min-w-0"
          :msg="{ content: b.texte }"
          data-texte-tour
          data-sans-graphiques
          @click-markdown="fil.handleMarkdownClick"
        ></ContenuMarkdown>
      </div>

      <template v-else-if="b.k === 'etapes'">
        <div
          v-for="e in b.etapes"
          :key="e.flat"
          class="flex flex-col"
          :data-etape="e.etape.callId || undefined"
        >
          <div class="elpis-journal__ligne">
            <span class="elpis-journal__puce" :class="puce(e.etape)" aria-hidden="true">●</span>
            <div class="min-w-0 flex items-baseline gap-2">
              <button
                type="button"
                class="min-w-0 truncate text-left font-mono text-[12px] text-slate-800 hover:text-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded"
                :title="e.etape.name"
                :aria-expanded="detail === e.flat ? 'true' : 'false'"
                data-geste
                @click="basculerDetail(e.flat)"
              >
                {{ geste(e.etape).verbe }}(<b class="font-semibold">{{ geste(e.etape).objet }}</b
                >)
              </button>
              <span class="shrink-0 text-[11px] text-slate-400 tabular-nums">{{ duree(e.etape) }}</span>
              <button
                v-if="visionneuse.parEtape.has(e.flat)"
                type="button"
                class="shrink-0 text-slate-400 hover:text-blue-600"
                :aria-label="'Voir la capture de l’étape ' + e.numero"
                title="Voir la capture"
                data-voir-capture
                @click="voirCapture(visionneuse.parEtape.get(e.flat)!)"
              >
                <i class="ph ph-camera text-[13px]" aria-hidden="true"></i>
              </button>
            </div>
          </div>
          <div
            v-if="e.etape.status === 'running'"
            class="elpis-journal__resultat text-slate-500"
            data-sortie-vivante
          >
            <div v-for="(l, li) in dernieresLignes(e.etape)" :key="li" class="truncate">{{ l }}</div>
          </div>
          <div
            v-else
            class="elpis-journal__resultat truncate"
            :class="e.etape._is_error ? 'text-red-600' : 'text-slate-500'"
            data-resultat
          >
            {{ resumeResultat(e.etape) }}
          </div>
          <CarteOutil
            v-if="detail === e.flat"
            :step="e.etape"
            :numero="e.numero"
            :compact-ouvert="!!entry.msg._compactOpen"
            @fermer="basculerDetail(e.flat)"
            @compact="(o: boolean) => fil.setMsgUi(entry, { _compactOpen: o })"
          />
        </div>
      </template>

      <LignesAgents
        v-else-if="b.k === 'agents'"
        :agents="agentsDe(b)"
        :maintenant="maintenant"
        :actif="agentActif"
        @ouvrir="(ri: number) => fil.openTaskModal(entry, ri)"
      />
      <LigneJob v-else-if="b.k === 'job'" :etape="b.etape" :job="jobDe(b)" @ouvrir="ouvrirJob(b)" />
      <div v-else-if="b.k === 'memoire' && lignesMemoire[b.rang]" class="elpis-effects" data-effects>
        <EffetMemoire :line="lignesMemoire[b.rang]!" />
      </div>
      <div
        v-else-if="b.k === 'compression'"
        class="elpis-journal__ligne"
        :data-etape="b.etape.callId || undefined"
      >
        <span class="elpis-journal__puce text-slate-400" aria-hidden="true">●</span>
        <span class="font-mono text-[12px] text-slate-600"
          >Compression · <span class="text-slate-500">{{ resumeCompression(b.etape) }}</span></span
        >
      </div>
    </template>
    <div v-if="vivant" class="elpis-journal__ligne mt-1">
      <span class="elpis-journal__puce text-slate-700" aria-hidden="true">●</span>
      <ContenuMarkdown
        class="min-w-0"
        :msg="vivant"
        data-texte-vivant
        data-sans-graphiques
        @click-markdown="fil.handleMarkdownClick"
      ></ContenuMarkdown>
    </div>
  </div>
</template>
