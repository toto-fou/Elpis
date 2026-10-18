// SPDX-License-Identifier: MIT
/** frontend/src/utils/office-model.ts — logique pure des visionneuses de l'éditeur : mode de vue, binaire, fenêtres de grille, LRU. */

export type ModeVue = "image" | "office" | "docx" | "hex" | "monaco";
export type GenreOffice = "docx" | "pptx" | "xlsx" | "pdf";

export interface OptionsMode {
  officeEnabled?: boolean;
  textFallback?: { has(cle: string): boolean } | null;
  binaryPaths?: { has(cle: string): boolean } | null;
}

export interface FenetreIndex {
  start: number;
  end: number;
}

export interface PlageContenu {
  start: number;
  end: number;
  total: number | null;
}

export interface Lru<V> {
  get(k: string): V | undefined;
  set(k: string, v: V): void;
  has(k: string): boolean;
  delete(k: string): boolean;
  clear(): void;
  keys(): string[];
  readonly size: number;
}

export const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico"];
export const OFFICE_EXTS: Readonly<Record<string, GenreOffice>> = {
  ".docx": "docx",
  ".pptx": "pptx",
  ".xlsx": "xlsx",
  ".pdf": "pdf",
};
export const HEX_EXTS = [
  ".bin",
  ".exe",
  ".so",
  ".dll",
  ".o",
  ".a",
  ".dylib",
  ".class",
  ".jar",
  ".dat",
  ".pyc",
  ".pyo",
  ".wasm",
  ".zip",
  ".gz",
  ".tgz",
  ".bz2",
  ".xz",
  ".7z",
  ".rar",
  ".tar",
  ".zst",
  ".lz4",
  ".whl",
  ".iso",
  ".img",
  ".deb",
  ".rpm",
  ".apk",
  ".sqlite",
  ".sqlite3",
  ".db",
  ".doc",
  ".xls",
  ".ppt",
  ".odt",
  ".ods",
  ".odp",
  ".docm",
  ".xlsm",
  ".pptm",
  ".dotx",
  ".xltx",
  ".potx",
  ".mp3",
  ".mp4",
  ".wav",
  ".ogg",
  ".flac",
  ".m4a",
  ".avi",
  ".mov",
  ".mkv",
  ".webm",
  ".ttf",
  ".otf",
  ".woff",
  ".woff2",
  ".eot",
  ".tif",
  ".tiff",
  ".heic",
  ".psd",
  ".gguf",
  ".safetensors",
  ".onnx",
  ".pt",
  ".pth",
  ".ckpt",
  ".pkl",
  ".npy",
  ".npz",
  ".parquet",
  ".h5",
];

