// SPDX-License-Identifier: MIT
/** frontend/src/features/editor/diff.ts — vue diff de l'éditeur (dernier enregistrement, dernier commit, version donnée par l'appelant), proposition de l'IA (Accepter / Rejeter), marge Git du code, pastilles de l'arbre et branche de la barre d'état. */
import { computed, nextTick, ref, watch } from "vue";
import type { Ref } from "vue";
import type * as M from "monaco-editor";

import { hunks, lines } from "../../utils/line-diff";
import { arbre } from "./arbre";
import { remplacerContenu } from "./ecriture-modele";
import type { CtxEditeur, EtatEditeur, Modele } from "./etat";
import type { PropositionIa } from "./ia";
import type { ReglagesEditeur } from "./instances";
import { langageDe } from "./langages";
import type { LiensEditeur, ServicesEditeur } from "./liens";
import { lireJson, schemaGitFichier } from "./schemas-bac";
import type { StatutGit } from "./schemas-bac";

interface Depot {
  repo: string;
  pre: string;
}

/** Statut Git → pastille par chemin (préfixe du dépôt courant ajouté). */
export function pastillesGit(
  st:
    | Partial<Pick<StatutGit, "is_repo" | "untracked" | "staged" | "modified" | "conflicted">>
    | null
    | undefined,
  depot: string | null | undefined,
): Record<string, string> {
  const carte: Record<string, string> = {};
  if (!st || !st.is_repo) return carte;
  const pre = depot && depot !== "." ? depot + "/" : "";
  for (const f of st.untracked ?? []) carte[pre + f.path] = "U";
  for (const f of st.staged ?? [])
    carte[pre + f.path] = f.status === "A" ? "A" : f.status === "D" ? "D" : "M";
  for (const f of st.modified ?? []) carte[pre + f.path] = f.status === "D" ? "D" : "M";
  for (const f of st.conflicted ?? []) carte[pre + f.path] = "C";
  return carte;
}

