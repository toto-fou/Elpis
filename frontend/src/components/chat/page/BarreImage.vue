<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/page/BarreImage.vue — barre du mode Images : format, taille, nombre, enrichir, graine, bibliothèque, options avancées. -->
<script setup lang="ts">
import { CLE_IMAGE, domaine } from "../../../features/chat/page/domaines";

const img = domaine(CLE_IMAGE);

function valeur(e: Event): string {
  return (e.target as HTMLSelectElement).value;
}
</script>

<template>
  <div v-if="img.imageMode" class="elpis-img-bar" data-image-bar>
    <button
      type="button"
      class="elpis-img-chip is-on"
      title="Quitter le mode Images (Échap sur une saisie vide)"
      aria-label="Quitter le mode Images"
      @click="img.closeImageMode()"
    >
      <i class="ph ph-image" aria-hidden="true"></i><span>Images</span>
      <i class="ph ph-x elpis-img-chip__x" aria-hidden="true"></i>
    </button>
    <select
      v-if="img.imageFixedSizes.length"
      class="elpis-img-chip elpis-img-select"
      :value="img.imageOpts.fixed"
      aria-label="Taille"
      title="Taille"
      @change="img.setImageFixed(valeur($event))"
    >
      <option v-for="sz in img.imageFixedSizes" :key="sz" :value="sz">{{ img.imageSizeLabel(sz) }}</option>
    </select>
    <template v-else>
      <div class="relative" data-image-pop>
        <button
          type="button"
          class="elpis-img-chip"
          data-image-format
          aria-haspopup="true"
          :aria-expanded="img.imagePop === 'ratio' ? 'true' : 'false'"
          :title="'Format · ' + img.imageSize().w + '×' + img.imageSize().h"
          @click="img.toggleImagePop('ratio')"
        >
          <span
            class="elpis-img-ratio"
            :style="
              img.ratioBox(
                img.imageOpts.custom
                  ? img.imageOpts.cw >= img.imageOpts.ch
                    ? '3:2'
                    : '2:3'
                  : img.imageOpts.ratio,
              )
            "
            aria-hidden="true"
          ></span>
          <span>{{ img.imageFormatLabel() }}</span>
        </button>
        <div
          v-if="img.imagePop === 'ratio'"
          class="elpis-img-pop elpis-img-pop--ratio"
          role="group"
          aria-label="Format"
        >
          <button
            v-for="r in img.imageBaseRatios"
            :key="r"
            type="button"
            class="elpis-img-opt"
            :aria-pressed="
              !img.imageOpts.custom && img.imageBaseRatio(img.imageOpts.ratio) === r ? 'true' : 'false'
            "
            @click="img.setImageRatio(r)"
          >
            <span
              class="elpis-img-ratio"
              :style="img.ratioBox(img.imageIsPortrait(img.imageOpts.ratio) ? img.imageFlipRatio(r) : r)"
              aria-hidden="true"
            ></span>
            <span>{{
              r === "1:1" ? "Carré" : img.imageIsPortrait(img.imageOpts.ratio) ? img.imageFlipRatio(r) : r
            }}</span>
          </button>
        </div>
      </div>
      <button
        type="button"
        class="elpis-img-chip elpis-img-chip--icon"
        data-image-flip
        :disabled="!img.imageOpts.custom && img.imageOpts.ratio === '1:1'"
        :aria-pressed="img.imageIsPortrait(img.imageOpts.ratio) ? 'true' : 'false'"
        title="Portrait / paysage"
        aria-label="Basculer portrait ou paysage"
        @click="img.flipImageRatio()"
      >
        <i class="ph ph-arrows-left-right" aria-hidden="true"></i>
      </button>
      <select
        v-if="img.imageSides.length > 1 && !img.imageOpts.custom"
        class="elpis-img-chip elpis-img-select"
        :value="img.imageOpts.side"
        aria-label="Taille"
        title="Plus grand côté"
        @change="img.setImageSide(valeur($event))"
      >
        <option v-for="v in img.imageSides" :key="v" :value="v">{{ v }} px</option>
      </select>
    </template>
    <select
      v-if="img.imageMaxN > 1"
      class="elpis-img-chip elpis-img-select"
      :value="img.imageOpts.n"
      aria-label="Nombre d’images"
      title="Nombre d’images"
      @change="img.setImageN(valeur($event))"
    >
      <option v-for="k in img.imageMaxN" :key="k" :value="k">×{{ k }}</option>
    </select>
    <button
      v-if="img.imageStatus && img.imageStatus.enhance_enabled !== false"
      type="button"
      class="elpis-img-chip"
      :class="{ 'is-on': img.imageOpts.enhance }"
      :aria-pressed="img.imageOpts.enhance ? 'true' : 'false'"
      title="Le modèle du chat réécrit la description avant l’envoi"
      @click="img.toggleImageEnhance()"
    >
      <i class="ph ph-magic-wand" aria-hidden="true"></i><span>Enrichir</span>
    </button>
    <button
      v-if="img.imageSeedSet"
      type="button"
      class="elpis-img-chip is-on"
      title="Graine fixée : mêmes résultats à demande égale. Cliquer pour revenir à l’aléatoire."
      aria-label="Retirer la graine fixée"
      data-image-seed
      @click="img.clearImageSeed()"
    >
      <span>graine {{ img.imageOpts.seed }}</span
      ><i class="ph ph-x elpis-img-chip__x" aria-hidden="true"></i>
    </button>
    <button
      type="button"
      class="elpis-img-chip elpis-img-chip--icon"
      data-image-gallery-open
      title="Bibliothèque"
      aria-label="Ouvrir la bibliothèque d’images"
      @click="img.openImageGallery('all')"
    >
      <i class="ph ph-images" aria-hidden="true"></i>
    </button>
    <div class="relative" data-image-pop>
      <button
        type="button"
        class="elpis-img-chip elpis-img-chip--icon"
        data-image-more
        aria-haspopup="true"
        :aria-expanded="img.imagePop === 'more' ? 'true' : 'false'"
        title="Options avancées"
        aria-label="Options avancées"
        @click="img.toggleImagePop('more')"
      >
        <i class="ph ph-dots-three" aria-hidden="true"></i>
      </button>
      <div
        v-if="img.imagePop === 'more'"
        class="elpis-img-pop elpis-img-pop--more"
        role="group"
        aria-label="Options avancées"
      >
        <template v-if="!img.imageFixedSizes.length">
          <button
            type="button"
            class="elpis-img-opt elpis-img-opt--row"
            :aria-pressed="img.imageOpts.custom ? 'true' : 'false'"
            title="Largeur et hauteur au choix, arrondies à 64 px"
            @click="img.setImageCustom(!img.imageOpts.custom)"
          >
            <i class="ph ph-arrows-out-simple" aria-hidden="true"></i><span>Dimensions libres</span>
          </button>
          <div v-if="img.imageOpts.custom" class="elpis-img-dims">
            <input
              v-model.number="img.imageOpts.cw"
              type="number"
              min="64"
              :max="(img.imageStatus && img.imageStatus.max_side) || 2048"
              :step="(img.imageStatus && img.imageStatus.step) || 64"
              aria-label="Largeur"
              placeholder="Largeur"
              class="elpis-img-input"
            />
            <span aria-hidden="true">×</span>
            <input
              v-model.number="img.imageOpts.ch"
              type="number"
              min="64"
              :max="(img.imageStatus && img.imageStatus.max_side) || 2048"
              :step="(img.imageStatus && img.imageStatus.step) || 64"
              aria-label="Hauteur"
              placeholder="Hauteur"
              class="elpis-img-input"
            />
          </div>
        </template>
        <label v-if="img.imageFeatures.seed" class="elpis-img-field">
          <span>Graine</span>
          <input
            v-model="img.imageOpts.seed"
            type="number"
            min="0"
            placeholder="Aléatoire"
            class="elpis-img-input"
          />
        </label>
        <label v-if="img.imageFeatures.steps" class="elpis-img-field">
          <span>Étapes</span>
          <input
            v-model="img.imageOpts.steps"
            type="number"
            min="1"
            max="200"
            placeholder="Modèle"
            class="elpis-img-input"
          />
        </label>
        <label v-if="img.imageFeatures.negative" class="elpis-img-field elpis-img-field--col">
          <span>À éviter</span>
          <textarea
            v-model="img.imageOpts.negative_prompt"
            rows="2"
            placeholder="flou, texte, filigrane"
            class="elpis-img-input"
          ></textarea>
        </label>
        <label
          v-if="img.imageFeatures.strength && (img.imageEditRef || img.attachedFiles.some((f) => f.isImage))"
          class="elpis-img-field elpis-img-field--col"
          title="Faible : proche de l’original. Forte : s’en éloigne davantage."
        >
          <span>Force · {{ Number(img.imageOpts.strength).toFixed(2) }}</span>
          <input
            v-model.number="img.imageOpts.strength"
            type="range"
            min="0.1"
            max="1"
            step="0.05"
            aria-label="Force de la modification"
          />
        </label>
      </div>
    </div>
  </div>
</template>
