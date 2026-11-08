<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/admin/EtatActualisation.vue — état d'actualisation d'une page de la Supervision : en cours, heure de la dernière mise à jour ou échec, actualisation automatique, bouton Actualiser. -->
<script setup lang="ts">
import { computed } from "vue";

import { formateurDate } from "../../features/admin/horodatage";

// Défaut explicite : sans lui, Vue convertirait un `auto` absent en `false` (« En pause » sur une page sans actualisation automatique).
const props = withDefaults(
  defineProps<{
    chargement: boolean;
    derniereMaj: number | null;
    echec?: boolean;
    /** null : la page ne s'actualise pas seule. */
    auto?: boolean | null;
    cadence?: string;
  }>(),
  { echec: false, auto: null, cadence: "" },
);
const emit = defineEmits<{ actualiser: []; basculerAuto: [] }>();

const heureSeconde = formateurDate({ hour: "2-digit", minute: "2-digit", second: "2-digit" });

const libelle = computed(() => {
  if (props.chargement) return "Actualisation…";
  if (props.echec) return "Échec de l'actualisation";
  if (props.derniereMaj === null) return "Pas encore chargé";
  return `Mis à jour à ${heureSeconde(props.derniereMaj)}`;
});
</script>

<template>
  <div class="adm-maj" :class="{ 'is-error': echec && !chargement }">
    <span class="adm-maj__etat">
      <i
        class="ph"
        :class="
          chargement
            ? 'ph-spinner-gap animate-spin'
            : echec
              ? 'ph-warning-circle'
              : 'ph-clock-counter-clockwise'
        "
        aria-hidden="true"
      ></i>
      <span class="tabular-nums">{{ libelle }}</span>
    </span>
    <button
      v-if="auto !== null"
      type="button"
      class="adm-maj__auto"
      :aria-pressed="auto ? 'true' : 'false'"
      :title="
        auto
          ? `Actualisation automatique toutes les ${cadence} : cliquer pour la suspendre`
          : 'Actualisation automatique suspendue : cliquer pour la reprendre'
      "
      @click="emit('basculerAuto')"
    >
      <span class="adm-maj__point" aria-hidden="true"></span>
      {{ auto ? `Auto · ${cadence}` : "En pause" }}
    </button>
    <button
      type="button"
      class="adm-btn adm-btn--icon adm-tool"
      title="Actualiser maintenant"
      aria-label="Actualiser maintenant"
      :disabled="chargement"
      @click="emit('actualiser')"
    >
      <i class="ph ph-arrows-clockwise" aria-hidden="true"></i>
    </button>
  </div>
</template>
