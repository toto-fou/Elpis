<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/outils/LigneEtapes.vue — étapes consécutives d'un tour sur une ligne riche : vivante (« Étape 3 · Exécute npm test · 18 s » et deux lignes de sortie), puis résumé dépliable en liste numérotée sur le tour. -->
<script setup lang="ts">
import { computed } from "vue";

import type { EtapeNumerotee } from "../../../features/chat/message/chronologie";
import { fmtDuree } from "../../../features/chat/outils/format";
import type { EtapeOutil } from "../../../features/chat/outils/types";
import { libelleEtape } from "../../../features/chat/outils/verbes";
import CarteOutil from "./CarteOutil.vue";

const props = defineProps<{
  etapes: readonly EtapeNumerotee[];
  ouvert: boolean;
  detail: number | null;
  maintenant: number;
  compactOuvert: boolean;
}>();
const emit = defineEmits<{ basculer: []; detail: [flat: number]; compact: [ouvert: boolean] }>();

type Signe = "cours" | "echec" | "arret" | "ok";

function signe(s: EtapeOutil): Signe {
  if (s.status === "running") return "cours";
  if (s.status === "stopped") return "arret";
  if (s._is_error) return "echec";
  return "ok";
}

const ICONES: Readonly<Record<Signe, string>> = {
  cours: "ph-spinner-gap animate-spin text-blue-500",
  echec: "ph-x-circle text-red-500",
  arret: "ph-stop-circle text-slate-400",
  ok: "ph-check text-emerald-600",
};
const NOMS: Readonly<Record<Signe, string>> = {
  cours: "En cours",
  echec: "Échec",
  arret: "Arrêtée",
  ok: "Terminée",
};

const enCours = computed(() => [...props.etapes].reverse().find((e) => e.etape.status === "running") ?? null);
const signeGroupe = computed<Signe>(() => {
  const s = props.etapes.map((e) => signe(e.etape));
  return s.includes("cours") ? "cours" : s.includes("echec") ? "echec" : s.includes("arret") ? "arret" : "ok";
});
const ids = computed(() =>
  props.etapes
    .map((e) => e.etape.callId)
    .filter(Boolean)
    .join(" "),
);
const principale = computed(() => enCours.value ?? props.etapes[props.etapes.length - 1] ?? null);

/** Début (verbe, ou nom de l'outil tiers en police fixe) suivi d'une espace, puis l'objet. */
function tete(s: EtapeOutil): { debut: string; mono: boolean; objet: string } {
  const l = libelleEtape(s);
  const debut = l.verbe ?? l.outil;
  return { debut: debut && l.objet ? debut + " " : debut, mono: l.verbe === null, objet: l.objet };
}

function duree(s: EtapeOutil): string {
  if (s.status === "running")
    return typeof s.startedAt === "number" ? fmtDuree(props.maintenant - s.startedAt) : "";
  if (typeof s.durationMs !== "number") return s.status === "stopped" ? "arrêtée" : "";
  return s.status === "stopped" ? "arrêtée à " + fmtDuree(s.durationMs) : fmtDuree(s.durationMs);
}

const total = computed(() => {
  if (props.etapes.length === 1) return principale.value ? duree(principale.value.etape) : "";
  const ms = props.etapes.reduce((a, e) => a + (e.etape.durationMs ?? 0), 0);
  return ms > 0 ? fmtDuree(ms) : "";
});
const objets = computed(() => {
  const vus = [...new Set(props.etapes.map((e) => libelleEtape(e.etape).objet).filter(Boolean))];
  return vus.slice(0, 3).join(", ") + (vus.length > 3 ? "…" : "");
});

/** Deux dernières lignes de sortie de l'étape en cours (console, journal ou progression). */
const sortie = computed(() => {
  const s = enCours.value?.etape;
  if (!s) return [];
  // eslint-disable-next-line no-control-regex -- séquences ANSI de la console retirées
  const brut = (s.shellOut ?? "").replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
  const lignes = brut.split(/\r?\n/).filter((l) => l.trim());
  if (lignes.length) return lignes.slice(-2);
  const journal = (s.logs ?? []).map((l) => l.message).filter(Boolean);
  if (journal.length) return journal.slice(-2);
  return s.progressInfo?.message ? [s.progressInfo.message] : [];
});
</script>

