<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/chat/page/BarreComposeur.vue — rangée du composeur sous la saisie (interface nouvelle) : « + » (catalogue), micro et puces d'état à gauche ; tâches de fond, menu du modèle et Envoyer à droite ; sous 420 px, libellés abrégés et puces sur la ligne suivante. -->
<script setup lang="ts">
import { useTemplateRef } from "vue";

import { CLE_PAGE, domaine } from "../../../features/chat/page/domaines";
import { suivreEtroit } from "../../../features/chat/page/largeur";
import BoutonMicro from "../../voix/BoutonMicro.vue";
import PuceJobs from "../outils/PuceJobs.vue";
import BoutonsEnvoi from "./BoutonsEnvoi.vue";
import CataloguePlus from "./CataloguePlus.vue";
import MenuModele from "./MenuModele.vue";
import ProgressionModele from "./ProgressionModele.vue";
import PucesComposeur from "./PucesComposeur.vue";

const p = domaine(CLE_PAGE);
const etroit = suivreEtroit(useTemplateRef<HTMLDivElement>("rangee"), 420);
</script>

<template>
  <div ref="rangee" class="flex flex-wrap items-center w-full gap-1" data-barre-composeur>
    <div class="shrink-0 flex items-center gap-0.5">
      <CataloguePlus @ancre="p.composerPlusRef = $event" />
      <BoutonMicro
        v-if="p.voiceCanDictate"
        :etat="p.voiceState"
        :occupe="p.voiceBusy"
        @basculer="p.toggleDictation"
      />
    </div>
    <PucesComposeur :etroit="etroit" :class="etroit ? 'order-last basis-full' : ''" />
    <div class="flex-1"></div>
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
      a-droite
      @basculer="p.jobsBasculer($event)"
      @portee="p.jobsChoisirPortee($event)"
      @arreter="p.jobsArreter($event)"
      @tout-arreter="p.jobsToutArreter()"
      @journal="p.jobsOuvrirJournal($event)"
      @interrupteur="p.jobsBasculerReveil()"
      @conversation="p.jobsOuvrirConversation($event)"
    />
    <ProgressionModele />
    <MenuModele :etroit="etroit" />
    <BoutonsEnvoi />
  </div>
</template>
