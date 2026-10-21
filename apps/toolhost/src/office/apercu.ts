// SPDX-License-Identifier: MIT
/** apps/toolhost/src/office/apercu.ts — aperçus Office et PDF de l'éditeur (sandbox/office_preview.py) : source lue par l'agent, cache hors /work (même format que le Python), grille xlsx en flux, PDF par LibreOffice. */
import { createHash, randomBytes } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { copyFile, open, unlink } from "node:fs/promises";
import path from "node:path";

import { estErreurAgent } from "@elpis/bac";
import {
  ErreurPython,
  FlottantPy,
  floatPy,
  getPy,
  intPy,
  journalDe,
  lowerPy,
  pyJsonDumps,
  pyJsonLoadsOctets,
  quotePy,
  stripPy,
  strPy,
  veritePy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { config } from "@elpis/config";
import type { AgentClient } from "@elpis/fichiers";
import { ErreurCheminBac, lexicalRel } from "@elpis/securite";

import { OFFICE_KINDS } from "../fichiers/types";
import { ArchiveOffice } from "./archive";
import {
  acquireFirst,
  buildArgv,
  cfg,
  childEnv,
  countPdfPages,
  ensureProfile,
  ErreurOffice,
  intCfg,
  isolationMode,
  loVersionToken,
  monotone,
  PDF_EXPORT_FILTERS,
  readLogTail,
  releaseLock,
  runSoffice,
  sofficeBin,
  tryLock,
} from "./conversion";
import { compileFormats, countRows, dimension, iterRows, numberFormats, sharedStrings, sheets } from "./xlsx";

const log = journalDe("office");

export const KEY_RE = /^[0-9a-f]{40}$/u;
export const MANIFEST = "manifest.json";
export const PDF_NAME = "doc.pdf";
export const CHUNK_ROWS = 200;
const MAX_MB_DEFAUTS: Readonly<Record<string, number>> = { docx: 100, pptx: 150, xlsx: 100, pdf: 200 };
const LIMITES: Readonly<Record<string, number>> = {
  xlsx_max_rows: 200_000,
  first_pages: 12,
  full_timeout_s: 300,
  max_pages: 300,
  xlsx_max_pages: 50,
  cache_mb: 2048,
  cache_user_mb: 512,
  cache_ttl_days: 14,
};
export const GRID_MAX_ROWS = 200_000;
export const GRID_MAX_COLS = 512;
export const GRID_CELL_CHARS = 1000;
export const GRID_MAX_BYTES = 64 * 1024 * 1024;
export const GRID_MAX_SHEETS = 64;
const WIDTH_SAMPLE_ROWS = 200;
export const XLSX_SRC = "src.xlsx";
export const XLSX_PREFETCH_CHUNKS = 5;
export const ZIP_MAX_MEMBERS = 5000;
export const ZIP_MAX_TOTAL = 1024 * 1024 * 1024;
export const ZIP_MAX_RATIO = 200;
export const ZIP_RATIO_FROM = 10 * 1024 * 1024;
export const XML_PART_MAX = 2 * 1024 * 1024;
const MAIN_TYPES: Readonly<Record<string, readonly string[]>> = {
  docx: ["wordprocessingml.document.main+xml", "wordprocessingml.template.main+xml"],
  pptx: [
    "presentationml.presentation.main+xml",
    "presentationml.slideshow.main+xml",
    "presentationml.template.main+xml",
  ],
  xlsx: ["spreadsheetml.sheet.main+xml", "spreadsheetml.template.main+xml"],
};
const CFB_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const INDISPONIBLE = new Set(["agent_unavailable", "container_down", "transport", "timeout"]);

function erreurDeConversion(e: unknown): boolean {
  return e instanceof ErreurPython && (e.type === "TypeError" || e.type === "ValueError");
}

/** `_limit` : réglage entier, la valeur par défaut s'il est illisible. */
export function limit(cle: string): number {
  try {
    return intPy(cfg(cle, LIMITES[cle]));
  } catch (e) {
    if (!erreurDeConversion(e)) throw e;
    return LIMITES[cle] as number;
  }
}

/** `max_bytes` : plafond de taille d'un format (`office_preview.max_mb`, au moins 1 Mo). */
export function maxBytes(kind: string): number {
  const defaut = MAX_MB_DEFAUTS[kind] as number;
  let mb: number;
  try {
    const brut = cfg("max_mb", {});
    const table = veritePy(brut) ? brut : {};
    if (table === null || typeof table !== "object" || Array.isArray(table))
      throw new ErreurPython("AttributeError", "'get'");
    const t = table as Record<string, unknown>;
    mb = floatPy(Object.hasOwn(t, kind) ? t[kind] : defaut);
  } catch (e) {
    if (!(e instanceof ErreurPython && ["TypeError", "ValueError", "AttributeError"].includes(e.type)))
      throw e;
    mb = defaut;
  }
  return intPy((mb > 1.0 ? mb : 1.0) * 1024 * 1024);
}

/** `cache_root` : racine du cache, créée en 0700 et refusée si elle n'est pas à ce compte. */
export function cacheRoot(): string {
  const conf = cfg("cache_dir", "");
  const brut =
    stripPy(process.env["APP_OFFICE_CACHE_DIR"] ?? "") || stripPy(veritePy(conf) ? strPy(conf) : "");
  const racine = brut || path.join(String(config.SANDBOX_DIR), ".office-cache");
  let st;
  try {
    mkdirSync(racine, { recursive: true, mode: 0o700 });
    st = lstatSync(racine);
  } catch (e) {
    log.warn(`[office] cache ${racine} inutilisable : ${(e as Error).message}`);
    throw new ErreurOffice("failed", 500, "Cache d'aperçu indisponible");
  }
  if (!st.isDirectory() || st.uid !== process.geteuid?.())
    throw new ErreurOffice("failed", 500, "Cache d'aperçu non sûr");
  if (st.mode & 0o077) {
    try {
      chmodSync(racine, 0o700);
    } catch {
      throw new ErreurOffice("failed", 500, "Cache d'aperçu non sûr");
    }
  }
  return racine;
}

function creerDossier(d: string): void {
  try {
    mkdirSync(d, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
}

/** `user_cache_dir` : `<racine>/u/<dossier du compte>`. */
export function userCacheDir(userDir: string): string {
  if (!userDir || userDir.includes("/") || userDir === "." || userDir === "..")
    throw new ErreurOffice("failed", 500, "Utilisateur invalide");
  const users = path.join(cacheRoot(), "u");
  creerDossier(users);
  const d = path.join(users, userDir);
  creerDossier(d);
  return d;
}

/** `key_dir` : dossier d'une clé (clé forgée : 400). */
export function keyDir(userDir: string, cle: string): string {
  if (!KEY_RE.test(cle || "")) throw new ErreurOffice("invalid", 400, "Clé d'aperçu invalide");
  return path.join(userCacheDir(userDir), cle);
}

/** État de la source vu par l'agent (`_Etat`). */
export interface EtatSource {
  readonly size: number;
  readonly mtimeNs: bigint;
  readonly mtime: number;
  readonly dev: bigint;
  readonly ino: bigint;
}

export interface Source {
  readonly agent: AgentClient;
  readonly rel: string;
  readonly kind: string;
  readonly ext: string;
  readonly st: EtatSource;
}

/** `PurePosixPath(p).suffix`. */
export function suffixe(p: string): string {
  const parties = p.split("/").filter((x) => x !== "" && x !== ".");
  const nom = parties[parties.length - 1] ?? "";
  const i = nom.lastIndexOf(".");
  return i > 0 && i < nom.length - 1 ? nom.slice(i) : "";
}

/** `PurePosixPath(p).stem`. */
function radical(p: string): string {
  const parties = p.split("/").filter((x) => x !== "" && x !== ".");
  const nom = parties[parties.length - 1] ?? "";
  const i = nom.lastIndexOf(".");
  return i > 0 && i < nom.length - 1 ? nom.slice(0, i) : nom;
}

/** `kind_of`. */
export function kindOf(p: unknown): string | null {
  return OFFICE_KINDS[lowerPy(suffixe(veritePy(p) ? strPy(p) : ""))] ?? null;
}

export function refusAgent(e: { code: string }): ErreurOffice {
  if (INDISPONIBLE.has(e.code))
    return new ErreurOffice(
      "unavailable",
      503,
      "Environnement sandbox arrêté — nouvelle tentative dans quelques instants.",
    );
  if (e.code === "bad_response")
    return new ErreurOffice("unavailable", 502, "Réponse invalide de l'environnement sandbox");
  if (e.code === "changed")
    return new ErreurOffice("changed", 409, "Fichier en cours de modification, réessayez");
  return new ErreurOffice("not_found", 404, "Fichier introuvable");
}

/** `int(v or 0)` exact d'une valeur de l'agent. */
function grandEntier(v: unknown): bigint {
  if (!veritePy(v)) return 0n;
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(Math.trunc(v));
  if (v instanceof FlottantPy) return BigInt(Math.trunc(v.valeur));
  return BigInt(intPy(v));
}

/** `open_source` : le fichier vu par l'agent (lien suivi sous /work seulement), format pris en charge, taille bornée. */
export async function openSource(agent: AgentClient, racine: string, userPath: string): Promise<Source> {
  let rel: string;
  try {
    rel = lexicalRel(racine, userPath, { allowRoot: false, tilde: false });
  } catch (e) {
    if (e instanceof ErreurCheminBac) throw new ErreurOffice("not_found", 404, "Fichier introuvable");
    throw e;
  }
  const ext = lowerPy(suffixe(rel));
  const kind = OFFICE_KINDS[ext];
  if (!kind) throw new ErreurOffice("unsupported", 415, "Format non pris en charge");
  let entrees: Dict[];
  try {
    entrees = await agent.stat([rel]);
  } catch (ex) {
    if (estErreurAgent(ex)) throw refusAgent(ex);
    throw ex;
  }
  if (entrees.length !== 1)
    throw new Error(`not enough values to unpack (expected 1, got ${entrees.length})`);
  const e = entrees[0] as Dict;
  if (getPy(e, "kind") !== "file") throw new ErreurOffice("not_found", 404, "Fichier introuvable");
  const ns = grandEntier(getPy(e, "mtime_ns"));
  const st: EtatSource = {
    size: Number(grandEntier(getPy(e, "size"))),
    mtimeNs: ns,
    mtime: Number(ns) / 1e9,
    dev: grandEntier(getPy(e, "dev")),
    ino: grandEntier(getPy(e, "ino")),
  };
  if (st.size > maxBytes(kind))
    throw new ErreurOffice(
      "too_large",
      413,
      `Fichier trop lourd (max ${Math.floor(maxBytes(kind) / (1024 * 1024))} Mo)`,
    );
  return { agent, rel, kind, ext, st };
}

/** `encode("utf-8", "surrogateescape")`. */
function encoderSurrogateEscape(s: string): Buffer {
  if (s.isWellFormed()) return Buffer.from(s, "utf8");
  const morceaux: Buffer[] = [];
  let debut = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        i++;
        continue;
      }
    }
    if (c < 0xd800 || c > 0xdfff) continue;
    if (c < 0xdc80 || c > 0xdcff)
      throw new Error("'utf-8' codec can't encode character: surrogates not allowed");
    morceaux.push(Buffer.from(s.slice(debut, i), "utf8"), Buffer.from([c - 0xdc00]));
    debut = i + 1;
  }
  morceaux.push(Buffer.from(s.slice(debut), "utf8"));
  return Buffer.concat(morceaux);
}

