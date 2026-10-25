<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/racine/CartesConnexion.vue — cartes affichées sans session : connexion (habillage de /api/public-config) ou changement forcé du mot de passe. -->
<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";

import { CLE_CONNEXION, domaineRacine } from "../../app/racine/domaine";

const a = domaineRacine(CLE_CONNEXION);
const lc = computed(() => a.loginConfig as Record<string, string | undefined>);
// Logo servi par le backend : chemin laissé tel quel (pas d'import d'asset Vite).
const LOGO = "static/elpis-256.png";

const CHAMP =
  "w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-700 focus:bg-white focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none transition-colors";
const mdp = ref<HTMLInputElement | null>(null);
const nouveau = ref<HTMLInputElement | null>(null);
const confirmation = ref<HTMLInputElement | null>(null);
const confirmer = ref("");
const erreurForce = ref("");
const voir = ref({ mdp: false, nouveau: false, confirmer: false });

watch(
  () => a.loginError,
  async (erreur) => {
    if (!erreur) return;
    await nextTick();
    mdp.value?.focus();
  },
);

async function appliquer(): Promise<void> {
  erreurForce.value = "";
  if (!a.newPasswordForce) {
    erreurForce.value = "Saisissez un nouveau mot de passe.";
    nouveau.value?.focus();
  } else if (a.newPasswordForce !== confirmer.value) {
    erreurForce.value = "Les deux saisies diffèrent.";
    await nextTick();
    confirmation.value?.focus();
  } else {
    await a.submitForcePasswordChange();
  }
}
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
        <div>
          <label for="login-identifiant" class="block text-sm font-medium text-slate-600 mb-1"
            >Identifiant</label
          >
          <input
            id="login-identifiant"
            v-model="a.loginForm.username"
            type="text"
            autocomplete="username"
            :aria-invalid="a.loginError ? 'true' : undefined"
            :aria-describedby="a.loginError ? 'login-erreur' : undefined"
            :class="CHAMP"
          />
        </div>
        <div>
          <label for="login-mdp" class="block text-sm font-medium text-slate-600 mb-1">Mot de passe</label>
          <div class="relative">
            <input
              id="login-mdp"
              ref="mdp"
              v-model="a.loginForm.password"
              :type="voir.mdp ? 'text' : 'password'"
              autocomplete="current-password"
              :aria-invalid="a.loginError ? 'true' : undefined"
              :aria-describedby="a.loginError ? 'login-erreur' : undefined"
              :class="CHAMP + ' pr-11'"
            />
            <button
              type="button"
              :aria-label="voir.mdp ? 'Masquer le mot de passe' : 'Afficher le mot de passe'"
              :aria-pressed="voir.mdp"
              class="absolute right-1 top-1/2 -translate-y-1/2 w-8 h-8 rounded-md text-slate-500 hover:bg-slate-100 flex items-center justify-center"
              @click="voir.mdp = !voir.mdp"
            >
              <i class="ph" :class="voir.mdp ? 'ph-eye-slash' : 'ph-eye'" aria-hidden="true"></i>
            </button>
          </div>
        </div>
        <div
          v-if="a.loginError"
          id="login-erreur"
          role="alert"
          class="text-red-600 text-center text-sm font-medium"
        >
          {{ a.loginError }}
        </div>
        <button
          type="submit"
          :disabled="a.isLoading"
          class="w-full text-white font-medium py-2.5 rounded-lg transition-colors shadow-sm flex items-center justify-center gap-2"
          :style="'background:' + (lc.btn_color || '#0f172a')"
        >
          <i v-if="a.isLoading" class="ph ph-spinner animate-spin"></i
          ><span>{{ a.isLoading ? "Connexion…" : "Se connecter" }}</span>
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
        <h1 class="text-xl font-bold text-slate-800">Nouveau mot de passe</h1>
        <p class="text-sm text-slate-500 mt-2">Exigé par l’administrateur avant de continuer.</p>
      </div>
      <form class="space-y-4" novalidate @submit.prevent="appliquer">
        <div>
          <label for="force-nouveau" class="block text-sm font-medium text-slate-600 mb-1"
            >Nouveau mot de passe</label
          >
          <div class="relative">
            <input
              id="force-nouveau"
              ref="nouveau"
              v-model="a.newPasswordForce"
              :type="voir.nouveau ? 'text' : 'password'"
              autocomplete="new-password"
              :class="CHAMP + ' pr-11'"
            />
            <button
              type="button"
              :aria-label="voir.nouveau ? 'Masquer le mot de passe' : 'Afficher le mot de passe'"
              :aria-pressed="voir.nouveau"
              class="absolute right-1 top-1/2 -translate-y-1/2 w-8 h-8 rounded-md text-slate-500 hover:bg-slate-100 flex items-center justify-center"
              @click="voir.nouveau = !voir.nouveau"
            >
              <i class="ph" :class="voir.nouveau ? 'ph-eye-slash' : 'ph-eye'" aria-hidden="true"></i>
            </button>
          </div>
        </div>
        <div>
          <label for="force-confirmer" class="block text-sm font-medium text-slate-600 mb-1">Confirmer</label>
          <div class="relative">
            <input
              id="force-confirmer"
              ref="confirmation"
              v-model="confirmer"
              :type="voir.confirmer ? 'text' : 'password'"
              autocomplete="new-password"
              :aria-invalid="erreurForce ? 'true' : undefined"
              :aria-describedby="erreurForce ? 'force-erreur' : undefined"
              :class="CHAMP + ' pr-11'"
            />
            <button
              type="button"
              :aria-label="voir.confirmer ? 'Masquer le mot de passe' : 'Afficher le mot de passe'"
              :aria-pressed="voir.confirmer"
              class="absolute right-1 top-1/2 -translate-y-1/2 w-8 h-8 rounded-md text-slate-500 hover:bg-slate-100 flex items-center justify-center"
              @click="voir.confirmer = !voir.confirmer"
            >
              <i class="ph" :class="voir.confirmer ? 'ph-eye-slash' : 'ph-eye'" aria-hidden="true"></i>
            </button>
          </div>
        </div>
        <div
          v-if="erreurForce"
          id="force-erreur"
          role="alert"
          class="text-red-600 text-center text-sm font-medium"
        >
          {{ erreurForce }}
        </div>
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
