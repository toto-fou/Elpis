// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/message/fichiers-modifies.ts — fichiers modifiés par un tour : fusion des changements, statistiques +/− (LCS borné), diff unifié, état par message, téléchargements. */
import type * as Vue from "vue";
import type { Ref } from "vue";

import { canonPath } from "../../../utils/utils-purs.ts";
import { decoderTexte } from "../../editor/lecture.ts";
import type { FichierModifie, LigneDiff } from "./types.ts";

export const MAX_DIFF_LINES = 2000;
const MAX_CELLULES = 4000000;
const MAX_LIGNES_SORTIE = 3000;
const SHA = /^[0-9a-f]{64}$/;
const CHANGEMENTS = ["created", "modified", "deleted", "moved"];

export interface Changement {
  path: string;
  change: string;
  before: string | null;
  after: string | null;
  added?: number;
  removed?: number;
  from?: string;
}

export function splitLines(s: unknown): string[] {
  if (s == null) return [];
  const t = String(s).replace(/\r\n?/g, "\n");
  if (t === "") return [];
  const out = t.split("\n");
  // Le saut final termine la dernière ligne, il n'en ouvre pas une nouvelle.
  if (out.length > 1 && out[out.length - 1] === "") out.pop();
  return out;
}

function nettoyer(e: unknown): Changement | null {
  if (!e || typeof e !== "object") return null;
  const r = e as Record<string, unknown>;
  const path = canonPath(r.path as string);
  if (!path || path.length > 1024) return null;
  const o: Changement = {
    path,
    change: CHANGEMENTS.includes(r.change as string) ? (r.change as string) : "modified",
    before: SHA.test((r.before as string) || "") ? (r.before as string) : null,
    after: SHA.test((r.after as string) || "") ? (r.after as string) : null,
  };
  if (Number.isInteger(r.added)) o.added = r.added as number;
  if (Number.isInteger(r.removed)) o.removed = r.removed as number;
  if (typeof r.from === "string") o.from = canonPath(r.from);
  return o;
}

/** Fusionne les changements d'un nouvel appel dans la liste du message (créé puis supprimé : disparaît). */
export function mergeFiles(list: unknown, files: unknown): Changement[] {
  const acc = new Map<string, Changement>();
  for (const e of Array.isArray(list) ? list : []) {
    const c = nettoyer(e);
    if (c) acc.set(c.path, c);
  }
  for (const brut of (Array.isArray(files) ? files : []).slice(0, 200)) {
    const e = nettoyer(brut);
    if (!e) continue;
    const prec = acc.get(e.path);
    if (!prec) {
      if (acc.size < 200) acc.set(e.path, e);
      continue;
    }
    if (prec.change === "created" && e.change === "deleted") {
      acc.delete(e.path);
      continue;
    }
    const m: Changement = { ...prec, after: e.after };
    delete m.added;
    delete m.removed;
    if (prec.change === "created") m.change = "created";
    else if (e.change === "deleted") m.change = "deleted";
    else if (prec.change === "deleted") m.change = "modified";
    acc.set(e.path, m);
  }
  return Array.from(acc.values());
}

/** Lignes ajoutées et retirées (LCS) ; au-delà de MAX_DIFF_LINES, un delta grossier. */
export function diffStats(
  avant: unknown,
  apres: unknown,
): { additions: number; deletions: number; tooLarge: boolean } {
  const A = splitLines(avant);
  const B = splitLines(apres);
  const n = A.length;
  const m = B.length;
  if (n === m && A.every((l, i) => l === B[i])) return { additions: 0, deletions: 0, tooLarge: false };
  if (n > MAX_DIFF_LINES || m > MAX_DIFF_LINES)
    return { additions: Math.max(0, m - n), deletions: Math.max(0, n - m), tooLarge: true };
  const W = m + 1;
  const dp = new Int32Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--) {
    const Ai = A[i];
    const ligne = i * W;
    const suivante = (i + 1) * W;
    for (let j = m - 1; j >= 0; j--) {
      if (Ai === B[j]) dp[ligne + j] = (dp[suivante + j + 1] ?? 0) + 1;
      else {
        const d = dp[suivante + j] ?? 0;
        const r = dp[ligne + j + 1] ?? 0;
        dp[ligne + j] = d > r ? d : r;
      }
    }
  }
  let i = 0;
  let j = 0;
  let additions = 0;
  let deletions = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      i++;
      j++;
    } else if ((dp[(i + 1) * W + j] ?? 0) >= (dp[i * W + j + 1] ?? 0)) {
      deletions++;
      i++;
    } else {
      additions++;
      j++;
    }
  }
  return { additions: additions + (m - j), deletions: deletions + (n - i), tooLarge: false };
}

