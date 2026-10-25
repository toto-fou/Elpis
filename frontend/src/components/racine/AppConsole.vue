<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/racine/AppConsole.vue — racine de la console d'administration séparée (admin.html) : ni éditeur, ni pages du chat ; la console, le transfert, les détails d'exécution et les groupes. -->
<script setup lang="ts">
import { fournirDomaineAdmin } from "../../features/admin/domaine";
import { fournirDomaineModales } from "../../features/chat/modales/domaine";
import { creerRacine } from "../../app/racine/racine";
import { fournirDomainesRacine } from "../../app/racine/domaine";
import CoqueConsole from "../admin/CoqueConsole.vue";
import ModalesGroupes from "../admin/ModalesGroupes.vue";
import DetailsExecution from "../chat/modales/DetailsExecution.vue";
import ModaleTransfert from "../chat/modales/ModaleTransfert.vue";
import CartesConnexion from "./CartesConnexion.vue";
import ChromeApp from "./ChromeApp.vue";

const r = creerRacine();

fournirDomainesRacine(r);
fournirDomaineAdmin(r);
fournirDomaineModales(r, true);
</script>

<template>
  <ChromeApp />
  <CartesConnexion />

  <!-- Console verrouillée sur la vue d'administration (drapeau de page posé par l'entrée). -->
  <div v-if="r.user" class="h-full w-full flex bg-slate-50 overflow-hidden">
    <CoqueConsole />
    <ModaleTransfert />
    <DetailsExecution />
    <ModalesGroupes />
  </div>
</template>
