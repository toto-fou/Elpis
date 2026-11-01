<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/agents/PanneauDroits.vue — onglet Droits de la fiche : fichiers, réflexion et, pour un agent qui a des outils web, session du navigateur ; l'effet du choix retenu est écrit sous chaque groupe, valeurs imposées par l'administrateur respectées. -->
<script setup lang="ts">
import { computed } from "vue";

import { CHOIX_REFLEXION } from "../../features/reglages/agents";
import { domaineReglages } from "../../features/reglages/domaine";
import BoutonChoix from "./BoutonChoix.vue";

const props = defineProps<{ navigateur: boolean }>();

const AIDE_ECRITURE = "Peut créer et modifier des fichiers de votre espace de travail.";
const AIDE_LECTURE_SEULE = "Lit et cherche seulement : rien n'est modifié, et le Terminal est retiré.";
const AIDE_PRIVEE = "Navigue dans une session vide, sans vos connexions, fermée à la fin de l'agent.";
const AIDE_COMPTE = "Navigue avec votre session connectée : il agit sur les sites comme vous.";

const rg = domaineReglages();
const choix = computed(() => rg.agentFormChoix);
const defautFichiers = computed(() => (choix.value.lectureSeule.defaut ? "lecture seule" : "écriture"));
const defautReflexion = computed(
  () => CHOIX_REFLEXION.find((c) => c.valeur === choix.value.reflexion.defaut)?.libelle.toLowerCase() ?? "",
);
const effetFichiers = computed(() => (choix.value.lectureSeule.valeur ? AIDE_LECTURE_SEULE : AIDE_ECRITURE));
const effetReflexion = computed(
  () => CHOIX_REFLEXION.find((c) => c.valeur === choix.value.reflexion.valeur)?.aide ?? "",
);
const effetNavigateur = computed(() => (choix.value.sessionWeb.valeur ? AIDE_COMPTE : AIDE_PRIVEE));
const avecNavigateur = computed(() => props.navigateur);
</script>

<template>
  <div v-if="rg.agentForm" class="flex flex-col gap-5">
    <div class="flex flex-col gap-2">
      <div class="flex items-center gap-2">
        <span id="agent-droits-fichiers" class="text-[13px] font-semibold text-slate-800">Fichiers</span>
        <span
          v-if="choix.lectureSeule.impose"
          class="inline-flex items-center gap-1 text-xs text-slate-600"
          title="Imposé par l'administrateur"
          data-agent-ro-impose
        >
          <i class="ph ph-lock-simple" aria-hidden="true"></i> Imposé
        </span>
        <button
          v-else-if="choix.lectureSeule.posee"
          type="button"
          class="min-h-7 px-1 text-xs underline text-blue-700 hover:text-blue-800 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          :title="'Revenir au défaut de l\'administrateur : ' + defautFichiers"
          data-agent-ro-defaut
          @click="rg.revenirDefautLectureSeule()"
        >
          Défaut
        </button>
      </div>
      <div
        class="flex flex-wrap gap-2.5"
        role="group"
        aria-labelledby="agent-droits-fichiers"
        aria-describedby="agent-droits-fichiers-effet"
        data-agent-fichiers
      >
        <BoutonChoix
          libelle="Écriture"
          :actif="!choix.lectureSeule.valeur"
          :desactive="choix.lectureSeule.impose"
          data-agent-ro="rw"
          @choisir="rg.choisirLectureSeule(false)"
        />
        <BoutonChoix
          libelle="Lecture seule"
          :actif="choix.lectureSeule.valeur"
          :desactive="choix.lectureSeule.impose"
          data-agent-ro="ro"
          @choisir="rg.choisirLectureSeule(true)"
        />
      </div>
      <p id="agent-droits-fichiers-effet" class="text-xs text-slate-600" data-agent-ro-effet>
        {{ effetFichiers }}
      </p>
    </div>
    <div class="flex flex-col gap-2">
      <div class="flex items-center gap-2">
        <span id="agent-droits-reflexion" class="text-[13px] font-semibold text-slate-800">Réflexion</span>
        <button
          v-if="choix.reflexion.posee"
          type="button"
          class="min-h-7 px-1 text-xs underline text-blue-700 hover:text-blue-800 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          :title="'Revenir au défaut de l\'administrateur : ' + defautReflexion"
          data-agent-refl-defaut
          @click="rg.revenirDefautReflexion()"
        >
          Défaut
        </button>
      </div>
      <div
        class="flex flex-wrap gap-2.5"
        role="group"
        aria-labelledby="agent-droits-reflexion"
        aria-describedby="agent-droits-reflexion-effet"
        data-agent-reflexion
      >
        <BoutonChoix
          v-for="c in CHOIX_REFLEXION"
          :key="c.valeur"
          :libelle="c.libelle"
          :actif="choix.reflexion.valeur === c.valeur"
          :data-agent-refl="c.valeur"
          @choisir="rg.choisirReflexion(c.valeur)"
        />
      </div>
      <p id="agent-droits-reflexion-effet" class="text-xs text-slate-600" data-agent-refl-effet>
        {{ effetReflexion }}
      </p>
    </div>
    <div class="flex flex-col gap-2">
      <div class="flex items-center gap-2">
        <span id="agent-droits-navigateur" class="text-[13px] font-semibold text-slate-800">Navigateur</span>
        <span
          v-if="avecNavigateur && !choix.sessionWeb.permise"
          class="inline-flex items-center gap-1 text-xs text-slate-600"
          title="L'administrateur interdit la session web du compte aux sous-agents"
          data-agent-session-interdite
        >
          <i class="ph ph-lock-simple" aria-hidden="true"></i> Interdit
        </span>
      </div>
      <template v-if="avecNavigateur">
        <div
          class="flex flex-wrap gap-2.5"
          role="group"
          aria-labelledby="agent-droits-navigateur"
          aria-describedby="agent-droits-navigateur-effet"
          data-agent-navigateur
        >
          <BoutonChoix
            libelle="Session privée"
            :actif="!choix.sessionWeb.valeur"
            data-agent-session="privee"
            @choisir="rg.choisirSessionWeb(false)"
          />
          <BoutonChoix
            libelle="Ma session web"
            :actif="choix.sessionWeb.valeur"
            :desactive="!choix.sessionWeb.permise"
            data-agent-session="compte"
            @choisir="rg.choisirSessionWeb(true)"
          />
        </div>
        <p id="agent-droits-navigateur-effet" class="text-xs text-slate-600" data-agent-session-effet>
          {{ effetNavigateur }}
        </p>
      </template>
      <p v-else class="text-xs text-slate-600" data-agent-sans-web>
        Sans objet : cet agent n'a pas d'outil web (onglet Outils).
      </p>
    </div>
  </div>
</template>
