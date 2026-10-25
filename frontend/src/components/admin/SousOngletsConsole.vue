<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/admin/SousOngletsConsole.vue — sélecteur de sous-onglets d'une page de la console, point sur l'onglet modifié. -->
<script setup lang="ts">
import type { OngletAffiche } from "../../features/admin/onglets";

const props = defineProps<{ onglets: readonly OngletAffiche[]; label: string; page: string }>();
const choisi = defineModel<string>({ required: true });

function auClavier(ev: KeyboardEvent): void {
  const pas = ev.key === "ArrowRight" ? 1 : ev.key === "ArrowLeft" ? -1 : 0;
  if (!pas && ev.key !== "Home" && ev.key !== "End") return;
  ev.preventDefault();
  const n = props.onglets.length;
  const i = props.onglets.findIndex((o) => o.id === choisi.value);
  const cible = ev.key === "Home" ? 0 : ev.key === "End" ? n - 1 : (i + pas + n) % n;
  const onglet = props.onglets[cible];
  if (!onglet) return;
  choisi.value = onglet.id;
  const boutons = (ev.currentTarget as HTMLElement).querySelectorAll<HTMLElement>("[role=tab]");
  boutons[cible]?.focus();
}
</script>

<template>
  <div class="adm-onglets" role="tablist" :aria-label="label" @keydown="auClavier">
    <button
      v-for="o in onglets"
      :id="'onglet-bouton-' + page + '-' + o.id"
      :key="o.id"
      type="button"
      role="tab"
      class="adm-onglets__btn"
      :class="{ 'is-active': choisi === o.id }"
      :aria-selected="choisi === o.id ? 'true' : 'false'"
      :aria-controls="'onglet-' + page + '-' + o.id"
      :tabindex="choisi === o.id ? 0 : -1"
      @click="choisi = o.id"
    >
      {{ o.label }}
      <span v-if="o.modifie" class="adm-onglets__point" title="Modifié" aria-hidden="true"></span>
      <span v-if="o.modifie" class="sr-only"> (modifié)</span>
    </button>
  </div>
</template>
