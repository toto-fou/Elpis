<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/admin/InterrupteurConsole.vue — interrupteur de la console : case masquée, piste et texte (fixe, ou selon l'état) ; id, data-field, aria-label et écouteurs vont à la case. -->
<script setup lang="ts">
defineOptions({ inheritAttrs: false });
const actif = defineModel<boolean>();
withDefaults(defineProps<{ texte?: string; oui?: string; non?: string }>(), {
  texte: undefined,
  oui: "Activé",
  non: "Désactivé",
});
</script>

<template>
  <label class="relative inline-flex items-center gap-2 cursor-pointer w-fit">
    <input v-model="actif" v-bind="$attrs" type="checkbox" class="sr-only peer" />
    <span class="set-switch-track block peer-checked:bg-blue-600 peer-checked:border-blue-600"></span>
    <span class="text-sm text-slate-700">{{ texte ?? (actif ? oui : non) }}</span>
  </label>
</template>
