<!-- SPDX-License-Identifier: MIT -->
<!-- frontend/src/components/racine/App.vue — racine de la page de chat (index.html) : monte tous les modules, fournit les domaines injectés, dispose la console intégrée, la barre latérale, les pages et les fenêtres. -->
<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onUnmounted, reactive, watch } from "vue";
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
import { prechaufferEditeurs } from "../../features/editor/instances";
import type { MonacoEditeurs } from "../../features/editor/instances";
import { ensureVendor } from "../../platform/vendor";
import { creerMorceaux } from "../../platform/differe";
import { definirPrechargement, ecouterIntentions } from "../../platform/precharge";
import { auRepos, auReposProlonge, definirOccupation } from "../../platform/repos";
import { SELECTEUR_FOCUSABLES } from "../../utils/focus";
import { fournirDomaineEditeur } from "../../features/editor/domaine";
import { setupEditor } from "../../features/editor/editeur";
import { fournirDomaineAdmin } from "../../features/admin/domaine";
import { fournirDomaineReglages } from "../../features/reglages/domaine";
import { fournirPreferencesChat } from "../../features/reglages/affichage-chat";
import { fournirDomaineModales } from "../../features/chat/modales/domaine";
import { fournirDomainesChat } from "../../features/chat/page/domaines";
import { creerRacine } from "../../app/racine/racine";
import { fournirDomainesRacine } from "../../app/racine/domaine";
import ModalesGroupes from "../admin/ModalesGroupes.vue";
import BarreLaterale from "../chat/page/BarreLaterale.vue";
import PageChat from "../chat/page/PageChat.vue";
import DetailsExecution from "../chat/modales/DetailsExecution.vue";
import FicheOutil from "../chat/modales/FicheOutil.vue";
import FormulaireAssistant from "../chat/modales/FormulaireAssistant.vue";
import GalerieImages from "../chat/modales/GalerieImages.vue";
import ModaleAPropos from "../chat/modales/ModaleAPropos.vue";
import ModaleAgent from "../chat/modales/ModaleAgent.vue";
import ModaleAide from "../chat/modales/ModaleAide.vue";
import ModaleAx from "../chat/modales/ModaleAx.vue";
import ModaleOpenCode from "../chat/modales/ModaleOpenCode.vue";
import ModaleTransfert from "../chat/modales/ModaleTransfert.vue";
import ProprietesModele from "../chat/modales/ProprietesModele.vue";
import RemplissageTemplate from "../chat/modales/RemplissageTemplate.vue";
import VisionneuseImages from "../chat/modales/VisionneuseImages.vue";
import ZoomImage from "../chat/modales/ZoomImage.vue";
import PageEditeur from "../editor/PageEditeur.vue";
import PanneauGeneration from "../reglages/PanneauGeneration.vue";
import PanneauMcp from "../reglages/PanneauMcp.vue";
import BulleSource from "../rag/BulleSource.vue";
import VisionneuseSource from "../rag/VisionneuseSource.vue";
import CartesConnexion from "./CartesConnexion.vue";
import ApercuSkin from "../reglages/ApercuSkin.vue";
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

/** Monaco, puis un éditeur et un éditeur de différences hors écran, chacun dans sa tranche ; rien si l'éditeur est désactivé. */
function prechaufferMonaco(tranche: (f: () => void) => void): Promise<void> | undefined {
  if (!r.settings.enable_editor) return undefined;
  return chargerMonaco().then((m) =>
    prechaufferEditeurs(m as unknown as MonacoEditeurs, r.settings, tranche),
  );
}

// Pages et fenêtres rares : morceaux à part, montés une fois chargés ; le chat reste affiché pendant le chargement.
const IMPORTS = {
  console: () => import("../admin/CoqueConsole.vue"),
  reglages: () => import("../reglages/ModaleReglages.vue"),
  mcp: () => import("../reglages/ModaleMcp.vue"),
  git: () => import("../editor/ModaleGit.vue"),
  routines: () => import("../routines/PageRoutines.vue"),
  agents: () => import("../agents/PageAgents.vue"),
  rag: () => import("../rag/PageRag.vue"),
  studio: () => import("../studio/PageStudio.vue"),
  code: () => import("../code/PageCode.vue"),
};
type Rare = keyof typeof IMPORTS;
const RARES = Object.keys(IMPORTS) as Rare[];
const LIBELLES: Record<Rare, string> = {
  console: "La console",
  reglages: "Paramètres",
  mcp: "La gestion MCP",
  git: "Git",
  routines: "Routines",
  agents: "Agents",
  rag: "RAG",
  studio: "Studio",
  code: "Remote code",
};
// Monté (caché par sa propre condition) dès que son morceau est là, préchargé ou demandé.
const montes = reactive(Object.fromEntries(RARES.map((k) => [k, false])) as Record<Rare, boolean>);
const rares = creerMorceaux(IMPORTS, {
  charge(k) {
    montes[k] = true;
  },
  echec(k, reessayer) {
    r.showToast(`${LIBELLES[k]} : chargement impossible, vérifiez la connexion au serveur.`, "error", {
      actionLabel: "Réessayer",
      onAction: reessayer,
    });
  },
  rechargeable: () => !r.isStreaming && !r.inputMessage.trim(),
  miseAJour(recharger) {
    r.showToast("Application mise à jour : rechargez la page pour ouvrir cette fenêtre.", "info", {
      actionLabel: "Recharger",
      onAction: recharger,
      duration: 30000,
    });
  },
});
const CoqueConsole = defineAsyncComponent(rares.charger.console);
const ModaleReglages = defineAsyncComponent(rares.charger.reglages);
const ModaleMcp = defineAsyncComponent(rares.charger.mcp);
const ModaleGit = defineAsyncComponent(rares.charger.git);
const PageRoutines = defineAsyncComponent(rares.charger.routines);
const PageAgents = defineAsyncComponent(rares.charger.agents);
const PageRag = defineAsyncComponent(rares.charger.rag);
const PageStudio = defineAsyncComponent(rares.charger.studio);
const PageCode = defineAsyncComponent(rares.charger.code);

