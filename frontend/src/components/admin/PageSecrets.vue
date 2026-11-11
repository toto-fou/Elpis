<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/admin/PageSecrets.vue — page Modèles et services › Secrets : secrets de l'instance (connecteurs LLM et serveurs MCP partagés, moteur d'images), rotation et suppression. -->
<script setup lang="ts">
import { domaineAdmin } from "../../features/admin/domaine";
import { fournirSecrets } from "../../features/secrets/gestion";
import TableSecrets from "../secrets/TableSecrets.vue";

const adm = domaineAdmin();
fournirSecrets(adm.secretsInstance);
</script>

<template>
  <div v-if="adm.adminTab === 'secrets'" class="animate-[fadeIn_0.2s]">
    <section id="secrets" class="adm-card elpis-secrets-carte scroll-mt-32">
      <header class="adm-card__head">
        <i class="ph ph-vault adm-card__icon" aria-hidden="true"></i>
        <div>
          <h3 class="adm-card__title">
            Secrets de l'instance
            <span v-if="adm.secretsInstance.charge" class="font-normal text-slate-500"
              >· {{ adm.secretsInstance.secrets.length }}</span
            >
          </h3>
          <span class="sr-only"
            >Clés des connecteurs LLM et des serveurs MCP partagés, moteur d'images : valeurs en écriture
            seule.</span
          >
        </div>
        <button
          type="button"
          class="ml-auto adm-btn adm-btn--icon"
          title="Rafraîchir"
          aria-label="Rafraîchir les secrets de l'instance"
          :disabled="adm.secretsInstance.chargement"
          @click="adm.loadInstanceSecrets()"
        >
          <i class="ph ph-arrow-clockwise" aria-hidden="true"></i>
        </button>
      </header>
      <div class="px-4 pb-3">
        <TableSecrets />
      </div>
    </section>
  </div>
</template>
