<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/racine/App.vue — racine de la page de chat (index.html) : monte tous les modules, fournit les domaines injectés, dispose la console intégrée, la barre latérale, les pages et les fenêtres. -->
<script setup lang="ts">
import { creerApiRoutines } from "../../features/routines/api";
import { creerRoutines } from "../../features/routines/routines";
import { fournirDomaineRoutines } from "../../features/routines/domaine";
import { creerApiSkills } from "../../features/skills/api";
import { creerSkills } from "../../features/skills/skills";
import { fournirDomaineSkills } from "../../features/skills/domaine";
import { creerCode } from "../../features/code/code";
import { fournirDomaineCode } from "../../features/code/domaine";
import { creerMascotte } from "../../features/mascotte/mascotte";
import { creerApiRag } from "../../features/rag/api";
import { fournirDomaineRag } from "../../features/rag/domaine";
import { creerRag } from "../../features/rag/rag";
import { lireJsonBureau } from "../../features/studio/api";
import { creerAutomatisationStudio } from "../../features/studio/automatisation";
import type { MonacoMinimal } from "../../features/studio/automatisation";
import { creerDialogueStudio } from "../../features/studio/dialogue";
import { fournirDomaineStudio } from "../../features/studio/domaine";
import { creerMenuStudio } from "../../features/studio/menu";
import { chargerMonaco } from "../../features/editor/chargeur";
import { fournirDomaineEditeur } from "../../features/editor/domaine";
import { setupEditor } from "../../features/editor/editeur";
import { fournirDomaineAdmin } from "../../features/admin/domaine";
import { fournirDomaineReglages } from "../../features/reglages/domaine";
import { fournirPreferencesChat } from "../../features/reglages/affichage-chat";
import { fournirDomaineModales } from "../../features/chat/modales/domaine";
import { fournirDomainesChat } from "../../features/chat/page/domaines";
import { creerRacine } from "../../app/racine/racine";
import { fournirDomainesRacine } from "../../app/racine/domaine";
import CoqueConsole from "../admin/CoqueConsole.vue";
import ModalesGroupes from "../admin/ModalesGroupes.vue";
import BarreLaterale from "../chat/page/BarreLaterale.vue";
import PageChat from "../chat/page/PageChat.vue";
import DetailsExecution from "../chat/modales/DetailsExecution.vue";
import FicheOutil from "../chat/modales/FicheOutil.vue";
import FormulaireAssistantSkill from "../chat/modales/FormulaireAssistantSkill.vue";
import GalerieImages from "../chat/modales/GalerieImages.vue";
import ModaleAPropos from "../chat/modales/ModaleAPropos.vue";
import ModaleAide from "../chat/modales/ModaleAide.vue";
import ModaleAx from "../chat/modales/ModaleAx.vue";
import ModaleOpenCode from "../chat/modales/ModaleOpenCode.vue";
import ModaleTransfert from "../chat/modales/ModaleTransfert.vue";
import ProprietesModele from "../chat/modales/ProprietesModele.vue";
import RemplissageTemplate from "../chat/modales/RemplissageTemplate.vue";
import VoletAgent from "../chat/modales/VoletAgent.vue";
import VisionneuseImages from "../chat/modales/VisionneuseImages.vue";
import ZoomImage from "../chat/modales/ZoomImage.vue";
import PageCode from "../code/PageCode.vue";
import ModaleGit from "../editor/ModaleGit.vue";
import PageEditeur from "../editor/PageEditeur.vue";
import ModaleMcp from "../reglages/ModaleMcp.vue";
import ModaleReglages from "../reglages/ModaleReglages.vue";
import PanneauGeneration from "../reglages/PanneauGeneration.vue";
import PanneauMcp from "../reglages/PanneauMcp.vue";
import BulleSource from "../rag/BulleSource.vue";
import PageRag from "../rag/PageRag.vue";
import VisionneuseSource from "../rag/VisionneuseSource.vue";
import PageRoutines from "../routines/PageRoutines.vue";
import PageStudio from "../studio/PageStudio.vue";
import CartesConnexion from "./CartesConnexion.vue";
import ChromeApp from "./ChromeApp.vue";

// Les modules typent chacun leurs refs et leur contexte : la racine leur passe les mêmes, partagés.
type Arg<F extends (...a: never[]) => unknown, I extends number> = Parameters<F>[I];

