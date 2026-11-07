<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/page/SaisieComposeur.vue — saisie du composeur reliée au texte en cours : seule elle se redessine à chaque touche, pas toute la colonne du chat. -->
<script setup lang="ts">
import { computed } from "vue";

import { CLE_COMPOSEUR, CLE_PAGE, domaine } from "../../../features/chat/page/domaines";
import ZoneSaisie from "../composeur/ZoneSaisie.vue";

const p = domaine(CLE_PAGE);
const comp = domaine(CLE_COMPOSEUR);
const questionnaireOuvert = computed(() => !!comp.askUserPanel?.ouvert);
// Liste ouverte sous la saisie (combobox) et option active, pour le lecteur d'écran.
const listeOuverte = computed(() => {
  if (comp.showSlash) return "slash-list";
  return p.showMentionDropdown && !p.isMentionLoading && p.mentionFiles.length ? "mention-list" : null;
});
const optionActive = computed(() => {
  if (listeOuverte.value === "slash-list") return `slash-opt-${comp.slashIdx}`;
  return listeOuverte.value === "mention-list" ? `mention-opt-${p.mentionIndex}` : null;
});
</script>

<template>
  <!-- Saisie ACTIVE pendant le stream (préparation du prochain message) ; l'ENVOI reste bloqué : le bouton devient Stop et Entrée insère un retour à la ligne (cf. handleInputKeydown). -->
  <ZoneSaisie
    v-model:texte="p.inputMessage"
    :nouveau-chat="p.messages.length === 0"
    :liste-id="listeOuverte"
    :option-active="optionActive"
    :etiquette="questionnaireOuvert ? 'Autre réponse ou précision' : undefined"
    :decrit-par="questionnaireOuvert ? 'elpis-ask-question' : undefined"
    :placeholder="
      questionnaireOuvert
        ? 'Autre réponse, ou une précision…'
        : p.isStreaming
          ? 'Préparez votre prochain message… (envoi possible une fois la génération terminée)'
          : p.imageMode
            ? 'Décrivez l’image…'
            : p.composerPlaceholder
    "
    @element="p.inputRef = $event"
    @touche="p.handleInputKeydown"
    @saisie="p.handleInputInput"
  />
</template>
