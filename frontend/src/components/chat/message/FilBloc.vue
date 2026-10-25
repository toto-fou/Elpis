<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/message/FilBloc.vue — déroulé « En bloc » : le travail du tour sous une ligne d'en-tête (étape en cours, puis bilan), ouvert pendant le tour et replié ensuite ; chaque appel en une phrase, sa réflexion derrière un cerveau, ses outils en pastilles. -->
<script setup lang="ts">
import { computed } from "vue";

import { appelsDuTour } from "../../../features/chat/message/appels";
import type { EtapeNumerotee } from "../../../features/chat/message/chronologie";
import { resumeCompression, utiliserTour } from "../../../features/chat/message/tour-affiche";
import type { EntreeMessage } from "../../../features/chat/message/types";
import { fmtDuree } from "../../../features/chat/outils/format";
import { dernieresLignes } from "../../../features/chat/outils/sortie";
import type { EtapeOutil } from "../../../features/chat/outils/types";
import { libelleEtape } from "../../../features/chat/outils/verbes";

import ContenuMarkdown from "../ContenuMarkdown.vue";
import CarteOutil from "../outils/CarteOutil.vue";
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
  graphiques,
  apercu,
  voirCapture,
  reflexionOuverte,
  basculerReflexion,
  basculerDetail,
  agentsDe,
  jobDe,
  ouvrirJob,
  agentActif,
} = utiliserTour(() => props.entry);

const appels = computed(() => appelsDuTour(blocs.value));
const etapes = computed(() => blocs.value.flatMap((b) => (b.k === "etapes" ? b.etapes : [])));
const enCours = computed(() => !!props.entry.msg.isStreaming && dernier.value);
// Un tour sans texte ni action (réponse simple) garde ses seules réflexions, sans bloc.
const avecTravail = computed(() => appels.value.some((a) => a.texte || a.actions.length) || !!vivant.value);
// Ouvert pendant le tour, replié ensuite ; un clic l'inverse.
const ouvert = computed(() => {
  const o = ouverts.value["bloc"];
  return o === undefined ? enCours.value : !!o;
});
function basculerBloc(): void {
  fil.setMsgUi(props.entry, { _filOuverts: { ...ouverts.value, bloc: !ouvert.value } });
}

const vivante = computed(() => [...etapes.value].reverse().find((e) => e.etape.status === "running") ?? null);
const echecs = computed(() => etapes.value.filter((e) => e.etape._is_error).length);
const pluriel = (n: number, mot: string): string => `${n} ${mot}${n > 1 ? "s" : ""}`;

function texte(s: EtapeOutil): string {
  const l = libelleEtape(s);
  return [l.verbe ?? l.outil, l.objet].filter(Boolean).join(" ");
}
function duree(s: EtapeOutil): string {
  if (s.status === "running")
    return typeof s.startedAt === "number" ? fmtDuree(maintenant.value - s.startedAt) : "";
  return typeof s.durationMs === "number" ? fmtDuree(s.durationMs) : "";
}

const titre = computed(() => {
  const v = vivante.value;
  if (enCours.value && v) return `Étape ${v.numero} · ${texte(v.etape)}`;
  if (enCours.value) return vivant.value ? "Écrit" : "Travaille";
  const parts = [`Travail · ${pluriel(etapes.value.length, "étape")}`];
  if (echecs.value) parts.push(pluriel(echecs.value, "échec"));
  return parts.join(" · ");
});
const dureeTitre = computed(() => {
  const v = vivante.value;
  if (enCours.value && v) return duree(v.etape);
  const ms = etapes.value.reduce((a, e) => a + (e.etape.durationMs ?? 0), 0);
  return ms > 0 ? fmtDuree(ms) : "";
});

