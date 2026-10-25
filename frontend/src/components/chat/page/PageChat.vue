<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/page/PageChat.vue — colonne du chat : dépôt de fichiers, en-tête, fil, composeur (saisie, mentions, menus « / » et « + », micro, mode plan, tâches, modèle, envoi) et perchoir de la mascotte. -->
<script setup lang="ts">
import { computed } from "vue";

import { CLE_COMPOSEUR, CLE_PAGE, domaine } from "../../../features/chat/page/domaines";
import { interfaceApp } from "../../../features/reglages/interface";
import MascottePerchee from "../../mascotte/MascottePerchee.vue";
import BoutonMicro from "../../voix/BoutonMicro.vue";
import MenuMention from "../composeur/MenuMention.vue";
import PiecesJointes from "../composeur/PiecesJointes.vue";
import ZoneSaisie from "../composeur/ZoneSaisie.vue";
import PuceJobs from "../outils/PuceJobs.vue";
import PuceTaches from "../outils/PuceTaches.vue";
import AlerteContexte from "./AlerteContexte.vue";
import BarreActivite from "./BarreActivite.vue";
import BarreComposeur from "./BarreComposeur.vue";
import BarreImage from "./BarreImage.vue";
import BoutonBas from "./BoutonBas.vue";
import BoutonsEnvoi from "./BoutonsEnvoi.vue";
import EffortReflexion from "./EffortReflexion.vue";
import EnteteChat from "./EnteteChat.vue";
import EnteteConversation from "./EnteteConversation.vue";
import EpinglesComposeur from "./EpinglesComposeur.vue";
import FilConversation from "./FilConversation.vue";
import FileAttente from "./FileAttente.vue";
import InfoCompression from "./InfoCompression.vue";
import MenuPlus from "./MenuPlus.vue";
import MenuSlash from "./MenuSlash.vue";
import ProgressionModele from "./ProgressionModele.vue";
import PucesComposeur from "./PucesComposeur.vue";
import QuestionnaireAssistant from "./QuestionnaireAssistant.vue";
import SelecteurModele from "./SelecteurModele.vue";
import StatsGeneration from "./StatsGeneration.vue";
import SurvolDepot from "./SurvolDepot.vue";

