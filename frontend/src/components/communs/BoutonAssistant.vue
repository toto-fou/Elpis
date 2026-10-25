<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/communs/BoutonAssistant.vue — bouton « Assistant » (étincelle) commun aux entrées des assistants de création : bouton ou lien. -->
<script setup lang="ts">
withDefaults(defineProps<{ lien?: boolean; libelle?: string; classe?: string }>(), {
  lien: false,
  libelle: "Assistant",
  classe: "",
});
</script>

<template>
  <button
    type="button"
    :class="
      classe ||
      (lien
        ? 'text-xs text-blue-600 hover:underline inline-flex items-center gap-1'
        : 'text-xs px-3 py-1.5 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50 transition-colors flex items-center gap-1.5')
    "
  >
    <i class="ph ph-sparkle"></i> {{ libelle }}
  </button>
</template>