function classePastille(s: EtapeOutil): string {
  if (s.status === "running") return "border-blue-200 bg-blue-50 text-blue-700";
  if (s._is_error) return "border-red-200 bg-red-50 text-red-700";
  return "border-slate-200 bg-slate-50 text-slate-700 hover:border-slate-300";
}
function iconePastille(s: EtapeOutil): string {
  if (s.status === "running") return "ph-spinner-gap animate-spin";
  if (s._is_error) return "ph-x";
  if (s.status === "stopped") return "ph-stop-circle text-slate-400";
  return "ph-check text-emerald-600";
}
const etapeDetail = (liste: readonly EtapeNumerotee[]): EtapeNumerotee | null =>
  liste.find((e) => e.flat === detail.value) ?? null;
</script>

<template>
  <template v-if="!avecTravail">
    <template v-for="a in appels" :key="a.cle">
      <LigneReflexion
        v-if="a.reflexion"
        :texte="a.reflexion.texte"
        :ms="a.reflexion.ms"
        :vivante="a.reflexion.vivante"
        :ouvert="reflexionOuverte(a.reflexion.cle)"
        :verrouillee="false"
        :repondre="a.reflexion.vivante && dernier && !!entry.msg.isStreaming"
        @basculer="basculerReflexion(a.reflexion.cle)"
        @repondre="fil.respondNow(entry.idx)"
      />
    </template>
  </template>
  <div v-else class="mb-3 elpis-bloc-travail" data-fil-bloc>
    <button
      type="button"
      class="w-full flex items-center gap-2 px-1.5 py-1 -mx-1.5 rounded-md text-left text-[13px] text-slate-600 hover:bg-slate-100 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
      :aria-expanded="ouvert ? 'true' : 'false'"
      data-tete-bloc
      @click="basculerBloc"
    >
      <i
        class="ph shrink-0 text-[15px]"
        :class="
          enCours
            ? 'ph-spinner-gap animate-spin text-blue-500'
            : echecs
              ? 'ph-warning-circle text-amber-600'
              : 'ph-check-circle text-emerald-600'
        "
        aria-hidden="true"
      ></i>
      <span class="flex-1 min-w-0 truncate" :aria-live="enCours ? 'polite' : undefined">{{ titre }}</span>
      <span class="shrink-0 text-[12px] text-slate-500 tabular-nums">{{ dureeTitre }}</span>
      <i
        class="ph ph-caret-down shrink-0 text-[11px] text-slate-400 transition-transform"
        :class="ouvert ? 'rotate-180' : ''"
        aria-hidden="true"
      ></i>
    </button>

    <div
      v-if="ouvert"
      class="mt-1 ml-1.5 pl-3.5 border-l-2 border-slate-200 flex flex-col gap-2.5"
      data-corps-bloc
    >
      <div v-for="a in appels" :key="a.cle" class="flex flex-col gap-1" data-appel>
        <div v-if="a.texte" class="flex items-start gap-1.5">
          <button
            v-if="a.reflexion"
            type="button"
            class="mt-0.5 shrink-0 rounded p-0.5 text-slate-400 hover:text-blue-600 hover:bg-slate-100 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            :title="'Réflexion' + (a.reflexion.ms ? ' · ' + fmtDuree(a.reflexion.ms) : '')"
            :aria-label="'Voir la réflexion de cet appel'"
            :aria-expanded="reflexionOuverte(a.reflexion.cle) ? 'true' : 'false'"
            data-cerveau
            @click="basculerReflexion(a.reflexion.cle)"
          >
            <i class="ph ph-brain block text-[14px] leading-none" aria-hidden="true"></i>
          </button>
          <ContenuMarkdown
            class="flex-1 min-w-0"
            :msg="{ content: a.texte.texte }"
            data-texte-tour
            @click-markdown="fil.handleMarkdownClick"
          ></ContenuMarkdown>
        </div>
        <LigneReflexion
          v-else-if="a.reflexion"
          :texte="a.reflexion.texte"
          :ms="a.reflexion.ms"
          :vivante="a.reflexion.vivante"
          :ouvert="reflexionOuverte(a.reflexion.cle)"
          :verrouillee="false"
          :repondre="a.reflexion.vivante && dernier && !!entry.msg.isStreaming"
          @basculer="basculerReflexion(a.reflexion.cle)"
          @repondre="fil.respondNow(entry.idx)"
        />
        <pre
          v-if="a.texte && a.reflexion && reflexionOuverte(a.reflexion.cle)"
          class="ml-6 pl-2.5 border-l-2 border-slate-200 text-[11.5px] text-slate-500 leading-relaxed whitespace-pre-wrap break-words font-mono max-h-52 overflow-y-auto m-0 bg-transparent"
          data-pensee
          >{{ a.reflexion.texte }}</pre>

        <template v-for="b in a.actions" :key="b.cle">
          <div v-if="b.k === 'etapes'" class="flex flex-col gap-1" :data-etapes="b.cle">
            <div class="flex flex-wrap gap-1.5">
              <template v-for="e in b.etapes" :key="e.flat">
                <button
                  type="button"
                  class="inline-flex items-center gap-1.5 h-6 px-2 rounded-md border text-[12px] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 max-w-full"
                  :class="classePastille(e.etape)"
                  :title="e.etape.name"
                  :aria-expanded="detail === e.flat ? 'true' : 'false'"
                  data-pastille-etape
                  @click="basculerDetail(e.flat)"
                >
                  <i class="ph shrink-0 text-[13px]" :class="iconePastille(e.etape)" aria-hidden="true"></i>
                  <span class="truncate">{{ texte(e.etape) }}</span>
                  <span v-if="e.etape.status === 'running'" class="shrink-0 tabular-nums"
                    >· {{ duree(e.etape) }}</span
                  >
                </button>
                <button
                  v-if="visionneuse.parEtape.has(e.flat)"
                  type="button"
                  class="inline-flex items-center h-6 px-1 rounded-md text-slate-400 hover:text-blue-600 hover:bg-slate-100"
                  :aria-label="'Voir la capture de l’étape ' + e.numero"
                  title="Voir la capture"
                  data-voir-capture
                  @click="voirCapture(visionneuse.parEtape.get(e.flat)!)"
                >
                  <i class="ph ph-camera text-[13px]" aria-hidden="true"></i>
                </button>
              </template>
            </div>
            <div
              v-for="e in b.etapes.filter(
                (x) => x.etape.status === 'running' && dernieresLignes(x.etape).length,
              )"
              :key="'s' + e.flat"
              class="font-mono text-[11px] leading-relaxed text-slate-500 whitespace-pre overflow-hidden"
              data-sortie-vivante
            >
              <div v-for="(l, li) in dernieresLignes(e.etape)" :key="li" class="truncate">{{ l }}</div>
            </div>
            <CarteOutil
              v-if="etapeDetail(b.etapes)"
              :step="etapeDetail(b.etapes)!.etape"
              :numero="etapeDetail(b.etapes)!.numero"
              :compact-ouvert="!!entry.msg._compactOpen"
              @fermer="basculerDetail(detail!)"
              @compact="(o: boolean) => fil.setMsgUi(entry, { _compactOpen: o })"
            />
            <div v-if="apercu && apercu.cle === b.cle" data-apercu-direct>
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
              </div>
            </div>
            <template v-for="e in b.etapes" :key="'g' + e.flat">
              <ContenuMarkdown
                v-if="graphiques.get(e.flat)"
                :msg="{ content: graphiques.get(e.flat) }"
                data-graphique-etape
              ></ContenuMarkdown>
            </template>
          </div>
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
            class="flex items-center gap-1.5 text-[12px] text-slate-500"
            :data-etape="b.etape.callId || undefined"
          >
            <i class="ph ph-arrows-in-simple text-[13px]" aria-hidden="true"></i>
            <span>Compression du contexte · {{ resumeCompression(b.etape) }}</span>
          </div>
        </template>
      </div>
      <ContenuMarkdown
        v-if="vivant"
        :msg="vivant"
        data-texte-vivant
        @click-markdown="fil.handleMarkdownClick"
      ></ContenuMarkdown>
    </div>
  </div>
</template>
