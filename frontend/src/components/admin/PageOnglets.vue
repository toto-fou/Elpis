<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/admin/PageOnglets.vue — page de la console à sous-onglets (Activité, Journaux) : barre d'onglets, sans barre quand il n'en reste qu'un, et emplacement du contenu de l'onglet actif. -->
<script setup lang="ts">
import { computed } from "vue";

import { domaineAdmin } from "../../features/admin/domaine";
import SousOngletsConsole from "./SousOngletsConsole.vue";

const props = defineProps<{ page: string; label: string }>();
defineSlots<{ default(p: { onglet: string }): unknown }>();

const adm = domaineAdmin();
const onglets = computed(() => adm.ongletsOuvrables(props.page).map((o) => ({ ...o, modifie: false })));
const avecBarre = computed(() => onglets.value.length > 1);
const onglet = computed({
  get: () => adm.ongletActif(props.page),
  set: (v: string) => void adm.goAdminOnglet(props.page, v),
});
</script>

<template>
  <div v-if="adm.adminTab === page" class="animate-[fadeIn_0.2s] space-y-3">
    <SousOngletsConsole v-if="avecBarre" v-model="onglet" :label="label" :page="page" :onglets="onglets" />
    <div
      :id="avecBarre ? 'onglet-' + page + '-' + onglet : undefined"
      :role="avecBarre ? 'tabpanel' : undefined"
      :aria-labelledby="avecBarre ? 'onglet-bouton-' + page + '-' + onglet : undefined"
    >
      <slot :onglet="onglet" />
    </div>
  </div>
</template>
