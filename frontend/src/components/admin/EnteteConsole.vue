<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/admin/EnteteConsole.vue — en-tête de page de la console. -->
<script setup lang="ts">
import { computed } from "vue";

import { groupeDeplie } from "../../features/admin/arbre";
import { domaineAdmin } from "../../features/admin/domaine";
import { interfaceApp } from "../../features/reglages/interface";

const adm = domaineAdmin();
const ui = interfaceApp();
const parent = computed(() => (ui.classique ? adm.adminPage.entryLabel : groupeDeplie(adm.adminPage.id)));
</script>

<template>
  <header class="adm-page-head">
    <div class="adm-col adm-page-head__in" :class="{ 'adm-col--wide': adm.adminPage.wide }">
      <button
        type="button"
        class="lg:hidden adm-btn adm-btn--icon -ml-2"
        title="Afficher ou masquer le panneau"
        aria-label="Afficher ou masquer le panneau"
        @click="adm.showSidebar = !adm.showSidebar"
      >
        <i class="ph ph-list text-lg" aria-hidden="true"></i>
      </button>
      <div class="adm-page-head__titles">
        <div v-if="parent && parent !== adm.adminPage.label" class="adm-page-head__parent">
          {{ parent }}
        </div>
        <h1
          :ref="
            (el) => {
              adm.adminH1 = el as typeof adm.adminH1;
            }
          "
          tabindex="-1"
          class="adm-page-head__title"
        >
          {{ adm.adminPage.label }}
        </h1>
      </div>

      <div class="adm-page-head__side">
        <template v-if="adm.adminTab === 'accounts'">
          <div class="relative">
            <i
              class="ph ph-magnifying-glass absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 text-sm"
              aria-hidden="true"
            ></i>
            <input
              v-model="adm.usersSearch"
              placeholder="Nom ou groupe"
              aria-label="Filtrer les comptes"
              class="set-input w-56 pl-8"
            />
          </div>
          <button
            type="button"
            title="Recharger la liste"
            aria-label="Recharger la liste"
            class="adm-btn adm-btn--icon"
            @click="adm.loadUsers(true)"
          >
            <i class="ph ph-arrow-clockwise" aria-hidden="true"></i>
          </button>
          <button type="button" class="adm-btn adm-btn--primary" @click="adm.showNewUserModal = true">
            <i class="ph ph-user-plus text-base" aria-hidden="true"></i> Créer un compte
          </button>
        </template>

        <template v-else-if="adm.adminTab === 'overview'">
          <span v-if="adm.overviewAge" class="adm-page-head__meta" aria-live="off"
            >Actualisé {{ adm.overviewAge }}</span
          >
          <button
            type="button"
            class="adm-btn adm-btn--icon"
            :disabled="adm.overviewLoading"
            title="Actualiser"
            aria-label="Actualiser"
            @click="adm.loadOverview(adm.adminIsAdmin)"
          >
            <i
              class="ph ph-arrow-clockwise"
              :class="adm.overviewLoading ? 'animate-spin' : ''"
              aria-hidden="true"
            ></i>
          </button>
        </template>

        <template v-else-if="adm.adminTab === 'prompts'">
          <button
            type="button"
            :disabled="adm.promptsLoading"
            class="adm-btn adm-btn--quiet"
            @click="adm.loadSystemPrompts()"
          >
            <i
              class="ph ph-arrow-clockwise"
              :class="adm.promptsLoading ? 'animate-spin' : ''"
              aria-hidden="true"
            ></i>
            Recharger
          </button>
        </template>
      </div>
    </div>
  </header>
</template>
