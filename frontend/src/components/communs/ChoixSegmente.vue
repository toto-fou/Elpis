<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/communs/ChoixSegmente.vue — contrôle segmenté à choix unique (groupe radio) : un segment par valeur, segments de même largeur (jamais sous leur libellé), flèches, Début et Fin pour changer, une seule tabulation pour le groupe. -->
<script setup lang="ts">
import { nextTick } from "vue";

const props = defineProps<{
  modelValue: string;
  choix: readonly { valeur: string; libelle: string }[];
  /** Nom accessible du groupe. */
  libelle: string;
}>();
const emit = defineEmits<{ "update:modelValue": [valeur: string] }>();

// Flèches : segment voisin (en boucle) ; Début et Fin : premier et dernier ; choisi et focalisé comme un groupe radio natif.
function surTouche(e: KeyboardEvent): void {
  const n = props.choix.length;
  const i = props.choix.findIndex((c) => c.valeur === props.modelValue);
  const cible =
    e.key === "ArrowRight" || e.key === "ArrowDown"
      ? (i + 1) % n
      : e.key === "ArrowLeft" || e.key === "ArrowUp"
        ? (i - 1 + n) % n
        : e.key === "Home"
          ? 0
          : e.key === "End"
            ? n - 1
            : -1;
  if (cible < 0) return;
  e.preventDefault();
  const suivant = props.choix[cible];
  if (!suivant) return;
  emit("update:modelValue", suivant.valeur);
  const groupe = e.currentTarget as HTMLElement;
  void nextTick(() => groupe.querySelector<HTMLElement>('[aria-checked="true"]')?.focus());
}
</script>

<template>
  <span
    role="radiogroup"
    :aria-label="libelle"
    class="inline-grid grid-flow-col auto-cols-[minmax(max-content,1fr)] gap-0.5 p-0.5 rounded-lg bg-slate-100"
    data-choix-segmente
    @keydown="surTouche"
  >
    <button
      v-for="c in choix"
      :key="c.valeur"
      type="button"
      role="radio"
      :aria-checked="c.valeur === modelValue ? 'true' : 'false'"
      :tabindex="c.valeur === modelValue ? 0 : -1"
      class="px-1.5 sm:px-2 h-6 rounded-md text-xs font-medium whitespace-nowrap transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
      :class="
        c.valeur === modelValue ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-600 hover:text-slate-800'
      "
      :data-valeur="c.valeur"
      @click="emit('update:modelValue', c.valeur)"
    >
      {{ c.libelle }}
    </button>
  </span>
</template>
