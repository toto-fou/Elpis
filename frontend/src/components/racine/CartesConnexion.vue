<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/racine/CartesConnexion.vue — cartes affichées sans session : connexion (habillage de /api/public-config) ou changement forcé du mot de passe. -->
<script setup lang="ts">
import { computed } from "vue";

import { CLE_CONNEXION, domaineRacine } from "../../app/racine/domaine";

const a = domaineRacine(CLE_CONNEXION);
const lc = computed(() => a.loginConfig as Record<string, string | undefined>);
// Logo servi par le backend : chemin laissé tel quel (pas d'import d'asset Vite).
const LOGO = "static/elpis-256.png";
</script>

<template>
  <!-- z-[9990] : au-dessus des fenêtres hors des blocs « connecté » (transfert 6000, confirmation 7000, menu 8000),
       peintes sinon par-dessus le formulaire quand la session expire fenêtre ouverte. -->
  <div
    v-if="!a.user && !a.mustChangePassword"
    class="fixed inset-0 z-[9990] flex items-center justify-center p-4"
    :style="lc.bg_color ? 'background:' + lc.bg_color : 'background:#f8fafc'"
  >
    <div
      class="rounded-2xl shadow-xl ring-1 ring-slate-200 p-8 w-full max-w-sm"
      :style="'background:' + (lc.card_color || '#ffffff')"
    >
      <div class="text-center mb-6">
        <div
          v-if="lc.icon_type === 'image' && lc.logo_b64"
          class="w-16 h-16 rounded-2xl mx-auto flex items-center justify-center mb-4 overflow-hidden shadow-md"
        >
          <img :src="lc.logo_b64" class="w-full h-full object-cover" />
        </div>
        <div v-else class="w-16 h-16 rounded-2xl mx-auto mb-4 overflow-hidden shadow-md">
          <img :src="LOGO" alt="Elpis" class="w-full h-full object-cover" />
        </div>
        <h1 class="text-2xl font-bold" :style="lc.text_color ? 'color:' + lc.text_color : 'color:#1e293b'">
          {{ lc.title || "Connexion" }}
        </h1>
        <p
          v-if="lc.subtitle"
          class="text-sm mt-1"
          :style="lc.text_color ? 'color:' + lc.text_color + ';opacity:.65' : 'color:#64748b'"
        >
          {{ lc.subtitle }}
        </p>
      </div>
      <form class="space-y-4" @submit.prevent="a.login">
        <input
          v-model="a.loginForm.username"
          type="text"
          aria-label="Identifiant"
          autocomplete="username"
          placeholder="Identifiant"
          class="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-700 focus:bg-white focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none transition-colors"
        />
        <input
          v-model="a.loginForm.password"
          type="password"
          aria-label="Mot de passe"
          autocomplete="current-password"
          placeholder="Mot de passe"
          class="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-700 focus:bg-white focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none transition-colors"
        />
        <div v-if="a.loginError" class="text-red-500 text-center text-sm font-medium">{{ a.loginError }}</div>
        <button
          type="submit"
          :disabled="a.isLoading"
          class="w-full text-white font-medium py-2.5 rounded-lg transition-colors shadow-sm flex items-center justify-center gap-2"
          :style="'background:' + (lc.btn_color || '#0f172a')"
        >
          <i v-if="a.isLoading" class="ph ph-spinner animate-spin"></i
          ><span>{{ a.isLoading ? "Connexion..." : "Se connecter" }}</span>
        </button>
      </form>
    </div>
  </div>

  <div
    v-else-if="!a.user && a.mustChangePassword"
    class="fixed inset-0 z-[9990] flex items-center justify-center bg-slate-50 p-4"
  >
    <div
      class="bg-white rounded-2xl shadow-xl ring-1 ring-slate-200 p-8 w-full max-w-sm animate-[slideUp_0.2s]"
    >
      <div class="text-center mb-6">
        <div
          class="w-16 h-16 bg-orange-500 rounded-2xl mx-auto flex items-center justify-center mb-4 shadow-md shadow-orange-500/30"
        >
          <i class="ph ph-lock-key text-3xl text-white"></i>
        </div>
        <h1 class="text-xl font-bold text-slate-800">Action requise</h1>
        <p class="text-sm text-slate-500 mt-2">
          Pour des raisons de sécurité, vous devez modifier votre mot de passe temporaire avant de continuer.
        </p>
      </div>
      <form class="space-y-4" @submit.prevent="a.submitForcePasswordChange">
        <input
          v-model="a.newPasswordForce"
          type="password"
          aria-label="Nouveau mot de passe"
          autocomplete="new-password"
          placeholder="Nouveau mot de passe"
          required
          class="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-700 focus:bg-white focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none transition-colors"
        />
        <button
          type="submit"
          :disabled="a.isLoading"
          class="w-full bg-slate-900 hover:bg-slate-800 text-white font-medium py-2.5 rounded-lg transition-colors shadow-sm flex items-center justify-center gap-2"
        >
          <i v-if="a.isLoading" class="ph ph-spinner animate-spin"></i><span>Appliquer et continuer</span>
        </button>
      </form>
    </div>
  </div>
</template>
