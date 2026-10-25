<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/reglages/onglets/OngletProfil.vue — onglet « profile » des Paramètres. -->
<script setup lang="ts">
import AideOnglet from "../AideOnglet.vue";
import { domaineReglages } from "../../../features/reglages/domaine";

const rg = domaineReglages();
</script>

<template>
  <!-- eslint-disable vue/multiline-html-element-content-newline -->
  <div class="space-y-5 max-w-xl">
    <AideOnglet titre="Profil">Vos informations de compte.</AideOnglet>

    <div class="flex items-center gap-4 p-4 bg-slate-50 rounded-xl">
      <div class="w-14 h-14 rounded-xl flex items-center justify-center shrink-0 overflow-hidden">
        <img v-if="rg.user.avatar" :src="'/avatars/' + rg.user.avatar" class="w-full h-full object-cover" />
        <div
          v-else
          class="w-full h-full bg-blue-600 flex items-center justify-center text-white font-bold text-xl"
        >
          {{ rg.user.username.substring(0, 2).toUpperCase() }}
        </div>
      </div>
      <div class="flex-1 min-w-0">
        <div class="font-semibold text-slate-800">{{ rg.user.username }}</div>
        <div
          class="text-xs font-semibold mt-0.5"
          :class="
            rg.user.role === 'admin'
              ? 'elpis-role-admin'
              : rg.user.role === 'moderator'
                ? 'text-amber-600'
                : 'text-slate-500'
          "
        >
          {{
            rg.user.role === "admin"
              ? "Administrateur"
              : rg.user.role === "moderator"
                ? "Modérateur"
                : "Utilisateur"
          }}
        </div>
      </div>
      <div class="flex items-center gap-1.5 shrink-0">
        <label
          class="px-3 py-1.5 bg-white border border-slate-200 hover:bg-slate-50 rounded-md text-xs font-medium text-slate-600 cursor-pointer transition-colors"
          >Photo<input type="file" class="hidden" accept="image/*" @change="rg.uploadAvatar"
        /></label>
        <button
          v-if="rg.user.avatar"
          aria-label="Supprimer la photo"
          class="px-2 py-1.5 bg-white border border-slate-200 hover:bg-red-50 hover:border-red-200 hover:text-red-600 text-slate-500 rounded-md text-xs transition-colors"
          @click="rg.removeAvatar"
        >
          <i class="ph ph-trash" aria-hidden="true"></i>
        </button>
      </div>
    </div>

    <div class="set-block">
      <div
        class="flex items-center justify-between cursor-pointer"
        @click="rg.showPasswordChange = !rg.showPasswordChange"
      >
        <div class="flex items-center gap-2 text-sm font-medium text-slate-700">
          <i class="ph ph-lock-key text-slate-400"></i> Mot de passe
        </div>
        <i
          class="ph text-slate-400 text-xs transition-transform"
          :class="rg.showPasswordChange ? 'ph-caret-up' : 'ph-caret-down'"
        ></i>
      </div>
      <div v-if="rg.showPasswordChange" class="space-y-2.5 mt-3 pt-3 border-t border-slate-100">
        <input
          v-model="rg.passwordForm.old_password"
          type="password"
          aria-label="Mot de passe actuel"
          placeholder="Mot de passe actuel"
          class="set-input"
        />
        <input
          v-model="rg.passwordForm.new_password"
          type="password"
          aria-label="Nouveau mot de passe"
          placeholder="Nouveau mot de passe"
          class="set-input"
        />
        <input
          v-model="rg.passwordForm.confirm_password"
          type="password"
          aria-label="Confirmation du mot de passe"
          placeholder="Confirmation"
          class="set-input"
        />
        <p
          v-if="
            rg.passwordForm.new_password &&
            rg.passwordForm.confirm_password &&
            rg.passwordForm.new_password !== rg.passwordForm.confirm_password
          "
          role="alert"
          class="text-xs text-red-500"
        >
          Les mots de passe ne correspondent pas.
        </p>
        <button
          :disabled="
            rg.passwordSaving ||
            !rg.passwordForm.old_password ||
            !rg.passwordForm.new_password ||
            rg.passwordForm.new_password !== rg.passwordForm.confirm_password
          "
          class="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white py-2 rounded-lg font-medium text-sm transition-colors inline-flex items-center justify-center gap-2"
          @click="rg.changeMyPassword"
        >
          <i v-if="rg.passwordSaving" class="ph ph-spinner-gap animate-spin" aria-hidden="true"></i>
          {{ rg.passwordSaving ? "Mise à jour…" : "Mettre à jour" }}
        </button>
      </div>
    </div>
  </div>
</template>