/** `cache_key` : empreinte du compte, du chemin, de la version du fichier et de LibreOffice. */
export function cacheKey(uid: number, rel: string, st: EtatSource, version: string): string {
  const brut = `v1|${Math.trunc(uid)}|${rel}|${st.dev}|${st.ino}|${st.mtimeNs}|${st.size}|${version}`;
  return createHash("sha256").update(encoderSurrogateEscape(brut)).digest("hex").slice(0, 40);
}

/** `snapshot_to` : copie bloc à bloc sur la version vue à l'ouverture (fichier changé : 409). */
export async function snapshotTo(src: Source, dest: string): Promise<void> {
  const taille = src.st.size;
  let pos = 0;
  const out = await open(dest, "w");
  try {
    while (pos < taille) {
      const n = Math.min(1 << 20, taille - pos);
      let data: Buffer;
      try {
        data = (
          await src.agent.read(src.rel, {
            offset: pos,
            length: n,
            maxBytes: n,
            expectSize: taille,
            expectMtimeNs: src.st.mtimeNs,
            ...(src.st.ino ? { expectIno: src.st.ino } : {}),
          })
        ).data;
      } catch (ex) {
        if (estErreurAgent(ex)) throw refusAgent(ex);
        throw ex;
      }
      if (!data.length) throw new ErreurOffice("changed", 409, "Fichier en cours de modification, réessayez");
      await out.write(data);
      pos += data.length;
    }
  } finally {
    await out.close();
  }
}

const illisible = (): ErreurOffice => new ErreurOffice("invalid", 422, "Fichier illisible");
const anormale = (): ErreurOffice => new ErreurOffice("invalid", 422, "Archive anormale");

