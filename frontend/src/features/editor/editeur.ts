// SPDX-License-Identifier: MIT
/** frontend/src/features/editor/editeur.ts — composant éditeur (porté d'`app-editor.js`) : crée l'état et les services, relie ses parties, initialise et libère Monaco, et rend la surface lue par la racine historique et les gabarits. */
import { nextTick, watch } from "vue";

import { canonPath } from "../../utils/utils-purs";
import type { GestionnaireSession } from "../auth/session";
import { setupEditorTerminal } from "../terminal/sessions";
import { setupEditorShortcutsHelp } from "./aide-raccourcis";
import { setupEditorPreview } from "./apercu";
import { setupEditorStatusBar } from "./barre-etat";
import { chargerMonaco } from "./chargeur";
import { setupEditorDiff } from "./diff";
import { setupEditorDisk } from "./disque";
import { editionMinimale, remplacerContenu } from "./ecriture-modele";
import { setupEditorSave } from "./enregistrement";
import { creerEtatEditeur, poserDans } from "./etat";
import type { CtxEditeur, Modele, RefsPartagees } from "./etat";
import { setupEditorSandboxFs } from "./fichiers";
import { setupEditorAssistantWrites } from "./flux-assistant";
import { setupEditorGit } from "./git";
import { setupEditorFimAi } from "./ia";
import { creerEditeurs } from "./instances";
import type { Editeurs } from "./instances";
import { enregistrerRobotFramework, langageDe } from "./langages";
import { lireTexteOuBinaire } from "./lecture";
import type { LiensEditeur, ServicesEditeur } from "./liens";
import { setupEditorTabMemory } from "./memoire-onglets";
import { setupEditorLayout } from "./mise-en-page";
import { RegistreModeles } from "./modeles";
import { setupEditorTabs } from "./onglets-ouverts";
import { creerFichiersRecents, setupEditorQuickOpen } from "./ouverture-rapide";
import { setupEditorTools } from "./outils-editeur";
import { setupEditorShortcuts } from "./raccourcis";
import { setupEditorResize } from "./redimension";
import { ServiceSauvegarde } from "./sauvegarde";
import { setupEditorRescue } from "./secours";
import { setupEditorViewers } from "./visionneuses";
import { setupEditorSplit } from "./vue-scindee";

const CLE_DISPOSITION = "elpis.editor.layout.v1";
const SONDAGE_QUOTA_MS = 10_000;
const urlBac = (endpoint: string): string => "/api/sandbox/" + endpoint;

function lireDisposition(): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(localStorage.getItem(CLE_DISPOSITION) || "{}");
  } catch {
    v = null;
  }
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function borne(v: unknown, bas: number, haut: number, defaut: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(bas, Math.min(haut, n)) : defaut;
}