type Op = [type: " " | "-" | "+", ia: number, ib: number];

/** Diff unifié à `context` lignes de contexte (hunks fusionnés), plafonné en lignes rendues. */
export function unifiedDiff(
  avant: unknown,
  apres: unknown,
  context?: number | null,
): { lines: LigneDiff[]; truncated: boolean; additions: number; deletions: number } {
  const C = context == null ? 3 : context;
  const a = splitLines(avant);
  const b = splitLines(apres);
  let top = 0;
  while (top < a.length && top < b.length && a[top] === b[top]) top++;
  let ea = a.length - 1;
  let eb = b.length - 1;
  while (ea >= top && eb >= top && a[ea] === b[eb]) {
    ea--;
    eb--;
  }
  const A = a.slice(top, ea + 1);
  const B = b.slice(top, eb + 1);
  const ops: Op[] = [];
  for (let k = 0; k < top; k++) ops.push([" ", k, k]);
  if (A.length * B.length > MAX_CELLULES) {
    A.forEach((_, k) => ops.push(["-", top + k, -1]));
    B.forEach((_, k) => ops.push(["+", -1, top + k]));
  } else {
    const N = A.length;
    const M = B.length;
    const W = M + 1;
    const dp = new Int32Array((N + 1) * W);
    const v = (k: number): number => dp[k] ?? 0;
    for (let i = N - 1; i >= 0; i--)
      for (let j = M - 1; j >= 0; j--)
        dp[i * W + j] =
          A[i] === B[j] ? v((i + 1) * W + j + 1) + 1 : Math.max(v((i + 1) * W + j), v(i * W + j + 1));
    let i = 0;
    let j = 0;
    while (i < N || j < M) {
      if (i < N && j < M && A[i] === B[j]) {
        ops.push([" ", top + i, top + j]);
        i++;
        j++;
      } else if (j >= M || (i < N && v((i + 1) * W + j) >= v(i * W + j + 1))) {
        ops.push(["-", top + i, -1]);
        i++;
      } else {
        ops.push(["+", -1, top + j]);
        j++;
      }
    }
  }
  for (let k = 1; ea + k < a.length; k++) ops.push([" ", ea + k, eb + k]);
  const out: LigneDiff[] = [];
  let truncated = false;
  let adds = 0;
  let dels = 0;
  const change = ops.map((o) => o[0] !== " ");
  let k = 0;
  while (k < ops.length) {
    if (!change[k]) {
      k++;
      continue;
    }
    const s = Math.max(0, k - C);
    let e = k;
    while (e < ops.length) {
      if (change[e]) {
        e++;
        continue;
      }
      let n = e;
      while (n < ops.length && !change[n]) n++;
      if (n < ops.length && n - e <= 2 * C) {
        e = n;
        continue;
      }
      e = Math.min(ops.length, e + C);
      break;
    }
    let la = 0;
    let lb = 0;
    let sa: number | null = null;
    let sb: number | null = null;
    for (let q = s; q < e; q++) {
      const o = ops[q] as Op;
      if (o[0] !== "+") {
        la++;
        if (sa === null) sa = o[1];
      }
      if (o[0] !== "-") {
        lb++;
        if (sb === null) sb = o[2];
      }
    }
    out.push({
      t: "@",
      text:
        "@@ -" +
        ((sa === null ? top : sa) + (la ? 1 : 0)) +
        "," +
        la +
        " +" +
        ((sb === null ? top : sb) + (lb ? 1 : 0)) +
        "," +
        lb +
        " @@",
    });
    for (let q = s; q < e; q++) {
      const o = ops[q] as Op;
      if (o[0] === "+") adds++;
      else if (o[0] === "-") dels++;
      if (out.length >= MAX_LIGNES_SORTIE) {
        truncated = true;
        continue;
      }
      out.push({ t: o[0], text: (o[0] === "+" ? b[o[2]] : a[o[1]]) ?? "" });
    }
    k = e;
  }
  return { lines: out, truncated, additions: adds, deletions: dels };
}