export const SNIFF_BYTES = 8192;
const BINARY_MAGICS: number[][] = [
  [0x25, 0x50, 0x44, 0x46, 0x2d],
  [0x50, 0x4b, 0x03, 0x04],
  [0x50, 0x4b, 0x05, 0x06],
  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  [0xff, 0xd8, 0xff],
  [0x47, 0x49, 0x46, 0x38, 0x37, 0x61],
  [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
  [0x7f, 0x45, 0x4c, 0x46],
  [0x1f, 0x8b],
  [0x42, 0x5a, 0x68],
  [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00],
  [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c],
  [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07],
  [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
  [0xff, 0xfe],
  [0xfe, 0xff],
];

export function extOf(path: unknown): string {
  if (!path) return "";
  const m = /\.[^./\\]+$/.exec(String(path).toLowerCase());
  return m ? m[0] : "";
}

export function officeKind(path: unknown): GenreOffice | null {
  return OFFICE_EXTS[extOf(path)] ?? null;
}

const possede = (ensemble: { has(cle: string): boolean } | null | undefined, cle: string): boolean =>
  !!ensemble && typeof ensemble.has === "function" && ensemble.has(cle);

/** Mode de vue d'un chemin (officeEnabled coupé : docx en texte, pptx/xlsx en hex ; PDF reste office). */
export function viewModeForPath(path: string, opts?: OptionsMode | null): ModeVue {
  const o = opts ?? {};
  const ext = extOf(path);
  if (IMAGE_EXTS.includes(ext)) return "image";
  const kind = OFFICE_EXTS[ext];
  if (kind === "pdf") return "office";
  if (kind) {
    if (o.officeEnabled !== false && !possede(o.textFallback, path)) return "office";
    return kind === "docx" ? "docx" : "hex";
  }
  if (HEX_EXTS.includes(ext)) return "hex";
  if (possede(o.binaryPaths, path)) return "hex";
  return "monaco";
}

/** Modes sans modèle Monaco. */
export function isViewerMode(mode: unknown): boolean {
  return mode === "image" || mode === "hex" || mode === "office";
}

function startsWith(u8: Uint8Array, magic: readonly number[]): boolean {
  if (u8.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) if (u8[i] !== magic[i]) return false;
  return true;
}

/** Vrai si les premiers octets ne sont pas du texte éditable (aligné sur filetypes::looks_binary du serveur). */
export function looksBinary(u8: Uint8Array | null | undefined): boolean {
  if (!u8 || !u8.length) return false;
  const n = Math.min(u8.length, SNIFF_BYTES);
  for (let i = 0; i < n; i++) if (u8[i] === 0) return true;
  return BINARY_MAGICS.some((magic) => startsWith(u8, magic));
}

export function parseContentRange(header: unknown): PlageContenu | null {
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(header || "").trim());
  if (!m) return null;
  return { start: +(m[1] ?? 0), end: +(m[2] ?? 0), total: m[3] === "*" ? null : +(m[3] ?? 0) };
}

/** Index de colonne 0-based en lettres Excel (0 → A, 26 → AA). */
export function colName(i: number): string {
  let n = Math.floor(i) + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Sommes de préfixes : out[i] = position gauche de la colonne i, out[n] = largeur totale. */
export function prefixSums(widths: readonly number[]): number[] {
  const out = [0];
  for (let i = 0; i < widths.length; i++) out.push((out[i] ?? 0) + (widths[i] ?? 0));
  return out;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Lignes visibles [start, end[ avec marge `overscan`. */
export function rowWindow(
  scrollTop: number,
  viewportH: number,
  rowH: number,
  total: number,
  overscan?: number | null,
): FenetreIndex {
  const marge = overscan == null ? 8 : overscan;
  if (!total || rowH <= 0) return { start: 0, end: 0 };
  const first = Math.floor(Math.max(0, scrollTop) / rowH);
  const count = Math.ceil(Math.max(0, viewportH) / rowH) + 1;
  return { start: clamp(first - marge, 0, total), end: clamp(first + count + marge, 0, total) };
}

/** Plus grand i tel que prefix[i] <= x (dichotomie). */
function floorIndex(prefix: readonly number[], x: number): number {
  let lo = 0;
  let hi = prefix.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((prefix[mid] ?? 0) <= x) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Colonnes visibles [start, end[ d'après les sommes de préfixes. */
export function colWindow(
  scrollLeft: number,
  viewportW: number,
  prefix: readonly number[],
  overscan?: number | null,
): FenetreIndex {
  const marge = overscan == null ? 2 : overscan;
  const total = prefix.length - 1;
  if (total <= 0) return { start: 0, end: 0 };
  const left = Math.max(0, scrollLeft);
  const first = Math.min(floorIndex(prefix, left), total - 1);
  const last = Math.min(floorIndex(prefix, left + Math.max(0, viewportW)), total - 1);
  return { start: clamp(first - marge, 0, total), end: clamp(last + 1 + marge, 0, total) };
}

/** Morceaux (taille `chunkSize`) couvrant les lignes [start, end[. */
export function chunksFor(start: number, end: number, chunkSize: number): number[] {
  const out: number[] = [];
  if (end <= start || chunkSize <= 0) return out;
  for (let c = Math.floor(start / chunkSize); c * chunkSize < end; c++) out.push(c);
  return out;
}

/** LRU borné (l'ordre d'insertion d'une Map est l'ordre d'usage). */
export function createLru<V>(max: number, onEvict?: (cle: string, valeur: V) => void): Lru<V> {
  const map = new Map<string, V>();
  return {
    get(k) {
      if (!map.has(k)) return undefined;
      const v = map.get(k) as V;
      map.delete(k);
      map.set(k, v);
      return v;
    },
    set(k, v) {
      if (map.has(k)) map.delete(k);
      map.set(k, v);
      while (map.size > max) {
        const oldest = map.keys().next().value as string;
        const ov = map.get(oldest) as V;
        map.delete(oldest);
        if (onEvict) {
          try {
            onEvict(oldest, ov);
          } catch {
            /* un échec de rappel ne bloque pas l'éviction */
          }
        }
      }
    },
    has: (k) => map.has(k),
    delete: (k) => map.delete(k),
    clear: () => map.clear(),
    keys: () => Array.from(map.keys()),
    get size() {
      return map.size;
    },
  };
}

const ERROR_LABELS: Readonly<Record<string, string>> = {
  disabled: "Aperçu désactivé",
  not_found: "Fichier introuvable",
  too_large: "Fichier trop lourd",
  unsupported: "Format non pris en charge",
  invalid: "Fichier illisible",
  encrypted: "Fichier protégé",
  soffice_missing: "LibreOffice absent",
  isolation_unavailable: "Isolation indisponible",
  busy: "Conversions occupées",
  timeout: "Délai dépassé",
  expired: "Aperçu expiré",
  failed: "Conversion échouée",
  network: "Erreur réseau",
};

export function errorLabel(code: unknown): string {
  return ERROR_LABELS[String(code)] ?? ERROR_LABELS["failed"] ?? "";
}
