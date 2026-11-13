<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/TexteFlux.vue — texte brut d'un flux dans un `pre` (réflexion) : pendant le flux, lu sur la référence du porteur du message ; un texte qui ne fait que grandir est ajouté au bout du nœud texte (une sélection faite dedans survit), sinon il est reposé. -->
<script setup lang="ts">
import { computed, onMounted, useTemplateRef, watch } from "vue";

/** Référence du porteur (réflexion en cours). */
interface TexteVivant {
  readonly value: string;
}

const props = defineProps<{ texte?: string | null; flux?: TexteVivant | null }>();
const affiche = computed(() => (props.flux ? props.flux.value : (props.texte ?? "")));
const racine = useTemplateRef<HTMLElement>("racine");
let noeud: Text | null = null;
let pose = "";

// Le nœud texte appartient à ce composant : le gabarit ne déclare aucun enfant, Vue n'y touche pas.
function poser(t: string): void {
  const el = racine.value;
  if (!el) return;
  if (!noeud || noeud.parentNode !== el || noeud.length !== pose.length) {
    el.textContent = "";
    noeud = el.appendChild(el.ownerDocument.createTextNode(t));
  } else if (t.length > pose.length && t.startsWith(pose)) noeud.appendData(t.slice(pose.length));
  else if (t !== pose) noeud.data = t;
  pose = t;
}

onMounted(() => poser(affiche.value));
watch(affiche, poser, { flush: "post" });
</script>

<template>
  <pre ref="racine"></pre>
</template>
