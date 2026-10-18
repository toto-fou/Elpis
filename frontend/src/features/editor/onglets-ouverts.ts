// SPDX-License-Identifier: MIT
/** frontend/src/features/editor/onglets-ouverts.ts — onglets de l'éditeur : ouverture (texte, visionneuses, .docx), changement, fermeture (modifications et copie de secours protégées), états de vue par onglet, menu d'onglet, débordement, navigation Alt+←/→. */
import { computed, nextTick, watch } from "vue";
import type { Ref } from "vue";

import { isViewerMode } from "../../utils/office-model";
import { editionMinimale, remplacerContenu } from "./ecriture-modele";
import type { CtxEditeur, EtatEditeur } from "./etat";
import { poserDans } from "./etat";
import type { ReglagesEditeur } from "./instances";
import { langageDe } from "./langages";
import { lireTexteOuBinaire } from "./lecture";
import type { LiensEditeur, OptionsOuverture, ServicesEditeur } from "./liens";
import { metaFichier } from "./meta-fichier";
import { basculerEpingle, indicesHomonymes, positionMenu } from "./onglets";
import type { MetaFichier, OngletEditeur } from "./onglets";
import { schemaDocx } from "./schemas-bac";

interface Position {
  path: string;
  line: number;
  col: number;
}

const urlBac = (endpoint: string): string => "/api/sandbox/" + endpoint;

