<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/reglages/onglets/OngletSecrets.vue — Paramètres › Secrets › Secrets web : coffre du compte, un bloc par secret comme les autres parties, création (web-login, http-auth, token) en bas. -->
<script setup lang="ts">
import { domaineReglages } from "../../../features/reglages/domaine";
import { fournirSecrets } from "../../../features/secrets/gestion";
import FormulaireSecret from "../../secrets/FormulaireSecret.vue";
import ListeSecrets from "../../secrets/ListeSecrets.vue";

const rg = domaineReglages();
const g = rg.secretsCompte;
fournirSecrets(g);
</script>

<template>
  <div class="space-y-5 max-w-2xl" data-onglet-secrets>
    <p class="text-xs text-slate-500 leading-snug" data-regle>
      Identifiants et jetons que l'assistant utilise sur vos sites : chiffrés dans le coffre, il n'en voit
      jamais la valeur.
    </p>
    <ListeSecrets />
    <FormulaireSecret v-if="g.creation" mode="creation" />
    <button
      v-else
      type="button"
      class="w-full px-3 py-2 border border-dashed border-slate-300 rounded-lg text-sm text-slate-500 hover:border-blue-300 hover:text-blue-600 transition-colors flex items-center justify-center gap-1.5"
      data-nouveau-secret
      @click="g.nouveau()"
    >
      <i class="ph ph-plus" aria-hidden="true"></i> Nouveau secret
    </button>
    <p class="text-xs text-slate-500" data-secrets-ailleurs>
      Les clés des modèles IA et des serveurs MCP se gèrent dans leurs menus ; un jeton Git importé reste ici
      jusqu'à sa vérification.
    </p>
  </div>
</template>
