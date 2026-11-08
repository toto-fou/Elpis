<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/admin/GraphiqueRapport.vue — courbe ou barres (empilées ou non) en SVG pour les graphiques du rapport, avec légende ; sans bibliothèque. -->
<script setup lang="ts">
import { computed } from "vue";

import type { SerieRapport } from "../../features/admin/rapport";

const props = withDefaults(defineProps<{ serie: SerieRapport; hauteur?: number }>(), { hauteur: 150 });

const L = 400;
const G = 34;
const D = 10;
const H = 6;
const B = 18;
const MAX_REPERES = 12;

const n = computed(() => props.serie.labels.length);
const zone = computed(() => ({ w: L - G - D, h: props.hauteur - H - B }));
const totaux = computed(() =>
  props.serie.labels.map((_, i) =>
    props.serie.empile
      ? props.serie.datasets.reduce((t, d) => t + (d.data[i] ?? 0), 0)
      : Math.max(0, ...props.serie.datasets.map((d) => d.data[i] ?? 0)),
  ),
);
const max = computed(() => Math.max(1, ...totaux.value));
const x = (i: number): number =>
  props.serie.type === "bar"
    ? G + ((i + 0.5) * zone.value.w) / n.value
    : G + (n.value > 1 ? (i * zone.value.w) / (n.value - 1) : zone.value.w / 2);
const y = (v: number): number => H + zone.value.h - (v / max.value) * zone.value.h;
const fmt = (v: number): string => (Math.round(v * 100) / 100).toLocaleString("fr-FR");

const trace = (data: number[]): string =>
  data.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
const largeur = computed(() => Math.max(1, (zone.value.w / Math.max(1, n.value)) * 0.7));

/** Barres : pile `k` de la catégorie `i`, du cumul des jeux précédents à son propre sommet. */
function segments(i: number): { k: number; y: number; h: number; v: number }[] {
  let cumul = 0;
  const jeux = props.serie.empile ? props.serie.datasets : props.serie.datasets.slice(0, 1);
  return jeux.map((d, k) => {
    const v = d.data[i] ?? 0;
    const bas = cumul;
    cumul += v;
    return { k, y: y(cumul), h: Math.max(0, y(bas) - y(cumul)), v };
  });
}

const pas = computed(() => Math.max(1, Math.ceil(n.value / MAX_REPERES)));
const reperes = computed(() =>
  props.serie.labels.map((_, i) => i).filter((i) => (n.value - 1 - i) % pas.value === 0),
);
const maxCar = computed(() =>
  Math.max(3, Math.floor(((zone.value.w / Math.max(1, n.value)) * pas.value) / 5)),
);
const court = (t: string): string => (t.length > maxCar.value ? t.slice(0, maxCar.value - 1) + "…" : t);
const ancre = (i: number): string =>
  i === n.value - 1 && n.value > 1
    ? "end"
    : i === 0 && n.value > 1 && props.serie.type === "line"
      ? "start"
      : "middle";
const legende = computed(() => (props.serie.datasets.length > 1 ? props.serie.datasets : []));
const points = computed(() => props.serie.type === "line" && n.value <= 48);
const resume = computed(() => {
  const d = totaux.value;
  return `${props.serie.titre} : ${n.value} points, de ${fmt(Math.min(...d))} à ${fmt(Math.max(...d))}`;
});
</script>

<template>
  <div class="rap-graphe-bloc">
    <svg
      class="rap-graphe"
      :viewBox="`0 0 ${L} ${hauteur}`"
      role="img"
      :aria-label="resume"
      preserveAspectRatio="xMidYMid meet"
    >
      <g class="rap-graphe__grille">
        <line v-for="f in [0, 0.5, 1]" :key="f" :x1="G" :x2="L - D" :y1="y(max * f)" :y2="y(max * f)" />
      </g>
      <g class="rap-graphe__axe">
        <text v-for="f in [0, 0.5, 1]" :key="f" :x="G - 3" :y="y(max * f) + 3" text-anchor="end">
          {{ fmt(max * f) }}
        </text>
        <text v-for="i in reperes" :key="i" :x="x(i)" :y="hauteur - 4" :text-anchor="ancre(i)">
          <title v-if="court(serie.labels[i] ?? '') !== serie.labels[i]">{{ serie.labels[i] }}</title>
          {{ court(serie.labels[i] ?? "") }}
        </text>
      </g>
      <template v-if="serie.type === 'bar'">
        <g v-for="(lab, i) in serie.labels" :key="i">
          <rect
            v-for="sg in segments(i)"
            :key="sg.k"
            class="rap-graphe__barre"
            :class="'rap-c' + sg.k"
            :x="x(i) - largeur / 2"
            :y="sg.y"
            :width="largeur"
            :height="sg.h"
          >
            <title>
              {{ lab }}{{ serie.datasets[sg.k]?.label ? " · " + serie.datasets[sg.k]?.label : "" }} :
              {{ fmt(sg.v) }}
            </title>
          </rect>
        </g>
      </template>
      <template v-else>
        <g v-for="(d, k) in serie.datasets" :key="k" :class="'rap-c' + k">
          <path class="rap-graphe__ligne" :class="'rap-graphe__ligne--' + (k % 3)" :d="trace(d.data)" />
          <circle
            v-for="(v, i) in points ? d.data : []"
            :key="i"
            class="rap-graphe__point"
            :cx="x(i)"
            :cy="y(v)"
            r="2.2"
          >
            <title>{{ serie.labels[i] }}{{ d.label ? " · " + d.label : "" }} : {{ fmt(v) }}</title>
          </circle>
        </g>
      </template>
    </svg>
    <ul v-if="legende.length" class="rap-legende">
      <li v-for="(d, k) in legende" :key="k">
        <i :class="'rap-c' + k" aria-hidden="true"></i>{{ d.label || "Série " + (k + 1) }}
      </li>
    </ul>
  </div>
</template>