export function setupEditorDiff(
  e: EtatEditeur,
  s: ServicesEditeur,
  l: LiensEditeur,
  ctx: CtxEditeur,
  settings: Ref<ReglagesEditeur>,
) {
  const { monacoRef, isDiffView, diffBase, activeTabPath, originalFileContent, openTabs } = e;
  const { models, vis, git } = s;
  const { showToast } = ctx;
  const modelOk = (p: string | null | undefined): boolean => !!p && s.modeles.ok(p);

  // Contenu de HEAD par chemin (null : hors dépôt, non suivi, illisible) et décorations de la marge.
  const tete: Record<string, { text: string | null }> = Object.create(null) as Record<
    string,
    { text: string | null }
  >;
  const decorations: Record<string, string[]> = Object.create(null) as Record<string, string[]>;

  function updateDiffView(): void {
    const chemin = activeTabPath.value;
    const diff = monacoRef.diff;
    const original = monacoRef.originalModel;
    if (!isDiffView.value || !chemin || !diff || !original || !modelOk(chemin)) return;
    if (diffBase.value !== "saved" && diffBase.value !== "head") return;
    const modifie = models[chemin];
    if (!modifie) return;
    const texte = diffBase.value === "head" ? (tete[chemin]?.text ?? "") : originalFileContent[chemin] || "";
    try {
      if (original.getValue() !== texte) remplacerContenu(original, texte);
      window.monaco?.editor.setModelLanguage(original, modifie.getLanguageId());
      diff.setModel({ original, modified: modifie });
      diff.layout();
    } catch {
      /* éditeur libéré */
    }
  }

  /** Bascule le diff ('saved' : dernier enregistrement, 'head' : dernier commit) ; la base déjà affichée le referme. */
  async function toggleDiffMode(baseDemandee?: string): Promise<void> {
    const base = baseDemandee === "head" ? "head" : "saved";
    if (isDiffView.value && diffBase.value === base) {
      isDiffView.value = false;
      diffBase.value = "saved";
      void nextTick(() => l.robustLayout());
      return;
    }
    if (base === "head") {
      const chemin = activeTabPath.value;
      const texte = chemin ? await _loadHead(chemin) : null;
      if (typeof texte !== "string") {
        showToast("Pas de version commitée pour ce fichier", "info");
        return;
      }
    }
    diffBase.value = base;
    isDiffView.value = true;
    e.showExplorer.value = false;
    ctx.showSidebar.value = false;
    void nextTick(() => {
      updateDiffView();
      l.robustLayout();
    });
  }

  // Quitter l'onglet referme un diff ponctuel (conflit, copie, proposition) : son côté gauche est à l'autre fichier.
  watch(activeTabPath, () => {
    if (isDiffView.value && !["saved", "head"].includes(diffBase.value)) {
      if (diffBase.value === "proposal") rejectAiProposal({ silent: true });
      isDiffView.value = false;
      diffBase.value = "saved";
    }
  });

  /** Diff d'un fichier modifié par un outil (carte du chat) : ouvert et rendu actif d'abord ; `avant` null : ouverture seule. */
  async function showToolDiff(cheminBrut: string, avant?: string | null): Promise<void> {
    const chemin = l.canon(cheminBrut);
    if (!chemin || !settings.value.enable_editor) return;
    if (vis.officeIsViewerPath(chemin)) {
      void l.openFile(chemin, true);
      return;
    }
    const m = models[chemin];
    if (!m || m.isDisposed() || activeTabPath.value !== chemin) {
      await l.openFile(chemin, !models[chemin], { quiet: true });
      await nextTick();
    }
    if (avant === null || avant === undefined) return;
    const apres = models[chemin];
    if (!apres || apres.isDisposed()) {
      showToast("Fichier introuvable dans la sandbox", "error");
      return;
    }
    showDiffForMessage(chemin, avant, "assistant");
  }

  function showDiffForMessage(cheminBrut: string, avant: string | null, base?: string): void {
    const chemin = l.canon(cheminBrut);
    if (!chemin || avant === null) return;
    diffBase.value = base || "external";
    if (!settings.value.enable_editor) return;
    if (vis.officeIsViewerPath(chemin)) {
      void l.openFile(chemin, true);
      return;
    }
    e.showEditor.value = true;
    e.editorMode.value = "code";
    void nextTick(async () => {
      await l.initMonaco();
      const ed = monacoRef.instance;
      const diff = monacoRef.diff;
      const original = monacoRef.originalModel;
      if (!ed || !diff || !original) return;
      if (activeTabPath.value !== chemin) {
        if (!openTabs.value.find((t) => t.path === chemin))
          openTabs.value.push({ path: chemin, name: chemin.split("/").pop() ?? chemin });
        activeTabPath.value = chemin;
        e.editorFilePath.value = chemin;
        const m = models[chemin];
        if (m && !m.isDisposed()) {
          try {
            ed.setModel(m);
          } catch {
            /* éditeur libéré */
          }
        }
      }
      try {
        if (original.getValue() !== avant) remplacerContenu(original, avant);
        const m = models[chemin];
        if (m && !m.isDisposed()) window.monaco?.editor.setModelLanguage(original, langageDe(chemin));
        diff.setModel({ original, modified: m ?? original });
      } catch {
        /* éditeur libéré */
      }
      isDiffView.value = true;
      l.robustLayout();
    });
  }

  // Proposition de l'IA montrée en diff (côté droit en lecture seule) avant application.
  const aiProposal = ref<{ path: string | null; label: string } | null>(null);
  let proposition: (Omit<PropositionIa, "label"> & { tmp: Modele }) | null = null;

  function proposeAiEdit(p: PropositionIa): boolean {
    const monaco = window.monaco;
    const diff = monacoRef.diff;
    const original = monacoRef.originalModel;
    if (!p || !p.model || !diff || !original || !monaco) return false;
    rejectAiProposal({ silent: true });
    const m = p.model;
    const texte = m.getValue();
    const a = m.getOffsetAt({ lineNumber: p.range.startLineNumber, column: p.range.startColumn });
    const b = m.getOffsetAt({ lineNumber: p.range.endLineNumber, column: p.range.endColumn });
    const tmp = monaco.editor.createModel(texte.slice(0, a) + p.text + texte.slice(b), m.getLanguageId());
    try {
      remplacerContenu(original, texte);
      monaco.editor.setModelLanguage(original, m.getLanguageId());
      diff.setModel({ original, modified: tmp });
      diff.getModifiedEditor().updateOptions({ readOnly: true });
    } catch {
      try {
        tmp.dispose();
      } catch {
        /* déjà libéré */
      }
      return false;
    }
    proposition = { model: m, versionId: p.versionId, range: p.range, text: p.text, tmp };
    aiProposal.value = { path: activeTabPath.value, label: p.label || "Proposition de l'IA" };
    diffBase.value = "proposal";
    isDiffView.value = true;
    void nextTick(() => {
      l.robustLayout();
      try {
        monacoRef.diff?.getModifiedEditor().revealLineInCenter(p.range.startLineNumber);
      } catch {
        /* éditeur libéré */
      }
    });
    return true;
  }

  function fermerProposition(): void {
    const pr = proposition;
    proposition = null;
    aiProposal.value = null;
    try {
      monacoRef.diff?.getModifiedEditor().updateOptions({ readOnly: false });
    } catch {
      /* éditeur libéré */
    }
    if (isDiffView.value && diffBase.value === "proposal") {
      isDiffView.value = false;
      diffBase.value = "saved";
    }
    try {
      if (monacoRef.diff && pr) monacoRef.diff.setModel(null);
    } catch {
      /* éditeur libéré */
    }
    try {
      pr?.tmp.dispose();
    } catch {
      /* déjà libéré */
    }
    void nextTick(() => l.robustLayout());
  }

  function acceptAiProposal(): void {
    const pr = proposition;
    if (!pr) return;
    if (pr.model.isDisposed() || pr.model.getVersionId() !== pr.versionId) {
      showToast("Document modifié entre-temps — proposition abandonnée", "warning");
      fermerProposition();
      return;
    }
    fermerProposition();
    try {
      const ed = monacoRef.instance;
      if (ed && ed.getModel() === pr.model) {
        ed.executeEdits("ai-infill", [{ range: pr.range, text: pr.text }]);
        ed.focus();
      } else {
        pr.model.pushEditOperations([], [{ range: pr.range, text: pr.text }], () => null);
      }
      showToast("Modification appliquée");
    } catch {
      showToast("Application impossible", "error");
    }
  }

  function rejectAiProposal(opts?: { silent?: boolean }): void {
    if (!proposition) return;
    fermerProposition();
    if (!opts?.silent) showToast("Proposition rejetée");
  }

  // Marge Git : ajouts, modifications, suppressions par rapport à HEAD.
  function depotDe(chemin: string): Depot | null {
    let meilleur: Depot | null = null;
    for (const r of git.gitRepos.value || []) {
      const rp = r.path;
      if (rp == null) continue;
      const pre = rp && rp !== "." ? rp + "/" : "";
      if (pre && !chemin.startsWith(pre)) continue;
      if (!meilleur || pre.length > meilleur.pre.length) meilleur = { repo: rp, pre };
    }
    return meilleur;
  }

  async function _loadHead(chemin: string, force?: boolean): Promise<string | null> {
    const connu = tete[chemin];
    if (!force && connu) return connu.text;
    const depot = depotDe(chemin);
    if (!depot) {
      tete[chemin] = { text: null };
      return null;
    }
    let texte: string | null = null;
    try {
      const res = await ctx.fetchAuth(
        "/api/sandbox/git/show-file?repo=" +
          encodeURIComponent(depot.repo) +
          "&hash=HEAD&path=" +
          encodeURIComponent(chemin.slice(depot.pre.length)),
        {},
        true,
      );
      if (res && res.ok) texte = (await lireJson(res, schemaGitFichier))?.content ?? null;
    } catch {
      texte = null;
    }
    tete[chemin] = { text: texte };
    return texte;
  }

  let minuterieScm: ReturnType<typeof setTimeout> | undefined;
  let cheminScm: string | null = null;
  function _scheduleScmRefresh(chemin: string): void {
    if (!chemin) return;
    cheminScm = chemin;
    clearTimeout(minuterieScm);
    minuterieScm = setTimeout(() => {
      if (cheminScm) void rafraichirScm(cheminScm);
    }, 350);
  }
  async function rafraichirScm(chemin: string): Promise<void> {
    if (!chemin || !modelOk(chemin) || !window.monaco) return;
    if (!(git.gitRepos.value || []).length) {
      appliquerScm(chemin);
      return;
    }
    if (!tete[chemin]) await _loadHead(chemin);
    appliquerScm(chemin);
  }
  function appliquerScm(chemin: string): void {
    const m = models[chemin];
    const monaco = window.monaco;
    if (!m || m.isDisposed() || !monaco) return;
    const head = tete[chemin]?.text ?? null;
    const decos: M.editor.IModelDeltaDecoration[] = [];
    if (typeof head === "string") {
      const n = m.getLineCount();
      for (const h of hunks(lines(head), m.getLinesContent())) {
        const classe =
          h.type === "add"
            ? "elpis-scm-added"
            : h.type === "mod"
              ? "elpis-scm-modified"
              : "elpis-scm-deleted";
        const debut = Math.min(h.start, n);
        const fin = h.type === "del" ? debut : Math.min(h.end, n);
        decos.push({
          range: new monaco.Range(debut, 1, fin, 1),
          options: {
            isWholeLine: true,
            linesDecorationsClassName: classe,
            overviewRuler: {
              color: h.type === "add" ? "#3fb95088" : h.type === "mod" ? "#1f6feb88" : "#f8514988",
              position: 1,
            },
          },
        });
      }
    }
    try {
      decorations[chemin] = m.deltaDecorations(decorations[chemin] || [], decos);
    } catch {
      /* modèle libéré */
    }
  }
  function _clearScm(chemin: string): void {
    const m = models[chemin];
    const ids = decorations[chemin];
    if (m && !m.isDisposed() && ids) {
      try {
        m.deltaDecorations(ids, []);
      } catch {
        /* modèle libéré */
      }
    }
    delete decorations[chemin];
    delete tete[chemin];
  }

  // Statut Git : pastilles de l'arbre ; tout changement invalide HEAD et redessine la marge de l'onglet actif.
  watch(
    () => [git.gitStatus.value, git.gitCurrentRepo.value],
    () => {
      arbre().setGit(pastillesGit(git.gitStatus.value, git.gitCurrentRepo.value));
      for (const k of Object.keys(tete)) delete tete[k];
      if (activeTabPath.value) _scheduleScmRefresh(activeTabPath.value);
    },
  );

  const prefixeDepot = (): string => {
    const d = git.gitCurrentRepo.value;
    return d && d !== "." ? d + "/" : "";
  };
  const statusBranch = computed(() => {
    const st = git.gitStatus.value;
    const p = activeTabPath.value;
    if (!st || !st.is_repo || !p) return "";
    const pre = prefixeDepot();
    if (pre && !p.startsWith(pre)) return "";
    return st.branch || "";
  });
  /** Clic sur un fichier de la vue Git : son diff par rapport à HEAD. */
  async function gitOpenChange(relatif: string, genre: string): Promise<void> {
    const chemin = prefixeDepot() + relatif;
    if (genre === "D") {
      showToast("Fichier supprimé — son contenu reste dans le dernier commit", "info");
      return;
    }
    if (genre === "U" || vis.officeIsViewerPath(chemin)) {
      await l.openFile(chemin, false);
      return;
    }
    await l.openFile(chemin, false);
    const head = await _loadHead(chemin, true);
    if (typeof head !== "string" || activeTabPath.value !== chemin) return;
    diffBase.value = "head";
    isDiffView.value = true;
    void nextTick(() => {
      updateDiffView();
      l.robustLayout();
    });
  }
  const activeInRepo = computed(() => {
    const p = activeTabPath.value;
    return !!(p && (git.gitRepos.value || []).length && depotDe(p));
  });

  return {
    updateDiffView,
    toggleDiffMode,
    showToolDiff,
    showDiffForMessage,
    aiProposal,
    proposeAiEdit,
    acceptAiProposal,
    rejectAiProposal,
    _loadHead,
    texteTete: (chemin: string): string | null => tete[chemin]?.text ?? null,
    _scheduleScmRefresh,
    _clearScm,
    statusBranch,
    gitOpenChange,
    activeInRepo,
    libererDiff(): void {
      clearTimeout(minuterieScm);
    },
  };
}
