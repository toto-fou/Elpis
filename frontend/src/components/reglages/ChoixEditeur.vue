<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/reglages/ChoixEditeur.vue — choix de l'éditeur dans Apparence (selon le skin ou classique), libellé au-dessus, explication dessous. -->
<script setup lang="ts">
import { computed } from "vue";

import {
  AIDE_SKIN_SANS_EDITEUR,
  CHOIX_INTERFACES_EDITEUR,
  lireInterfaceEditeur,
} from "../../features/editor/interface";
import type { InterfaceEditeur } from "../../features/editor/interface";
import { domaineReglages } from "../../features/reglages/domaine";

defineProps<{ idChamp: string }>();

const rg = domaineReglages();
const choix = computed(() => lireInterfaceEditeur(rg.settings));
const aide = computed(() =>
  choix.value === "skin" && !rg.skinCourant.editor_css_url
    ? AIDE_SKIN_SANS_EDITEUR
    : (CHOIX_INTERFACES_EDITEUR.find((c) => c.valeur === choix.value)?.aide ?? ""),
);

function choisir(e: Event): void {
  rg.settings.editor_ui = (e.target as HTMLSelectElement).value as InterfaceEditeur;
}
</script>

<template>
  <div>
    <label :for="idChamp" class="block text-xs font-medium text-slate-600 mb-2">Éditeur</label>
    <select
      :id="idChamp"
      class="set-select w-full"
      :value="choix"
      :aria-describedby="idChamp + '-aide'"
      @change="choisir"
    >
      <option v-for="c in CHOIX_INTERFACES_EDITEUR" :key="c.valeur" :value="c.valeur">{{ c.libelle }}</option>
    </select>
    <p :id="idChamp + '-aide'" class="text-xs text-slate-500 mt-1.5 leading-snug">{{ aide }}</p>
  </div>
</template>