/** `zipfile.ZipFile(chemin)` : archive illisible (BadZipFile, OSError, ValueError) → 422. */
async function ouvrirZip(chemin: string): Promise<ArchiveOffice> {
  try {
    return await ArchiveOffice.ouvrir(chemin);
  } catch (e) {
    const type = (e as { type?: unknown }).type;
    if (type === "NotImplementedError" || e instanceof ErreurPython) throw e;
    if (
      type === "BadZipFile" ||
      type === "UnicodeDecodeError" ||
      e instanceof RangeError ||
      (e as NodeJS.ErrnoException).code !== undefined
    )
      throw illisible();
    throw e;
  }
}

async function readMember(zf: ArchiveOffice, nom: string): Promise<Buffer> {
  const info = zf.info(nom);
  if (info === undefined || info.taille > XML_PART_MAX) throw illisible();
  const f = zf.ouvrirMembre(info);
  let data: Buffer;
  try {
    data = await f.lire(XML_PART_MAX + 1);
  } finally {
    await f.fermer();
  }
  const texte = data.toString("latin1");
  if (data.length > XML_PART_MAX || texte.includes("<!DOCTYPE") || texte.includes("<!ENTITY"))
    throw illisible();
  return data;
}

/** `check_ooxml` : archive saine et de la famille annoncée par l'extension. */
export async function checkOoxml(chemin: string, kind: string): Promise<void> {
  let tete: Buffer;
  try {
    const fh = await open(chemin, "r");
    try {
      const b = Buffer.alloc(8);
      const { bytesRead } = await fh.read(b, 0, 8, 0);
      tete = b.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  } catch {
    throw illisible();
  }
  if (tete.length >= 8 && tete.equals(CFB_MAGIC))
    throw new ErreurOffice("encrypted", 422, "Fichier protégé par mot de passe ou ancien format");
  if (tete.subarray(0, 2).toString("latin1") !== "PK") throw illisible();
  const zf = await ouvrirZip(chemin);
  const infos = zf.zip.membres;
  if (infos.length > ZIP_MAX_MEMBERS) throw anormale();
  let total = 0;
  for (const info of infos) {
    const nom = info.nom;
    const parties = nom.split("/").filter((p) => p !== "" && p !== ".");
    if (nom.includes("\0") || nom.includes("\\") || nom.startsWith("/") || parties.includes(".."))
      throw anormale();
    total += info.taille;
    if (info.taille > ZIP_RATIO_FROM && info.taille > ZIP_MAX_RATIO * Math.max(1, info.tailleCompressee))
      throw anormale();
  }
  if (total > ZIP_MAX_TOTAL) throw anormale();
  const types = (await readMember(zf, "[Content_Types].xml")).toString("utf8");
  if (!(MAIN_TYPES[kind] ?? []).some((t) => types.includes(t)))
    throw new ErreurOffice("invalid", 422, "Contenu incohérent avec l'extension");
}

/** `check_pdf` : signature `%PDF-` dans le premier Kio. */
export async function checkPdf(chemin: string): Promise<void> {
  let tete: Buffer;
  try {
    const f = await open(chemin, "r");
    try {
      const { bytesRead, buffer } = await f.read(Buffer.alloc(1024), 0, 1024, 0);
      tete = buffer.subarray(0, bytesRead);
    } finally {
      await f.close();
    }
  } catch {
    throw illisible();
  }
  if (!tete.toString("latin1").includes("%PDF-")) throw illisible();
}

export function maxRowsLimit(): number {
  return Math.max(CHUNK_ROWS, Math.min(1_048_576, limit("xlsx_max_rows")));
}

export interface FeuilleGrille {
  name: string;
  hidden: boolean;
  rows: number;
  cols: number;
  chunks: number;
  complete: boolean;
  truncated: boolean;
  widths: number[];
}

export interface SourceFeuille {
  member: string;
  date1904: boolean;
  no_dim: boolean;
}

/** `xlsx_skeleton` : tailles des feuilles d'après `<dimension>` (sinon comptées), sans lire les lignes. */
export async function xlsxSkeleton(
  chemin: string,
): Promise<[{ chunk: number; sheets: FeuilleGrille[]; truncated: boolean }, SourceFeuille[]]> {
  const zf = await ouvrirZip(chemin);
  let metas = await sheets(zf);
  const tronque = metas.length > GRID_MAX_SHEETS;
  metas = metas.slice(0, GRID_MAX_SHEETS);
  const feuilles: FeuilleGrille[] = [];
  const sources: SourceFeuille[] = [];
  for (const m of metas) {
    let dim = await dimension(zf, m.member);
    if (dim === null) {
      const compte = await countRows(zf, m.member, maxRowsLimit());
      dim = compte ? [compte, 0] : null;
    }
    const rows = dim ? Math.min(dim[0], maxRowsLimit()) : 0;
    const cols = dim ? Math.min(dim[1], GRID_MAX_COLS) : 0;
    feuilles.push({
      name: m.name,
      hidden: m.hidden,
      rows: rows || CHUNK_ROWS,
      cols: cols || 1,
      chunks: 0,
      complete: false,
      truncated: false,
      widths: [],
    });
    sources.push({ member: m.member, date1904: m.date1904, no_dim: rows === 0 });
  }
  if (!feuilles.length) throw new ErreurOffice("invalid", 422, "Classeur sans feuille lisible");
  return [{ chunk: CHUNK_ROWS, sheets: feuilles, truncated: tronque }, sources];
}

export interface StatsFeuille {
  rows: number;
  cols: number;
  chunks: number;
  complete: boolean;
  truncated: boolean;
  widths: number[];
}

const respirer = (): Promise<void> => new Promise((r) => setImmediate(r));

function points(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0xdc00 || c > 0xdfff || i === 0 || s.charCodeAt(i - 1) < 0xd800 || s.charCodeAt(i - 1) > 0xdbff)
      n++;
  }
  return n;
}

