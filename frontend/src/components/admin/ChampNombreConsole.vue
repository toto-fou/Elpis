<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/admin/ChampNombreConsole.vue — champ numérique de la console suivi de son unité ; id, data-field, bornes et classes en plus vont au champ. -->
<script setup lang="ts">
defineOptions({ inheritAttrs: false });
const valeur = defineModel<unknown>();
defineProps<{ unite: string }>();
</script>

<template>
  <div class="flex items-center gap-2">
    <input v-model.number="valeur" type="number" class="set-input adm-num" v-bind="$attrs" />
    <span class="adm-unit">{{ unite }}</span>
  </div>
</template>
