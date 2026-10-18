<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/images/ImageGrid.vue — résultats d'une génération d'images : grille, actions par image (agrandir, modifier, télécharger, supprimer), pied (description, variantes). -->
<script setup lang="ts">
import { computed } from "vue";

import { imageCellStyle, imageFmtSec, imageSizeLabel } from "../../features/images/formats";
import { apiImages } from "../../features/images/partage";
import type { ImageAffichee } from "../../features/images/partage";

const props = withDefaults(
  defineProps<{
    items?: readonly ImageAffichee[];
    prompt?: string;
    revised?: string;
    meta?: { model?: string; duration_s?: number } | null;
    tool?: boolean;
    reveal?: boolean;
    variants?: boolean;
  }>(),
  { items: () => [], prompt: "", revised: "", meta: null, tool: false, reveal: false, variants: false },
);
defineEmits<{ variants: [] }>();

const etat = (): Record<string, string> => apiImages()?.state ?? {};

const cells = computed(() => {
  const liste = props.items || [];
  return liste.map((ref, i) => ({
    ref,
    i,
    st: etat()[ref.id] || "",
    style: imageCellStyle(ref.width, ref.height, liste.length),
    src: ref.thumb_url || ref.url,
  }));
});
const texte = computed(() => props.revised || props.prompt || "");
const metaText = computed(() => {
  const liste = props.items || [];
  const m = props.meta || {};
  const premier = liste[0] || ({} as Partial<ImageAffichee>);
  const parts: string[] = [];
  if (m.model) parts.push(m.model);
  if (premier.width && premier.height) parts.push(imageSizeLabel({ w: premier.width, h: premier.height }));
  if (Number(m.duration_s) > 0) parts.push(imageFmtSec(m.duration_s));
  if (liste.length === 1 && premier.seed !== undefined && premier.seed !== null)
    parts.push(`graine ${premier.seed}`);
  return parts.join(" · ");
});
const canEdit = computed(() => !!apiImages()?.canEdit.value);
const altText = computed(() => (texte.value || "Image générée").slice(0, 300));

function open(i: number): void {
  apiImages()?.openViewer(props.items, i, { prompt: props.prompt, revised: props.revised, meta: props.meta });
}
function edit(ref: ImageAffichee): void {
  apiImages()?.edit(ref);
}
function download(ref: ImageAffichee): void {
  apiImages()?.download(ref, props.prompt || props.revised || "");
}
function remove(ref: ImageAffichee): void {
  apiImages()?.remove(ref);
}
function expired(ref: ImageAffichee): void {
  apiImages()?.markExpired(ref.id);
}
function copy(): void {
  apiImages()?.copyText(texte.value);
}
</script>

<template>
  <div class="elpis-img-result" :class="{ 'is-tool': tool }" data-image-grid>
    <div class="elpis-img-cells">
      <div
        v-for="c in cells"
        :key="c.ref.id"
        class="elpis-img-cell"
        :style="c.style"
        :data-image-id="c.ref.id"
      >
        <div v-if="c.st === 'expired' || c.st === 'deleted' || c.st === 'pending'" class="elpis-img-frame">
          <i class="ph" :class="c.st === 'expired' ? 'ph-image-broken' : 'ph-trash'" aria-hidden="true"></i>
          <span>{{ c.st === "expired" ? "Expirée" : "Supprimée" }}</span>
        </div>
        <template v-else>
          <button
            type="button"
            class="elpis-img-open"
            :aria-label="'Agrandir l’image ' + (c.i + 1)"
            @click="open(c.i)"
          >
            <img
              :src="c.src"
              :alt="altText"
              loading="lazy"
              decoding="async"
              :width="c.ref.width || undefined"
              :height="c.ref.height || undefined"
              :class="{ 'elpis-img-reveal': reveal }"
              @error="expired(c.ref)"
            />
          </button>
          <div class="elpis-img-actions">
            <button
              v-if="canEdit"
              type="button"
              class="elpis-img-act"
              title="Modifier"
              aria-label="Modifier l’image"
              @click.stop="edit(c.ref)"
            >
              <i class="ph ph-pencil-simple" aria-hidden="true"></i>
            </button>
            <button
              type="button"
              class="elpis-img-act"
              title="Télécharger"
              aria-label="Télécharger l’image"
              @click.stop="download(c.ref)"
            >
              <i class="ph ph-download-simple" aria-hidden="true"></i>
            </button>
            <button
              type="button"
              class="elpis-img-act is-danger"
              title="Supprimer"
              aria-label="Supprimer l’image"
              @click.stop="remove(c.ref)"
            >
              <i class="ph ph-trash" aria-hidden="true"></i>
            </button>
          </div>
          <span
            v-if="cells.length > 1 && c.ref.seed !== undefined && c.ref.seed !== null"
            class="elpis-img-seed"
            >{{ c.ref.seed }}</span
          >
        </template>
      </div>
    </div>
    <div class="elpis-img-foot">
      <span v-if="metaText" class="elpis-img-foot__meta">{{ metaText }}</span>
      <span class="elpis-img-foot__actions">
        <button
          v-if="texte"
          type="button"
          class="elpis-img-link"
          title="Copier la description"
          @click="copy()"
        >
          <i class="ph ph-copy" aria-hidden="true"></i><span>Copier</span>
        </button>
        <button
          v-if="variants && !tool"
          type="button"
          class="elpis-img-link"
          title="Nouvelles images, même demande, autre graine"
          data-image-variants
          @click="$emit('variants')"
        >
          <i class="ph ph-shuffle" aria-hidden="true"></i><span>Variantes</span>
        </button>
      </span>
    </div>
    <details v-if="revised" class="elpis-img-revised">
      <summary>Description utilisée</summary>
      <p>{{ revised }}</p>
    </details>
  </div>
</template>
