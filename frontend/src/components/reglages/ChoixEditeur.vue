<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/reglages/ChoixEditeur.vue — rangée « Éditeur » des Paramètres : selon le skin ou classique, avec l'effet sur le skin courant. -->
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
</script>

<template>
  <div class="set-row">
    <i class="ph ph-layout text-slate-400 text-lg w-5" aria-hidden="true"></i>
    <div class="flex-1 min-w-0">
      <label :for="idChamp" class="text-sm text-slate-800">Éditeur</label>
      <div :id="idChamp + '-aide'" class="text-xs text-slate-500">{{ aide }}</div>
    </div>
    <select
      :id="idChamp"
      class="set-select set-control--sm shrink-0"
      :value="choix"
      :aria-describedby="idChamp + '-aide'"
      @change="rg.settings.editor_ui = ($event.target as HTMLSelectElement).value as InterfaceEditeur"
    >
      <option v-for="c in CHOIX_INTERFACES_EDITEUR" :key="c.valeur" :value="c.valeur">{{ c.libelle }}</option>
    </select>
  </div>
</template>