/** `build_xlsx_sheet` : morceaux JSON d'une feuille lue en flux (numéros de ligne du document), statistiques. */
export async function buildXlsxSheet(
  xlsx: string,
  gridDir: string,
  source: { member: string; date1904?: unknown },
  sheetIdx: number,
  o: { maxRows?: number | null; budget?: number } = {},
): Promise<StatsFeuille> {
  const maxRows = o.maxRows ?? maxRowsLimit();
  const sdir = path.join(gridDir, `s${sheetIdx}`);
  mkdirSync(sdir, { recursive: true });
  const zf = await ouvrirZip(xlsx);
  let nChunk = 0;
  let maxCols = 0;
  let lastRow = 0;
  let truncated = false;
  const widths: number[] = [];
  let buf: string[][] = [];
  let reste = o.budget ?? GRID_MAX_BYTES;
  const flush = (index: number, rows: string[][], plein = false): void => {
    if (plein) while (rows.length < CHUNK_ROWS) rows.push([]);
    const data = Buffer.from(pyJsonDumps(rows, { ensureAscii: false, separators: [",", ":"] }), "utf8");
    writeFileSync(path.join(sdir, `c${index}.json`), data);
    reste -= data.length;
  };
  const sst = await sharedStrings(zf);
  const formats = compileFormats(await numberFormats(zf));
  let pause = performance.now();
  const lignes = iterRows(zf, { member: source.member, date1904: veritePy(source.date1904) }, sst, formats, {
    maxCols: GRID_MAX_COLS,
    cellChars: GRID_CELL_CHARS,
  });
  for await (const [r, cells, coupe] of lignes) {
    if (performance.now() - pause > 10) {
      await respirer();
      pause = performance.now();
    }
    if (r <= 0) continue;
    if (r > maxRows || reste <= 0) {
      truncated = true;
      break;
    }
    truncated = truncated || coupe;
    reste -= cells.reduce((n, c) => n + points(c), 0) + 3 * cells.length + 3;
    const idx = r - 1;
    const chunkNo = Math.floor(idx / CHUNK_ROWS);
    while (nChunk < chunkNo) {
      flush(nChunk, buf, true);
      nChunk++;
      buf = [];
    }
    while (buf.length < idx % CHUNK_ROWS) buf.push([]);
    buf.push(cells);
    lastRow = r;
    maxCols = Math.max(maxCols, cells.length);
    if (r <= WIDTH_SAMPLE_ROWS)
      cells.forEach((c, i) => {
        const w = Math.min(40, Math.max(6, points(c)));
        if (i >= widths.length) widths.push(w);
        else if (w > (widths[i] as number)) widths[i] = w;
      });
  }
  flush(nChunk, buf);
  nChunk++;
  while (widths.length < maxCols) widths.push(6);
  return {
    rows: lastRow,
    cols: maxCols,
    chunks: nChunk,
    complete: !truncated,
    truncated,
    widths: widths.slice(0, maxCols),
  };
}

const enCours = new Set<string>();
const taches = new Set<Promise<void>>();
let arret = new AbortController();

/** Tests et arrêt : attend les constructions et conversions de fond en cours. */
export async function attendreTachesOffice(): Promise<void> {
  while (taches.size) await Promise.allSettled([...taches]);
}

/** Arrêt de l'hôte : conversions LibreOffice en cours tuées (groupe compris), tâches de fond attendues. */
export async function arreterOffice(): Promise<void> {
  arret.abort(new ErreurOffice("cancelled", 503, "Hôte d'outils en cours d'arrêt"));
  try {
    await attendreTachesOffice();
  } finally {
    arret = new AbortController();
  }
}

function lancer(marque: string, f: () => Promise<void>): void {
  if (enCours.has(marque)) return;
  enCours.add(marque);
  const t = f().finally(() => {
    enCours.delete(marque);
    taches.delete(t);
  });
  taches.add(t);
}

/** `_schedule_sheet_build` : construction d'une feuille en fond, une seule à la fois par (clé, feuille). */
function scheduleSheetBuild(userDir: string, cle: string, feuille: number): void {
  lancer(`${cle}|${feuille}`, async () => {
    try {
      await ensureSheetBuilt(userDir, cle, feuille, { attendre: false });
    } catch (e) {
      log.debug(`[office] construction de fond échouée (clé=${cle.slice(0, 8)}) : ${(e as Error).message}`);
    }
  });
}

/** Liste Python indexée comme `seq[i]` (indices négatifs depuis la fin), `undefined` hors bornes. */
function indice<T>(l: unknown, i: number): T | undefined {
  return Array.isArray(l) ? (l.at(i) as T | undefined) : undefined;
}

function feuillesDe(m: Dict): Dict[] {
  const g = veritePy(getPy(m, "grid")) ? getPy(m, "grid") : {};
  const s = g !== null && typeof g === "object" && !Array.isArray(g) ? (g as Dict)["sheets"] : undefined;
  return veritePy(s) && Array.isArray(s) ? (s as Dict[]) : [];
}

/** `want_sheet` : la feuille va être lue, sa construction part en fond (aucune erreur ne remonte). */
export function wantSheet(userDir: string, cle: string, feuille: number): void {
  try {
    const d = keyDir(userDir, cle);
    void readManifest(d)
      .then((m) => {
        if (!m || !veritePy(getPy(m, "grid")) || sheetIsBuilt(m, feuille)) return;
        if (feuille >= 0 && feuille < feuillesDe(m).length) scheduleSheetBuild(userDir, cle, feuille);
      })
      .catch(() => undefined);
  } catch {
    // swallow("office.want_sheet")
  }
}

/** `_sheet_is_built`. */
export function sheetIsBuilt(m: Dict, feuille: number): boolean {
  const g = getPy(m, "grid");
  const grille = veritePy(g) ? g : {};
  if (grille === null || typeof grille !== "object" || Array.isArray(grille)) return false;
  const s = indice<unknown>(Object.hasOwn(grille, "sheets") ? (grille as Dict)["sheets"] : [], feuille);
  if (s === null || typeof s !== "object" || Array.isArray(s)) return false;
  return veritePy((s as Dict)["complete"]);
}