/** Copie hors contexte sécurisé (HTTP sur IP du LAN) : `navigator.clipboard` y est absent. */
export function copierSecours(texte: string): boolean {
  try {
    const ta = document.createElement("textarea");
    ta.value = texte;
    ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function setupEditorTabs(
  e: EtatEditeur,
  s: ServicesEditeur,
  l: LiensEditeur,
  ctx: CtxEditeur,
  settings: Ref<ReglagesEditeur>,
) {
  const { monacoRef, openTabs, activeTabPath, originalFileContent, tabViewStates } = e;
  const { modeles, models, vis, disque } = s;
  const { showToast, fetchAuth, openConfirm } = ctx;

  const modelOk = (p: string | null | undefined): boolean => !!p && modeles.ok(p);

  // États de vue (défilement, curseur, sélection, plis) par onglet, en mémoire seulement.
  function _saveCurrentViewState(): void {
    const ed = monacoRef.instance;
    const chemin = activeTabPath.value;
    if (!ed || !chemin) return;
    const cur = ed.getModel();
    if (!cur || cur.isDisposed() || cur !== models[chemin]) return;
    if (e.writeStreams[chemin]?.active) return;
    try {
      const vs = ed.saveViewState();
      if (vs) tabViewStates[chemin] = vs;
    } catch {
      /* éditeur libéré */
    }
  }

  function _restoreViewStateFor(chemin: string): boolean {
    const ed = monacoRef.instance;
    if (!ed || !chemin) return false;
    const vs = tabViewStates[chemin];
    if (!vs) {
      // Onglet restauré au démarrage : curseur et défilement mémorisés.
      const pos = s.memoire._pendingPositions[chemin];
      if (!pos) return false;
      delete s.memoire._pendingPositions[chemin];
      try {
        const m = ed.getModel();
        const ligne = Math.min(Math.max(1, pos.line), m ? m.getLineCount() : pos.line);
        ed.setPosition({ lineNumber: ligne, column: Math.max(1, pos.col || 1) });
        if (pos.top) ed.setScrollTop(pos.top);
        else ed.revealLineInCenter(ligne);
        return true;
      } catch {
        return false;
      }
    }
    try {
      ed.restoreViewState(vs);
      return true;
    } catch {
      return false;
    }
  }

  function _clearViewStateFor(chemin: string): void {
    if (chemin && tabViewStates[chemin]) delete tabViewStates[chemin];
  }

  /** Onglet modifié : contenu du modèle différent du dernier contenu disque connu. */
  function _tabIsDirty(chemin: string | null | undefined): boolean {
    if (!chemin || !modelOk(chemin)) return false;
    try {
      const original = originalFileContent[chemin];
      return original !== undefined && models[chemin]?.getValue() !== original;
    } catch {
      return false;
    }
  }

  // Point « non sauvegardé » par onglet : ensemble réactif recalculé (120 ms) depuis _tabIsDirty.
  let minuterieModifies: ReturnType<typeof setTimeout> | null = null;
  function _refreshDirtyTabs(): void {
    const n = new Set<string>();
    for (const t of openTabs.value) {
      try {
        if (_tabIsDirty(t.path)) n.add(t.path);
      } catch {
        /* modèle libéré */
      }
    }
    const cur = e.dirtyTabs.value;
    if (n.size !== cur.size || [...n].some((p) => !cur.has(p))) e.dirtyTabs.value = n;
  }
  function _scheduleDirtyRefresh(): void {
    if (minuterieModifies) clearTimeout(minuterieModifies);
    minuterieModifies = setTimeout(() => {
      minuterieModifies = null;
      _refreshDirtyTabs();
    }, 120);
  }
  watch(e.isEditorDirty, _scheduleDirtyRefresh);
  watch(openTabs, _scheduleDirtyRefresh, { deep: true });

  // Débordement de la barre d'onglets : le composant mesure et fait défiler.
  function updateHiddenTabs(): void {
    e.tabStripRef.value?.mesurer();
  }
  watch(openTabs, () => nextTick(updateHiddenTabs), { deep: true });
  function scrollTabIntoView(chemin: string | null): void {
    e.tabStripRef.value?.defiler(chemin);
  }
  watch(activeTabPath, (p) =>
    nextTick(() => {
      scrollTabIntoView(p);
      updateHiddenTabs();
    }),
  );
  function pickTabFromOverflow(chemin: string): void {
    e.showTabsOverflow.value = false;
    void switchTab(chemin);
    void nextTick(() => {
      scrollTabIntoView(chemin);
      updateHiddenTabs();
    });
  }

  // Menu contextuel d'onglet.
  function openTabCtxMenu(ev: Event & { clientX: number; clientY: number }, chemin: string): void {
    ev.preventDefault();
    ev.stopPropagation();
    const pos = positionMenu(ev.clientX, ev.clientY, window.innerWidth, window.innerHeight);
    e.tabCtxMenu.value = { show: true, x: pos.x, y: pos.y, path: chemin };
  }
  function closeTabCtxMenu(): void {
    e.tabCtxMenu.value = { ...e.tabCtxMenu.value, show: false };
  }
  /** Ferme une liste d'onglets par closeTab (confirmation comprise) ; les épinglés survivent. */
  async function fermerChacun(chemins: string[]): Promise<void> {
    for (const p of chemins) {
      try {
        await closeTab(p, null);
      } catch {
        /* fermeture refusée */
      }
    }
  }
  async function closeOtherTabs(chemin: string): Promise<void> {
    closeTabCtxMenu();
    await fermerChacun(openTabs.value.filter((t) => t.path !== chemin && !t.pinned).map((t) => t.path));
  }
  async function closeTabsToRight(chemin: string): Promise<void> {
    closeTabCtxMenu();
    const i = openTabs.value.findIndex((t) => t.path === chemin);
    if (i < 0) return;
    await fermerChacun(
      openTabs.value
        .slice(i + 1)
        .filter((t) => !t.pinned)
        .map((t) => t.path),
    );
  }
  async function closeAllTabs(): Promise<void> {
    closeTabCtxMenu();
    await fermerChacun(openTabs.value.filter((t) => !t.pinned).map((t) => t.path));
  }
  function togglePinTab(chemin: string): void {
    closeTabCtxMenu();
    const tabs = basculerEpingle(openTabs.value, chemin);
    if (!tabs) return;
    openTabs.value = tabs;
    void nextTick(() => scrollTabIntoView(activeTabPath.value));
  }
  function tabIsPinned(chemin: string): boolean {
    return !!openTabs.value.find((x) => x.path === chemin)?.pinned;
  }
  function reorderTabs(tabs: OngletEditeur[]): void {
    openTabs.value = tabs;
  }
  function tabIcon(nom: string | { name?: string }): MetaFichier {
    try {
      return metaFichier(typeof nom === "string" ? nom : nom.name || "");
    } catch {
      return { icon: "ph-file", color: "text-slate-400" };
    }
  }
  const tabHints = computed(() => indicesHomonymes(openTabs.value));
  function copyTabPath(chemin: string): void {
    closeTabCtxMenu();
    if (!chemin) return;
    const ok = (): void => showToast("Chemin copié : " + chemin);
    const echec = (): void => {
      if (copierSecours(chemin)) ok();
      else showToast("Copie impossible", "error");
    };
    if (navigator.clipboard && window.isSecureContext)
      navigator.clipboard.writeText(chemin).then(ok).catch(echec);
    else echec();
  }

  // Précédent / suivant (Alt+← / Alt+→).
  const arriere: Position[] = [];
  const avant: Position[] = [];
  let navigationMuette = false;
  function positionCourante(): Position | null {
    const p = activeTabPath.value;
    if (!p) return null;
    let line = 1;
    let col = 1;
    try {
      const ed = monacoRef.instance;
      if (ed && ed.getModel() === models[p]) {
        const pos = ed.getPosition();
        if (pos) {
          line = pos.lineNumber;
          col = pos.column;
        }
      }
    } catch {
      /* éditeur libéré */
    }
    return { path: p, line, col };
  }
  function _pushNav(): void {
    if (navigationMuette) return;
    const pos = positionCourante();
    if (!pos) return;
    const derniere = arriere[arriere.length - 1];
    if (derniere && derniere.path === pos.path && derniere.line === pos.line) return;
    arriere.push(pos);
    if (arriere.length > 100) arriere.shift();
    avant.length = 0;
  }
  async function allerA(pos: Position): Promise<void> {
    navigationMuette = true;
    try {
      if (openTabs.value.some((t) => t.path === pos.path)) await switchTab(pos.path);
      else await openFile(pos.path, false);
    } finally {
      navigationMuette = false;
    }
    const ed = monacoRef.instance;
    if (ed && ed.getModel() === models[pos.path]) {
      const p = { lineNumber: pos.line, column: pos.col };
      try {
        ed.setPosition(p);
        ed.revealPositionInCenterIfOutsideViewport(p);
        ed.focus();
      } catch {
        /* éditeur libéré */
      }
    }
  }
  async function navBack(): Promise<void> {
    const pos = arriere.pop();
    if (!pos) return;
    const cur = positionCourante();
    if (cur) avant.push(cur);
    await allerA(pos);
  }
  async function navForward(): Promise<void> {
    const pos = avant.pop();
    if (!pos) return;
    const cur = positionCourante();
    if (cur) arriere.push(cur);
    await allerA(pos);
  }

  const enCours: Record<string, Promise<void>> = {};
  const grosSignales = new Set<string>();

  /** Ouvre `chemin` (rechargé par défaut) ; un appel concurrent sur le même chemin partage la même ouverture. */
  async function openFile(cheminBrut: string, forceReload?: boolean, opts?: OptionsOuverture): Promise<void> {
    const chemin = l.canon(cheminBrut);
    if (!chemin) return;
    const force = forceReload !== false;
    const discret = !!opts?.quiet;
    const deja = enCours[chemin];
    if (deja) return deja;
    const promesse = ouvrir(chemin, force, discret);
    enCours[chemin] = promesse;
    try {
      await promesse;
    } finally {
      delete enCours[chemin];
    }
  }

  /** Visionneuse, .docx ou texte ; un onglet modifié n'est jamais écrasé (conflit), un échec de lecture retire l'onglet sauf s'il existait avec son modèle. */
  async function ouvrir(chemin: string, force: boolean, discret: boolean): Promise<void> {
    if (!e.showEditor.value) {
      e.showEditor.value = true;
      await nextTick();
      void s.fs.loadSandboxFiles();
    }
    await l.initMonaco();
    const ed = monacoRef.instance;
    if (!ed) return;
    e.editorMode.value = "code";
    e.isDiffView.value = false;
    if (activeTabPath.value && activeTabPath.value !== chemin) {
      _pushNav();
      _saveCurrentViewState();
    }
    const garderSiEchec = !!openTabs.value.find((t) => t.path === chemin) && modelOk(chemin);
    if (!openTabs.value.find((t) => t.path === chemin))
      openTabs.value.push({ path: chemin, name: chemin.split("/").pop() ?? chemin });
    activeTabPath.value = chemin;
    e.editorFilePath.value = chemin;

    const mode = vis._resolveFileViewMode(chemin);
    if (mode === "office") {
      if (models[chemin]) modeles.liberer(chemin);
      originalFileContent[chemin] = "";
      await vis.officeOpen(chemin, { force });
      l.robustLayout();
      return;
    }
    if (mode === "image") {
      vis.imageViewerPath.value = urlBac("download?path=") + encodeURIComponent(chemin);
      originalFileContent[chemin] = "";
      l.robustLayout();
      return;
    }
    if (mode === "hex") {
      if (models[chemin]) modeles.liberer(chemin);
      await vis._openHex(chemin);
      originalFileContent[chemin] = "";
      l.robustLayout();
      return;
    }
    if (mode === "docx") {
      await ouvrirDocx(chemin);
      if (modelOk(chemin) && activeTabPath.value === chemin) {
        try {
          const m = models[chemin];
          if (m) ed.setModel(m);
          ed.updateOptions({ readOnly: true });
        } catch {
          /* éditeur libéré */
        }
      }
      l.robustLayout();
      return;
    }

    try {
      const res = await fetchAuth(urlBac("download?path=") + encodeURIComponent(chemin));
      const mtimeDisque = disque._mtimeOf(res);
      const shaDisque = disque._shaOf(res);
      if (res && res.ok) {
        const lu = await lireTexteOuBinaire(res);
        if ("binary" in lu) {
          vis._setWith(vis.binaryPaths, chemin);
          if (models[chemin]) modeles.liberer(chemin);
          originalFileContent[chemin] = "";
          if (activeTabPath.value === chemin) await vis._openHex(chemin);
          l.robustLayout();
          return;
        }
        const contenu = lu.text;
        e.openTransientFail.delete(chemin);
        if (contenu.length > 5 * 1024 * 1024 && !grosSignales.has(chemin)) {
          grosSignales.add(chemin);
          showToast(
            "Fichier volumineux (" +
              Math.round(contenu.length / 1048576) +
              " Mo) — l'éditeur peut être ralenti",
            "info",
          );
        }
        const lang = langageDe(chemin);
        let realigne = false;
        if (!modelOk(chemin)) {
          modeles.liberer(chemin);
          modeles.assurer(chemin, contenu, lang);
          s.barre._detectIndentation(models[chemin]);
          realigne = true;
        } else if (force) {
          const m = models[chemin];
          if (m) {
            const avantOrig = originalFileContent[chemin];
            const modifieLocal = avantOrig !== undefined && m.getValue() !== avantOrig;
            if (modifieLocal && !l.isStreamActive(chemin)) {
              const memeBase = shaDisque ? shaDisque === disque.fileShas[chemin] : contenu === avantOrig;
              if (memeBase || contenu === avantOrig) {
                disque._setBase(chemin, mtimeDisque, shaDisque);
              } else {
                poserDans(e.diskConflicts, chemin, { mtime: mtimeDisque, missing: false });
                disque._handledDiskMtime[chemin] = shaDisque || mtimeDisque;
              }
            } else {
              disque._syncModelEol(m, lu.eol);
              if (m.getValue() !== contenu && !l.isStreamActive(chemin))
                editionMinimale(m, m.getValue(), contenu);
              realigne = true;
            }
            if (m.getLanguageId() !== lang) window.monaco?.editor.setModelLanguage(m, lang);
          }
        }
        if (realigne) disque._adoptDisk(chemin, { ...lu, mtime: mtimeDisque, sha: shaDisque });
        if (realigne && vis.readOnlyTabs.value.has(chemin) && !disque.fileFormats[chemin]?.lossy) {
          vis.readOnlyTabs.value.delete(chemin);
          if (activeTabPath.value === chemin) vis._applyActiveReadOnly();
        }
        l.rememberRecent(chemin);
        l.scheduleLint(chemin, models[chemin] ? models[chemin].getValue() : "");
        l.scheduleScmRefresh(chemin);
      } else {
        const nom = chemin.split("/").pop() ?? chemin;
        let message: string;
        if (!res) message = "Session expirée — reconnectez-vous pour ouvrir " + nom + ".";
        else if (res.status === 404) message = "Fichier introuvable : " + nom;
        else if (res.status === 503)
          message =
            "Impossible d’ouvrir " +
            nom +
            " : environnement sandbox " +
            "indisponible (redémarrage en cours) — réessayez dans quelques instants.";
        else message = "Impossible d’ouvrir " + nom + " (erreur " + res.status + ") — réessayez.";
        if (!res || res.status !== 404) e.openTransientFail.add(chemin);
        else e.openTransientFail.delete(chemin);
        if (garderSiEchec && modelOk(chemin)) {
          showToast(
            message.replace(/ — réessayez\.?$/, "") +
              (_tabIsDirty(chemin) ? " — vos modifications sont conservées." : ""),
            "error",
          );
          if (activeTabPath.value === chemin) {
            try {
              const m = models[chemin];
              if (m) ed.setModel(m);
            } catch {
              /* éditeur libéré */
            }
            _restoreViewStateFor(chemin);
            l.updateDiffView();
          }
          l.robustLayout();
          return;
        }
        if (!discret) showToast(message, "error");
        const i = openTabs.value.findIndex((t) => t.path === chemin);
        if (i !== -1) {
          openTabs.value.splice(i, 1);
          modeles.liberer(chemin);
          delete originalFileContent[chemin];
        }
        if (activeTabPath.value === chemin) {
          activeTabPath.value = openTabs.value.length
            ? (openTabs.value[openTabs.value.length - 1]?.path ?? null)
            : null;
          const actif = activeTabPath.value;
          try {
            if (actif && modelOk(actif)) {
              const m = models[actif];
              if (m) ed.setModel(m);
            } else if (!actif) ed.setModel(null);
          } catch {
            /* éditeur libéré */
          }
        }
        return;
      }
    } catch {
      showToast(
        "Lecture de " +
          (chemin.split("/").pop() ?? chemin) +
          " interrompue — " +
          "réponse incomplète du serveur. Refermez l’onglet et réessayez.",
        "error",
      );
    }
    if (modelOk(chemin) && activeTabPath.value === chemin) {
      try {
        const m = models[chemin];
        if (m) ed.setModel(m);
      } catch {
        /* éditeur libéré */
      }
      _restoreViewStateFor(chemin);
      l.updateDiffView();
    }
    l.robustLayout();
    if (chemin.toLowerCase().endsWith(".html")) s.apercu.previewPath.value = chemin;
  }

  /** .docx : texte extrait par le serveur, onglet en lecture seule. */
  async function ouvrirDocx(chemin: string): Promise<void> {
    try {
      const res = await fetchAuth(urlBac("read-docx?path=") + encodeURIComponent(chemin));
      if (res && res.ok) {
        const lu = schemaDocx.safeParse(await res.json());
        const texte = (lu.success && lu.data.text) || "";
        originalFileContent[chemin] = texte;
        vis.readOnlyTabs.value.add(chemin);
        const m = models[chemin];
        if (!modelOk(chemin) || !m) {
          modeles.liberer(chemin);
          modeles.assurer(chemin, texte, "plaintext");
        } else {
          remplacerContenu(m, texte);
          window.monaco?.editor.setModelLanguage(m, "plaintext");
        }
        showToast("Lecture seule (fichier .docx)");
      } else if (res && res.status === 501) {
        showToast("Support .docx non installé côté serveur", "error");
      } else {
        showToast("Lecture .docx échouée", "error");
      }
    } catch {
      showToast("Erreur lecture .docx", "error");
    }
  }

  /** État de vue de l'onglet quitté saisi, retard d'enregistrement vidé avant le changement (il viserait sinon le nouvel onglet). */
  async function switchTab(chemin: string): Promise<void> {
    if (activeTabPath.value && activeTabPath.value !== chemin) {
      _pushNav();
      _saveCurrentViewState();
    }
    const quitte = activeTabPath.value;
    if (s.sauvegarde.cheminRetarde("left")) {
      void s.sauvegarde.vider("left");
    } else if (
      quitte &&
      quitte !== chemin &&
      settings.value?.editor_auto_save === "on_blur" &&
      _tabIsDirty(quitte)
    ) {
      void l.saveEditorContent({ silent: true, path: quitte });
    }
    activeTabPath.value = chemin;
    e.editorFilePath.value = chemin;
    e.isEditorDirty.value = _tabIsDirty(chemin);
    if (isViewerMode(vis._resolveFileViewMode(chemin))) {
      await openFile(chemin, true);
      return;
    }
    if (!modelOk(chemin)) {
      modeles.liberer(chemin);
      await openFile(chemin, true);
      return;
    }
    try {
      const m = models[chemin];
      if (m) monacoRef.instance?.setModel(m);
      _restoreViewStateFor(chemin);
      if (e.isDiffView.value) l.updateDiffView();
    } catch {
      /* éditeur libéré */
    }
    if (chemin.toLowerCase().endsWith(".html")) s.apercu.previewPath.value = chemin;
    l.robustLayout();
    l.scheduleLint(chemin, models[chemin] ? models[chemin].getValue() : "");
    l.rememberRecent(chemin);
    l.scheduleScmRefresh(chemin);
  }

  /** Onglet modifié : enregistré d'abord en mode automatique, sinon question ; copie de secours confirmée ; panneau droit réassigné. */
  async function closeTab(chemin: string, ev?: Event | null, force?: boolean): Promise<void> {
    ev?.stopPropagation();
    if (openTabs.value.findIndex((t) => t.path === chemin) === -1) return;
    if (!force && _tabIsDirty(chemin)) {
      if ((settings.value?.editor_auto_save || "off") !== "off") {
        if (s.sauvegarde.cheminRetarde("left") === chemin) s.sauvegarde.annulerRetard("left");
        if (s.sauvegarde.cheminRetarde("right") === chemin) s.sauvegarde.annulerRetard("right");
        await l.saveEditorContent({ silent: true, path: chemin });
      }
      if (_tabIsDirty(chemin)) {
        const nom = chemin.split("/").pop() ?? chemin;
        const choix = ctx.openChoice
          ? await ctx.openChoice(
              "Enregistrer « " + nom + " » ?",
              "Ce fichier contient des modifications non enregistrées.",
              [
                { id: "discard", label: "Ne pas enregistrer", tone: "danger" },
                { id: "save", label: "Enregistrer", tone: "primary" },
              ],
            )
          : (await openConfirm("Fermer sans sauvegarder ?", nom, true, "Fermer sans sauvegarder", "Annuler"))
            ? "discard"
            : null;
        if (!choix) return;
        if (choix === "save") {
          await l.saveEditorContent({ path: chemin });
          if (_tabIsDirty(chemin)) return;
        }
      }
    }
    if (!force && e.assistantStash.value[chemin]) {
      const nom = chemin.split("/").pop() ?? chemin;
      if (
        !(await openConfirm(
          "Fermer « " + nom + " » ?",
          "Vos modifications mises de côté avant l’écriture de l’assistant seront perdues.",
          true,
          "Fermer quand même",
          "Annuler",
        ))
      )
        return;
    }
    const i = openTabs.value.findIndex((t) => t.path === chemin);
    if (i === -1) return;
    _clearViewStateFor(chemin);
    disque._dropBase(chemin);
    e.restorePending.delete(chemin);
    poserDans(e.diskConflicts, chemin, null);
    poserDans(e.assistantStash, chemin, null);
    l.clearScm(chemin);
    openTabs.value.splice(i, 1);
    void nextTick(() => scrollTabIntoView(activeTabPath.value));
    modeles.liberer(chemin);
    delete originalFileContent[chemin];
    if (vis.readOnlyTabs.value.has(chemin)) vis.readOnlyTabs.value.delete(chemin);
    vis.oublierVisionneuse(chemin);
    if (chemin === activeTabPath.value) {
      const suivant = openTabs.value[Math.min(i, openTabs.value.length - 1)];
      if (suivant) {
        void switchTab(suivant.path);
      } else {
        activeTabPath.value = null;
        try {
          monacoRef.instance?.setModel(null);
        } catch {
          /* éditeur libéré */
        }
        try {
          monacoRef.diff?.setModel(null);
        } catch {
          /* éditeur libéré */
        }
      }
    }
    if (chemin === e.splitTabPath.value && e.splitMode.value === "code") {
      const autre = openTabs.value.find(
        (t) => t.path !== activeTabPath.value && !vis.officeIsViewerPath(t.path),
      );
      if (e.splitView.value && autre) l.setSplitFile(autre.path);
      else {
        e.splitTabPath.value = null;
        l.exitSplit();
      }
    }
  }

  return {
    _saveCurrentViewState,
    _restoreViewStateFor,
    _clearViewStateFor,
    _tabIsDirty,
    _scheduleDirtyRefresh,
    updateHiddenTabs,
    scrollTabIntoView,
    pickTabFromOverflow,
    openTabCtxMenu,
    closeTabCtxMenu,
    closeOtherTabs,
    closeTabsToRight,
    closeAllTabs,
    togglePinTab,
    tabIsPinned,
    reorderTabs,
    tabIcon,
    tabHints,
    copyTabPath,
    _pushNav,
    navBack,
    navForward,
    openFile,
    switchTab,
    closeTab,
    libererOnglets(): void {
      if (minuterieModifies) clearTimeout(minuterieModifies);
      minuterieModifies = null;
    },
  };
}
