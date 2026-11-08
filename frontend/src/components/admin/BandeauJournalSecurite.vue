<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/admin/BandeauJournalSecurite.vue — Journaux › Sécurité : bandeau d'état du journal (conservation, gel, centralisation, horloge, disque, signature, alertes). -->
<script setup lang="ts">
import { computed } from "vue";

import { domaineAdmin } from "../../features/admin/domaine";
import { cellulesBandeau, resumeEcrivains } from "../../features/admin/journal-securite-affichage";
import { heureLocale, isoUtc } from "../../features/admin/horodatage";

const adm = domaineAdmin();
const etat = computed(() => adm.secuEtat);
const cellules = computed(() => (etat.value ? cellulesBandeau(etat.value) : []));
</script>

<template>
  <section class="adm-card" aria-label="État du journal de sécurité">
    <div v-if="!etat" class="px-4 py-3 text-xs adm-muted" role="status">
      <template v-if="adm.secuEtatEchec">
        <i class="ph ph-warning-circle" aria-hidden="true"></i> État du journal indisponible.
        <button type="button" class="adm-link" @click="adm.loadJournalEtat()">Réessayer</button>
      </template>
      <template v-else>
        <span class="adm-skeleton inline-block h-3 w-64 align-middle" aria-hidden="true"></span>
        <span class="sr-only">Chargement de l'état du journal…</span>
      </template>
    </div>
    <template v-else>
      <div class="sup-secu-bandeau">
        <div v-for="c in cellules" :key="c.cle" class="sup-secu-bandeau__cell" :title="c.detail">
          <div class="sup-secu-bandeau__lbl">{{ c.libelle }}</div>
          <div class="sup-secu-bandeau__val">
            <span class="adm-status" :data-state="c.etat"
              ><i class="ph" :class="c.icone" aria-hidden="true"></i> {{ c.valeur }}</span
            >
          </div>
          <div class="sup-secu-bandeau__det">{{ c.detail }}</div>
        </div>
      </div>
      <ul v-if="etat.alerts.length" class="sup-secu-alertes" aria-label="Alertes du journal">
        <li v-for="a in etat.alerts" :key="a.id" :data-niveau="a.level">
          <i class="ph" :class="a.level === 'info' ? 'ph-info' : 'ph-warning'" aria-hidden="true"></i>
          <span
            ><b>{{ a.title }}</b> {{ a.detail }}</span
          >
        </li>
      </ul>
      <div class="sup-secu-bandeau__pied">
        <span v-if="etat.signed"
          ><i class="ph ph-seal-check" aria-hidden="true"></i> Signé · clé
          <span class="sup-mono">{{ etat.kid }}</span></span
        >
        <span v-else class="sup-secu-avert"
          ><i class="ph ph-seal-warning" aria-hidden="true"></i> Non signé : clé absente</span
        >
        <span aria-hidden="true">·</span>
        <span class="sup-mono">{{ etat.directory }}</span>
        <template v-if="etat.write_failures.count">
          <span aria-hidden="true">·</span>
          <span class="sup-secu-danger" :title="etat.write_failures.last_error ?? undefined"
            ><i class="ph ph-warning-octagon" aria-hidden="true"></i>
            {{ etat.write_failures.count }} écritures en échec</span
          >
        </template>
        <span aria-hidden="true">·</span>
        <span>{{ resumeEcrivains(etat) }}</span>
        <span aria-hidden="true">·</span>
        <span :title="isoUtc(etat.generated_at)">État de {{ heureLocale(etat.generated_at).slice(-8) }}</span>
        <button
          type="button"
          class="adm-link sup-secu-bandeau__lien"
          @click="adm.goAdminPage('audit-logging')"
        >
          Régler la journalisation <i class="ph ph-arrow-right" aria-hidden="true"></i>
        </button>
      </div>
    </template>
  </section>
</template>
