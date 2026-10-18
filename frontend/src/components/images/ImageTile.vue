<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/images/ImageTile.vue — tuile « en cours » d'une génération d'images : même boîte que l'image finale, progression, aperçu, arrêt et erreur. -->
<script setup lang="ts">
import { computed } from "vue";

import { imageCellStyle, imageErrorText, imageProgressText } from "../../features/images/formats";
import type { ProgressionImage } from "../../features/images/formats";
import { chronometreTuile } from "../../features/images/tuile";

interface Dimensions {
  w?: number;
  h?: number;
  n?: number;
}

type ErreurImage = { retryable?: boolean; message?: string; code?: string } | string | boolean | null;

const props = withDefaults(
  defineProps<{
    progress?: ProgressionImage | null;
    dims?: Dimensions | null;
    error?: ErreurImage;
    stoppable?: boolean;
    live?: boolean;
  }>(),
  { progress: null, dims: null, error: null, stoppable: false, live: false },
);
defineEmits<{ stop: []; retry: [] }>();

const ecoule = chronometreTuile(
  () => props.progress,
  () => !!props.error,
);
const taille = computed(() => {
  const p = props.progress || {};
  const d = props.dims || {};
  return {
    w: p.width || d.w || 1024,
    h: p.height || d.h || 1024,
    n: props.error ? 1 : Math.max(1, Math.min(4, p.n || d.n || 1)),
  };
});
const cells = computed(() => Array.from({ length: taille.value.n }, (_, i) => i));
const cellStyle = computed(() =>
  imageCellStyle(taille.value.w, taille.value.h, props.error ? 2 : taille.value.n),
);
const label = computed(() => imageProgressText(props.progress || {}, ecoule.value));
const stateLabel = computed(() =>
  imageProgressText(Object.assign({}, props.progress || {}, { eta_s: 0 }), 0).replace(/ · 0 s$/, ""),
);
const queued = computed(
  () => ["queued", "waiting", "enhancing"].indexOf((props.progress || {}).state ?? "") >= 0,
);
const preview = computed(() => {
  const p = (props.progress || {}).preview;
  return typeof p === "string" && p.indexOf("data:image/") === 0 ? p : "";
});
const pct = computed(() => {
  const p = props.progress || {};
  return p.pct_real && typeof p.pct === "number" ? Math.max(0, Math.min(100, p.pct)) : null;
});
const errorText = computed(() => imageErrorText(props.error));
const retryable = computed(
  () => !(props.error && typeof props.error === "object" && props.error.retryable === false),
);
</script>

<template>
  <div class="elpis-img-cells" data-image-progress>
    <span v-if="!error" class="sr-only" role="status" aria-live="polite">{{ stateLabel }}</span>
    <div
      v-for="k in cells"
      :key="k"
      class="elpis-img-cell elpis-img-tile"
      :class="{ 'is-queued': queued && !error, 'is-error': !!error }"
      :style="cellStyle"
    >
      <div v-if="error" class="elpis-img-tile__err" :role="live ? 'alert' : 'status'" data-image-error>
        <i class="ph ph-warning-circle" aria-hidden="true"></i>
        <span>{{ errorText }}</span>
        <button v-if="retryable" type="button" class="elpis-img-btn" @click="$emit('retry')">
          Réessayer
        </button>
      </div>
      <template v-else>
        <img
          v-if="k === 0 && preview"
          :src="preview"
          alt=""
          class="elpis-img-tile__preview"
          aria-hidden="true"
        />
        <div v-else class="elpis-img-tile__wash" aria-hidden="true"></div>
        <div
          v-if="pct !== null"
          class="elpis-img-tile__fill"
          :style="{ height: pct + '%' }"
          aria-hidden="true"
        ></div>
        <div v-if="k === 0" class="elpis-img-tile__foot">
          <span class="elpis-img-tile__label" aria-hidden="true">{{ label }}</span>
          <button
            v-if="stoppable"
            type="button"
            class="elpis-img-tile__stop"
            title="Arrêter"
            aria-label="Arrêter la génération"
            @click="$emit('stop')"
          >
            <i class="ph ph-stop" aria-hidden="true"></i>
          </button>
        </div>
      </template>
    </div>
  </div>
</template>
