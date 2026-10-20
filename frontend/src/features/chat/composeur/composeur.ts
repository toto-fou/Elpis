// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/composeur/composeur.ts — composeur du chat : @mention de fichiers de la sandbox (cache, récents, pages), cascade clavier, menus « / » et templates (slash.ts, templates.ts). */
import type { Ref } from "vue";

import { creerMenuSlash } from "./slash.ts";
import type { CtxSlash, VueSlash } from "./slash.ts";
import { creerTemplates } from "./templates.ts";
import type { VueTemplates } from "./templates.ts";

export interface PieceJointe {
  name: string;
  content?: string;
  isMention?: boolean;
  isImage?: boolean;
  /** Fichier d'origine d'un dépôt ou d'un sélecteur : `/rag add` le dépose tel quel dans une collection. */
  fichier?: File;
  _uid?: string | number;
}

export interface FichierMention {
  path: string;
  name: string;
}

interface NoeudArbre {
  type?: string;
  path?: string;
  name?: string;
  children?: readonly NoeudArbre[];
  items?: readonly NoeudArbre[];
  files?: readonly NoeudArbre[];
}

export interface RefsComposeur {
  inputRef: Ref<HTMLTextAreaElement | null>;
  inputMessage: Ref<string>;
  attachedFiles: Ref<PieceJointe[]>;
  isStreaming?: Ref<boolean>;
}

export interface ContexteComposeur {
  fetchAuth(url: string, options?: Record<string, unknown>, soft?: boolean): Promise<Response | null>;
  showToast(message: string, type?: string): void;
  sendMessage(): unknown;
  readonly autoResize?: (() => void) | undefined;
  [cle: string]: unknown;
}

const CLE_RECENTS = "elpis.mention.recents.v1";
const RECENTS_MAX = 5;
const TAILLE_PAGE = 50;
const MAX_FICHIERS = 10;

function aplatir(items: readonly NoeudArbre[] | undefined, acc: FichierMention[] = []): FichierMention[] {
  for (const item of items || []) {
    if (!item) continue;
    if (item.type === "file")
      acc.push({ path: item.path ?? "", name: item.name || (item.path || "").split("/").pop() || "" });
    const enfants = item.children || item.items || item.files;
    if (Array.isArray(enfants) && enfants.length) aplatir(enfants, acc);
  }
  return acc;
}