const r = creerRacine({
  modules: {
    editeur: ({ session, refs, ctx }) =>
      setupEditor(
        session,
        refs as unknown as Arg<typeof setupEditor, 1>,
        ctx as unknown as Arg<typeof setupEditor, 2>,
      ),
    skills: ({ http, refs, ctx }) =>
      creerSkills(
        creerApiSkills(http),
        refs as unknown as Arg<typeof creerSkills, 1>,
        ctx as unknown as Arg<typeof creerSkills, 2>,
      ),
    routines: ({ http, refs, ctx }) =>
      creerRoutines(
        creerApiRoutines(http),
        refs as unknown as Arg<typeof creerRoutines, 1>,
        ctx as unknown as Arg<typeof creerRoutines, 2>,
      ),
    code: ({ refs, ctx }) => creerCode(refs, ctx as unknown as Arg<typeof creerCode, 1>),
    mascotte: ({ refs, ctx }) =>
      creerMascotte(
        refs as unknown as Arg<typeof creerMascotte, 0>,
        ctx as unknown as Arg<typeof creerMascotte, 1>,
      ),
    rag: ({ http, refs, ctx }) => creerRag(creerApiRag(http), refs, ctx),
    studio: ({ refs, ctx }) => creerMenuStudio(refs, { ...ctx, lireJson: lireJsonBureau }),
    studioChat: ({ ctx }, menu) =>
      creerDialogueStudio({ ...ctx, lireJson: lireJsonBureau }, menu as Arg<typeof creerDialogueStudio, 1>),
    studioAuto: ({ ctx }, menu, dialogue) =>
      creerAutomatisationStudio(
        {
          ...ctx,
          lireJson: lireJsonBureau,
          chargerMonaco: chargerMonaco as unknown as () => Promise<MonacoMinimal>,
        },
        menu,
        dialogue,
      ),
  },
});

fournirDomainesRacine(r);
fournirPreferencesChat(() => r.settings);
fournirDomainesChat(r);
fournirDomaineEditeur(r);
fournirDomaineRoutines(r);
fournirDomaineRag(r);
fournirDomaineSkills(r);
fournirDomaineCode(r);
fournirDomaineReglages(r);
fournirDomaineAdmin(r);
fournirDomaineStudio(r);
fournirDomaineModales(r, false);
</script>

<template>
  <ChromeApp />
  <CartesConnexion />

  <div
    v-if="r.user && !r.mustChangePassword && r.isAdminView"
    class="h-full w-full flex bg-slate-50 overflow-hidden"
  >
    <!-- Coquille de la console (partagée avec admin.html). -->
    <CoqueConsole />
  </div>

  <div v-if="r.user && !r.mustChangePassword && !r.isAdminView" class="flex h-full w-full relative">
    <div
      v-if="r.showSidebar && !r.editorFullscreen"
      class="fixed inset-0 bg-black/40 z-40 lg:hidden"
      @click="r.showSidebar = false"
    ></div>

    <BarreLaterale />

    <!-- overflow-clip (pas hidden) : le focus d'un élément rogné (case sr-only) ferait défiler un conteneur
         overflow:hidden et tronquerait toute la colonne sans retour ; repli hidden dans style.css. -->
    <div class="flex-1 flex min-w-0 bg-white overflow-clip relative z-40">
      <PageChat />
      <!-- Source citée d'une réponse du RAG : volet à droite du chat, à la place de l'éditeur de la sandbox. -->
      <VisionneuseSource v-if="!(r.showEditor && r.settings.enable_editor)" />
      <PanneauMcp />
      <VoletAgent />
      <PanneauGeneration />
      <PageEditeur />
      <PageRoutines />
      <PageRag v-if="r.ragPage" />
      <PageStudio />
      <PageCode />
    </div>
  </div>

  <BulleSource />
  <ModaleGit />
  <!-- Transfert (progression des imports et exports) : globale, la console s'en sert aussi. -->
  <ModaleTransfert />
  <ModaleReglages />
  <ModaleMcp />
  <ModalesGroupes />
  <ProprietesModele />
  <DetailsExecution />
  <ModaleAPropos />
  <ModaleOpenCode />
  <ModaleAide />
  <VisionneuseImages />
  <GalerieImages />
  <ZoomImage />
  <ModaleAx />
  <FormulaireAssistantSkill />
  <FicheOutil />
  <RemplissageTemplate />
</template>
