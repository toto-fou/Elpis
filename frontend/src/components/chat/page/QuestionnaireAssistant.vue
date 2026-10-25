<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/page/QuestionnaireAssistant.vue — questionnaire de l'outil ask_user, haut de la carte du composeur : progression, question, options à touche numérotée ; la zone de saisie en dessous sert de champ libre. -->
<script setup lang="ts">
import { computed, nextTick, useTemplateRef } from "vue";

import { CLE_COMPOSEUR, domaine } from "../../../features/chat/page/domaines";

const comp = domaine(CLE_COMPOSEUR);
const panneau = computed(() => (comp.askUserPanel?.ouvert ? comp.askUserPanel : null));
const courante = computed(() => (panneau.value ? comp.askUserCurrent : null));
const options = computed(() => courante.value?.options ?? []);
const multi = computed(() => !!courante.value?.multi);
const total = computed(() => panneau.value?.items.length ?? 0);
const liste = useTemplateRef<HTMLElement>("liste");
// Choix unique : une seule option dans l'ordre de tabulation (la cochée, sinon la première).
const optionTab = computed(() =>
  Math.max(
    0,
    options.value.findIndex((o) => comp.isAskOptionOn(o)),
  ),
);

// Un radio coché ne se décoche pas au clic (les cases à cocher, si).
function choisir(opt: string): void {
  if (multi.value || !comp.isAskOptionOn(opt)) comp.toggleAskOption(opt);
}

// Flèches entre les radios : le focus et la coche suivent.
function fleche(ev: KeyboardEvent, oi: number): void {
  if (multi.value) return;
  const pas = ["ArrowDown", "ArrowRight"].includes(ev.key)
    ? 1
    : ["ArrowUp", "ArrowLeft"].includes(ev.key)
      ? -1
      : 0;
  if (!pas) return;
  ev.preventDefault();
  const k = (oi + pas + options.value.length) % options.value.length;
  const opt = options.value[k];
  if (opt !== undefined) choisir(opt);
  void nextTick(() => liste.value?.querySelectorAll<HTMLElement>("[role='radio']")[k]?.focus());
}
</script>

<template>
  <div v-if="panneau && courante" data-ask-bloc>
    <div class="elpis-ask-haut">
      <div class="flex items-center gap-3">
        <span class="elpis-ask-etape">Question {{ panneau.idx + 1 }} sur {{ total }}</span>
        <div class="flex gap-1" aria-hidden="true">
          <span
            v-for="(qq, qi) in panneau.items"
            :key="qi"
            class="elpis-ask-pas"
            :class="{ 'is-faite': qi < panneau.idx, 'is-courante': qi === panneau.idx }"
          ></span>
        </div>
        <span class="flex-1"></span>
        <button
          type="button"
          class="elpis-ask-lien"
          title="Fermer le questionnaire et écrire librement (Échap)"
          @click="comp.dismissAskUser"
        >
          Répondre librement
        </button>
      </div>
      <div id="elpis-ask-question" class="elpis-ask-question">{{ courante.q }}</div>
      <div
        v-if="options.length"
        ref="liste"
        :role="multi ? 'group' : 'radiogroup'"
        aria-labelledby="elpis-ask-question"
        :aria-describedby="multi ? 'elpis-ask-multi' : undefined"
        class="elpis-ask-liste"
      >
        <button
          v-for="(opt, oi) in options"
          :key="opt"
          type="button"
          class="elpis-ask-opt"
          :role="multi ? 'checkbox' : 'radio'"
          :aria-checked="comp.isAskOptionOn(opt) ? 'true' : 'false'"
          :tabindex="multi || oi === optionTab ? 0 : -1"
          @click="choisir(opt)"
          @keydown="fleche($event, oi)"
        >
          <span class="elpis-ask-kbd" :class="{ 'is-vide': oi > 8 }" aria-hidden="true">{{
            oi < 9 ? oi + 1 : ""
          }}</span>
          <span class="flex-1">{{ opt }}</span>
          <span class="elpis-ask-ind" :class="multi ? 'is-carre' : 'is-rond'" aria-hidden="true">
            <svg
              v-if="multi"
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="3"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M5 12.5l4.5 4.5L19 7.5" />
            </svg>
            <span v-else class="elpis-ask-point"></span>
          </span>
        </button>
      </div>
      <span v-if="multi" id="elpis-ask-multi" class="elpis-ask-aide">Plusieurs choix possibles.</span>
    </div>
    <div class="elpis-ask-sep"></div>
  </div>
</template>
