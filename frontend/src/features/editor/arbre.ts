// SPDX-License-Identifier: MIT
/** frontend/src/features/editor/arbre.ts — état partagé de l'arbre de fichiers (dossiers dépliés mémorisés par compte, sélection multiple, fichier actif, pastilles Git, « Localiser »), navigation clavier et chemins d'un glisser-déposer interne (porté de `utils.js`). */
import { reactive } from "vue";

import { marquerDepotTraite } from "../../utils/depot";
import { importeur } from "./importeur";

export interface EtatArbre {
  open: Set<string>;
  selected: Set<string>;
  anchor: string;
  active: string;
  git: Record<string, string>;
  gitDirs: Set<string>;
  revealPath: string;
  revealSeq: number;
}

export type ModeSelection = "single" | "toggle" | "range";

export interface ElementNavigable {
  path: string;
  type: string;
}

export interface ArbrePartage {
  readonly state: EtatArbre;
  setUser(id: string | number | null): void;
  isOpen(p: string): boolean;
  setOpen(p: string, v: boolean): void;
  collapseAll(): void;
  openAncestors(path: string, includeSelf?: boolean): void;
  reveal(path: string, opts?: { folder?: boolean }): void;
  setActive(p: string | null): void;
  select(path: string, mode: ModeSelection | string, order?: string[]): void;
  clearSelection(): void;
  targetsFor(path: string): string[];
  setGit(map: Record<string, string> | null | undefined): void;
  navKey(e: KeyboardEvent, rowEl: HTMLElement | null, item: ElementNavigable): boolean;
  parentOf(p: string): string;
}

/** Type MIME propre au glisser-déposer interne : un dépôt de fichiers depuis l'OS ne le porte jamais. */
export const MIME_GLISSER = "application/x-elpis-paths";

export function parentDe(p: string): string {
  const s = String(p || "");
  const i = s.lastIndexOf("/");
  return i > 0 ? s.slice(0, i) : "";
}

export function ancetres(p: string): string[] {
  const out: string[] = [];
  let cur = parentDe(p);
  while (cur) {
    out.unshift(cur);
    cur = parentDe(cur);
  }
  return out;
}

