<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/reglages/onglets/OngletSecrets.vue — onglet « secrets » des Paramètres : coffre du compte (table, création web-login, http-auth et token). -->
<script setup lang="ts">
import { domaineReglages } from "../../../features/reglages/domaine";
import { fournirSecrets } from "../../../features/secrets/gestion";
import FormulaireSecret from "../../secrets/FormulaireSecret.vue";
import TableSecrets from "../../secrets/TableSecrets.vue";
import AideOnglet from "../AideOnglet.vue";

const rg = domaineReglages();
const g = rg.secretsCompte;
fournirSecrets(g);
</script>

<template>
  <!-- eslint-disable vue/multiline-html-element-content-newline -->
  <div class="space-y-4" data-onglet-secrets>
    <div class="flex items-start gap-3">
      <div class="flex-1 min-w-0">
        <AideOnglet titre="Secrets"
          >Valeur en écriture seule, utilisable seulement sur sa portée, jamais lue par le modèle.</AideOnglet
        >
      </div>
      <button
        v-if="!g.creation"
        type="button"
        class="adm-btn adm-tool adm-btn--sm shrink-0"
        data-nouveau-secret
        @click="g.nouveau()"
      >
        <i class="ph ph-plus" aria-hidden="true"></i> Nouveau
      </button>
    </div>
    <FormulaireSecret v-if="g.creation" mode="creation" />
    <TableSecrets />
  </div>
</template>
