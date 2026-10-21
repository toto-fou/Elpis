<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/reglages/onglets/OngletApparence.vue — onglet « appearance » des Paramètres. -->
<script setup lang="ts">
import { domaineReglages } from "../../../features/reglages/domaine";

const rg = domaineReglages();
</script>

<template>
  <!-- eslint-disable vue/multiline-html-element-content-newline -->
  <div class="space-y-5 max-w-xl">
    <div>
      <h3 class="text-base font-semibold text-slate-800 mb-1">Apparence</h3>
      <p class="text-xs text-slate-500">Identité visuelle de l'assistant dans le chat.</p>
    </div>

    <div class="bg-slate-50 rounded-xl">
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

    <div>
      <label class="block text-xs font-medium text-slate-600 mb-2" for="set-skin">Habillage</label>
      <select
        id="set-skin"
        class="set-select w-full"
        :value="rg.settings.skin || ''"
        @change="rg.settings.skin = ($event.target as HTMLInputElement).value"
      >
        <option v-for="sk in rg.APP_SKINS" :key="sk.id || 'defaut'" :value="sk.id">
          {{ sk.label }}
        </option>
      </select>
      <p class="text-[11px] text-slate-500 mt-1.5 leading-snug">{{ rg.skinCourant.desc }}</p>
    </div>

    <div v-if="rg.mascottesOffertes">
      <label class="block text-xs font-medium text-slate-600 mb-2" for="set-mascotte">Mascotte</label>
      <div class="flex items-start gap-3">
        <div class="flex-1 min-w-0">
          <select
            id="set-mascotte"
            class="set-select w-full"
            :value="rg.settings.welcome_mascot ?? 'boite_or'"
            @change="rg.settings.welcome_mascot = ($event.target as HTMLInputElement).value"
          >
            <option v-for="m in rg.MASCOTTES" :key="m.id || 'logo'" :value="m.id">
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
            <span class="text-[11px] text-slate-500 leading-snug">
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

    <div>
      <label class="block text-xs font-medium text-slate-600 mb-1.5" for="set-assistant-nom"
        >Nom de l'assistant</label
      >
      <div class="flex items-center gap-3">
        <img
          :src="rg.logoApp"
          alt=""
          data-avatar-assistant
          class="w-10 h-10 rounded-full object-cover shrink-0 border border-slate-200"
        />
        <input
          id="set-assistant-nom"
          v-model="rg.settings.assistant_name"
          type="text"
          placeholder="Assistant"
          class="set-input font-medium text-slate-800"
        />
      </div>
      <p class="text-[11px] text-slate-500 mt-1.5 leading-snug">
        L'avatar de l'assistant est le logo de l'application, choisi par l'administrateur.
      </p>
    </div>
  </div>
</template>
