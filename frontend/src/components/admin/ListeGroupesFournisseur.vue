<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/admin/ListeGroupesFournisseur.vue — tiroir d'un fournisseur d'identité : une liste de groupes (pastilles à retirer, saisie, bouton Ajouter). -->
<script setup lang="ts">
import { computed } from "vue";

import { domaineAdmin } from "../../features/admin/domaine";
import { SAISIES } from "../../features/admin/identite";

const props = defineProps<{
  liste: keyof typeof SAISIES;
  champ: string;
  label: string;
  indice: string;
  exemple?: string;
  attrAjouter?: Record<string, string>;
}>();

const adm = domaineAdmin();
const f = computed(() => adm.authTiroir);
const general = computed(() => adm.authFige(""));
</script>

<template>
  <div v-if="f" class="adm-field">
    <label class="adm-field__label" :for="props.champ">{{ props.label }}</label>
    <ul v-if="f[props.liste].length" class="flex flex-wrap gap-1.5" :aria-label="props.label">
      <li v-for="(g, i) in f[props.liste]" :key="g" class="adm-pill">
        <span class="font-mono">{{ g }}</span>
        <button
          type="button"
          class="adm-link"
          :aria-label="'Retirer ' + g"
          :disabled="!!general"
          @click="adm.authRetirerGroupe(props.liste, i)"
        >
          <i class="ph ph-x" aria-hidden="true"></i>
        </button>
      </li>
    </ul>
    <div class="adm-field__row">
      <input
        :id="props.champ"
        v-model="f[SAISIES[props.liste]]"
        class="set-input flex-1"
        :placeholder="props.exemple"
        :disabled="!!general"
        :title="general || props.indice"
        @keydown.enter.prevent="adm.authAjouterGroupe(props.liste)"
      />
      <button
        type="button"
        class="adm-btn adm-btn--quiet adm-btn--sm"
        v-bind="props.attrAjouter"
        :disabled="!!general || f[SAISIES[props.liste]].trim() === ''"
        @click="adm.authAjouterGroupe(props.liste)"
      >
        Ajouter
      </button>
    </div>
  </div>
</template>
