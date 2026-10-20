<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/admin/RagLigneEssai.vue — ligne « État » d'un service du RAG : voyant, libellé, bouton d'essai et résultat de l'essai. -->
<script setup lang="ts">
import { domaineAdmin } from "../../features/admin/domaine";
import type { ServiceRagConsole } from "../../features/admin/rag";

defineProps<{
  service: ServiceRagConsole;
  etat: "ok" | "down" | "off" | "unknown";
  libelle: string;
}>();

const adm = domaineAdmin();
const ICONES = { ok: "ph-check-circle", down: "ph-x-circle", off: "ph-minus-circle", unknown: "ph-question" };
</script>

<template>
  <div class="adm-row adm-row--top">
    <span class="adm-row__label" title="Teste les valeurs saisies ci-dessus sans les enregistrer.">État</span>
    <div class="min-w-0">
      <div class="adm-rag-ligne">
        <span class="adm-status" :data-state="etat" role="status">
          <i class="ph" :class="ICONES[etat]" aria-hidden="true"></i>
          {{ libelle }}
        </span>
        <button
          type="button"
          class="adm-btn adm-tool adm-btn--sm"
          :disabled="adm.ragAdmEssais[service].state === 'busy'"
          @click="adm.ragAdmEssayer(service)"
        >
          <i
            class="ph"
            :class="adm.ragAdmEssais[service].state === 'busy' ? 'ph-circle-notch animate-spin' : 'ph-pulse'"
            aria-hidden="true"
          ></i>
          {{ adm.ragAdmEssais[service].state === "busy" ? "Test en cours…" : "Tester" }}
        </button>
      </div>
      <p
        v-if="adm.ragAdmEssais[service].state === 'ok'"
        class="adm-rag-resultat"
        data-state="ok"
        role="status"
      >
        <i class="ph ph-check-circle" aria-hidden="true"></i> {{ adm.ragAdmEssais[service].detail }}
      </p>
      <p
        v-else-if="adm.ragAdmEssais[service].state === 'err'"
        class="adm-rag-resultat"
        data-state="down"
        role="alert"
      >
        <i class="ph ph-x-circle" aria-hidden="true"></i> Échec : {{ adm.ragAdmEssais[service].detail }}
      </p>
    </div>
  </div>
</template>
