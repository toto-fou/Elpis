<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/studio/CadreSurvolStudio.vue — cadre et libellé de l'élément survolé, dessinés une fois au-dessus des boîtes : un survol ne re-rend que ce cadre. -->
<script setup lang="ts">
import { computed } from "vue";

import { domaineStudio } from "../../features/studio/domaine";

const sd = domaineStudio();
const survoles = computed(() => sd.studioOverlayElements.filter((el) => el.id === sd.hoveredElementId));
</script>

<template>
  <g style="pointer-events: none">
    <template v-for="el in survoles" :key="el.id">
      <rect
        :x="el.box[0]"
        :y="el.box[1]"
        :width="el.box[2] - el.box[0]"
        :height="el.box[3] - el.box[1]"
        fill="none"
        :stroke="el.id === sd.selectedElementId ? 'var(--accent)' : 'var(--warn-soft)'"
        stroke-width="4"
        vector-effect="non-scaling-stroke"
      ></rect>
      <text
        :x="el.box[0]"
        :y="Math.max(12, el.box[1] - 4)"
        :font-size="Math.max(11, (sd.studioFrame.imgH || 1000) / 55)"
        fill="#f59e0b"
        style="paint-order: stroke; stroke: #fff; stroke-width: 3px"
      >
        {{ sd.elementDisplay(el) }}
      </text>
    </template>
  </g>
</template>
