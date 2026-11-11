<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/secrets/ChampValeur.vue — saisie d'une valeur de secret : masquée, non copiable, ignorée des gestionnaires de mots de passe (champ texte masqué par CSS, type password seulement là où ce masquage n'existe pas). -->
<script setup lang="ts">
const valeur = defineModel<string>({ required: true });

// Un champ `password` dans un formulaire retiré après l'appel ferait proposer la valeur comme mot de passe d'Elpis.
const masqueCss =
  typeof CSS === "undefined" ||
  typeof CSS.supports !== "function" ||
  CSS.supports("-webkit-text-security", "disc");
</script>

<template>
  <input
    v-model="valeur"
    :type="masqueCss ? 'text' : 'password'"
    class="elpis-valeur-secrete"
    autocomplete="off"
    autocapitalize="off"
    spellcheck="false"
    translate="no"
    data-1p-ignore
    data-lpignore="true"
    data-bwignore
    data-form-type="other"
    @copy.prevent
    @cut.prevent
    @dragstart.prevent
  />
</template>
