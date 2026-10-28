<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/page/PageChat.vue — colonne du chat : dépôt de fichiers, en-tête, fil, composeur (saisie, mentions, menus « / » et « + », micro, mode plan, tâches, modèle, envoi) et perchoir de la mascotte. -->
<script setup lang="ts">
import { computed } from "vue";

import { CLE_COMPOSEUR, CLE_CONVERSATION, CLE_PAGE, domaine } from "../../../features/chat/page/domaines";
import { utiliserEchecsJobs } from "../../../features/chat/page/echecs-jobs";
import MascottePerchee from "../../mascotte/MascottePerchee.vue";
import MenuMention from "../composeur/MenuMention.vue";
import PiecesJointes from "../composeur/PiecesJointes.vue";
import ZoneSaisie from "../composeur/ZoneSaisie.vue";
import AlerteContexte from "./AlerteContexte.vue";
import BarreComposeur from "./BarreComposeur.vue";
import BoutonBas from "./BoutonBas.vue";
import CarteApprobation from "./CarteApprobation.vue";
import EnteteConversation from "./EnteteConversation.vue";
import EpinglesComposeur from "./EpinglesComposeur.vue";
import FilConversation from "./FilConversation.vue";
import FileAttente from "./FileAttente.vue";
import InfoCompression from "./InfoCompression.vue";
import MenuSlash from "./MenuSlash.vue";
import PiedQuestionnaire from "./PiedQuestionnaire.vue";
import PuceQuestionnaire from "./PuceQuestionnaire.vue";
import QuestionnaireAssistant from "./QuestionnaireAssistant.vue";
import SurvolDepot from "./SurvolDepot.vue";

const p = domaine(CLE_PAGE);
const comp = domaine(CLE_COMPOSEUR);
const questionnaireOuvert = computed(() => !!comp.askUserPanel?.ouvert);
// Annonce lue à l'ouverture, en naviguant et à la réouverture : la région reste dans la page, hors du questionnaire.
const annonceQuestionnaire = computed(() => {
  const q = comp.askUserPanel;
  const courante = q?.ouvert ? q.items[q.idx] : null;
  return q && courante ? `Question ${q.idx + 1} sur ${q.items.length} : ${courante.q}` : "";
});
// Rien au-dessus du composeur : l'échec d'une tâche de fond est signalé par un toast.
utiliserEchecsJobs(p, domaine(CLE_CONVERSATION));
// Liste ouverte sous la saisie (combobox) et option active, pour le lecteur d'écran.
const listeOuverte = computed(() => {
  if (comp.showSlash) return "slash-list";
  return p.showMentionDropdown && !p.isMentionLoading && p.mentionFiles.length ? "mention-list" : null;
});
const optionActive = computed(() => {
  if (listeOuverte.value === "slash-list") return `slash-opt-${comp.slashIdx}`;
  return listeOuverte.value === "mention-list" ? `mention-opt-${p.mentionIndex}` : null;
});
// Le dépôt ne lit que les fichiers de la cible.
function surFichiers(e: Event): void {
  p.handleFileUpload({ target: e.target as HTMLInputElement });
}
</script>

<template>
  <main
    class="flex flex-col h-full relative w-full min-w-0 flex-1"
    @dragenter="p.handleChatDragEnter"
    @dragover="p.handleChatDragOver"
    @dragleave="p.handleChatDragLeave"
    @drop="p.handleChatDrop"
  >
    <SurvolDepot />

    <EnteteConversation />

    <!-- Colonne de défilement, en-tête, composeur : composants de frontend/src/components/chat/page/ (domaines injectés). -->
    <FilConversation
      @conteneur="p.chatContainer = $event"
      @accueil="p.accueilHote = $event"
      @zoom-image="p.imgZoom = $event"
      @edition="p.editMessageText = $event"
    />

    <BoutonBas />

    <div
      class="absolute left-0 right-0 px-4 md:px-6 pointer-events-none flex justify-center z-30 transition-all duration-300"
      :class="p.messages.length === 0 ? 'top-[44dvh]' : 'bottom-6'"
    >
      <!-- ``relative`` : ancre les panneaux « / » et @mention
                           (absolute left-0 right-0) sur LA COLONNE du composeur —
                           sans lui ils s'ancraient sur la bande pleine largeur et
                           ne suivaient pas la largeur de la barre de prompt. -->
      <!-- ref composeColRef : hauteur observée (ResizeObserver,
                           features/chat/coeur) pour caler le spacer de fin de chat et le
                           bouton « descendre » au-dessus de la pile de widgets. -->
      <div
        :ref="(el) => (p.composeColRef = el as HTMLElement | null)"
        class="elpis-compose-col relative w-full pointer-events-auto transition-all duration-300"
        :style="{
          maxWidth: !p.showEditor || !p.settings.enable_editor ? p.settings.chat_width + '%' : '48rem',
        }"
      >
        <InfoCompression />

        <MenuMention
          :ouvert="p.showMentionDropdown"
          :requete="p.mentionQuery"
          :fichiers="p.mentionFiles"
          :index="p.mentionIndex"
          :recents="p.mentionRecentCount"
          :chargement="p.isMentionLoading"
          :encore="p.mentionHasMore"
          @choisir="p.selectMention"
          @survol="p.mentionIndex = $event"
          @defiler="p.onMentionScroll"
        />

        <MenuSlash />

        <FileAttente />

        <AlerteContexte />

        <CarteApprobation />

        <PuceQuestionnaire />

        <div class="sr-only" role="status" aria-live="polite">{{ annonceQuestionnaire }}</div>

        <div
          class="elpis-compose-card relative bg-white/90 backdrop-blur-xl rounded-2xl shadow-xl border border-slate-200 focus-within:border-slate-300 transition-colors flex flex-col"
          :class="{ 'elpis-ask-ouvert': questionnaireOuvert }"
          @keydown="comp.askUserKeydown"
        >
          <!-- Perchoir de la mascotte (src/components/mascotte) : elle vient dormir sur la barre après trois minutes sans geste. -->
          <MascottePerchee
            :actif="p.perchee"
            :perso="p.mascotteId"
            :x="p.percheX"
            :duree="p.percheDuree"
            :anim="p.percheAnim"
            :dort="p.percheDort"
          />
          <QuestionnaireAssistant />
          <EpinglesComposeur />
          <PiecesJointes :fichiers="p.attachedFiles" @retirer="p.removeAttachedFile" />

          <div class="flex flex-col w-full p-1.5 gap-1">
            <!-- Saisie EN HAUT, pleine largeur (style Claude/ChatGPT) : le
                                       texte commence au-dessus de la barre d'outils, pas après le +. -->
            <!-- Saisie ACTIVE pendant le stream (préparation du prochain
                                       message, style chatbot classique) — l'ENVOI reste bloqué :
                                       le bouton devient Stop et Enter insère un retour à la ligne
                                       (cf. handleInputKeydown). Pas de file d'attente. -->
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
            <!-- « Joindre un fichier » vit dans le menu « + » : l'input caché est déclenché par triggerFileUpload(). -->
            <input
              :ref="(el) => (p.fileInput = el)"
              type="file"
              class="hidden"
              multiple
              @change="surFichiers"
            />
            <PiedQuestionnaire v-if="questionnaireOuvert" />
            <BarreComposeur v-else />
          </div>
        </div>
      </div>
    </div>
  </main>
</template>