const p = domaine(CLE_PAGE);
const comp = domaine(CLE_COMPOSEUR);
const ui = interfaceApp();
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

    <EnteteChat v-if="ui.classique" />
    <EnteteConversation v-else />

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

        <QuestionnaireAssistant />

        <BarreActivite v-if="!ui.classique" />

        <div
          class="elpis-compose-card relative bg-white/90 backdrop-blur-xl rounded-2xl shadow-xl border border-slate-200 focus-within:border-slate-300 transition-colors flex flex-col"
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
          <EpinglesComposeur />
          <PiecesJointes :fichiers="p.attachedFiles" @retirer="p.removeAttachedFile" />

          <div class="flex flex-col w-full p-1.5 gap-1">
            <!-- Saisie EN HAUT, pleine largeur (style Claude/ChatGPT) : le
                                       texte commence au-dessus de la barre d'outils, pas après le +. -->
            <!-- Saisie ACTIVE pendant le stream (préparation du prochain
                                       message, style chatbot classique) — l'ENVOI reste bloqué :
                                       le bouton devient Stop et Enter insère un retour à la ligne
                                       (cf. handleInputKeydown). Pas de file d'attente. -->
            <PucesComposeur v-if="!ui.classique" />
            <ZoneSaisie
              v-model:texte="p.inputMessage"
              :nouveau-chat="p.messages.length === 0"
              :liste-id="listeOuverte"
              :option-active="optionActive"
              :placeholder="
                p.isStreaming
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
            <!-- Rangée du bas : courte (interface nouvelle) ou barre d'outils complète (interface classique). -->
            <BarreComposeur v-if="!ui.classique" />
            <div v-else class="flex items-center w-full gap-1">
              <div class="shrink-0 flex items-center gap-0.5">
                <!-- Ancien bouton brain/réflexion retiré ici : l'activation
                                           de la réflexion (Qwen3 / DeepSeek-R1) vit désormais dans
                                           le panneau Sampling (section "Agent & reasoning"), à côté
                                           du thinking_budget. Raison : les modèles reasoning partent
                                           en boucle de thinking après 10-15 tool calls, ce qui rend
                                           le toggle "global rapide" contre-productif. La place naturelle
                                           du réglage est dans les paramètres du modèle, où on le pose
                                           UNE FOIS en connaissance de cause. -->

                <MenuPlus @ancre="p.composerPlusRef = $event" />

                <!-- Micro : visible si l'instance a la reconnaissance vocale et que la dictée est activée ; l'envoi reste manuel. -->
                <BoutonMicro
                  v-if="p.voiceCanDictate"
                  :etat="p.voiceState"
                  :occupe="p.voiceBusy"
                  @basculer="p.toggleDictation"
                />
              </div>
              <BarreImage />
              <!-- ====================================================== -->
              <!--   Chip Tâches (outil todowrite) — DANS la barre de       -->
              <!--   prompt, à côté du "+". Remplace le panneau empilé      -->
              <!--   au-dessus du composeur (il recouvrait le chat et le    -->
              <!--   bouton « descendre » dès que la liste s'allongeait).   -->
              <!--   Même vocabulaire que le sélecteur de modèle (bouton    -->
              <!--   nu slate, état ouvert bg-slate-100) ; flyout ancré     -->
              <!--   bottom-full comme les popovers RAG / "+". Point bleu   -->
              <!--   pulsé = une tâche in_progress (signal d'activité,     -->
              <!--   alternative reduced-motion : point fixe).              -->
              <!--   Fermeture : re-clic, X, clic hors ancre (onGlobalClick -->
              <!--   via [data-todo-flyout]), et repli AUTO en fin de tour. -->
              <!-- ====================================================== -->
              <!-- Témoin lecture seule DANS la barre de prompt : le badge du
                                       titre est loin de l'endroit où l'on tape. Celui-ci est
                                       ACTIONNABLE (clic = /plan off) et CONDITIONNEL comme le
                                       badge : rien à l'écran hors mode. Même vocabulaire que le
                                       chip todo voisin (bouton nu slate). -->
              <button
                v-if="p.planMode"
                data-plan-chip
                title="Mode plan : outils d'écriture retirés jusqu'à la réponse. Se coupe seul une fois le plan rendu ; cliquer pour le couper."
                class="flex items-center gap-1 px-1.5 py-1 rounded-lg text-xs font-medium transition-colors text-slate-500 hover:text-slate-700 hover:bg-slate-100 shrink-0"
                @click="p.setPlanMode(false)"
              >
                <i class="ph ph-binoculars text-base" aria-hidden="true"></i>
                <span>Mode plan</span>
              </button>
              <PuceTaches
                v-if="p.todoList && p.todoList.length"
                :taches="p.todoList"
                :ouvert="p.todoPanelOpen"
                @basculer="p.todoPanelOpen = $event"
              />

              <PuceJobs
                v-if="p.jobsActifsTotal > 0 || p.jobsChat.length || p.jobsFileReveil.length || p.jobsOuvert"
                :jobs="p.jobsPortee === 'all' ? p.jobsTous : p.jobsChat"
                :portee="p.jobsPortee"
                :ouvert="p.jobsOuvert"
                :actifs-chat="p.jobsActifsChat"
                :actifs-total="p.jobsActifsTotal"
                :file-reveil="p.jobsFileReveil"
                :reveil-en-cours="p.jobsReveilEnCours"
                :reveil-desactive="p.jobsReveilDesactive"
                :chat-id="p.currentChatId"
                :limite="p.jobsPortee === 'all' ? p.jobsLimites.compte : p.jobsLimites.chat"
                @basculer="p.jobsBasculer($event)"
                @portee="p.jobsChoisirPortee($event)"
                @arreter="p.jobsArreter($event)"
                @tout-arreter="p.jobsToutArreter()"
                @journal="p.jobsOuvrirJournal($event)"
                @interrupteur="p.jobsBasculerReveil()"
                @conversation="p.jobsOuvrirConversation($event)"
              />

              <SelecteurModele />

              <ProgressionModele />

              <EffortReflexion />
              <StatsGeneration />
              <div class="flex-1"></div>
              <BoutonsEnvoi />
            </div>
          </div>
        </div>
      </div>
    </div>
  </main>
</template>
