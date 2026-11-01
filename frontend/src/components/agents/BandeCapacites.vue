<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/agents/BandeCapacites.vue — bande fixe de cinq cases (Lire, Modifier, Terminal, Git, Web) : accordée en bleu, absente en pointillé, cadenas en lecture seule. -->
<script setup lang="ts">
import type { BandeAgent, EtatCase } from "../../features/agents/page";

defineProps<{ bande: BandeAgent }>();

// Table littérale : chaque classe est écrite en entier pour la feuille générée.
const CLASSES_CASE: Readonly<Record<EtatCase, string>> = {
  oui: "bg-blue-50 text-blue-700 border border-blue-200",
  non: "border border-dashed border-slate-300 text-slate-500",
  verrou: "bg-slate-100 text-slate-600 border border-slate-200",
};
</script>

<template>
  <span class="inline-flex items-center gap-1" data-agent-capacites>
    <span class="sr-only">{{ bande.lecteur }}</span>
    <span
      v-for="c in bande.cases"
      :key="c.cle"
      class="w-6 h-6 rounded-md inline-flex items-center justify-center shrink-0"
      :class="CLASSES_CASE[c.etat]"
      :title="c.titre"
      aria-hidden="true"
      :data-capacite="c.cle"
      :data-etat="c.etat"
    >
      <i class="ph text-[13px]" :class="c.icone" aria-hidden="true"></i>
    </span>
  </span>
</template>
