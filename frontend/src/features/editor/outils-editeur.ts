// SPDX-License-Identifier: MIT
/** frontend/src/features/editor/outils-editeur.ts — menu contextuel du code (édition, IA, chat), ponts éditeur ↔ chat (sélection, pièces jointes, liens de chemins), exécution dans le terminal et liens cliquables de sa sortie, « Localiser » dans l'arbre. */
import { computed, nextTick, watch } from "vue";
import type { Ref } from "vue";
import type { ILink, Terminal } from "@xterm/xterm";

import { parsePath } from "../../utils/utils-purs";
import { arbre } from "./arbre";
import type { CtxEditeur, EtatEditeur, Utilisateur } from "./etat";
import type { ReglagesEditeur } from "./instances";
import { langageDe } from "./langages";
import type { LiensEditeur, ServicesEditeur } from "./liens";
import type { NoeudArbre } from "./schemas-bac";

/** Commande d'exécution par extension. */
export const EXECUTANTS: Readonly<Record<string, string>> = {
  py: "python3",
  js: "node",
  mjs: "node",
  cjs: "node",
  sh: "bash",
  bash: "bash",
  rb: "ruby",
  pl: "perl",
  php: "php",
  lua: "lua",
  r: "Rscript",
  go: "go run",
};

/** Argument shell entre apostrophes. */
export function citerShell(s: string): string {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

/** Chemin cité → fichier de l'arbre : exact, sinon suffixe unique (un suffixe ambigu ne devine rien). */
export function resoudreChemin(chemin: string, index: ReadonlyMap<string, string>): string | null {
  if (!chemin) return null;
  if (index.get(chemin) === "file") return chemin;
  let trouve: string | null = null;
  for (const [k, t] of index) {
    if (t === "file" && k.endsWith("/" + chemin)) {
      if (trouve) return null;
      trouve = k;
    }
  }
  return trouve;
}

const MOTIF_CHEMIN = /(?:\.{0,2}\/)?(?:[\w@.-]+\/)*[\w@-][\w@.-]*\.[A-Za-z0-9]{1,10}(?::\d+(?::\d+)?)?/g;

export function setupEditorTools(
  e: EtatEditeur,
  s: ServicesEditeur,
  l: LiensEditeur,
  ctx: CtxEditeur,
  settings: Ref<ReglagesEditeur>,
  user: Ref<Utilisateur | null>,
) {
  const { monacoRef, editorCtxMenu, activeTabPath, showExplorer, sandboxFiles } = e;
  const { showToast } = ctx;

  // Menu contextuel du code (remplace celui de Monaco, borné à la fenêtre).
  function _openEditorCtxMenu(ev: MouseEvent): void {
    const ed = monacoRef.instance;
    if (!ed) return;
    const sel = ed.getSelection();
    const avecSelection = !!sel && !sel.isEmpty();
    let texte = "";
    let lignes = 0;
    if (sel && avecSelection) {
      texte = ed.getModel()?.getValueInRange(sel) ?? "";
      lignes = sel.endLineNumber - sel.startLineNumber + 1;
    }
    editorCtxMenu.value = {
      show: true,
      x: Math.min(ev.clientX, window.innerWidth - 272),
      y: Math.max(8, Math.min(ev.clientY, window.innerHeight - 540)),
      hasSelection: avecSelection,
      selectionText: texte,
      lineCount: lignes,
    };
  }
  function closeEditorCtxMenu(): void {
    editorCtxMenu.value = { ...editorCtxMenu.value, show: false };
    monacoRef.instance?.focus();
  }
  function action(id: string): void {
    closeEditorCtxMenu();
    const ed = monacoRef.instance;
    if (!ed) return;
    ed.focus();
    ed.trigger("keyboard", id, null);
  }
  const editorCtxToggleComment = (): void => action("editor.action.commentLine");
  const editorCtxFormatDoc = (): void => action("editor.action.formatDocument");
  const editorCtxGoToDef = (): void => action("editor.action.revealDefinition");
  const editorCtxFindRefs = (): void => action("editor.action.goToReferences");
  const editorCtxRename = (): void => action("editor.action.rename");
  function editorCtxCopy(): void {
    const code = editorCtxMenu.value.selectionText;
    closeEditorCtxMenu();
    if (code)
      navigator.clipboard
        .writeText(code)
        .then(() => showToast("Copié !"))
        .catch(() => undefined);
  }

  /** Sélection insérée dans le chat, avec chemin, lignes et langage. */
  function askChatAboutSelection(): void {
    const ed = monacoRef.instance;
    const code = editorCtxMenu.value.selectionText;
    const sel = ed?.getSelection();
    closeEditorCtxMenu();
    const p = activeTabPath.value;
    if (!code || !sel || !p || !ctx.insertIntoChat) return;
    const lang = langageDe(p);
    const cloture = code.includes("```") ? "````" : "```";
    const lignes =
      sel.startLineNumber === sel.endLineNumber
        ? "ligne " + sel.startLineNumber
        : "lignes " + sel.startLineNumber + "-" + sel.endLineNumber;
    ctx.insertIntoChat(
      "`" +
        p +
        "` (" +
        lignes +
        ") :\n" +
        cloture +
        (lang && lang !== "plaintext" ? lang : "") +
        "\n" +
        code.replace(/\s+$/, "") +
        "\n" +
        cloture +
        "\n",
    );
  }

  // Arbre : index chemin → type, fichier actif, « Localiser ».
  const indexArbre = computed(() => {
    const m = new Map<string, string>();
    const parcourir = (noeuds: readonly NoeudArbre[] | undefined): void => {
      for (const n of noeuds || []) {
        m.set(n.path, n.type);
        if (n.children) parcourir(n.children);
      }
    };
    parcourir(sandboxFiles.value);
    return m;
  });
  const _resolveSandboxPath = (p: string): string | null => resoudreChemin(l.canon(p), indexArbre.value);

  watch(
    () => user.value?.id,
    (id) => arbre().setUser(id ?? null),
    { immediate: true },
  );
  watch(activeTabPath, (p) => {
    arbre().setActive(p || "");
    if (
      p &&
      settings.value?.editor_follow_active &&
      showExplorer.value &&
      s.git.explorerTab.value === "files" &&
      !e.sandboxSearch.value
    )
      arbre().reveal(p);
  });
  function revealActiveInTree(chemin?: string): void {
    const p = (typeof chemin === "string" && chemin) || activeTabPath.value;
    l.closeTabCtxMenu();
    if (!p) return;
    showExplorer.value = true;
    s.git.explorerTab.value = "files";
    if (e.sandboxSearch.value) e.sandboxSearch.value = "";
    void nextTick(() => arbre().reveal(p));
  }
  /** Fil d'Ariane : déplie le dossier (et l'explorateur s'il est masqué). */
  function revealFolderInTree(prefixe: string): void {
    if (!prefixe) return;
    if (!showExplorer.value) showExplorer.value = true;
    arbre().reveal(prefixe, { folder: true });
  }
  function collapseAllFolders(): void {
    arbre().collapseAll();
  }
  function explorerMultiCount(item: { path?: string } | null | undefined): number {
    return item?.path ? arbre().targetsFor(item.path).length : 0;
  }

  async function attachToChat(chemin: string): Promise<void> {
    l.closeTabCtxMenu();
    if (!ctx.attachFileToChat || !chemin) return;
    const cibles = arbre().targetsFor(chemin);
    const fichiers = cibles.filter((p) => indexArbre.value.get(p) !== "folder");
    if (!fichiers.length) {
      showToast("Seuls des fichiers peuvent être joints", "info");
      return;
    }
    for (const p of fichiers) {
      try {
        await ctx.attachFileToChat(p);
      } catch {
        /* pièce jointe refusée */
      }
    }
    if (fichiers.length < cibles.length)
      showToast("Dossiers ignorés : seuls les fichiers sont joints", "info");
  }

  /** Lien de chemin du chat (`src/a.py:12`) ouvert à la ligne ; un chemin absent de l'arbre tronqué est tenté tel quel. */
  async function openPathFromChat(chemin: string, ligne?: number, col?: number): Promise<void> {
    if (!settings.value?.enable_editor) {
      showToast("L'éditeur est désactivé dans les réglages", "info");
      return;
    }
    if (!sandboxFiles.value.length) {
      try {
        await s.fs.loadSandboxFiles();
      } catch {
        /* arbre indisponible */
      }
    }
    const cible = _resolveSandboxPath(chemin);
    if (!cible && !s.fs.treeTruncated.value) {
      showToast("Fichier introuvable dans la sandbox : " + l.canon(chemin), "error");
      return;
    }
    l.pushNav();
    await s.fs.openFileAtLine(cible || l.canon(chemin), ligne || 0, col || 0);
  }

  // Terminal : commande envoyée au shell actif (ouvert au besoin, 12 s au plus pour être prêt).
  async function envoyerAuTerminal(cmd: string): Promise<boolean> {
    const t = s.terminal;
    if (!t.showTerminal.value) await t.toggleTerminal();
    if (!t.showTerminal.value) return false;
    const limite = Date.now() + 12000;
    while (Date.now() < limite) {
      const st = t._activeTermState();
      if (st && (st.transport === "sse" || (st.transport === "ws" && st.conn?.ouvert))) {
        t._sendInputFor(st, cmd + "\r");
        _scheduleTreeRefreshAfterCommand();
        try {
          st.term.focus();
        } catch {
          /* terminal démonté */
        }
        return true;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    showToast("Terminal indisponible", "error");
    return false;
  }
  function canRunActive(): boolean {
    const ext = (activeTabPath.value || "").split(".").pop()?.toLowerCase() ?? "";
    return !!EXECUTANTS[ext] || ((ext === "html" || ext === "htm") && !!settings.value.enable_preview);
  }
  /** Exécute le fichier actif (enregistré d'abord) ; une page HTML s'ouvre dans l'aperçu à côté. */
  async function runActiveFile(): Promise<void> {
    e.showEditorMore.value = false;
    closeEditorCtxMenu();
    const p = activeTabPath.value;
    if (!p) return;
    const ext = p.split(".").pop()?.toLowerCase() ?? "";
    if (ext === "html" || ext === "htm") {
      if (!settings.value.enable_preview) {
        showToast("Activez l'aperçu Web dans les réglages", "info");
        return;
      }
      if (l.tabIsDirty(p)) await l.saveEditorContent({ path: p });
      s.apercu.previewPath.value = p;
      if (!(e.splitView.value && e.splitMode.value === "preview")) l.enterSplitPreview();
      else s.apercu.refreshPreview();
      return;
    }
    const executant = EXECUTANTS[ext];
    if (!executant) {
      showToast("Aucune commande d'exécution pour ." + ext, "info");
      return;
    }
    if (l.tabIsDirty(p)) {
      await l.saveEditorContent({ path: p });
      if (l.tabIsDirty(p)) return;
    }
    const dossier = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
    await envoyerAuTerminal(
      "cd " +
        citerShell("/work" + (dossier ? "/" + dossier : "")) +
        " && " +
        executant +
        " " +
        citerShell(p.split("/").pop() ?? p),
    );
  }
  async function openTerminalHere(dossier: string): Promise<void> {
    l.closeTabCtxMenu();
    await envoyerAuTerminal("cd " + citerShell("/work" + (dossier ? "/" + dossier : "")));
  }

  // Après une commande : arbre, onglets modifiés sur disque et Git à jour (1,5 s puis 6 s).
  let minuteriesCommande: Array<ReturnType<typeof setTimeout>> = [];
  function _scheduleTreeRefreshAfterCommand(): void {
    for (const id of minuteriesCommande) clearTimeout(id);
    minuteriesCommande = [1500, 6000].map((ms) =>
      setTimeout(() => {
        if (!e.showEditor.value || !user.value) return;
        void s.fs.loadSandboxFiles();
        void s.disque._checkExternalMods();
        s.git._gitAutoRefresh();
      }, ms),
    );
  }

  /** Liens cliquables de la sortie du terminal (`src/a.py:12`, traces Python) vers les fichiers de l'arbre. */
  function _registerTermLinks(t: Terminal): void {
    if (typeof t.registerLinkProvider !== "function") return;
    try {
      t.registerLinkProvider({
        provideLinks(y, rendre) {
          let texte: string;
          try {
            texte = t.buffer.active.getLine(y - 1)?.translateToString(true) ?? "";
          } catch {
            texte = "";
          }
          const liens: ILink[] = [];
          MOTIF_CHEMIN.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = MOTIF_CHEMIN.exec(texte))) {
            const trouve = m[0];
            const analyse = parsePath(trouve);
            if (!analyse) continue;
            const cible = _resolveSandboxPath(analyse.path);
            if (!cible) continue;
            let ligne: number = analyse.line;
            if (!ligne) {
              const suite = texte.slice(m.index + trouve.length, m.index + trouve.length + 20);
              const tb = /^"?,\s*line\s+(\d+)/.exec(suite);
              if (tb) ligne = Number(tb[1]);
            }
            const col = analyse.col;
            liens.push({
              range: { start: { x: m.index + 1, y }, end: { x: m.index + trouve.length, y } },
              text: trouve,
              decorations: { underline: true, pointerCursor: true },
              activate() {
                l.pushNav();
                void s.fs.openFileAtLine(cible, ligne, col);
              },
            });
          }
          rendre(liens.length ? liens : undefined);
        },
      });
    } catch {
      /* terminal sans liens */
    }
  }

  return {
    _openEditorCtxMenu,
    closeEditorCtxMenu,
    editorCtxToggleComment,
    editorCtxFormatDoc,
    editorCtxCopy,
    editorCtxGoToDef,
    editorCtxFindRefs,
    editorCtxRename,
    askChatAboutSelection,
    _resolveSandboxPath,
    revealActiveInTree,
    revealFolderInTree,
    collapseAllFolders,
    explorerMultiCount,
    attachToChat,
    openPathFromChat,
    canRunActive,
    runActiveFile,
    openTerminalHere,
    _scheduleTreeRefreshAfterCommand,
    _registerTermLinks,
    libererOutils(): void {
      for (const id of minuteriesCommande) clearTimeout(id);
      minuteriesCommande = [];
    },
  };
}