export function setupEditor(session: GestionnaireSession, refs: RefsPartagees, ctx: CtxEditeur) {
  const { user, settings } = refs;
  const { showToast, fetchAuth, openConfirm } = ctx;
  const e = creerEtatEditeur();
  const { monacoRef, showEditor, openTabs, activeTabPath, originalFileContent, isEditorDirty } = e;
  const disposition = lireDisposition();

  // Table des fonctions croisées, résolues à l'appel (les parties sont créées plus bas).
  const l: LiensEditeur = {
    canon: (p) => String(canonPath(p, settings.value.sandbox_path_display) ?? ""),
    initMonaco: () => initMonaco(),
    openFile: (p, f, o) => onglets.openFile(p, f, o),
    switchTab: (p) => onglets.switchTab(p),
    closeTab: (p, ev, f) => onglets.closeTab(p, ev, f),
    tabIsDirty: (p) => onglets._tabIsDirty(p),
    saveCurrentViewState: () => onglets._saveCurrentViewState(),
    restoreViewStateFor: (p) => onglets._restoreViewStateFor(p),
    pushNav: () => onglets._pushNav(),
    scheduleDirtyRefresh: () => onglets._scheduleDirtyRefresh(),
    scrollTabIntoView: (p) => onglets.scrollTabIntoView(p),
    closeTabCtxMenu: () => onglets.closeTabCtxMenu(),
    rememberRecent: (p) => recents._rememberRecent(p),
    setSplitFile: (p) => scindee.setSplitFile(p),
    exitSplit: () => scindee.exitSplit(),
    enterSplitPreview: () => scindee.enterSplitPreview(),
    scheduleRenderPane: () => scindee._scheduleRenderPane(),
    saveEditorContent: (o) => enr.saveEditorContent(o),
    scheduleLint: (p, c) => enr.scheduleLint(p, c),
    formatPython: (m) => enr._formatPython(m),
    loadHistorySession: () => enr.loadHistorySession(),
    isStreamActive: (p) => flux.isStreamActive(p),
    updateDiffView: () => diff.updateDiffView(),
    showDiffForMessage: (p, a, b) => diff.showDiffForMessage(p, a, b),
    proposeAiEdit: (p) => diff.proposeAiEdit(p),
    rejectAiProposal: (o) => diff.rejectAiProposal(o),
    scheduleScmRefresh: (p) => diff._scheduleScmRefresh(p),
    clearScm: (p) => diff._clearScm(p),
    loadHead: (p, f) => diff._loadHead(p, f),
    headText: (p) => diff.texteTete(p),
    forceLayout: () => page._forceLayout(),
    robustLayout: () => page.robustLayout(),
    smoothOpenLayout: () => page._smoothOpenLayout(),
    relayoutDuringTransition: () => page._relayoutMonacoDuringTransition(),
    closeEditorCtxMenu: () => outils.closeEditorCtxMenu(),
    openEditorCtxMenu: (ev) => outils._openEditorCtxMenu(ev),
    editorCtxComplete: () => ia.editorCtxComplete(),
    monacoConsumesEscape: (ev) => touches.monacoConsumesEscape(ev),
    revealActiveInTree: (p) => outils.revealActiveInTree(p),
    scheduleTreeRefreshAfterCommand: () => outils._scheduleTreeRefreshAfterCommand(),
    registerTermLinks: (t) => outils._registerTermLinks(t),
  };
  const modelOk = (p: string | null | undefined): boolean => !!p && modeles.ok(p);

  const apercu = setupEditorPreview(session, {
    fetchAuth,
    ongletActif: () => activeTabPath.value,
    apercuScinde: () => e.splitView.value && e.splitMode.value === "preview",
    enregistrer: (o) => enr.saveEditorContent(o),
  });
  const vis = setupEditorViewers(
    { openTabs, activeTabPath, settings, showEditor, features: ctx.features, monacoRef },
    { fetchAuth, showToast },
    {
      url: urlBac,
      fermerOnglet: (p, ev, force) => onglets.closeTab(p, ev, force),
      ouvrirFichier: (p, force) => onglets.openFile(p, force),
      poserMtime: (p, mt) => disque._setBaseMtime(p, mt),
      canonique: (p) => l.canon(p),
    },
  );
  const modeles = new RegistreModeles<Modele>({
    monaco: () => {
      if (!window.monaco) throw new Error("Monaco non chargé");
      return window.monaco;
    },
    langue: langageDe,
    ecrire: (m, texte) => {
      try {
        remplacerContenu(m, texte);
      } catch {
        /* modèle libéré */
      }
    },
    editeurs: () => monacoRef,
  });
  const models = modeles.table;
  const disque = setupEditorDisk(
    {
      openTabs,
      activeTabPath,
      isEditorDirty,
      isDiffView: e.isDiffView,
      diffBase: e.diffBase,
      readOnlyTabs: vis.readOnlyTabs,
      diskConflicts: e.diskConflicts,
      assistantStash: e.assistantStash,
      user,
      showEditor,
      modeles,
      originalFileContent,
    },
    { showToast, fetchAuth, openConfirm },
    {
      url: urlBac,
      finsDeLigne: () => window.monaco?.editor.EndOfLineSequence ?? { LF: 0, CRLF: 1 },
      enregistrementEnCours: (p) => sauvegarde.enCours(p),
      fluxActif: (p) => flux.isStreamActive(p),
      estModifie: (p) => onglets._tabIsDirty(p),
      modeVue: (p) => vis._resolveFileViewMode(p),
      lireTexte: lireTexteOuBinaire,
      editionMinimale: (m, a, b) => editionMinimale(m, a, b),
      fermerOnglet: (p, ev, force) => onglets.closeTab(p, ev, force),
      ouvrirOffice: (p, o) => vis.officeOpen(p, o),
      ouvrirFichier: (p, force) => onglets.openFile(p, force),
      appliquerLectureSeule: () => vis._applyActiveReadOnly(),
      majDiff: () => diff.updateDiffView(),
      rafraichirModifies: () => onglets._scheduleDirtyRefresh(),
      rafraichirScm: (p) => diff._scheduleScmRefresh(p),
      comparer: (p, texte, base) => diff.showDiffForMessage(p, texte, base),
      enregistrer: (o) => enr.saveEditorContent(o),
      mettreEnPage: () => page.robustLayout(),
      gitAutoRefresh: () => git._gitAutoRefresh(),
      chargerQuota: () => fs.loadSandboxQuota(),
    },
  );

  // Premier affichage de l'éditeur : sondage disque et quota, statut Git, restauration interrompue signalée.
  let quotaMinuterie: ReturnType<typeof setInterval> | null = null;
  let premierAffichage = false;
  watch(showEditor, (v) => {
    if (!v || premierAffichage) return;
    premierAffichage = true;
    disque._startMtimeChecks();
    if (quotaMinuterie) clearInterval(quotaMinuterie);
    quotaMinuterie = setInterval(() => {
      if (document.visibilityState === "visible" && showEditor.value) void fs.loadSandboxQuota();
    }, SONDAGE_QUOTA_MS);
    void fs.loadSandboxQuota();
    git.gitBackgroundInit().catch(() => undefined);
    fs.loadSnapshots()
      .then(() => {
        if (fs.restoreIncomplete.value)
          showToast(
            "⚠ Une restauration de snapshot a été interrompue — " +
              "vos fichiers sont peut-être incomplets. Voir le panneau Snapshots.",
            "error",
          );
      })
      .catch(() => undefined);
  });

  const memoire = setupEditorTabMemory(
    {
      openTabs,
      activeTabPath,
      settings,
      user,
      showEditor,
      monacoRef,
      models,
      tabViewStates: e.tabViewStates,
      openTransientFail: e.openTransientFail,
    },
    {
      ouvrirFichier: (p, force, o) => onglets.openFile(p, force, o),
      basculer: (p) => onglets.switchTab(p),
      modeVue: (p) => vis._resolveFileViewMode(p),
      toast: (m, t) => showToast(m, t),
    },
  );
  const aide = setupEditorShortcutsHelp(settings);
  const recents = creerFichiersRecents(user);
  const ouvertureRapide = setupEditorQuickOpen(
    { settings, sandboxFiles: e.sandboxFiles, recentFiles: recents.recentFiles },
    { ouvrirFichier: (p, force) => onglets.openFile(p, force) },
  );
  const terminal = setupEditorTerminal(
    session,
    { user, monacoRef },
    {
      fetchAuth,
      showToast,
      handleSessionExpired: () => {
        void ctx.handleSessionExpired?.();
      },
    },
    {
      verifierDisqueBientot: (d) => disque.checkExternalModsSoon(d),
      liens: (t) => l.registerTermLinks(t),
      apresCommande: () => l.scheduleTreeRefreshAfterCommand(),
    },
  );
  const git = setupEditorGit({ openTabs, models, originalFileContent, readOnlyTabs: vis.readOnlyTabs }, ctx, {
    openFile: (p, force) => onglets.openFile(p, force),
    reloadTab: (p) => rechargerOngletGit(p),
    checkDisk: () => disque.checkExternalModsSoon(0),
    loadSandboxFiles: () => fs.loadSandboxFiles(),
    _modelOk: (p) => modelOk(p),
    _tabIsDirty: (p) => onglets._tabIsDirty(p),
    showDiffForMessage: (p, avant) => diff.showDiffForMessage(p, avant),
    applyActiveReadOnly: () => vis._applyActiveReadOnly(),
    isViewerPath: (p) => vis.officeIsViewerPath(p),
  });
  const sauvegarde = new ServiceSauvegarde({
    lire: (p) => enr.lireInstantane(p),
    ecrire: (p, texte, o) => enr._writeEditorContent(p, texte, o),
    enregistre: () => undefined,
    echeance: async (p) => {
      if (p && onglets._tabIsDirty(p)) await enr.saveEditorContent({ silent: true, path: p });
    },
  });
  const fs = setupEditorSandboxFs(
    {
      sandboxFiles: e.sandboxFiles,
      sandboxQuota: e.sandboxQuota,
      isLoadingFiles: e.isLoadingFiles,
      sandboxSearch: e.sandboxSearch,
      sandboxSearchMode: e.sandboxSearchMode,
      sandboxSearchResults: e.sandboxSearchResults,
      isSearchingSandbox: e.isSearchingSandbox,
      sandboxFileInput: e.sandboxFileInput,
      sandboxFolderInput: e.sandboxFolderInput,
      showImportMenu: e.showImportMenu,
      openTabs,
      activeTabPath,
      editorFilePath: e.editorFilePath,
      models,
      originalFileContent,
      monacoRef,
      showHiddenFiles: e.showHiddenFiles,
    },
    ctx,
    {
      _sbUrl: urlBac,
      openFile: (p, f) => onglets.openFile(p, f),
      closeTab: (p, _ev, force) => onglets.closeTab(p, null, force),
      _migrateModel: (a, b) => migrerModele(a, b),
      _gitAutoRefresh: () => git._gitAutoRefresh(),
      isSpecialPath: (p) => vis._resolveFileViewMode(p) !== "monaco",
      isPathDirty: (p) => openTabs.value.some((t) => t.path === p) && onglets._tabIsDirty(p),
      // Écriture hors de /save : onglet propre rechargé, onglet modifié = conflit signalé.
      setBaseMtime: (p) => {
        if (!openTabs.value.some((t) => t.path === p) || !modelOk(p)) return;
        if (!onglets._tabIsDirty(p)) void disque._reloadFromDisk(p, { quiet: true });
        else poserDans(e.diskConflicts, p, { mtime: null, missing: false });
      },
      onFilesReplaced: async (chemins) => {
        for (const p of chemins) {
          if (!openTabs.value.some((t) => t.path === p)) continue;
          if (modelOk(p) && !onglets._tabIsDirty(p)) await disque._reloadFromDisk(p, { quiet: true });
          else if (modelOk(p)) poserDans(e.diskConflicts, p, { mtime: null, missing: false });
        }
      },
      onPathsMoved: (de, vers) => suivreDeplacement(de, vers),
      beforeJump: () => onglets._pushNav(),
    },
  );
  const barre = setupEditorStatusBar(
    {
      settings,
      activeTabPath,
      splitView: e.splitView,
      activePane: e.activePane,
      showEditor,
      isEditorDirty,
      monacoRef,
      models,
      fileFormats: disque.fileFormats,
    },
    {
      modeleOk: modelOk,
      lectureSeule: (p) => vis._isReadOnlyTab(p),
      estModifie: (p) => onglets._tabIsDirty(p),
      rafraichirModifies: () => onglets._scheduleDirtyRefresh(),
      toast: (m) => showToast(m),
    },
  );
  const s: ServicesEditeur = {
    modeles,
    models,
    vis,
    disque,
    apercu,
    memoire,
    terminal,
    fs,
    git,
    barre,
    sauvegarde,
  };

  const onglets = setupEditorTabs(e, s, l, ctx, settings);
  const page = setupEditorLayout(e, () => ctx.showSidebar, {
    sauverVue: () => onglets._saveCurrentViewState(),
    restaurerVue: (p) => onglets._restoreViewStateFor(p),
    modeleOk: modelOk,
    modele: (p) => models[p],
    preparerConteneur: () => terminal._ensureSandboxContainerReady(),
    echapPourMonaco: (ev) => touches.monacoConsumesEscape(ev),
  });
  const scindee = setupEditorSplit(e, s, l, ctx);
  const enr = setupEditorSave(e, s, l, ctx, settings, () => terminal.invaliderConteneur());
  const flux = setupEditorAssistantWrites(e, s, l, ctx, settings);
  const diff = setupEditorDiff(e, s, l, ctx, settings);
  const outils = setupEditorTools(e, s, l, ctx, settings, user);
  const ia = setupEditorFimAi(
    {
      monacoRef,
      fimLoading: e.fimLoading,
      fimGhostText: e.fimGhostText,
      editorCtxMenu: e.editorCtxMenu,
      activeTabPath,
      editorFilePath: e.editorFilePath,
    },
    ctx,
    {
      closeEditorCtxMenu: () => outils.closeEditorCtxMenu(),
      _getLang: langageDe,
      proposeEdit: (p) => diff.proposeAiEdit(p),
    },
  );
  const redim = setupEditorResize(
    { terminalHeight: terminal.terminalHeight, explorerWidth: e.explorerWidth, settings, monacoRef },
    {
      ajustement: () => {
        const st = terminal._activeTermState();
        return st ? st.fitAddon : null;
      },
    },
  );
  const { rescueDirtyBuffers, _maybeRestoreRescued } = setupEditorRescue(
    {
      user,
      openTabs,
      activeTabPath,
      isEditorDirty,
      fileShas: disque.fileShas,
      fileMtimes: disque.fileMtimes,
      fileFormats: disque.fileFormats,
      modeles,
    },
    {
      estModifie: (p) => onglets._tabIsDirty(p),
      lectureSeule: (p) => vis._isReadOnlyTab(p),
      ouvrirFichier: (p) => onglets.openFile(p, true, { quiet: true }),
      editionMinimale: (m, a, b) => editionMinimale(m, a, b),
      poserBase: (p, mt, sha) => disque._setBase(p, mt, sha),
      confirmer: (t, x) => openConfirm(t, x, false, "Restaurer"),
      rafraichirModifies: () => onglets._scheduleDirtyRefresh(),
      toast: (m) => showToast(m),
    },
  );
  const touches = setupEditorShortcuts(e, s, l, settings, {
    rouvrirDernierFerme: () => memoire.reopenLastClosed(),
    basculerTerminal: () => terminal.toggleTerminal(),
    toutEnregistrer: () => enr.saveAllTabs(),
    navArriere: () => onglets.navBack(),
    navAvant: () => onglets.navForward(),
  });

  /** Modèle d'un renommage déplacé vers le nouveau chemin, état de vue et contenu gardés. */
  function migrerModele(ancien: string, nouveau: string): void {
    const m = models[ancien];
    if (!m || !modelOk(ancien)) return;
    const contenu = m.getValue();
    const ed = monacoRef.instance;
    const actif = !!ed && ed.getModel() === m;
    let vue: ReturnType<NonNullable<typeof ed>["saveViewState"]> = null;
    if (ed && actif) {
      try {
        vue = ed.saveViewState();
      } catch {
        vue = null;
      }
    }
    modeles.liberer(ancien);
    const neuf = modeles.assurer(nouveau, contenu, langageDe(nouveau));
    const vs = e.tabViewStates[ancien];
    if (vs) {
      e.tabViewStates[nouveau] = vs;
      delete e.tabViewStates[ancien];
    }
    if (actif && monacoRef.instance) {
      try {
        monacoRef.instance.setModel(neuf);
        if (vue) monacoRef.instance.restoreViewState(vue);
      } catch {
        /* éditeur libéré */
      }
    }
  }

  /** Renommage ou déplacement : tout état indexé par chemin suit le fichier (base disque, conflits, panneau droit). */
  function suivreDeplacement(de: string, vers: string): void {
    const cible = (k: string): string | null =>
      k === de ? vers : k.startsWith(de + "/") ? vers + k.substring(de.length) : null;
    const deplacer = <T>(obj: Record<string, T>): void => {
      for (const k of Object.keys(obj)) {
        const nk = cible(k);
        const v = obj[k];
        if (nk && v !== undefined) {
          obj[nk] = v;
          delete obj[k];
        }
      }
    };
    deplacer(disque._handledDiskMtime);
    deplacer(disque.fileShas);
    deplacer(disque.fileFormats);
    if (e.splitTabPath.value) {
      const ns = cible(e.splitTabPath.value);
      if (ns) e.splitTabPath.value = ns;
    }
    const mtimes = { ...disque.fileMtimes.value };
    deplacer(mtimes);
    disque.fileMtimes.value = mtimes;
    const conflits = { ...e.diskConflicts.value };
    deplacer(conflits);
    e.diskConflicts.value = conflits;
    const copies = { ...e.assistantStash.value };
    deplacer(copies);
    e.assistantStash.value = copies;
    for (const k of Array.from(vis.readOnlyTabs.value)) {
      const nk = cible(k);
      if (nk) {
        vis.readOnlyTabs.value.delete(k);
        vis.readOnlyTabs.value.add(nk);
      }
    }
  }

  /** Après une opération Git : un onglet propre reprend le disque sans changer d'onglet actif. */
  async function rechargerOngletGit(chemin: string): Promise<boolean> {
    if (onglets._tabIsDirty(chemin)) return false;
    const fige = vis.readOnlyTabs.value.has(chemin);
    if (activeTabPath.value === chemin && (fige || !modelOk(chemin))) {
      await onglets.openFile(chemin, true);
      return true;
    }
    if (!modelOk(chemin)) return false;
    if (fige) {
      modeles.liberer(chemin);
      vis.readOnlyTabs.value.delete(chemin);
      delete originalFileContent[chemin];
      return true;
    }
    return disque._reloadFromDisk(chemin, { quiet: true });
  }

  // Disposition restaurée (explorateur, terminal, vue scindée), mémorisée à chaque changement.
  e.explorerWidth.value = borne(disposition["explorerWidth"], 140, 640, 224);
  terminal.terminalHeight.value = borne(disposition["terminalHeight"], 90, 900, 250);
  e.splitRatio.value = borne(disposition["splitRatio"], 15, 85, 50);
  let minuterieDisposition: ReturnType<typeof setTimeout> | undefined;
  watch([e.explorerWidth, terminal.terminalHeight, e.splitRatio], () => {
    clearTimeout(minuterieDisposition);
    minuterieDisposition = setTimeout(() => {
      try {
        localStorage.setItem(
          CLE_DISPOSITION,
          JSON.stringify({
            explorerWidth: e.explorerWidth.value,
            terminalHeight: terminal.terminalHeight.value,
            splitRatio: e.splitRatio.value,
          }),
        );
      } catch {
        /* stockage plein ou interdit */
      }
    }, 400);
  });

  let editeurs: Editeurs<
    NonNullable<typeof monacoRef.instance>,
    NonNullable<typeof monacoRef.diff>,
    Modele
  > | null = null;
  let imagePrevue = false;

  /** Crée les éditeurs une fois (appels concurrents partagés) ; charge le module Monaco au premier appel. */
  function initMonaco(): Promise<void> {
    if (monacoRef.instance) return Promise.resolve();
    if (monacoRef.initPromise) return monacoRef.initPromise;
    const monaco = window.monaco;
    if (!monaco) {
      monacoRef.initPromise = chargerMonaco()
        .then(() => {
          monacoRef.initPromise = null;
          return initMonaco();
        })
        .catch(() => {
          monacoRef.initPromise = null;
        });
      return monacoRef.initPromise;
    }
    monacoRef.initPromise = Promise.resolve().then(() => {
      const el = document.getElementById("monaco-editor");
      if (!el) return;
      enregistrerRobotFramework(monaco);
      const surBlur = (): boolean => settings.value?.editor_auto_save === "on_blur";
      editeurs = creerEditeurs(
        monaco,
        {
          principal: el,
          diff: document.getElementById("monaco-diff-editor"),
          droit: document.getElementById("monaco-editor-2"),
        },
        settings.value,
        {
          curseur: () => barre._updateStatusFromEditor(),
          contenuPrincipal() {
            const p = activeTabPath.value;
            if (!flux.isStreamActive(p)) {
              isEditorDirty.value = true;
              enr._scheduleAutoSave();
              apercu._schedulePreviewLive();
              onglets._scheduleDirtyRefresh();
            }
            if (p && /\.pyi?$/i.test(p)) enr.scheduleLint(p);
            if (p) diff._scheduleScmRefresh(p);
            scindee._scheduleRenderPane();
          },
          selection: () => barre._updateStatusExtras(),
          modeleChange() {
            barre._updateStatusExtras();
            barre._refreshProblems();
          },
          optionsModele: () => barre._updateStatusExtras(),
          completer: () => void ia.editorCtxComplete(),
          flouPrincipal() {
            const p = activeTabPath.value;
            if (surBlur() && p && onglets._tabIsDirty(p))
              void enr.saveEditorContent({ silent: true, path: p });
          },
          enregistrer: () => void enr.saveEditorContent(),
          menu: (ev) => outils._openEditorCtxMenu(ev),
          focusGauche() {
            e.activePane.value = "left";
          },
          focusDroit() {
            e.activePane.value = "right";
          },
          contenuDroit() {
            const p = e.splitTabPath.value;
            if (p && !flux.isStreamActive(p)) {
              if (p === activeTabPath.value) isEditorDirty.value = true;
              enr._scheduleAutoSaveRight();
              onglets._scheduleDirtyRefresh();
            }
          },
          flouDroit() {
            const p = e.splitTabPath.value;
            if (surBlur() && p && onglets._tabIsDirty(p))
              void enr.saveEditorContent({ silent: true, path: p });
          },
          enregistrerDroit() {
            if (e.splitTabPath.value) void enr.saveEditorContent({ path: e.splitTabPath.value });
          },
          redimension() {
            // Pas de mise en page par image pendant l'animation d'ouverture (saccade).
            if (showEditor.value && settings.value.enable_editor && !page.enOuverture() && !imagePrevue) {
              imagePrevue = true;
              requestAnimationFrame(() => {
                imagePrevue = false;
                page._forceLayout();
              });
            }
          },
          problemes: () => barre._refreshProblems(),
          formaterPython: (m) => enr._formatPython(m),
        },
      );
      monacoRef.instance = editeurs.instance;
      monacoRef.instance2 = editeurs.instance2;
      monacoRef.diff = editeurs.diff;
      monacoRef.originalModel = editeurs.originalModel;
      page._bindFullscreenEsc();
      setTimeout(() => {
        void _maybeRestoreRescued();
      }, 0);
    });
    return monacoRef.initPromise;
  }

  /** Libère éditeurs, modèles, terminaux, flux, minuteries et sondages (fin de session, éditeur désactivé). */
  async function disposeAll(): Promise<void> {
    await terminal._destroyAllTerminals();
    terminal.showTerminal.value = false;
    vis._resetViewersState();
    e.editorFullscreen.value = false;
    e.splitView.value = false;
    e.splitTabPath.value = null;
    e.activePane.value = "left";
    flux.libererFlux();
    e.isTypingEffect.value = false;
    isEditorDirty.value = false;
    modeles.libererTout();
    if (editeurs) {
      editeurs.liberer();
      editeurs = null;
    }
    monacoRef.instance = null;
    monacoRef.instance2 = null;
    monacoRef.diff = null;
    monacoRef.initPromise = null;
    monacoRef.originalModel = null;
    e.pathsNeedingReload.clear();
    for (const k of Object.keys(originalFileContent)) delete originalFileContent[k];
    for (const k of Object.keys(e.tabViewStates)) delete e.tabViewStates[k];
    enr.libererEnregistrement();
    disque._stopMtimeChecks();
    memoire.libererMemoire();
    sauvegarde.annulerRetards();
    if (quotaMinuterie) {
      clearInterval(quotaMinuterie);
      quotaMinuterie = null;
    }
    premierAffichage = false;
    page.libererMiseEnPage();
  }

  /** Bouton « Éditeur » : ouvre (arbre chargé, Monaco créé, onglet actif rattaché) ou ferme le panneau. */
  async function toggleEditor(): Promise<void> {
    if (!settings.value.enable_editor) return;
    showEditor.value = !showEditor.value;
    if (!showEditor.value) return;
    void fs.loadSandboxFiles();
    await nextTick();
    await initMonaco();
    const p = activeTabPath.value;
    if (!p) {
      page._smoothOpenLayout();
      return;
    }
    const relire = !modelOk(p) || e.pathsNeedingReload.has(p);
    e.pathsNeedingReload.delete(p);
    if (relire) {
      modeles.liberer(p);
      await onglets.openFile(p, true);
      return;
    }
    try {
      const m = models[p];
      if (m) monacoRef.instance?.setModel(m);
    } catch {
      /* éditeur libéré */
    }
    onglets._restoreViewStateFor(p);
    page._smoothOpenLayout();
  }

  /** Nettoyage de fin de session : état Git (identifiants préremplis), terminaux, visionneuses. */
  function resetOnLogout(): void {
    try {
      git.resetOnLogout();
    } catch {
      /* déjà nettoyé */
    }
    terminal._destroyAllTerminals().catch(() => undefined);
    vis._resetViewersState();
  }

  // Fermeture de l'onglet du navigateur : mémoire des onglets écrite, avertissement s'il reste du travail non enregistré.
  window.addEventListener("beforeunload", (ev) => {
    memoire.ecrireAvantFermeture();
    const travail =
      openTabs.value.some((t) => onglets._tabIsDirty(t.path)) ||
      Object.keys(e.assistantStash.value || {}).length > 0;
    if (travail) {
      ev.preventDefault();
      ev.returnValue = "";
    }
  });

  // Éditeur désactivé à chaud : modifications mises de côté, tout est libéré (recréé à la prochaine ouverture).
  watch(
    () => settings.value?.enable_editor,
    async (actif, avant) => {
      if (avant === undefined || actif) return;
      try {
        onglets._saveCurrentViewState();
      } catch {
        /* éditeur libéré */
      }
      const gardes = rescueDirtyBuffers();
      if (gardes)
        showToast(
          gardes + " fichier(s) non enregistré(s) mis de côté — proposés à la réactivation de l'éditeur",
          "info",
        );
      showEditor.value = false;
      try {
        await disposeAll();
      } catch {
        /* libération partielle */
      }
    },
  );

  // Thème de l'éditeur à chaud (global à Monaco, indépendant du mode sombre de la page).
  watch(
    () => settings.value?.editor_dark_mode,
    (sombre, avant) => {
      if (avant === undefined || !window.monaco) return;
      try {
        window.monaco.editor.setTheme(sombre === false ? "vs" : "vs-dark");
      } catch {
        /* aucun éditeur encore créé */
      }
    },
  );

  // Préférences à chaud (police, tabulations, retour à la ligne, minimap, numéros) sans recréer les éditeurs.
  watch(
    () => {
      const r = settings.value || {};
      return [
        r.editor_font_size,
        r.editor_font_family,
        r.editor_tab_size,
        r.editor_insert_spaces,
        r.editor_word_wrap,
        r.editor_minimap,
        r.editor_line_numbers,
      ].join("|");
    },
    (_cur, avant) => {
      if (avant === undefined || !window.monaco || !editeurs) return;
      editeurs.appliquerPreferences(settings.value);
      try {
        for (const m of window.monaco.editor.getModels()) barre._detectIndentation(m);
      } catch {
        /* modèle libéré */
      }
      barre._updateStatusExtras();
      editeurs.mettreEnPage();
    },
  );

  return {
    showEditor,
    showExplorer: e.showExplorer,
    explorerWidth: e.explorerWidth,
    sandboxFiles: e.sandboxFiles,
    sandboxQuota: e.sandboxQuota,
    isLoadingFiles: e.isLoadingFiles,
    showHiddenFiles: e.showHiddenFiles,
    fileInput: e.fileInput,
    openTabs,
    activeTabPath,
    isEditorDirty,
    isTypingEffect: e.isTypingEffect,
    editorFilePath: e.editorFilePath,
    isDiffView: e.isDiffView,
    editorMode: e.editorMode,
    previewPath: apercu.previewPath,
    previewKey: apercu.previewKey,
    previewSource: apercu.previewSource,
    previewPort: apercu.previewPort,
    previewServerPath: apercu.previewServerPath,
    previewSrc: apercu.previewSrc,
    previewServerUrl: apercu.previewServerUrl,
    previewServerHostWarn: apercu.previewServerHostWarn,
    commitPreviewServerUrl: apercu.commitPreviewServerUrl,
    reloadPreview: apercu.reloadPreview,
    sandboxSearch: e.sandboxSearch,
    sandboxSearchMode: e.sandboxSearchMode,
    sandboxSearchResults: e.sandboxSearchResults,
    isSearchingSandbox: e.isSearchingSandbox,
    filteredFilesList: fs.filteredFilesList,
    sandboxFileInput: e.sandboxFileInput,
    sandboxFolderInput: e.sandboxFolderInput,
    showImportMenu: e.showImportMenu,
    monacoRef,
    models,
    initMonaco,
    toggleEditor,
    openFile: onglets.openFile,
    refreshPreview: apercu.refreshPreview,
    updateDiffView: diff.updateDiffView,
    toggleDiffMode: diff.toggleDiffMode,
    switchTab: onglets.switchTab,
    closeTab: onglets.closeTab,
    saveEditorContent: enr.saveEditorContent,
    lintCurrentFile: enr.lintCurrentFile,
    capturePreWrite: flux.capturePreWrite,
    showDiffForMessage: diff.showDiffForMessage,
    showToolDiff: diff.showToolDiff,
    robustLayout: page.robustLayout,
    disposeAll,
    updateEditor: flux.updateEditor,
    checkExternalModsSoon: disque.checkExternalModsSoon,
    rescueDirtyBuffers,
    historySession: enr.historySession,
    historyEntries: enr.historyEntries,
    historyLoading: enr.historyLoading,
    HISTORY_SOURCES: enr.HISTORY_SOURCES,
    loadHistorySession: enr.loadHistorySession,
    openHistoryPanel: enr.openHistoryPanel,
    toggleHistoryFile: enr.toggleHistoryFile,
    historyCompare: enr.historyCompare,
    historyRestore: enr.historyRestore,
    historyTime: enr.historyTime,
    toggleOriginalDiff: enr.toggleOriginalDiff,
    streamOpenForWrite: flux.streamOpenForWrite,
    streamLocateEdit: flux.streamLocateEdit,
    streamWriteChunk: flux.streamWriteChunk,
    streamFinalize: flux.streamFinalize,
    isStreamActive: flux.isStreamActive,
    getStreamPreSnapshot: flux.getStreamPreSnapshot,
    loadSandboxFiles: fs.loadSandboxFiles,
    treeTruncated: fs.treeTruncated,
    toggleHiddenFiles: fs.toggleHiddenFiles,
    loadSandboxQuota: fs.loadSandboxQuota,
    scheduleQuotaRefresh: fs.scheduleQuotaRefresh,
    downloadFile: fs.downloadFile,
    createFolder: fs.createFolder,
    createFile: fs.createFile,
    openFileAtLine: fs.openFileAtLine,
    renameItem: fs.renameItem,
    deleteFile: fs.deleteFile,
    moveItem: fs.moveItem,
    triggerSandboxImport: fs.triggerSandboxImport,
    handleSandboxImport: fs.handleSandboxImport,
    snapshots: fs.snapshots,
    snapshotsMax: fs.snapshotsMax,
    snapshotBusy: fs.snapshotBusy,
    snapshotProgress: fs.snapshotProgress,
    showSnapshotPanel: fs.showSnapshotPanel,
    snapshotName: fs.snapshotName,
    loadSnapshots: fs.loadSnapshots,
    createSnapshot: fs.createSnapshot,
    restoreSnapshot: fs.restoreSnapshot,
    deleteSnapshot: fs.deleteSnapshot,
    toggleSnapshotPanel: fs.toggleSnapshotPanel,
    restoreIncomplete: fs.restoreIncomplete,
    dismissRestoreIncomplete: fs.dismissRestoreIncomplete,
    restoreIncompleteWhen: fs.restoreIncompleteWhen,
    fimLoading: e.fimLoading,
    fimGhostText: e.fimGhostText,
    editorCtxMenu: e.editorCtxMenu,
    closeEditorCtxMenu: outils.closeEditorCtxMenu,
    editorCtxComplete: ia.editorCtxComplete,
    editorCtxRunAI: ia.editorCtxRunAI,
    editorCtxToggleComment: outils.editorCtxToggleComment,
    editorCtxFormatDoc: outils.editorCtxFormatDoc,
    editorCtxCopy: outils.editorCtxCopy,
    editorCtxGoToDef: outils.editorCtxGoToDef,
    editorCtxFindRefs: outils.editorCtxFindRefs,
    editorCtxRename: outils.editorCtxRename,
    showTerminal: terminal.showTerminal,
    terminalHeight: terminal.terminalHeight,
    terminalInitOverlay: terminal.terminalInitOverlay,
    dismissTerminalInitOverlay: terminal.dismissTerminalInitOverlay,
    toggleTerminal: terminal.toggleTerminal,
    terminalResizeStart: redim.terminalResizeStart,
    termSessions: terminal.termSessions,
    termActiveSid: terminal.termActiveSid,
    termMaxSessions: terminal.termMaxSessions,
    termMultiSession: terminal.termMultiSession,
    termRenamingSid: terminal.termRenamingSid,
    termRenameValue: terminal.termRenameValue,
    termSessionStatus: terminal.termSessionStatus,
    termSessionState: terminal.termSessionState,
    termSessionTitle: terminal.termSessionTitle,
    termNewSession: terminal.termNewSession,
    termCloseSession: terminal.termCloseSession,
    termSwitchTo: terminal.termSwitchTo,
    termStartRename: terminal.termStartRename,
    termCommitRename: terminal.termCommitRename,
    termCancelRename: terminal.termCancelRename,
    editorSplitDragging: redim.editorSplitDragging,
    editorSplitStart: redim.editorSplitStart,
    explorerResizeStart: redim.explorerResizeStart,
    mdPreview: e.mdPreview,
    isCurrentFileMd: scindee.isCurrentFileMd,
    svgPreview: e.svgPreview,
    isCurrentFileSvg: scindee.isCurrentFileSvg,
    toggleSvgPreview: scindee.toggleSvgPreview,
    editorFullscreen: e.editorFullscreen,
    toggleEditorFullscreen: page.toggleEditorFullscreen,
    exitEditorFullscreen: page.exitEditorFullscreen,
    showEscapeHint: e.showEscapeHint,
    showEditorMore: e.showEditorMore,
    splitView: e.splitView,
    splitTabPath: e.splitTabPath,
    activePane: e.activePane,
    splitRatio: e.splitRatio,
    splitMode: e.splitMode,
    toggleSplit: scindee.toggleSplit,
    enterSplit: scindee.enterSplit,
    exitSplit: scindee.exitSplit,
    setSplitFile: scindee.setSplitFile,
    toggleSplitPreview: scindee.toggleSplitPreview,
    enterSplitPreview: scindee.enterSplitPreview,
    previewLive: apercu.previewLive,
    togglePreviewLive: apercu.togglePreviewLive,
    openPreviewInNewTab: apercu.openPreviewInNewTab,
    onTabActivate: scindee.onTabActivate,
    openInSplit: scindee.openInSplit,
    splitResizeStart: scindee.splitResizeStart,
    revealFolderInTree: outils.revealFolderInTree,
    breadcrumbSegments: e.breadcrumbSegments,
    explorerTab: git.explorerTab,
    gitRepos: git.gitRepos,
    gitCurrentRepo: git.gitCurrentRepo,
    showGitRepoMenu: git.showGitRepoMenu,
    showExplorerMenu: git.showExplorerMenu,
    gitStatus: git.gitStatus,
    gitBranches: git.gitBranches,
    gitCommitMsg: git.gitCommitMsg,
    gitLoading: git.gitLoading,
    gitError: git.gitError,
    showGitCloneModal: git.showGitCloneModal,
    gitCloneForm: git.gitCloneForm,
    showGitBranchMenu: git.showGitBranchMenu,
    gitCloneConnectorId: git.gitCloneConnectorId,
    gitCloneRepos: git.gitCloneRepos,
    gitCloneReposLoading: git.gitCloneReposLoading,
    gitCloneReposError: git.gitCloneReposError,
    gitCloneRepoFilter: git.gitCloneRepoFilter,
    gitFilteredCloneRepos: git.gitFilteredCloneRepos,
    gitOpenCloneModal: git.gitOpenCloneModal,
    gitLoadConnectorRepos: git.gitLoadConnectorRepos,
    gitPickRepo: git.gitPickRepo,
    showGitRemoteModal: git.showGitRemoteModal,
    gitRemoteForm: git.gitRemoteForm,
    showGitInitModal: git.showGitInitModal,
    gitInitForm: git.gitInitForm,
    showGitMoreMenu: git.showGitMoreMenu,
    showGitMergeModal: git.showGitMergeModal,
    gitMergePreview: git.gitMergePreview,
    gitMergeBranch: git.gitMergeBranch,
    showGitPushAuth: git.showGitPushAuth,
    gitCredShowPwd: git.gitCredShowPwd,
    gitPushAfterAuth: git.gitPushAfterAuth,
    gitOpenMergeModal: git.gitOpenMergeModal,
    gitLoadMergePreview: git.gitLoadMergePreview,
    gitExecuteMerge: git.gitExecuteMerge,
    gitMergeAbort: git.gitMergeAbort,
    gitMergeResolve: git.gitMergeResolve,
    gitTree: git.gitTree,
    gitLog: git.gitLog,
    gitDiffData: git.gitDiffData,
    gitCredUser: git.gitCredUser,
    gitCredToken: git.gitCredToken,
    gitSectionOpen: git.gitSectionOpen,
    gitOpenTab: git.gitOpenTab,
    gitSelectRepo: git.gitSelectRepo,
    gitLoadRepos: git.gitLoadRepos,
    gitRefresh: git.gitRefresh,
    gitLoadBranches: git.gitLoadBranches,
    gitLoadTree: git.gitLoadTree,
    gitLoadLog: git.gitLoadLog,
    gitOpenRepoFile: git.gitOpenRepoFile,
    gitViewCommitDiff: git.gitViewCommitDiff,
    gitShowFileDiff: git.gitShowFileDiff,
    gitRestoreCommit: git.gitRestoreCommit,
    gitRevertLast: git.gitRevertLast,
    gitInit: git.gitInit,
    gitClone: git.gitClone,
    gitStage: git.gitStage,
    gitUnstage: git.gitUnstage,
    gitDiscard: git.gitDiscard,
    gitCommit: git.gitCommit,
    gitPush: git.gitPush,
    gitPull: git.gitPull,
    gitFetch: git.gitFetch,
    gitCheckout: git.gitCheckout,
    gitCreateBranch: git.gitCreateBranch,
    gitPromptMerge: git.gitPromptMerge,
    gitRebase: git.gitRebase,
    gitPromptRebase: git.gitPromptRebase,
    gitStash: git.gitStash,
    gitSetRemote: git.gitSetRemote,
    _getLang: langageDe,
    quickOpenVisible: ouvertureRapide.quickOpenVisible,
    quickOpenQuery: ouvertureRapide.quickOpenQuery,
    quickOpenSelectedIdx: ouvertureRapide.quickOpenSelectedIdx,
    quickOpenResults: ouvertureRapide.quickOpenResults,
    openQuickOpen: ouvertureRapide.openQuickOpen,
    closeQuickOpen: ouvertureRapide.closeQuickOpen,
    quickOpenSelect: ouvertureRapide.quickOpenSelect,
    quickOpenKeyDown: ouvertureRapide.quickOpenKeyDown,
    statusCursor: barre.statusCursor,
    statusLineCount: barre.statusLineCount,
    statusLanguage: barre.statusLanguage,
    statusIndent: barre.statusIndent,
    tabCtxMenu: e.tabCtxMenu,
    openTabCtxMenu: onglets.openTabCtxMenu,
    closeTabCtxMenu: onglets.closeTabCtxMenu,
    closeOtherTabs: onglets.closeOtherTabs,
    closeTabsToRight: onglets.closeTabsToRight,
    closeAllTabs: onglets.closeAllTabs,
    copyTabPath: onglets.copyTabPath,
    reopenLastClosed: memoire.reopenLastClosed,
    dirtyTabs: e.dirtyTabs,
    tabStripRef: e.tabStripRef,
    hiddenTabsCount: e.hiddenTabsCount,
    showTabsOverflow: e.showTabsOverflow,
    updateHiddenTabs: onglets.updateHiddenTabs,
    pickTabFromOverflow: onglets.pickTabFromOverflow,
    scrollTabIntoView: onglets.scrollTabIntoView,
    shortcutsModalVisible: aide.shortcutsModalVisible,
    shortcutGroups: aide.shortcutGroups,
    openShortcutsModal: aide.openShortcutsModal,
    closeShortcutsModal: aide.closeShortcutsModal,
    activeFileViewMode: vis.activeFileViewMode,
    imageViewerPath: vis.imageViewerPath,
    hexViewerData: vis.hexViewerData,
    hexViewerLines: vis.hexViewerLines,
    hexViewerLoading: vis.hexViewerLoading,
    readOnlyTabs: vis.readOnlyTabs,
    activeIsViewer: vis.activeIsViewer,
    officeActive: vis.officeActive,
    officeNow: vis.officeNow,
    officeSetView: vis.officeSetView,
    officeReload: vis.officeReload,
    officeUseText: vis.officeUseText,
    officeFetchChunk: vis.officeFetchChunk,
    officeIsViewerPath: vis.officeIsViewerPath,
    editorRefreshViewer: vis.editorRefreshViewer,
    resetOnLogout,
    diskConflicts: e.diskConflicts,
    assistantStash: e.assistantStash,
    activeBanner: disque.activeBanner,
    conflictReload: disque.conflictReload,
    conflictCompare: disque.conflictCompare,
    conflictOverwrite: disque.conflictOverwrite,
    conflictDismiss: disque.conflictDismiss,
    stashRestore: disque.stashRestore,
    stashCompare: disque.stashCompare,
    stashDismiss: disque.stashDismiss,
    saveAllTabs: enr.saveAllTabs,
    revealActiveInTree: outils.revealActiveInTree,
    collapseAllFolders: outils.collapseAllFolders,
    explorerMultiCount: outils.explorerMultiCount,
    duplicateItem: fs.duplicateItem,
    togglePinTab: onglets.togglePinTab,
    tabIsPinned: onglets.tabIsPinned,
    reorderTabs: onglets.reorderTabs,
    tabIcon: onglets.tabIcon,
    tabHints: onglets.tabHints,
    navBack: onglets.navBack,
    navForward: onglets.navForward,
    recentFiles: recents.recentFiles,
    quickOpenRecent: ouvertureRapide.quickOpenRecent,
    searchCase: fs.searchCase,
    searchRegex: fs.searchRegex,
    searchGlob: fs.searchGlob,
    searchTruncated: fs.searchTruncated,
    searchError: fs.searchError,
    searchResultGroups: fs.searchResultGroups,
    showReplace: fs.showReplace,
    replaceText: fs.replaceText,
    replacePreview: fs.replacePreview,
    replaceBusy: fs.replaceBusy,
    replaceSelectedCount: fs.replaceSelectedCount,
    previewReplace: fs.previewReplace,
    applyReplace: fs.applyReplace,
    diffBase: e.diffBase,
    statusBranch: diff.statusBranch,
    activeInRepo: diff.activeInRepo,
    gitOpenChange: diff.gitOpenChange,
    gitResolveFile: git.gitResolveFile,
    gitSuggestCommitMessage: git.gitSuggestCommitMessage,
    gitCommitSuggesting: git.gitCommitSuggesting,
    statusEol: barre.statusEol,
    statusEncoding: barre.statusEncoding,
    statusEolMixed: barre.statusEolMixed,
    toggleEol: barre.toggleEol,
    statusSelection: barre.statusSelection,
    activeProblems: barre.activeProblems,
    problemCounts: barre.problemCounts,
    showProblems: barre.showProblems,
    goToProblem: barre.goToProblem,
    renderPaneKind: scindee.renderPaneKind,
    renderPaneSource: scindee.renderPaneSource,
    toggleSplitRender: scindee.toggleSplitRender,
    renderSvgSafe: scindee.renderSvgSafe,
    imageZoom: scindee.imageZoom,
    imageZoomLabel: scindee.imageZoomLabel,
    imageStyle: scindee.imageStyle,
    imageZoomBy: scindee.imageZoomBy,
    imageZoomSet: scindee.imageZoomSet,
    onImageLoad: scindee.onImageLoad,
    onImageWheel: scindee.onImageWheel,
    runActiveFile: outils.runActiveFile,
    canRunActive: outils.canRunActive,
    openTerminalHere: outils.openTerminalHere,
    askChatAboutSelection: outils.askChatAboutSelection,
    attachToChat: outils.attachToChat,
    openPathFromChat: outils.openPathFromChat,
    aiProposal: diff.aiProposal,
    acceptAiProposal: diff.acceptAiProposal,
    rejectAiProposal: diff.rejectAiProposal,
    monacoConsumesEscape: touches.monacoConsumesEscape,
  };
}

export type SurfaceEditeur = ReturnType<typeof setupEditor>;