/** Arbre partagé ; `stockage` remplaçable (tests). L'état réactif est créé à la première lecture. */
export function creerArbre(
  stockage: () => Storage | null = () => globalThis.localStorage ?? null,
): ArbrePartage {
  let st: EtatArbre | null = null;
  let uid: string | number | null = null;
  let minuterie: ReturnType<typeof setTimeout> | undefined;
  const S = (): EtatArbre =>
    (st ??= reactive({
      open: new Set<string>(),
      selected: new Set<string>(),
      anchor: "",
      active: "",
      git: {},
      gitDirs: new Set<string>(),
      revealPath: "",
      revealSeq: 0,
    }) as EtatArbre);
  const cle = (): string => "elpis.tree.open." + String(uid || "anon");
  function persister(): void {
    clearTimeout(minuterie);
    minuterie = setTimeout(() => {
      try {
        stockage()?.setItem(cle(), JSON.stringify(Array.from(S().open).slice(0, 5000)));
      } catch {
        /* stockage plein ou interdit */
      }
    }, 250);
  }
  function setUser(id: string | number | null): void {
    if (id === uid) return;
    uid = id;
    let arr: unknown;
    try {
      arr = JSON.parse(stockage()?.getItem(cle()) || "[]");
    } catch {
      arr = [];
    }
    S().open = new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : []);
    S().selected = new Set();
    S().anchor = "";
  }
  const isOpen = (p: string): boolean => S().open.has(p);
  function setOpen(p: string, v: boolean): void {
    const o = S().open;
    if (!!v === o.has(p)) return;
    if (v) o.add(p);
    else o.delete(p);
    persister();
  }
  function collapseAll(): void {
    if (!S().open.size) return;
    S().open.clear();
    persister();
  }
  /** Déplie les ancêtres de `path` (et `path` lui-même si `includeSelf`). */
  function openAncestors(path: string, includeSelf?: boolean): void {
    const o = S().open;
    let change = false;
    const liste = ancetres(path);
    if (includeSelf && path) liste.push(path);
    for (const a of liste) {
      if (!o.has(a)) {
        o.add(a);
        change = true;
      }
    }
    if (change) persister();
  }
  function reveal(path: string, opts?: { folder?: boolean }): void {
    if (!path) return;
    openAncestors(path, !!opts?.folder);
    S().revealPath = path;
    S().revealSeq++;
  }
  function setActive(p: string | null): void {
    S().active = p || "";
  }
  /** Sélection : 'single', 'toggle' ou 'range' (`order` = chemins visibles dans l'ordre d'affichage). */
  function select(path: string, mode: ModeSelection | string, order?: string[]): void {
    const s = S();
    if (mode === "toggle") {
      const n = new Set(s.selected);
      if (n.has(path)) n.delete(path);
      else n.add(path);
      s.selected = n;
      s.anchor = path;
      return;
    }
    if (mode === "range" && s.anchor && Array.isArray(order)) {
      const a = order.indexOf(s.anchor);
      const b = order.indexOf(path);
      if (a >= 0 && b >= 0) {
        s.selected = new Set(order.slice(Math.min(a, b), Math.max(a, b) + 1));
        return;
      }
    }
    s.selected = new Set([path]);
    s.anchor = path;
  }
  function clearSelection(): void {
    S().selected = new Set();
    S().anchor = "";
  }
  /** Cibles d'une action lancée depuis `path` : la sélection s'il en fait partie, descendants d'un dossier sélectionné retirés. */
  function targetsFor(path: string): string[] {
    const sel = S().selected;
    if (!path || sel.size < 2 || !sel.has(path)) return path ? [path] : [];
    const tous = Array.from(sel);
    return tous.filter((p) => !tous.some((q) => q !== p && p.indexOf(q + "/") === 0));
  }
  function setGit(map: Record<string, string> | null | undefined): void {
    const m = map || {};
    const dossiers = new Set<string>();
    for (const p of Object.keys(m)) for (const a of ancetres(p)) dossiers.add(a);
    S().git = m;
    S().gitDirs = dossiers;
  }
  /** Navigation clavier (motif APG « tree ») sur les lignes rendues, dont l'ordre du DOM est l'ordre visible. */
  function navKey(e: KeyboardEvent, rowEl: HTMLElement | null, item: ElementNavigable): boolean {
    const tree = rowEl?.closest('[role="tree"]');
    if (!rowEl || !tree) return false;
    const rows = Array.from(tree.querySelectorAll<HTMLElement>('[role="treeitem"]'));
    const i = rows.indexOf(rowEl);
    const dossier = item.type === "folder";
    const focusAt = (j: number): boolean => {
      const r = rows[j];
      if (!r) return false;
      r.focus();
      return true;
    };
    switch (e.key) {
      case "ArrowDown":
        return focusAt(i + 1);
      case "ArrowUp":
        return focusAt(i - 1);
      case "Home":
        return focusAt(0);
      case "End":
        return focusAt(rows.length - 1);
      case "ArrowRight":
        if (!dossier) return false;
        if (!isOpen(item.path)) {
          setOpen(item.path, true);
          return true;
        }
        if ((rows[i + 1]?.dataset["path"] || "").indexOf(item.path + "/") === 0) return focusAt(i + 1);
        return true;
      case "ArrowLeft": {
        if (dossier && isOpen(item.path)) {
          setOpen(item.path, false);
          return true;
        }
        const par = parentDe(item.path);
        if (!par) return true;
        rows.find((r) => r.dataset["path"] === par)?.focus();
        return true;
      }
    }
    return false;
  }
  return {
    get state() {
      return S();
    },
    setUser,
    isOpen,
    setOpen,
    collapseAll,
    openAncestors,
    reveal,
    setActive,
    select,
    clearSelection,
    targetsFor,
    setGit,
    navKey,
    parentOf: parentDe,
  };
}

/** Chemins d'un glisser-déposer interne (plusieurs si la sélection l'est), à défaut le texte brut. */
export function cheminsGlisses(dt: DataTransfer | null | undefined): string[] {
  try {
    const brut = dt?.getData(MIME_GLISSER);
    if (brut) {
      const liste: unknown = JSON.parse(brut);
      if (Array.isArray(liste) && liste.length)
        return liste.filter((p): p is string => typeof p === "string" && !!p);
    }
  } catch {
    /* charge illisible */
  }
  const un = dt?.getData("text/plain");
  return un ? [un] : [];
}

/** Dépôt sur un dossier : import si l'OS a déposé des dossiers ou fichiers, sinon chemins internes à déplacer (dossier cible, ses ancêtres et son contenu direct écartés). */
export function depotSurDossier(
  dt: DataTransfer,
  dossier: string,
  parentOf: (p: string) => string,
): { importe: boolean; sources: string[] } {
  const entrees: FileSystemEntry[] = [];
  if (dt.items?.length && typeof DataTransferItem !== "undefined") {
    for (const it of dt.items) {
      if (it.kind !== "file") continue;
      const entree = it.webkitGetAsEntry?.();
      if (entree) entrees.push(entree);
    }
  }
  const imp = importeur();
  if (entrees.length && imp) {
    marquerDepotTraite();
    void imp.entrees(entrees, dossier);
    return { importe: true, sources: [] };
  }
  if (dt.files?.length) {
    marquerDepotTraite();
    if (imp) void imp.fichiers(dt.files, dossier);
    return { importe: true, sources: [] };
  }
  const sources = cheminsGlisses(dt).filter(
    (src) => src && src !== dossier && dossier.indexOf(src + "/") !== 0 && parentOf(src) !== dossier,
  );
  if (sources.length) marquerDepotTraite();
  return { importe: false, sources };
}

let partage: ArbrePartage | null = null;

/** L'arbre de la page (singleton). */
export function arbre(): ArbrePartage {
  return (partage ??= creerArbre());
}