/** L'API pure des fichiers modifiés, regroupée (harnais vm des tests historiques). */
export const elpisFilesChanged = Object.freeze({ mergeFiles, unifiedDiff, diffStats });

interface EtatFichier {
  loading: boolean;
  error: string | null;
  computed: boolean;
  noStats: boolean;
  additions: number;
  deletions: number;
  tooLarge: boolean;
  open: boolean;
  lines: readonly LigneDiff[] | null;
  truncated: boolean;
}

const DEFAUTS: Readonly<EtatFichier> = Object.freeze({
  loading: false,
  error: null,
  computed: false,
  noStats: false,
  additions: 0,
  deletions: 0,
  tooLarge: false,
  open: false,
  lines: null,
  truncated: false,
});

interface Rangee {
  path: string;
  change: string;
  beforeSha: string | null;
  afterSha: string | null;
  added?: number | undefined;
  removed?: number | undefined;
  from: string | null;
  snapshot?: unknown;
}

export interface MessageFichiers {
  files_changed?: readonly unknown[] | null;
  _diffFiles?: Readonly<Record<string, unknown>> | null;
  _diffPath?: string | null;
  _diffBefore?: unknown;
  _diffStats?: Readonly<Record<string, { additions: number; deletions: number }>> | null;
}

interface ModeleMonaco {
  isDisposed(): boolean;
  getValue(): string;
}

export interface CtxFichiers {
  fetchAuth(url: string, options?: Record<string, unknown>, soft?: boolean): Promise<Response | null>;
  showToast?: (message: string, type?: string) => void;
  readonly models?: Readonly<Record<string, ModeleMonaco | undefined>> | null;
  showToolDiff?: (path: string, avant: string | null) => unknown;
}

export interface CarteFichiers {
  diffCardState: Record<number, { files: Record<string, EtatFichier> }>;
  resetDiffCardState(): void;
  diffCardRev: Ref<number>;
  diffFilesFor(msg: MessageFichiers | null | undefined, msgIdx: number): FichierModifie[];
  hasDiffFiles(msg: MessageFichiers | null | undefined): boolean;
  isDiffEditorEnabled(): boolean;
  onDiffRowClick(msgIdx: number, file: (FichierModifie & Partial<Rangee>) | null | undefined): Promise<void>;
  downloadOneFile(path: string): void;
  downloadAllFilesAsZip(paths: readonly string[], nom?: string): Promise<void>;
}

function decoder(octets: Uint8Array): string {
  return decoderTexte(octets).text;
}