// Ce que l'écran demande à afficher : la page rechargée après une mise à jour, un message et un nouvel essai sur une coupure.
const demandes = computed<Record<Rare, boolean>>(() => ({
  console: !!r.isAdminView,
  reglages: !!r.showSettingsModal,
  mcp: !!r.showMcpManagerModal,
  git: !!(
    r.showGitCloneModal ||
    r.showGitInitModal ||
    r.showGitRemoteModal ||
    r.showGitPushAuth ||
    r.showGitMergeModal
  ),
  routines: r.currentView === "routines",
  agents: r.currentView === "agents",
  rag: r.currentView === "rag",
  studio: r.currentView === "studio",
  code: r.currentView === "code",
}));
watch(
  demandes,
  (d) => {
    for (const k of RARES) if (d[k]) void rares.demander(k);
  },
  { immediate: true },
);

/** Fenêtre montée déjà ouverte (son morceau est arrivé après le clic) : elle prend le focus comme à l'ouverture. */
function focaliserSiOuverte(k: Rare): void {
  if (!demandes.value[k]) return;
  void nextTick(() => {
    const f = [...globalThis.document.querySelectorAll<HTMLElement>("[data-a11y-modal]")].pop();
    if (!f || f.contains(globalThis.document.activeElement)) return;
    (
      f.querySelector<HTMLElement>('[tabindex="-1"]') ?? f.querySelector<HTMLElement>(SELECTEUR_FOCUSABLES)
    )?.focus();
  });
}

// Préchargés au survol, au focus ou à l'appui de leur bouton ; sinon, une fois connecté, après la coloration du code, au repos prolongé.
definirOccupation(() => r.isStreaming);
for (const k of RARES) definirPrechargement(k, () => rares.precharger(k));
definirPrechargement("editeur", () =>
  Promise.all([prechaufferMonaco((f) => auRepos(f, 1000)), rares.precharger("git")]),
);
const retirerIntentions = ecouterIntentions();
onUnmounted(retirerIntentions);
watch(
  () => !!r.user,
  () =>
    auReposProlonge(
      () => ensureVendor("highlight"),
      () => rares.precharger("reglages"),
      () => rares.precharger("routines"),
      () => r.settings.enable_mcp && rares.precharger("mcp"),
      () => r.ragAllowed && rares.precharger("rag"),
      () => r.features.agents && rares.precharger("agents"),
      () => rares.precharger("studio"),
      () => r.features.opencode && rares.precharger("code"),
      () => r.settings.enable_editor && rares.precharger("git"),
      () => prechaufferMonaco((f) => auReposProlonge(f)),
    ),
  { once: true },
);
</script>

<template>
  <ChromeApp />
  <CartesConnexion />

  <div
    v-if="r.user && !r.mustChangePassword && r.isAdminView && montes.console"
    class="h-full w-full flex bg-slate-50 overflow-hidden"
  >
    <!-- Coquille de la console (partagée avec admin.html). -->
    <CoqueConsole />
  </div>

  <div
    v-if="r.user && !r.mustChangePassword && !(r.isAdminView && montes.console)"
    class="flex h-full w-full relative"
  >
    <BarreLaterale />

    <!-- overflow-clip (pas hidden) : le focus d'un élément rogné (case sr-only) ferait défiler un conteneur
         overflow:hidden et tronquerait toute la colonne sans retour ; repli hidden dans style.css. -->
    <div class="flex-1 flex min-w-0 bg-white overflow-clip relative z-40">
      <PageChat />
      <!-- Source citée d'une réponse du RAG : volet à droite du chat, à la place de l'éditeur de la sandbox. -->
      <VisionneuseSource v-if="!(r.showEditor && r.settings.enable_editor)" />
      <PanneauMcp />
      <PanneauGeneration />
      <PageEditeur />
      <PageRoutines v-if="montes.routines" />
      <PageAgents v-if="montes.agents" />
      <PageRag v-if="montes.rag && r.ragPage" />
      <PageStudio v-if="montes.studio" />
      <PageCode v-if="montes.code" />
    </div>
  </div>

  <BulleSource />
  <ModaleGit v-if="montes.git" @vue:mounted="focaliserSiOuverte('git')" />
  <!-- Transfert (progression des imports et exports) : globale, la console s'en sert aussi. -->
  <ModaleTransfert />
  <ModaleReglages v-if="montes.reglages" @vue:mounted="focaliserSiOuverte('reglages')" />
  <ModaleMcp v-if="montes.mcp" @vue:mounted="focaliserSiOuverte('mcp')" />
  <ModalesGroupes />
  <ProprietesModele />
  <DetailsExecution />
  <ModaleAgent />
  <ModaleAPropos />
  <ModaleOpenCode />
  <ModaleAide />
  <VisionneuseImages />
  <GalerieImages />
  <ZoomImage />
  <ModaleAx />
  <FormulaireAssistant />
  <ApercuSkin />
  <FicheOutil />
  <RemplissageTemplate />
</template>