function lireRecents(): string[] {
  try {
    const raw = localStorage.getItem(CLE_RECENTS);
    if (!raw) return [];
    const arr: unknown = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

function ajouterRecent(path: string): void {
  try {
    const cur = lireRecents().filter((p) => p !== path);
    cur.unshift(path);
    localStorage.setItem(CLE_RECENTS, JSON.stringify(cur.slice(0, RECENTS_MAX)));
  } catch {
    /* stockage désactivé ou plein : sans conséquence */
  }
}

/** Icône Phosphor et teinte selon l'extension (mêmes classes que les puces jointes). */
export function mentionIconClass(chemin: string | null | undefined): { icon: string; color: string } {
  const n = (chemin || "").toLowerCase();
  if (n.endsWith(".js") || n.endsWith(".mjs")) return { icon: "ph-file-js", color: "text-yellow-400" };
  if (n.endsWith(".ts") || n.endsWith(".tsx")) return { icon: "ph-file-ts", color: "text-blue-400" };
  if (n.endsWith(".html")) return { icon: "ph-browsers", color: "text-orange-500" };
  if (n.endsWith(".css")) return { icon: "ph-paint-brush", color: "text-sky-400" };
  if (n.endsWith(".json")) return { icon: "ph-brackets-curly", color: "text-lime-500" };
  if (n.endsWith(".py")) return { icon: "ph-file-py", color: "text-blue-500" };
  if (n.endsWith(".sh")) return { icon: "ph-terminal-window", color: "text-green-500" };
  if (n.endsWith(".md")) return { icon: "ph-info", color: "text-slate-400" };
  if (n.endsWith(".txt")) return { icon: "ph-file-text", color: "text-gray-500" };
  return { icon: "ph-file", color: "text-blue-400" };
}

export function mentionFilenameOf(chemin: string | null | undefined): string {
  if (!chemin) return "";
  const i = chemin.lastIndexOf("/");
  return i >= 0 ? chemin.substring(i + 1) : chemin;
}

export function mentionDirOf(chemin: string | null | undefined): string {
  if (!chemin) return "";
  const i = chemin.lastIndexOf("/");
  return i >= 0 ? chemin.substring(0, i + 1) : "/";
}

/** Même contrat que l'ancien `setupChatCompose` : refs et actions lues par le cœur du chat et les composants du composeur. */
export type VueComposeur = VueSlash & VueTemplates;

export function creerComposeur(vue: VueComposeur, refs: RefsComposeur, ctx: ContexteComposeur) {
  const { inputRef, inputMessage, attachedFiles, isStreaming } = refs;
  const { fetchAuth, showToast, sendMessage } = ctx;
  const { ref, nextTick } = vue;

  const showMentionDropdown = ref(false);
  const mentionQuery = ref("");
  const mentionFiles = ref<FichierMention[]>([]);
  const mentionIndex = ref(0);
  const isMentionLoading = ref(false);
  const mentionHasMore = ref(false);
  const mentionRecentCount = ref(0);
  let tous: FichierMention[] = [];
  let dateCache = 0;
  let tries: FichierMention[] | null = null;
  let enVol: Promise<void> | null = null;

  function redimensionner(): void {
    if (ctx.autoResize) ctx.autoResize();
  }

  async function chargerFichiers(): Promise<void> {
    if (tous.length > 0 && Date.now() - dateCache < 30000) return;
    if (enVol) return enVol;
    isMentionLoading.value = true;
    enVol = (async () => {
      try {
        const res = await fetchAuth("/api/sandbox/tree", {}, true);
        if (res && res.ok) {
          const data = (await res.json()) as { items?: NoeudArbre[] } | null;
          tous = aplatir((data && data.items) || []);
          tries = null;
          dateCache = Date.now();
        }
      } catch {
        /* arbre indisponible : liste vide */
      } finally {
        isMentionLoading.value = false;
        enVol = null;
      }
    })();
    return enVol;
  }

  function triesTous(): FichierMention[] {
    tries ??= tous.slice().sort((a, b) => {
      const da = (a.path.match(/\//g) || []).length;
      const db = (b.path.match(/\//g) || []).length;
      return da !== db ? da - db : a.path.localeCompare(b.path);
    });
    return tries;
  }

  function filtrer(query: string): FichierMention[] {
    const q = (query || "").toLowerCase();
    let filtres: FichierMention[];
    if (!q) {
      const all = triesTous();
      mentionHasMore.value = all.length > TAILLE_PAGE;
      filtres = all.slice(0, TAILLE_PAGE);
    } else {
      filtres = tous
        .filter((f) => f.path.toLowerCase().includes(q) || f.name.toLowerCase().includes(q))
        .slice(0, 200);
      mentionHasMore.value = false;
    }
    const parChemin = new Map(filtres.map((f) => [f.path, f]));
    const recents: FichierMention[] = [];
    const vus = new Set<string>();
    for (const p of lireRecents()) {
      const f = parChemin.get(p);
      if (f) {
        recents.push(f);
        vus.add(p);
      }
    }
    mentionRecentCount.value = recents.length;
    return [...recents, ...filtres.filter((f) => !vus.has(f.path))];
  }

  function loadMoreMentionFiles(): void {
    if (!mentionHasMore.value || mentionQuery.value) return;
    const all = triesTous();
    const n = mentionFiles.value.length;
    const suivant = Math.min(n + TAILLE_PAGE, all.length);
    if (suivant <= n) {
      mentionHasMore.value = false;
      return;
    }
    const recents = mentionFiles.value.slice(0, mentionRecentCount.value);
    const vus = new Set(recents.map((f) => f.path));
    const reste = all.filter((f) => !vus.has(f.path));
    mentionFiles.value = [...recents, ...reste].slice(0, suivant);
    mentionHasMore.value = suivant < recents.length + reste.length;
  }

  function onMentionScroll(event: Event): void {
    const el = event.target as HTMLElement | null;
    if (el && el.scrollTop + el.clientHeight >= el.scrollHeight - 80) loadMoreMentionFiles();
  }

  function contexteMention(): { query: string; start: number } | null {
    const el = inputRef.value;
    if (!el) return null;
    const curseur = el.selectionStart;
    const avant = (inputMessage.value || "").substring(0, curseur);
    const m = avant.match(/@([\w.\-/]*)$/);
    return m ? { query: m[1] ?? "", start: curseur - m[0].length } : null;
  }

  function ouvrir(query: string): void {
    mentionQuery.value = query;
    mentionFiles.value = filtrer(query);
    mentionIndex.value = 0;
    showMentionDropdown.value = true;
  }

  function closeMentionDropdown(): void {
    showMentionDropdown.value = false;
    mentionFiles.value = [];
    mentionQuery.value = "";
    mentionIndex.value = 0;
    mentionRecentCount.value = 0;
  }

  async function selectMention(file: FichierMention): Promise<void> {
    if (file && file.path) ajouterRecent(file.path);
    const c = contexteMention();
    const requete = mentionQuery.value;
    closeMentionDropdown();
    if (c !== null) {
      const texte = inputMessage.value || "";
      inputMessage.value = texte.substring(0, c.start) + texte.substring(c.start + 1 + requete.length);
      void nextTick(() => {
        if (inputRef.value) {
          inputRef.value.setSelectionRange(c.start, c.start);
          inputRef.value.focus();
        }
        redimensionner();
      });
    }
    if (attachedFiles.value.some((f) => f.name === file.path)) return;
    if (attachedFiles.value.length >= MAX_FICHIERS) {
      showToast("Maximum " + MAX_FICHIERS + " fichiers joints", "error");
      return;
    }
    const proprietaire = attachedFiles.value;
    try {
      const res = await fetchAuth("/api/sandbox/download?path=" + encodeURIComponent(file.path), {}, true);
      if (attachedFiles.value !== proprietaire) return;
      if (res && res.ok) {
        const content = await res.text();
        if (attachedFiles.value !== proprietaire) return;
        if (attachedFiles.value.some((f) => f.name === file.path)) return;
        if (attachedFiles.value.length >= MAX_FICHIERS) {
          showToast("Maximum " + MAX_FICHIERS + " fichiers joints", "error");
          return;
        }
        attachedFiles.value.push({ name: file.path, content, isMention: true });
      } else {
        showToast("Impossible de lire " + file.name, "error");
      }
    } catch {
      showToast("Erreur lecture fichier", "error");
    }
  }

  const templates = creerTemplates(vue, { inputRef, inputMessage }, ctx);
  const slash = creerMenuSlash(
    vue,
    { inputRef, inputMessage, showMentionDropdown, templates },
    ctx as ContexteComposeur & CtxSlash,
  );

  function handleInputKeydown(e: KeyboardEvent): void {
    if (slash.slashKeydown(e)) return;
    if (showMentionDropdown.value) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (mentionIndex.value >= mentionFiles.value.length - 1 && mentionHasMore.value)
          loadMoreMentionFiles();
        mentionIndex.value = Math.min(mentionIndex.value + 1, mentionFiles.value.length - 1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        mentionIndex.value = Math.max(mentionIndex.value - 1, 0);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const choisi = mentionFiles.value[mentionIndex.value];
        if (choisi) void selectMention(choisi);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeMentionDropdown();
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      const commande = slash.slashResolve(inputMessage.value);
      if (isStreaming && isStreaming.value && !commande) return;
      e.preventDefault();
      void sendMessage();
    }
  }

  async function handleInputInput(): Promise<void> {
    redimensionner();
    const c = contexteMention();
    if (c !== null) {
      slash.slashDismiss();
      await chargerFichiers();
      if (contexteMention() === null) return;
      ouvrir(c.query);
      return;
    }
    if (showMentionDropdown.value) closeMentionDropdown();
    slash.onInput();
  }

  return {
    showMentionDropdown,
    mentionQuery,
    mentionFiles,
    mentionIndex,
    mentionRecentCount,
    isMentionLoading,
    mentionHasMore,
    loadMoreMentionFiles,
    onMentionScroll,
    closeMentionDropdown,
    selectMention,
    handleInputKeydown,
    handleInputInput,
    mentionIconClass,
    mentionFilenameOf,
    mentionDirOf,
    ...slash,
    ...templates,
  };
}
