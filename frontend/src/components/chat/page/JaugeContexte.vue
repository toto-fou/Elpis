<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/page/JaugeContexte.vue — occupation de la fenêtre de contexte dans la rangée du composeur, sous la forme choisie dans les Paramètres : bloc qui se remplit, pourcentage seul ou anneau ; signe ⚠ et ambre dès le seuil d'alerte. -->
<script setup lang="ts">
import { computed } from "vue";

import type { PuceContexte } from "../../../features/chat/page/puces";
import { SEUIL_CONTEXTE } from "../../../features/chat/page/puces";
import type { AffichageContexte } from "../../../features/reglages/affichage-chat";

const props = defineProps<{ contexte: PuceContexte; forme: AffichageContexte; etroit?: boolean }>();

const alerte = computed(() => props.contexte.pct >= SEUIL_CONTEXTE);
// Remplissage du bloc : visible dès qu'un jeton occupe la fenêtre.
const largeur = computed(() => {
  const part = props.contexte.part;
  return part > 0 ? Math.max(6, part * 100) + "%" : "0%";
});
// Anneau de 14 px : un cercle de rayon 5,5 dont le trait couvre la part occupée.
const RAYON = 5.5;
const CIRCONFERENCE = 2 * Math.PI * RAYON;
const trait = computed(() => {
  const part = Math.min(1, Math.max(0, props.contexte.part));
  return `${(part * CIRCONFERENCE).toFixed(2)} ${CIRCONFERENCE.toFixed(2)}`;
});
</script>

<template>
  <span
    class="elpis-jauge-contexte relative inline-flex items-center gap-1 h-5 text-xs font-medium tabular-nums text-slate-600 overflow-hidden select-none"
    :class="[
      forme === 'fill' ? 'px-2 rounded border border-slate-200' : 'px-1',
      alerte ? 'is-alerte' : '',
      'is-' + forme,
    ]"
    :title="contexte.titre"
    role="meter"
    aria-label="Contexte"
    aria-valuemin="0"
    aria-valuemax="100"
    :aria-valuenow="contexte.pct"
    data-puce-contexte
  >
    <span
      v-if="forme === 'fill'"
      class="elpis-jauge-contexte__plein absolute inset-y-0 left-0"
      :style="{ width: largeur }"
      aria-hidden="true"
      data-jauge-contexte
    ></span>
    <svg
      v-else-if="forme === 'ring'"
      class="elpis-jauge-contexte__anneau relative shrink-0"
      width="14"
      height="14"
      viewBox="0 0 14 14"
      aria-hidden="true"
      data-jauge-contexte
    >
      <circle cx="7" cy="7" :r="RAYON" fill="none" stroke-width="2" class="piste" />
      <circle
        cx="7"
        cy="7"
        :r="RAYON"
        fill="none"
        stroke-width="2"
        stroke-linecap="round"
        class="arc"
        :stroke-dasharray="trait"
        transform="rotate(-90 7 7)"
      />
    </svg>
    <i v-if="alerte" class="ph ph-warning relative text-[12px]" aria-hidden="true"></i>
    <span :class="etroit || forme !== 'fill' ? 'sr-only' : 'relative'">Contexte </span>
    <span class="relative">{{ contexte.pct }} %</span>
  </span>
</template>