const dormir = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function estFichier(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** `ensure_sheet_built` : bâtit la feuille si elle ne l'est pas (une passe, sous verrou), rend le manifeste à jour. */
export async function ensureSheetBuilt(
  userDir: string,
  cle: string,
  feuille: number,
  o: { attendu?: string; maxRows?: number; attendre?: boolean } = {},
): Promise<Dict | null> {
  const d = keyDir(userDir, cle);
  let m = await readManifest(d);
  if (!m || !veritePy(getPy(m, "grid"))) return null;
  let fs = feuillesDe(m);
  if (!(feuille >= 0 && feuille < fs.length) || veritePy(getPy(fs[feuille] as Dict, "complete"))) return m;
  const src = path.join(d, XLSX_SRC);
  const gs = getPy(m, "grid_src");
  const sources = veritePy(gs) && Array.isArray(gs) ? (gs as Dict[]) : [];
  if (!estFichier(src) || !(feuille >= 0 && feuille < sources.length)) return m;
  let fd = await tryLock(`grid-${cle}-${feuille}`);
  if (fd === null) {
    if (!(o.attendre ?? true)) return m;
    const limite = monotone() + intCfg("timeout_s", 5, 600);
    while (monotone() < limite) {
      await dormir(100);
      if (o.attendu !== undefined && estFichier(o.attendu)) return (await readManifest(d)) ?? m;
      m = (await readManifest(d)) ?? m;
      if (sheetIsBuilt(m, feuille)) return m;
      fd = await tryLock(`grid-${cle}-${feuille}`);
      if (fd !== null) break;
    }
    if (fd === null) return m;
  }
  try {
    m = (await readManifest(d)) ?? m;
    fs = feuillesDe(m);
    if (feuille >= 0 && feuille < fs.length && veritePy(getPy(fs[feuille] as Dict, "complete"))) return m;
    const t0 = monotone();
    const stats = await buildXlsxSheet(
      src,
      path.join(d, "grid"),
      sources[feuille] as unknown as SourceFeuille,
      feuille,
      {
        ...(o.maxRows !== undefined ? { maxRows: o.maxRows } : {}),
      },
    );
    const partielle = o.maxRows !== undefined && stats.rows >= o.maxRows;
    log.info(
      `[office] feuille ${feuille} : ${stats.rows} lignes en ${(monotone() - t0).toFixed(2)} s (${partielle ? "tête" : "complète"}) clé=${cle.slice(0, 8)}`,
    );
    const sh = fs[feuille] as Dict;
    const connues = veritePy(getPy(sh, "rows")) ? getPy(sh, "rows") : 0;
    for (const [k, v] of Object.entries(stats)) sh[k] = v;
    if (partielle) {
      sh["complete"] = false;
      sh["truncated"] = false;
      sh["rows"] = Math.max(Number(connues), stats.rows);
    } else sh["rows"] = Math.max(stats.rows, 0);
    writeManifest(d, m);
    return m;
  } finally {
    releaseLock(fd);
  }
}

/** `read_manifest` : manifeste v1 (premier Mio relu comme `json.loads`), `null` sinon. */
export async function readManifest(d: string): Promise<Dict | null> {
  let data: unknown;
  try {
    const fh = await open(path.join(d, MANIFEST), "r");
    let brut: Buffer;
    try {
      const b = Buffer.alloc(1024 * 1024);
      const { bytesRead } = await fh.read(b, 0, b.length, 0);
      brut = b.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
    data = pyJsonLoadsOctets(brut);
  } catch {
    return null;
  }
  if (data === null || typeof data !== "object" || Array.isArray(data) || data instanceof FlottantPy)
    return null;
  const v = (data as Dict)["v"];
  const un = v === 1 || v === true || v === 1n || (v instanceof FlottantPy && v.valeur === 1);
  return un ? (data as Dict) : null;
}

/** `write_manifest` : écrit à côté puis remplace (jamais un manifeste à moitié écrit). */
export function writeManifest(d: string, manifeste: Dict): void {
  const tmp = path.join(d, `.${MANIFEST}.${randomBytes(4).toString("hex")}`);
  writeFileSync(tmp, pyJsonDumps(manifeste, { ensureAscii: false }), "utf8");
  renameSync(tmp, path.join(d, MANIFEST));
}

/** `_touch` : estampille d'usage du manifeste, au plus une fois par heure. */
function toucher(d: string): void {
  try {
    const p = path.join(d, MANIFEST);
    if (Date.now() / 1000 - statSync(p).mtimeMs / 1000 > 3600) {
      const t = Date.now() / 1000;
      utimesSync(p, t, t);
    }
  } catch {
    // estampille non mise à jour
  }
}

/** `_payload` : manifeste rendu au front pour une vue. */
export function payload(m: Dict, vue: string): Dict {
  const cle = m["key"];
  const nom = radical(strPy(m["rel"])) || "document";
  let pages: Dict | null = null;
  const p = getPy(m, "pages");
  if (veritePy(p)) {
    const pg = p as Dict;
    const r = getPy(pg, "rev", 0);
    const rev = intPy(veritePy(r) ? r : 0);
    const url = `/api/sandbox/office/pdf/${strPy(cle)}/${quotePy(nom + ".pdf")}`;
    pages = {
      url: url + (rev ? `?r=${rev}` : ""),
      count: getPy(pg, "count") ?? null,
      truncated: veritePy(getPy(pg, "truncated")),
      partial: veritePy(getPy(pg, "partial")),
    };
  }
  return {
    kind: m["kind"],
    key: cle,
    rel: m["rel"],
    size: m["size"],
    mtime: m["mtime"],
    view: vue,
    pages: vue === "pages" ? pages : null,
    grid: vue === "grid" ? (getPy(m, "grid") ?? null) : null,
    has: { pages: veritePy(getPy(m, "pages")), grid: veritePy(getPy(m, "grid")) },
  };
}

/** `pdf_file` : PDF du cache, `null` s'il n'existe plus. */
export async function pdfFile(userDir: string, cle: string): Promise<string | null> {
  const d = keyDir(userDir, cle);
  const m = await readManifest(d);
  if (!m || !veritePy(getPy(m, "pages"))) return null;
  const p = path.join(d, PDF_NAME);
  return estFichier(p) ? p : null;
}

/** `sheet_chunk` : (fichier du morceau, taille réelle de la feuille). */
export async function sheetChunk(
  userDir: string,
  cle: string,
  feuille: number,
  morceau: number,
): Promise<[string | null, { rows: unknown; cols: unknown; complete: boolean } | null]> {
  const p = await sheetChunkFile(userDir, cle, feuille, morceau);
  let taille = null;
  if (p !== null) {
    const m = (await readManifest(keyDir(userDir, cle))) ?? {};
    const fs = feuillesDe(m);
    if (feuille >= 0 && feuille < fs.length) {
      const sh = fs[feuille] as Dict;
      taille = {
        rows: getPy(sh, "rows", 0),
        cols: getPy(sh, "cols", 0),
        complete: veritePy(getPy(sh, "complete")),
      };
    }
  }
  return [p, taille];
}

/** `sheet_chunk_file` : morceau de grille, bâti à la demande s'il manque (tête seule pour le haut d'une feuille vierge). */
export async function sheetChunkFile(
  userDir: string,
  cle: string,
  feuille: number,
  morceau: number,
): Promise<string | null> {
  if (
    !(feuille >= 0 && feuille < GRID_MAX_SHEETS) ||
    !(morceau >= 0 && morceau <= GRID_MAX_ROWS / CHUNK_ROWS)
  )
    return null;
  const d = keyDir(userDir, cle);
  const m = await readManifest(d);
  if (!m || !veritePy(getPy(m, "grid"))) return null;
  const p = path.join(d, "grid", `s${feuille}`, `c${morceau}.json`);
  if (estFichier(p)) {
    toucher(d);
    return p;
  }
  if (sheetIsBuilt(m, feuille)) return null;
  const fs = feuillesDe(m);
  const vierge = feuille >= 0 && feuille < fs.length && !veritePy(getPy(fs[feuille] as Dict, "chunks"));
  if (vierge && morceau < XLSX_PREFETCH_CHUNKS) {
    if (
      (await ensureSheetBuilt(userDir, cle, feuille, {
        attendu: p,
        maxRows: XLSX_PREFETCH_CHUNKS * CHUNK_ROWS,
      })) === null
    )
      return null;
    if (estFichier(p)) {
      toucher(d);
      return p;
    }
  }
  if ((await ensureSheetBuilt(userDir, cle, feuille, { attendu: p })) === null) return null;
  toucher(d);
  return estFichier(p) ? p : null;
}

function normalizeView(kind: string, vue: string | null): string {
  if (kind === "xlsx") return vue === "pages" ? "pages" : "grid";
  return "pages";
}

/** `prepare` : manifeste de l'aperçu demandé, converti au besoin (une conversion par clé à la fois). */
export async function prepare(o: {
  uid: number;
  userDir: string;
  racine: string;
  chemin: string;
  vue: string | null;
  agent: AgentClient;
}): Promise<Dict> {
  const src = await openSource(o.agent, o.racine, o.chemin);
  const version = src.kind === "pdf" ? "pdf" : loVersionToken(sofficeBin());
  const cle = cacheKey(o.uid, src.rel, src.st, version);
  const v = normalizeView(src.kind, o.vue);
  const d = path.join(userCacheDir(o.userDir), cle);
  const deja = await readManifest(d);
  if (deja && veritePy(getPy(deja, v))) {
    toucher(d);
    return payload(deja, v);
  }
  const waitS = intCfg("wait_s", 1, 120);
  const echeance = monotone() + waitS;
  let cleFd: number | null = null;
  try {
    [cleFd] = await acquireFirst([`key-${cle}`], echeance + intCfg("timeout_s", 5, 600));
    const m = await readManifest(d);
    if (m && veritePy(getPy(m, v))) return payload(m, v);
    return await build(o.uid, o.userDir, src, cle, v, d, m, monotone() + waitS);
  } finally {
    releaseLock(cleFd);
  }
}

function newJobDir(userDir: string, cle: string): string {
  const job = path.join(userCacheDir(userDir), `.tmp-${cle}-${randomBytes(4).toString("hex")}`);
  mkdirSync(job);
  mkdirSync(path.join(job, "out"), { mode: 0o700 });
  return job;
}

function baseManifest(src: Source, cle: string, precedent: Dict | null): Dict {
  if (precedent) return { ...precedent };
  return {
    v: 1,
    key: cle,
    rel: src.rel,
    kind: src.kind,
    size: src.st.size,
    mtime: new FlottantPy(src.st.mtime),
    created: new FlottantPy(Date.now() / 1000),
  };
}

/** `_publish` : artefacts déplacés dans le dossier de clé, puis le manifeste (dernier geste). */
function publish(job: string, d: string, manifeste: Dict, artefacts: readonly string[]): void {
  creerDossier(d);
  for (const nom of artefacts) {
    const dst = path.join(d, nom);
    try {
      if (lstatSync(dst).isDirectory()) rmSync(dst, { recursive: true, force: true });
    } catch {
      // destination absente
    }
    renameSync(path.join(job, nom), dst);
  }
  writeManifest(d, manifeste);
}

async function build(
  uid: number,
  userDir: string,
  src: Source,
  cle: string,
  v: string,
  d: string,
  precedent: Dict | null,
  echeance: number,
): Promise<Dict> {
  const job = newJobDir(userDir, cle);
  try {
    const inName = `in${src.ext}`;
    const entree = path.join(job, inName);
    await snapshotTo(src, entree);
    const manifeste = baseManifest(src, cle, precedent);
    if (src.kind === "pdf") {
      await checkPdf(entree);
      renameSync(entree, path.join(job, PDF_NAME));
      manifeste["pages"] = { count: null, truncated: false };
      publish(job, d, manifeste, [PDF_NAME]);
      return payload(manifeste, v);
    }
    if (src.kind === "xlsx" && v === "grid") {
      await checkOoxml(entree, src.kind);
      const [grille, sources] = await xlsxSkeleton(entree);
      mkdirSync(path.join(job, "grid"));
      const vue = grille.sheets.findIndex((s) => !s.hidden);
      const premiere = vue < 0 ? 0 : vue;
      const tete = (sources[premiere] as SourceFeuille).no_dim ? null : XLSX_PREFETCH_CHUNKS * CHUNK_ROWS;
      const stats = await buildXlsxSheet(
        entree,
        path.join(job, "grid"),
        sources[premiere] as SourceFeuille,
        premiere,
        {
          maxRows: tete,
        },
      );
      const partielle = tete !== null && stats.rows >= tete;
      const f = grille.sheets[premiere] as FeuilleGrille;
      f.cols = Math.max(stats.cols, f.cols);
      f.chunks = stats.chunks;
      f.widths = stats.widths;
      f.complete = !partielle && !stats.truncated;
      f.truncated = stats.truncated && !partielle;
      if (!partielle) f.rows = stats.rows;
      else if (stats.rows > f.rows) f.rows = stats.rows;
      manifeste["grid"] = grille;
      manifeste["grid_src"] = sources;
      renameSync(entree, path.join(job, XLSX_SRC));
      publish(job, d, manifeste, [XLSX_SRC, "grid"]);
      await maybePruneUser(userDir);
      if (!f.complete) scheduleSheetBuild(userDir, cle, premiere);
      return payload(manifeste, v);
    }
    const soffice = sofficeBin();
    if (!soffice) throw new ErreurOffice("soffice_missing", 503, "LibreOffice absent du serveur");
    const isolation = await isolationMode();
    await checkOoxml(entree, src.kind);
    const plafond = limit(src.kind === "xlsx" ? "xlsx_max_pages" : "max_pages");
    const tete = Math.max(1, Math.min(plafond, limit("first_pages")));
    const demandees = src.kind === "docx" || src.kind === "pptx" ? tete : plafond;
    const outPdf = await convertToPdf({
      uid,
      job,
      kind: src.kind,
      inName,
      isolation,
      soffice,
      pages: demandees,
      echeance,
      timeoutS: intCfg("timeout_s", 5, 600),
      etiquette: v,
    });
    await checkPdf(outPdf);
    const cap = intCfg("max_pdf_mb", 1, 4096) * 1024 * 1024;
    if (statSync(outPdf).size > cap) throw new ErreurOffice("too_large", 413, "Aperçu trop lourd");
    const nombre = await countPdfPages(outPdf);
    renameSync(outPdf, path.join(job, PDF_NAME));
    const partiel = demandees < plafond && nombre >= demandees;
    manifeste["pages"] = { count: nombre, truncated: nombre >= plafond, partial: partiel, rev: 0 };
    const artefacts = [PDF_NAME];
    if (partiel) {
      renameSync(entree, path.join(job, `src${src.ext}`));
      artefacts.push(`src${src.ext}`);
    }
    publish(job, d, manifeste, artefacts);
    await maybePruneUser(userDir);
    if (partiel) scheduleFullPdf(uid, userDir, cle, src.kind, src.ext);
    return payload(manifeste, v);
  } finally {
    rmSync(job, { recursive: true, force: true });
  }
}

/** `_convert_to_pdf` : LibreOffice sur `job/inName` sous les créneaux du compte puis global ; rend le PDF produit. */
async function convertToPdf(o: {
  uid: number;
  job: string;
  kind: string;
  inName: string;
  isolation: string;
  soffice: string;
  pages: number;
  echeance: number;
  timeoutS: number;
  etiquette: string;
}): Promise<string> {
  const slots = intCfg("slots", 1, 16);
  const parCompte = intCfg("slots_per_user", 1, 16);
  let userFd: number | null = null;
  let slotFd: number | null = null;
  try {
    [userFd] = await acquireFirst(
      Array.from({ length: parCompte }, (_, j) => `user-u${Math.trunc(o.uid)}-${j}`),
      o.echeance,
    );
    let slotNom: string;
    [slotFd, slotNom] = await acquireFirst(
      Array.from({ length: slots }, (_, i) => `slot-${i}`),
      o.echeance,
    );
    const profil = path.join(cacheRoot(), "profiles", slotNom);
    ensureProfile(profil);
    const opts = {
      PageRange: { type: "string", value: `1-${Math.max(1, o.pages)}` },
      ReduceImageResolution: { type: "boolean", value: "true" },
      MaxImageResolution: { type: "long", value: "150" },
    };
    const convertTo = `pdf:${PDF_EXPORT_FILTERS[o.kind] ?? ""}:${pyJsonDumps(opts, { separators: [",", ":"] })}`;
    const argv = buildArgv({
      isolation: o.isolation,
      soffice: o.soffice,
      profil,
      job: o.job,
      kind: o.kind,
      inName: o.inName,
      convertTo,
      timeoutS: o.timeoutS,
    });
    const env = childEnv(o.isolation, profil, o.job);
    const t0 = monotone();
    const rc = await runSoffice(argv, env, {
      cwd: o.job,
      logPath: path.join(o.job, "lo.log"),
      timeoutS: o.timeoutS,
      signal: arret.signal,
    });
    log.info(
      `[office] ${o.kind} → ${o.etiquette} (1-${o.pages}) en ${(monotone() - t0).toFixed(2)} s (rc=${rc}, ${o.isolation})`,
    );
  } finally {
    releaseLock(slotFd);
    releaseLock(userFd);
  }
  const outPdf = path.join(o.job, "out", "in.pdf");
  if (!estFichier(outPdf)) throw conversionFailed(o.job);
  return outPdf;
}

function conversionFailed(job: string): ErreurOffice {
  const fin = readLogTail(path.join(job, "lo.log"));
  if (fin) log.warn(`[office] conversion échouée : ${fin}`);
  return new ErreurOffice("failed", 500, "Conversion échouée");
}

const NOM_CONVERSION = /^[A-Za-z0-9_-]{1,40}\.[a-z0-9]{2,5}$/u;

/** `convert_bytes` : conversion d'octets à octets pour les outils Office (export PDF, PNG des graphiques), même prison, mêmes créneaux, profils et contrôles que l'aperçu ; `{nom d'entrée: octets produits}`, un fichier non converti est absent, aucun produit : « failed ». */
export async function convertBytes(o: {
  uid: number;
  kind: string;
  files: Readonly<Record<string, Uint8Array>>;
  convertTo: string;
  outExt: string;
  timeoutS?: number;
  signal?: AbortSignal;
}): Promise<Record<string, Buffer>> {
  const soffice = sofficeBin();
  if (!soffice) throw new ErreurOffice("unavailable", 503, "LibreOffice n'est pas installé sur le serveur");
  const entrees = Object.entries(o.files);
  if (entrees.length === 0) return {};
  const isolation = await isolationMode();
  const timeoutS = o.timeoutS || intCfg("timeout_s", 5, 600);
  const echeance = monotone() + intCfg("wait_s", 1, 300);
  const jobs = path.join(cacheRoot(), "jobs");
  mkdirSync(jobs, { recursive: true, mode: 0o700 });
  const job = mkdtempSync(path.join(jobs, "tool-"));
  try {
    const noms: string[] = [];
    for (const [nom, donnees] of entrees) {
      if (!NOM_CONVERSION.test(nom))
        throw new ErreurOffice("failed", 400, "Nom de fichier de conversion invalide");
      writeFileSync(path.join(job, nom), donnees);
      if (MAIN_TYPES[o.kind] !== undefined) await checkOoxml(path.join(job, nom), o.kind);
      noms.push(nom);
    }
    mkdirSync(path.join(job, "out"), { mode: 0o700 });
    const slots = intCfg("slots", 1, 16);
    const parCompte = intCfg("slots_per_user", 1, 16);
    let userFd: number | null = null;
    let slotFd: number | null = null;
    try {
      [userFd] = await acquireFirst(
        Array.from({ length: parCompte }, (_, j) => `user-u${Math.trunc(o.uid)}-${j}`),
        echeance,
      );
      let slotNom: string;
      [slotFd, slotNom] = await acquireFirst(
        Array.from({ length: slots }, (_, i) => `slot-${i}`),
        echeance,
      );
      const profil = path.join(cacheRoot(), "profiles", slotNom);
      ensureProfile(profil);
      const argv = buildArgv({
        isolation,
        soffice,
        profil,
        job,
        kind: o.kind,
        inName: noms[0] as string,
        convertTo: o.convertTo,
        timeoutS,
        autres: noms.slice(1),
      });
      const env = childEnv(isolation, profil, job);
      const t0 = monotone();
      const rc = await runSoffice(argv, env, {
        cwd: job,
        logPath: path.join(job, "lo.log"),
        timeoutS,
        signal: o.signal ? AbortSignal.any([o.signal, arret.signal]) : arret.signal,
      });
      log.info(
        `[office] outils : ${noms.length} ${o.kind} → ${o.outExt} en ${(monotone() - t0).toFixed(2)} s (rc=${rc}, ${isolation})`,
      );
    } finally {
      releaseLock(slotFd);
      releaseLock(userFd);
    }
    const sorties: Record<string, Buffer> = {};
    const plafond = intCfg("max_pdf_mb", 1, 4096) * 1024 * 1024;
    for (const nom of noms) {
      const p = path.join(job, "out", nom.slice(0, nom.lastIndexOf(".")) + o.outExt);
      if (!estFichier(p)) continue;
      if (o.outExt === ".pdf") {
        await checkPdf(p);
        if (statSync(p).size > plafond) throw new ErreurOffice("too_large", 413, "PDF trop volumineux");
      }
      sorties[nom] = readFileSync(p);
    }
    if (Object.keys(sorties).length === 0) throw conversionFailed(job);
    return sorties;
  } finally {
    rmSync(job, { recursive: true, force: true });
  }
}

/** `_schedule_full_pdf` : document entier converti en fond après l'aperçu de tête (une passe par document). */
function scheduleFullPdf(uid: number, userDir: string, cle: string, kind: string, ext: string): void {
  lancer(`${cle}|-1`, async () => {
    try {
      await buildFullPdf(uid, userDir, cle, kind, ext);
    } catch (e) {
      if (e instanceof ErreurOffice)
        log.info(`[office] passe complète abandonnée (${e.code}) clé=${cle.slice(0, 8)}`);
      else log.warn(`[office] passe complète échouée clé=${cle.slice(0, 8)} : ${(e as Error).message}`);
    }
  });
}

async function buildFullPdf(
  uid: number,
  userDir: string,
  cle: string,
  kind: string,
  ext: string,
): Promise<void> {
  const d = keyDir(userDir, cle);
  let m = await readManifest(d);
  const pg = m ? getPy(m, "pages") : null;
  if (!m || !veritePy(pg) || !veritePy(getPy(pg as Dict, "partial"))) return;
  const source = path.join(d, `src${ext}`);
  if (!estFichier(source)) return;
  const soffice = sofficeBin();
  if (!soffice) return;
  const fd = await tryLock(`full-${cle}`);
  if (fd === null) return;
  let job: string | null = null;
  try {
    job = newJobDir(userDir, cle);
    const isolation = await isolationMode();
    const inName = `in${ext}`;
    await copyFile(source, path.join(job, inName));
    const plafond = limit(kind === "xlsx" ? "xlsx_max_pages" : "max_pages");
    const timeoutS = limit("full_timeout_s");
    const outPdf = await convertToPdf({
      uid,
      job,
      kind,
      inName,
      isolation,
      soffice,
      pages: plafond,
      echeance: monotone() + timeoutS,
      timeoutS,
      etiquette: "pages (complet)",
    });
    await checkPdf(outPdf);
    const cap = intCfg("max_pdf_mb", 1, 4096) * 1024 * 1024;
    if (statSync(outPdf).size > cap) {
      log.info("[office] passe complète : PDF trop lourd, on garde la tête");
      return;
    }
    const nombre = await countPdfPages(outPdf);
    renameSync(outPdf, path.join(job, PDF_NAME));
    m = (await readManifest(d)) ?? m;
    const ancien = getPy(m, "pages");
    const r = veritePy(ancien) ? getPy(ancien as Dict, "rev", 0) : 0;
    const rev = intPy(r) + 1;
    m["pages"] = { count: nombre, truncated: nombre >= plafond, partial: false, rev };
    publish(job, d, m, [PDF_NAME]);
    await unlink(source).catch(() => undefined);
    await maybePruneUser(userDir);
  } finally {
    if (job !== null) rmSync(job, { recursive: true, force: true });
    releaseLock(fd);
  }
}

const dernierElagage = new Map<string, number>();
const ELAGAGE_S = 300;

/** `_maybe_prune_user` : élagage du cache du compte, au plus toutes les 5 minutes (sous le verrou de la clé publiée). */
async function maybePruneUser(userDir: string): Promise<void> {
  const t = monotone();
  if (t - (dernierElagage.get(userDir) ?? -Infinity) < ELAGAGE_S) return;
  dernierElagage.set(userDir, t);
  try {
    await pruneUser(
      userCacheDir(userDir),
      limit("cache_user_mb") * 1024 * 1024,
      limit("cache_ttl_days") * 86400,
    );
  } catch (e) {
    log.debug(`[office] élagage utilisateur échoué : ${(e as Error).message}`);
  }
}

/** Tests : l'élagage par compte peut repartir tout de suite. */
export function oublierElagages(): void {
  dernierElagage.clear();
}

function tailleDossier(d: string): number {
  let total = 0;
  let entrees;
  try {
    entrees = readdirSync(d, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entrees) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) total += tailleDossier(p);
    else
      try {
        total += lstatSync(p).size;
      } catch {
        // disparu
      }
  }
  return total;
}

function enfants(d: string): string[] {
  try {
    return readdirSync(d);
  } catch {
    return [];
  }
}

/** `prune_user` : tmp de plus d'une heure, puis dossiers de clé périmés ou au-delà du plafond (jamais une clé en conversion). */
export async function pruneUser(
  dossier: string,
  capOctets: number,
  ttlS: number,
  maintenant = Date.now() / 1000,
): Promise<number> {
  let retires = 0;
  for (const nom of enfants(dossier)) {
    if (!nom.startsWith(".tmp-")) continue;
    try {
      if (maintenant - statSync(path.join(dossier, nom)).mtimeMs / 1000 > 3600) {
        rmSync(path.join(dossier, nom), { recursive: true, force: true });
        retires++;
      }
    } catch {
      // disparu
    }
  }
  const entrees: [number, number, string, string][] = [];
  for (const nom of enfants(dossier)) {
    if (!KEY_RE.test(nom)) continue;
    const p = path.join(dossier, nom);
    let utilise: number;
    try {
      utilise = statSync(path.join(p, MANIFEST)).mtimeMs / 1000;
    } catch {
      try {
        utilise = statSync(p).mtimeMs / 1000;
      } catch {
        continue;
      }
    }
    entrees.push([utilise, tailleDossier(p), p, nom]);
  }
  entrees.sort((a, b) => a[0] - b[0] || a[1] - b[1] || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0));
  let total = entrees.reduce((n, e) => n + e[1], 0);
  for (const [utilise, taille, p, cle] of entrees) {
    if (maintenant - utilise > ttlS || total > capOctets) {
      const fd = await tryLock(`key-${cle}`);
      if (fd === null) continue;
      try {
        rmSync(p, { recursive: true, force: true });
      } finally {
        releaseLock(fd);
      }
      total -= taille;
      retires++;
    }
  }
  return retires;
}
