<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/reglages/onglets/OngletApparence.vue — onglet « appearance » des Paramètres : thème, éditeur, mascotte. -->
<script setup lang="ts">
import { computed, onMounted } from "vue";

import BoutonAssistant from "../../communs/BoutonAssistant.vue";
import ChoixEditeur from "../ChoixEditeur.vue";
import { domaineReglages } from "../../../features/reglages/domaine";
import { sectionCourante } from "../../../features/reglages/sections";

const rg = domaineReglages();
const section = computed(() => sectionCourante(rg, "appearance"));
onMounted(() => void rg.chargerSkinsPerso());
</script>

<template>
  <!-- eslint-disable vue/multiline-html-element-content-newline -->
  <h3 class="sr-only">{{ section?.libelle }}</h3>
  <div class="space-y-5 max-w-xl">
    <div v-if="section?.id === 'theme'" class="bg-slate-50 rounded-xl">
      <div class="set-row">
        <i class="ph ph-moon text-slate-400 text-lg w-5" aria-hidden="true"></i>
        <div class="flex-1 min-w-0">
          <div
            id="set-theme-mode-lbl"
            class="text-sm text-slate-800"
            title="Système suit la préférence du poste. S'applique à tout : chat, barre latérale, fenêtres et éditeur."
          >
            Mode
          </div>
        </div>
        <div class="adm-seg" role="radiogroup" aria-labelledby="set-theme-mode-lbl">
          <button
            v-for="m in [
              { v: 'system', l: 'Système' },
              { v: 'light', l: 'Clair' },
              { v: 'dark', l: 'Sombre' },
            ]"
            :key="m.v"
            type="button"
            role="radio"
            :aria-checked="rg.themeMode === m.v ? 'true' : 'false'"
            class="adm-seg__btn"
            :class="rg.themeMode === m.v ? 'is-active' : ''"
            @click="rg.applyThemeMode(m.v)"
          >
            {{ m.l }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="section?.id === 'theme'">
      <label class="block text-xs font-medium text-slate-600 mb-2" for="set-skin">Habillage</label>
      <select
        id="set-skin"
        class="set-select w-full"
        :value="rg.settings.skin || ''"
        @change="rg.choisirHabillage(($event.target as HTMLSelectElement).value)"
      >
        <template v-if="rg.skinsPerso.length">
          <optgroup label="Habillages de l'instance">
            <option v-for="sk in rg.skinsInstance" :key="sk.id || 'defaut'" :value="sk.id">
              {{ sk.label }}
            </option>
          </optgroup>
          <optgroup label="Mes habillages">
            <option v-for="sk in rg.skinsPerso" :key="sk.id" :value="sk.id">{{ sk.label }}</option>
          </optgroup>
        </template>
        <template v-else>
          <option v-for="sk in rg.APP_SKINS" :key="sk.id || 'defaut'" :value="sk.id">
            {{ sk.label }}
          </option>
        </template>
      </select>
      <p class="text-xs text-slate-500 mt-1.5 leading-snug">{{ rg.skinCourant.desc }}</p>
    </div>

    <div v-if="section?.id === 'theme' && rg.skinCourant.palettes && rg.skinCourant.palettes.length > 1">
      <label class="block text-xs font-medium text-slate-600 mb-2" for="set-palette">Couleurs</label>
      <select id="set-palette" v-model="rg.settings.skin_palette" class="set-select w-full">
        <option v-for="p in rg.skinCourant.palettes" :key="p.id || 'defaut'" :value="p.id">
          {{ p.label }}
        </option>
      </select>
      <p
        v-if="rg.paletteCourante && rg.paletteCourante.desc"
        class="text-xs text-slate-500 mt-1.5 leading-snug"
      >
        {{ rg.paletteCourante.desc }}
      </p>
    </div>

    <div v-if="section?.id === 'editeur'" class="bg-slate-50 rounded-xl">
      <ChoixEditeur id-champ="set-editeur" />
    </div>

    <div v-if="section?.id === 'theme' && rg.persoDispo" id="set-mes-habillages">
      <div class="flex items-center gap-2 mb-2">
        <span class="block text-xs font-medium text-slate-600 flex-1">
          Mes habillages ({{ rg.skinsPerso.length }}/{{ rg.persoMax }})
        </span>
        <BoutonAssistant libelle="Créer avec l'assistant" @click="rg.ouvrirAssistant('apparence')" />
      </div>
      <p v-if="!rg.skinsPerso.length" class="text-xs text-slate-500 leading-snug">
        Aucun habillage personnel. L'assistant te propose un habillage que tu prévisualises puis importes
        toi-même.
      </p>
      <ul v-else class="space-y-1.5">
        <li
          v-for="sk in rg.skinsPerso"
          :key="sk.id"
          class="flex items-center gap-2 bg-slate-50 rounded-lg px-3 py-2"
        >
          <span class="inline-flex gap-0.5" aria-hidden="true">
            <span
              v-for="(c, i) in sk.sw"
              :key="i"
              class="w-4 h-4 rounded-full border border-slate-300 inline-block"
              :style="{ backgroundColor: c }"
            ></span>
          </span>
          <span class="text-sm text-slate-800 flex-1 min-w-0 truncate">{{ sk.label }}</span>
          <button type="button" class="skl-btn skl-btn--secondary" @click="rg.apercuHabillage(sk)">
            Aperçu
          </button>
          <button type="button" class="skl-btn skl-btn--danger" @click="rg.supprimerHabillage(sk)">
            Supprimer
          </button>
        </li>
      </ul>
    </div>

    <div v-if="section?.id === 'mascotte'">
      <label class="block text-xs font-medium text-slate-600 mb-2" for="set-mascotte"
        >Accueil d'un nouveau chat</label
      >
      <div class="flex items-start gap-3">
        <div class="flex-1 min-w-0">
          <select
            id="set-mascotte"
            class="set-select w-full"
            :value="rg.mascotteId"
            @change="rg.choisirAccueil(($event.target as HTMLSelectElement).value)"
          >
            <option v-for="m in rg.choixAccueil" :key="m.id || 'logo'" :value="m.id">
              {{ m.label }}
            </option>
          </select>

          <label v-if="rg.mascotteId" class="flex items-start gap-2 mt-2.5 cursor-pointer">
            <input
              type="checkbox"
              :checked="rg.settings.welcome_mascot_anime !== false"
              class="mt-0.5 rounded border-slate-300 text-blue-600"
              @change="rg.settings.welcome_mascot_anime = ($event.target as HTMLInputElement).checked"
            />
            <span class="text-xs text-slate-500 leading-snug">
              Animer l'accueil.
              <span v-if="rg.mouvementReduit" class="text-slate-400"
                >Ton système demande moins de mouvement : décoche pour rendre la scène à l'arrêt.</span
              >
              <span v-else class="text-slate-400"
                >La mascotte joue autour du mot ; décoche pour une image fixe.</span
              >
            </span>
          </label>
        </div>

        <div
          class="w-24 h-24 shrink-0 rounded-xl border border-slate-200 bg-slate-50 flex items-center justify-center overflow-hidden"
        >
          <span
            v-if="rg.mascotteId"
            class="socle-mascotte"
            aria-hidden="true"
            style="width: 96px; height: 96px"
            :data-perso="rg.mascotteId"
            data-etat="repos"
          ></span>
          <img
            v-else-if="rg.welcomeConfig && rg.welcomeConfig.type === 'image' && rg.welcomeConfig.image_b64"
            :src="rg.welcomeConfig.image_b64"
            alt=""
            aria-hidden="true"
            class="w-16 h-16 object-contain"
          />
          <i
            v-else
            class="ph text-5xl text-blue-500"
            aria-hidden="true"
            :class="(rg.welcomeConfig && rg.welcomeConfig.icon) || 'ph-sparkle'"
          ></i>
        </div>
      </div>
    </div>
  </div>
</template>
