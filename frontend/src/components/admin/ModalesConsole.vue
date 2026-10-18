<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/admin/ModalesConsole.vue — modales locales de la console (mot de passe, nouveau compte). -->
<script setup lang="ts">
import { domaineAdmin } from "../../features/admin/domaine";

const adm = domaineAdmin();
</script>

<template>
  <Transition name="modal">
    <div
      v-if="adm.resetTarget"
      class="fixed inset-0 z-[6000] flex items-center justify-center bg-slate-900/80 p-4"
      @click.self="adm.resetTarget = null"
    >
      <div
        class="bg-white p-6 rounded-2xl w-full max-w-sm shadow-2xl border border-slate-200"
        role="dialog"
        aria-modal="true"
        aria-label="Modifier le mot de passe"
        tabindex="-1"
        data-a11y-modal
      >
        <h3 class="font-bold mb-4 text-lg text-slate-800">
          Modifier <span class="text-blue-600">{{ adm.resetTarget.username }}</span>
        </h3>
        <input
          v-model="adm.newPasswordInput"
          placeholder="Nouveau mot de passe"
          autofocus
          class="w-full bg-slate-50 border border-slate-200 p-3 rounded-lg mb-5 outline-none focus:ring-1 focus:ring-blue-500 font-medium text-sm text-slate-700 transition-colors"
          @keydown.enter="adm.newPasswordInput && adm.confirmReset()"
        />
        <div class="flex justify-end gap-2">
          <button class="adm-btn adm-btn--quiet" @click="adm.resetTarget = null">Annuler</button>
          <button class="adm-btn adm-btn--primary" @click="adm.confirmReset">Appliquer</button>
        </div>
      </div>
    </div>
  </Transition>

  <Transition name="modal">
    <div
      v-if="adm.showNewUserModal"
      class="fixed inset-0 z-[6000] flex items-center justify-center bg-slate-900/80 p-4"
      @click.self="adm.showNewUserModal = false"
    >
      <div
        class="bg-white p-6 rounded-2xl w-full max-w-sm shadow-2xl border border-slate-200"
        role="dialog"
        aria-modal="true"
        aria-label="Nouvel utilisateur"
        tabindex="-1"
        data-a11y-modal
      >
        <h3 class="font-bold mb-4 text-lg text-slate-800 flex items-center gap-2">
          <i class="ph ph-user-plus text-blue-600"></i> Nouvel utilisateur
        </h3>
        <input
          v-model="adm.newUserForm.username"
          placeholder="Identifiant"
          autofocus
          class="w-full bg-slate-50 border border-slate-200 p-3 rounded-lg mb-3 outline-none focus:ring-1 focus:ring-blue-500 font-medium text-sm text-slate-700"
          @keydown.enter="
            (($event.target as HTMLInputElement).nextElementSibling as HTMLElement | null)?.focus()
          "
        />
        <input
          v-model="adm.newUserForm.password"
          placeholder="Mot de passe temporaire"
          type="text"
          class="w-full bg-slate-50 border border-slate-200 p-3 rounded-lg mb-3 outline-none focus:ring-1 focus:ring-blue-500 font-medium text-sm text-slate-700"
          @keydown.enter="adm.newUserForm.username && adm.newUserForm.password && adm.createUserAdmin()"
        />
        <div class="mb-5">
          <label class="block text-sm font-medium text-slate-700 mb-1">Rôle</label>
          <select
            v-model="adm.newUserForm.role"
            class="w-full bg-slate-50 border border-slate-200 p-3 rounded-lg outline-none focus:ring-1 focus:ring-blue-500 font-medium text-sm text-slate-700"
          >
            <option value="user">Utilisateur</option>
            <option value="moderator">Modérateur</option>
            <option value="admin">Administrateur</option>
          </select>
        </div>
        <div class="flex justify-end gap-2">
          <button class="adm-btn adm-btn--quiet" @click="adm.showNewUserModal = false">Annuler</button>
          <button
            :disabled="!adm.newUserForm.username || !adm.newUserForm.password"
            class="adm-btn adm-btn--primary"
            @click="adm.createUserAdmin"
          >
            Créer
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>
