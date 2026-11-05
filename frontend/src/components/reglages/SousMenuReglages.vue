<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/reglages/SousMenuReglages.vue — bandeau horizontal des parties de l'onglet ouvert, un élément par composant, avec l'aide de la partie affichée. -->
<script setup lang="ts">
import { computed, ref, useId, watch } from "vue";

import { domaineReglages } from "../../features/reglages/domaine";
import { entreeRail } from "../../features/reglages/rail";
import { sectionCourante, sectionsVisibles } from "../../features/reglages/sections";

const rg = domaineReglages();
const onglet = computed(() => rg.settingsTab);
const sections = computed(() => sectionsVisibles(rg, onglet.value));
const courante = computed(() => sectionCourante(rg, onglet.value));
const titre = computed(() => entreeRail(onglet.value)?.libelle ?? "");
// Détail et formulaire d'un skill : plein cadre avec leur retour, un onglet cliqué par erreur y perdrait la saisie.
const masque = computed(() => onglet.value === "skills" && !!rg.skillEditMode);
const aideOuverte = ref(false);
const idAide = useId();

watch(courante, () => {
  aideOuverte.value = false;
});

function choisir(id: string): void {
  rg.settingsSections[onglet.value] = id;
}
</script>

<template>
  <div v-if="sections.length && !masque" class="elpis-sous-menu" data-sous-menu>
    <div class="elpis-sous-menu__ligne">
      <nav class="elpis-sous-menu__liste" :aria-label="'Parties de ' + titre">
        <button
          v-for="s in sections"
          :key="s.id"
          type="button"
          class="elpis-sous-menu__item"
          :aria-current="courante?.id === s.id ? 'page' : undefined"
          :data-section="s.id"
          @click="choisir(s.id)"
        >
          <i class="ph" :class="s.icone" aria-hidden="true"></i>
          {{ s.libelle }}
        </button>
      </nav>
      <button
        type="button"
        class="elpis-sous-menu__aide"
        :aria-expanded="aideOuverte ? 'true' : 'false'"
        :aria-controls="idAide"
        title="Afficher l'aide"
        data-aide-bouton
        @click="aideOuverte = !aideOuverte"
      >
        <i class="ph ph-question" aria-hidden="true"></i>
        Aide
      </button>
    </div>
    <p v-show="aideOuverte" :id="idAide" class="elpis-sous-menu__ligne-aide" data-aide-ligne>
      {{ courante?.aide }}
    </p>
  </div>
</template>
