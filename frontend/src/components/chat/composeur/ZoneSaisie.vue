<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/composeur/ZoneSaisie.vue — zone de saisie du composeur : texte (v-model:texte), élément publié au parent (focus, curseur, hauteur), touches et saisie transmises. -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, useTemplateRef } from "vue";

const props = defineProps<{ texte: string; placeholder: string }>();
const emit = defineEmits<{
  "update:texte": [texte: string];
  element: [el: HTMLTextAreaElement | null];
  touche: [e: KeyboardEvent];
  saisie: [e: Event];
}>();

const zone = useTemplateRef<HTMLTextAreaElement>("zone");
const valeur = computed({
  get: () => props.texte,
  set: (v: string) => emit("update:texte", v),
});

onMounted(() => emit("element", zone.value));
onBeforeUnmount(() => emit("element", null));
</script>

<template>
  <textarea
    ref="zone"
    v-model="valeur"
    rows="1"
    :placeholder="props.placeholder"
    class="w-full bg-transparent px-3 py-2 outline-none resize-none max-h-40 text-slate-800 placeholder:text-slate-500 disabled:opacity-50 text-sm font-medium"
    style="min-height: 40px"
    @keydown="emit('touche', $event)"
    @input="emit('saisie', $event)"
  ></textarea>
</template>