function telechargerLien(href: string, nom: string): void {
  const a = document.createElement("a");
  a.href = href;
  a.rel = "noopener";
  a.download = nom;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

/** Même contrat que l'ancien `setupChatDiffCard(vue, refs, ctx)` de chat/_diff_card.js. */
export function creerCarteFichiers(
  vue: Pick<typeof Vue, "ref" | "reactive">,
  refs: { settings?: Ref<{ enable_editor?: boolean } | null> },
  ctx: CtxFichiers,
): CarteFichiers {
  const { reactive, ref } = vue;
  const { fetchAuth, showToast } = ctx;
  // État par message (index dans le chat, purgé au changement de chat).
  const diffCardState = reactive<Record<number, { files: Record<string, EtatFichier> }>>({});
  const diffCardRev = ref(0);
  const signaler = (): void => {
    diffCardRev.value++;
  };

  function resetDiffCardState(): void {
    for (const k of Object.keys(diffCardState)) delete diffCardState[Number(k)];
  }

  function etat(msgIdx: number, path: string): EtatFichier {
    const ms = (diffCardState[msgIdx] ??= { files: {} });
    return (ms.files[path] ??= { ...DEFAUTS });
  }

  // Versions de l'historique : immuables, donc mises en cache par empreinte.
  const blobs = new Map<string, string>();
  async function texteBlob(sha: string | null): Promise<string | null> {
    if (!sha) return null;
    const connu = blobs.get(sha);
    if (connu !== undefined) return connu;
    try {
      const res = await fetchAuth("/api/sandbox/history/blob?sha=" + encodeURIComponent(sha), {}, true);
      if (!res || !res.ok) return null;
      const texte = decoder(new Uint8Array(await res.arrayBuffer()));
      if (blobs.size > 64) blobs.clear();
      blobs.set(sha, texte);
      return texte;
    } catch {
      return null;
    }
  }

  async function texteActuel(path: string): Promise<string | null> {
    try {
      const modele = ctx.models?.[path];
      if (modele && !modele.isDisposed()) return modele.getValue();
    } catch {
      /* repli sur l'API */
    }
    try {
      const res = await fetchAuth("/api/sandbox/download?path=" + encodeURIComponent(path), {}, true);
      if (res && res.ok) return decoder(new Uint8Array(await res.arrayBuffer()));
    } catch {
      /* non fatal */
    }
    return null;
  }

  // Avant : historique, sinon instantané de l'éditeur, vide pour un créé ; après : historique, vide pour un supprimé, sinon actuel.
  async function textes(f: Rangee): Promise<{ before: string | null; after: string | null }> {
    let before: string | null = null;
    let after: string | null = null;
    if (f.change === "created") before = "";
    else if (f.beforeSha) before = await texteBlob(f.beforeSha);
    if (before === null && typeof f.snapshot === "string") before = f.snapshot;
    if (f.change === "deleted") after = "";
    else if (f.afterSha) after = await texteBlob(f.afterSha);
    if (after === null && f.change !== "deleted") after = await texteActuel(f.path);
    return { before, after };
  }

  // Statistiques calculées hors rendu (microtâche) : le gabarit ne fait que lire.
  const programmes = new Set<string>();
  function programmerStats(msgIdx: number, f: Rangee): void {
    const cle = msgIdx + "|" + f.path;
    if (programmes.has(cle)) return;
    programmes.add(cle);
    void Promise.resolve().then(async () => {
      programmes.delete(cle);
      const fs = etat(msgIdx, f.path);
      if (fs.computed || fs.loading) return;
      if (Number.isInteger(f.added)) {
        fs.additions = f.added as number;
        fs.deletions = f.removed || 0;
        fs.computed = true;
        signaler();
        return;
      }
      if (f.change === "moved") {
        fs.noStats = true;
        fs.computed = true;
        signaler();
        return;
      }
      fs.loading = true;
      try {
        const { before, after } = await textes(f);
        if (before === null || after === null || before.includes("\u0000") || after.includes("\u0000"))
          fs.noStats = true;
        else {
          const st = diffStats(before, after);
          fs.additions = st.additions;
          fs.deletions = st.deletions;
          fs.tooLarge = st.tooLarge;
        }
      } catch (e) {
        fs.error = (e instanceof Error && e.message) || "Erreur de calcul";
      } finally {
        fs.loading = false;
        fs.computed = true;
        signaler();
      }
    });
  }

  function rangees(msg: MessageFichiers): Rangee[] {
    const out: Rangee[] = [];
    const vus = new Set<string>();
    for (const e of Array.isArray(msg.files_changed) ? msg.files_changed : []) {
      const c = nettoyer(e);
      if (!c || vus.has(c.path)) continue;
      vus.add(c.path);
      out.push({
        path: c.path,
        change: c.change,
        beforeSha: c.before,
        afterSha: c.after,
        added: c.added,
        removed: c.removed,
        from: c.from || null,
        snapshot: msg._diffFiles ? msg._diffFiles[c.path] : undefined,
      });
    }
    let carte = msg._diffFiles;
    if ((!carte || !Object.keys(carte).length) && msg._diffPath) carte = { [msg._diffPath]: msg._diffBefore };
    const st = msg._diffStats || {};
    for (const p of Object.keys(carte || {})) {
      const cp = canonPath(p);
      if (!cp || vus.has(cp)) continue;
      vus.add(cp);
      const bs = st[p];
      out.push({
        path: cp,
        change: "modified",
        beforeSha: null,
        afterSha: null,
        added: bs ? bs.additions : undefined,
        removed: bs ? bs.deletions : undefined,
        from: null,
        snapshot: carte?.[p],
      });
    }
    return out;
  }

  function hasDiffFiles(msg: MessageFichiers | null | undefined): boolean {
    if (!msg) return false;
    return (
      (Array.isArray(msg.files_changed) && msg.files_changed.length > 0) ||
      !!(msg._diffFiles && Object.keys(msg._diffFiles).length) ||
      !!msg._diffPath
    );
  }

  function diffFilesFor(msg: MessageFichiers | null | undefined, msgIdx: number): FichierModifie[] {
    if (!msg) return [];
    return rangees(msg).map((r) => {
      const fs0 = diffCardState[msgIdx]?.files[r.path] ?? null;
      if (!fs0 || !(fs0.computed || fs0.loading)) programmerStats(msgIdx, r);
      const fs = fs0 || DEFAUTS;
      const slash = r.path.lastIndexOf("/");
      return {
        ...r,
        from: r.from ?? undefined,
        name: slash >= 0 ? r.path.substring(slash + 1) : r.path,
        dir: slash >= 0 ? r.path.substring(0, slash) : "",
        loading: fs.loading,
        error: fs.error,
        computed: fs.computed,
        noStats: fs.noStats,
        additions: fs.additions,
        deletions: fs.deletions,
        tooLarge: fs.tooLarge,
        open: fs.open,
        lines: fs.lines,
        truncated: fs.truncated,
      };
    });
  }

  function isDiffEditorEnabled(): boolean {
    return !!refs.settings?.value?.enable_editor;
  }

  // Diff Monaco si l'éditeur est là et le fichier existe, sinon diff unifié déplié sous la ligne.
  async function onDiffRowClick(
    msgIdx: number,
    file: (FichierModifie & Partial<Rangee>) | null | undefined,
  ): Promise<void> {
    if (!file) return;
    const fs = etat(msgIdx, file.path);
    if (fs.open) {
      fs.open = false;
      signaler();
      return;
    }
    const editeur = isDiffEditorEnabled() && typeof ctx.showToolDiff === "function";
    if (file.change === "moved") {
      if (editeur) ctx.showToolDiff?.(file.path, null);
      return;
    }
    const { before, after } = await textes({
      path: file.path,
      change: file.change || "modified",
      beforeSha: file.beforeSha ?? null,
      afterSha: file.afterSha ?? null,
      from: file.from ?? null,
      snapshot: file.snapshot,
    });
    if (before === null) {
      showToast?.("Version précédente non disponible", "info");
      if (editeur && file.change !== "deleted") ctx.showToolDiff?.(file.path, null);
      return;
    }
    if (editeur && file.change !== "deleted") {
      ctx.showToolDiff?.(file.path, before);
      return;
    }
    if (after === null) {
      showToast?.("Contenu actuel introuvable", "error");
      return;
    }
    if (before.includes("\u0000") || after.includes("\u0000")) {
      showToast?.("Fichier binaire : pas de diff texte", "info");
      return;
    }
    const d = unifiedDiff(before, after);
    fs.lines = Object.freeze(d.lines);
    fs.truncated = d.truncated;
    fs.open = true;
    signaler();
  }

  function downloadOneFile(path: string): void {
    if (!path) return;
    const url = "/api/sandbox/download?path=" + encodeURIComponent(path);
    try {
      telechargerLien(url, path.split("/").pop() || "file");
    } catch {
      window.open(url, "_self");
    }
  }

  async function downloadAllFilesAsZip(paths: readonly string[], nom?: string): Promise<void> {
    if (!Array.isArray(paths) || paths.length === 0) return;
    try {
      const res = await fetchAuth("/api/sandbox/download-multi", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths }),
      });
      if (!res || !res.ok) {
        showToast?.("Erreur lors de la création du zip", "error");
        return;
      }
      const url = URL.createObjectURL(await res.blob());
      telechargerLien(url, nom || "files.zip");
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (e) {
      showToast?.("Erreur réseau : " + ((e instanceof Error && e.message) || ""), "error");
    }
  }

  return {
    diffCardState,
    resetDiffCardState,
    diffCardRev,
    diffFilesFor,
    hasDiffFiles,
    isDiffEditorEnabled,
    onDiffRowClick,
    downloadOneFile,
    downloadAllFilesAsZip,
  };
}
