<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/reglages/onglets/OngletSecrets.vue — onglet « secrets » des Paramètres : coffre du compte (table, création web-login, http-auth et token). -->
<script setup lang="ts">
import { domaineReglages } from "../../../features/reglages/domaine";
import { fournirSecrets } from "../../../features/secrets/gestion";
import FormulaireSecret from "../../secrets/FormulaireSecret.vue";
import TableSecrets from "../../secrets/TableSecrets.vue";

const rg = domaineReglages();
const g = rg.secretsCompte;
fournirSecrets(g);
</script>

<template>
  <div class="space-y-4" data-onglet-secrets>
    <div v-if="!g.creation" class="flex justify-end">
      <button type="button" class="adm-btn adm-tool adm-btn--sm" data-nouveau-secret @click="g.nouveau()">
        <i class="ph ph-plus" aria-hidden="true"></i> Nouveau
      </button>
    </div>
    <FormulaireSecret v-if="g.creation" mode="creation" />
    <TableSecrets />
    <p class="text-xs text-slate-500" data-secrets-ailleurs>
      Les clés des modèles IA, des serveurs MCP et des comptes Git se gèrent dans leurs menus ; un jeton Git
      importé reste ici jusqu'à sa vérification.
    </p>
  </div>
</template>