<template>
  <div class="mb-1" :data-etape="principale?.etape.callId || undefined" :data-etapes="ids || undefined">
    <button
      type="button"
      class="w-full flex items-center gap-2 px-1.5 py-1 -mx-1.5 rounded-md text-left text-[13px] text-slate-700 hover:bg-slate-100 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
      :aria-expanded="ouvert ? 'true' : 'false'"
      :title="etapes.map((e) => e.etape.name).join(', ')"
      data-ligne-etapes
      @click="emit('basculer')"
    >
      <i class="ph shrink-0 text-[14px]" :class="ICONES[signeGroupe]" :aria-label="NOMS[signeGroupe]"></i>
      <span v-if="enCours" class="flex-1 min-w-0 truncate" aria-live="polite"
        >{{ "Étape " + enCours.numero + " · "
        }}<span :class="tete(enCours.etape).mono ? 'font-mono' : ''">{{ tete(enCours.etape).debut }}</span
        ><b class="font-semibold">{{ tete(enCours.etape).objet }}</b></span
      >
      <span v-else-if="etapes.length === 1 && principale" class="flex-1 min-w-0 truncate"
        ><span :class="tete(principale.etape).mono ? 'font-mono' : ''">{{
          tete(principale.etape).debut
        }}</span
        ><b class="font-semibold">{{ tete(principale.etape).objet }}</b></span
      >
      <span v-else class="flex-1 min-w-0 truncate"
        >{{ etapes.length }} étapes<template v-if="objets"> · {{ objets }}</template></span
      >
      <span class="shrink-0 text-[12px] text-slate-500 tabular-nums">{{
        enCours ? duree(enCours.etape) : total
      }}</span>
      <i
        class="ph ph-caret-down shrink-0 text-[11px] text-slate-400 transition-transform"
        :class="ouvert ? 'rotate-180' : ''"
        aria-hidden="true"
      ></i>
    </button>
    <div
      v-if="enCours && sortie.length"
      class="pl-6 font-mono text-[11px] leading-relaxed text-slate-500 whitespace-pre overflow-hidden"
      data-sortie-vivante
    >
      <div v-for="(l, li) in sortie" :key="li" class="truncate">{{ l }}</div>
    </div>
    <ol v-if="ouvert" :start="etapes[0]?.numero" class="mt-0.5 mb-1 pl-6 flex flex-col gap-0.5 list-none">
      <li v-for="e in etapes" :key="e.flat" :data-etape="e.etape.callId || undefined">
        <button
          type="button"
          class="w-full flex items-center gap-2 px-1.5 py-0.5 -mx-1.5 rounded-md text-left text-[12.5px] text-slate-600 hover:bg-slate-100 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          :aria-expanded="detail === e.flat ? 'true' : 'false'"
          :title="e.etape.name"
          @click="emit('detail', e.flat)"
        >
          <span class="w-5 shrink-0 text-right text-[11.5px] text-slate-500 tabular-nums"
            >{{ e.numero }}.</span
          >
          <i
            class="ph shrink-0 text-[13px]"
            :class="ICONES[signe(e.etape)]"
            :aria-label="NOMS[signe(e.etape)]"
          ></i>
          <span class="flex-1 min-w-0 truncate"
            ><span :class="tete(e.etape).mono ? 'font-mono' : ''">{{ tete(e.etape).debut }}</span
            >{{ tete(e.etape).objet }}</span
          >
          <span class="shrink-0 text-[11.5px] text-slate-500 tabular-nums">{{ duree(e.etape) }}</span>
        </button>
        <CarteOutil
          v-if="detail === e.flat"
          :step="e.etape"
          :numero="e.numero"
          :compact-ouvert="compactOuvert"
          @fermer="emit('detail', e.flat)"
          @compact="(o) => emit('compact', o)"
        />
      </li>
    </ol>
  </div>
</template>
