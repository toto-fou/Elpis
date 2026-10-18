// SPDX-License-Identifier: MIT
/** apps/toolhost/src/office/xlsx.ts — classeur .xlsx lu en flux (sandbox/office_xlsx.py) : feuilles, `<dimension>`, chaînes partagées, formats, valeurs « telles qu'affichées ». */
import {
  arrondiEntierPy,
  ErreurPython,
  estChiffresPy,
  fixePy,
  floatPy,
  intPy,
  journalDe,
  lowerPy,
  pyJoin,
  pyParent,
  pyPath,
  reprFlottant,
  stripPy,
} from "@elpis/commun";

import type { ArchiveOffice, FluxMembre } from "./archive";
import { AnalyseurXml, ErreurXml, nomLocal, parcourir } from "./xml";
import type { ElementXml } from "./xml";

export const NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}";
export const NS_REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}";
export const SST_MAX_ITEMS = 2_000_000;
export const SST_MAX_CHARS = 64 * 1024 * 1024;
export const STYLES_MAX_XF = 65_536;
export const HEAD_BYTES = 16 * 1024;
const BLOC_ITERPARSE = 16 * 1024;
const BLOC_PARSE = 64 * 1024;

const DIM_RE = /<dimension[^>]*[ \t\n\r\f\v]ref="([A-Z]+[0-9]+)(?::([A-Z]+)([0-9]+))?"/u;
const XMLNS_RE = /<worksheet[^>]*[ \t\n\r\f\v]xmlns="([^"]+)"/u;
const BUILTIN_DATE = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
const BUILTIN_CODES: ReadonlyMap<number, string> = new Map([
  [0, "General"],
  [1, "0"],
  [2, "0.00"],
  [3, "#,##0"],
  [4, "#,##0.00"],
  [9, "0%"],
  [10, "0.00%"],
  [11, "0.00E+00"],
  [12, "# ?/?"],
  [13, "# ??/??"],
  [14, "mm-dd-yy"],
  [15, "d-mmm-yy"],
  [16, "d-mmm"],
  [17, "mmm-yy"],
  [18, "h:mm AM/PM"],
  [19, "h:mm:ss AM/PM"],
  [20, "h:mm"],
  [21, "h:mm:ss"],
  [22, "m/d/yy h:mm"],
  [37, "#,##0 ;(#,##0)"],
  [38, "#,##0 ;[Red](#,##0)"],
  [39, "#,##0.00;(#,##0.00)"],
  [40, "#,##0.00;[Red](#,##0.00)"],
  [45, "mm:ss"],
  [46, "[h]:mm:ss"],
  [47, "mmss.0"],
  [48, "##0.0E+0"],
  [49, "@"],
]);
const US_JOUR = 86_400_000_000n;
/** Ordinaux (1 = 0001-01-01) des origines 1899-12-30 et 1904-01-01. */
const EPOQUE_1900 = 693_594;
const EPOQUE_1904 = 695_056;
const ORDINAL_1970 = 719_163;
const ORDINAL_MAX = 3_652_059;
const log = journalDe("office");

/** `XlsxError` : classeur illisible (partie absente, entités refusées). */
export class ErreurXlsx extends Error {
  override name = "XlsxError";
}

/** `_Prefixed` : flux « en-tête déjà lu + reste ». */
export class FluxPrefixe {
  private pos = 0;
  readonly tete: Buffer;
  private readonly reste: FluxMembre;

  constructor(tete: Buffer, reste: FluxMembre) {
    this.tete = tete;
    this.reste = reste;
  }

  async lire(n = -1): Promise<Buffer> {
    if (this.pos < this.tete.length) {
      if (n < 0) {
        const out = Buffer.concat([this.tete.subarray(this.pos), await this.reste.lire(-1)]);
        this.pos = this.tete.length;
        return out;
      }
      const debut = this.tete.subarray(this.pos, this.pos + n);
      this.pos += debut.length;
      return debut.length < n ? Buffer.concat([debut, await this.reste.lire(n - debut.length)]) : debut;
    }
    return this.reste.lire(n);
  }

  fermer(): Promise<void> {
    return this.reste.fermer();
  }
}

/** `_safe_open` : partie XML refusée si son en-tête déclare des entités. */
export async function ouvrirSur(zf: ArchiveOffice, nom: string): Promise<FluxPrefixe> {
  const info = zf.info(nom);
  if (info === undefined) throw new ErreurXlsx(`partie absente : ${nom}`);
  const f = zf.ouvrirMembre(info);
  const tete = await f.lire(1024);
  const texte = tete.toString("latin1");
  if (texte.includes("<!DOCTYPE") || texte.includes("<!ENTITY")) {
    await f.fermer();
    throw new ErreurXlsx("entités XML refusées");
  }
  return new FluxPrefixe(tete, f);
}

/** `ET.parse(f).getroot()`. */
async function analyserFlux(f: FluxPrefixe): Promise<ElementXml> {
  const a = new AnalyseurXml();
  for (;;) {
    const bloc = await f.lire(BLOC_PARSE);
    if (!bloc.length) break;
    a.nourrir(bloc);
  }
  return a.terminer();
}

async function racineDe(zf: ArchiveOffice, nom: string): Promise<ElementXml | null> {
  let f: FluxPrefixe;
  try {
    f = await ouvrirSur(zf, nom);
  } catch (e) {
    if (e instanceof ErreurXlsx) return null;
    throw e;
  }
  try {
    return await analyserFlux(f);
  } catch (e) {
    if (e instanceof ErreurXml) return null;
    throw e;
  } finally {
    await f.fermer();
  }
}

/** `str.lstrip(caracteres)` / `str.rstrip(caracteres)` de Python. */
function lstripDe(s: string, c: string): string {
  let i = 0;
  while (i < s.length && c.includes(s.charAt(i))) i++;
  return s.slice(i);
}

function rstripDe(s: string, c: string): string {
  let i = s.length;
  while (i > 0 && c.includes(s.charAt(i - 1))) i--;
  return s.slice(0, i);
}

/** `PurePosixPath(p).name`. */
function nomDe(p: string): string {
  const n = pyPath(p);
  return n === "." || n === "/" || n === "//" ? "" : n.slice(n.lastIndexOf("/") + 1);
}

/** `_rels_map` : `rId` → cible, relative au dossier de la partie. */
async function relsMap(zf: ArchiveOffice, part: string): Promise<Map<string, string>> {
  const base = pyParent(part);
  const rels = lstripDe(`${base}/_rels/${nomDe(part)}.rels`, "./");
  const out = new Map<string, string>();
  const racine = await racineDe(zf, rels);
  if (racine === null) return out;
  for (const rel of parcourir(racine)) {
    if (nomLocal(rel.tag) !== "Relationship") continue;
    const rid = rel.attrib.get("Id");
    const cible = rel.attrib.get("Target");
    if (!rid || !cible) continue;
    out.set(rid, cible.startsWith("/") ? lstripDe(cible, "/") : lstripDe(pyJoin(base, cible), "./"));
  }
  return out;
}

/** `workbook_part` : partie principale du classeur. */
export async function workbookPart(zf: ArchiveOffice): Promise<string> {
  const racine = await racineDe(zf, "_rels/.rels");
  if (racine !== null)
    for (const rel of parcourir(racine))
      if ((rel.attrib.get("Type") ?? "").endsWith("/officeDocument"))
        return lstripDe(rel.attrib.get("Target") ?? "", "/") || "xl/workbook.xml";
  return "xl/workbook.xml";
}

export interface Feuille {
  name: string;
  hidden: boolean;
  member: string;
  date1904: boolean;
}

/** `sheets` : nom, état masqué, partie XML, base de dates, dans l'ordre du classeur. */
export async function sheets(zf: ArchiveOffice): Promise<Feuille[]> {
  const wb = await workbookPart(zf);
  const racine = await racineDe(zf, wb);
  if (racine === null) return [];
  const rels = await relsMap(zf, wb);
  const base = pyParent(wb);
  let date1904 = false;
  const out: Feuille[] = [];
  for (const node of parcourir(racine)) {
    const nom = nomLocal(node.tag);
    if (nom === "workbookPr") {
      date1904 = ["1", "true"].includes(lowerPy(node.attrib.get("date1904") ?? "false"));
      continue;
    }
    if (nom !== "sheet") continue;
    const rid = node.attrib.get(NS_REL + "id") || node.attrib.get("id") || "";
    const member = rels.get(rid) || `${base}/worksheets/sheet${out.length + 1}.xml`;
    out.push({
      name: node.attrib.get("name") ?? "",
      hidden: (node.attrib.get("state") ?? "visible") !== "visible",
      member,
      date1904,
    });
  }
  return out;
}

const COLONNES = new Map<string, number>();

/** `_col_index` : lettres → colonne (0-based). */
export function colIndex(lettres: string): number {
  let n = 0;
  for (const c of lettres.toUpperCase()) {
    if (!(c >= "A" && c <= "Z")) break;
    n = n * 26 + (c.charCodeAt(0) - 64);
  }
  return Math.max(0, n - 1);
}

/** `_col_of` : colonne d'une référence `B7` (préfixe avant le premier chiffre au sens de `isdigit`). */
export function colOf(ref: string): number {
  let lettres = "";
  for (const c of ref) {
    if (estChiffresPy(c)) break;
    lettres += c;
  }
  let col = COLONNES.get(lettres);
  if (col === undefined) {
    col = lettres ? colIndex(lettres) : 0;
    if (COLONNES.size >= 4096) COLONNES.clear();
    COLONNES.set(lettres, col);
  }
  return col;
}

/** `_split_ref` : `"B7"` → (colonne 0-based, ligne 1-based). */
export function splitRef(ref: string): [number, number] {
  const cps = Array.from(ref);
  let i = 0;
  while (i < cps.length && /^\p{L}$/u.test(cps[i] as string)) i++;
  const col = i ? colOf(ref) : 0;
  const reste = cps.slice(i).join("");
  let row = 0;
  if (reste) {
    try {
      row = intPy(reste);
    } catch (e) {
      if (!(e instanceof ErreurPython && e.type === "ValueError")) throw e;
    }
  }
  return [col, row];
}

/** `dimension` : (lignes, colonnes) de `<dimension>`, lu dans les 16 premiers Kio ; `null` sans lui. */
export async function dimension(zf: ArchiveOffice, member: string): Promise<[number, number] | null> {
  let tete: Buffer;
  try {
    const f = await ouvrirSur(zf, member);
    try {
      tete = await f.lire(HEAD_BYTES);
    } finally {
      await f.fermer();
    }
  } catch (e) {
    if (e instanceof ErreurXlsx) return null;
    throw e;
  }
  const m = DIM_RE.exec(tete.toString("latin1"));
  if (!m) return null;
  if (m[2] === undefined) {
    const [col, row] = splitRef(m[1] ?? "");
    return [Math.max(1, row), Math.max(1, col + 1)];
  }
  const rows = Number(m[3]);
  return [Math.max(1, rows), Math.max(1, colIndex(m[2]) + 1)];
}

function compter(data: Buffer, motif: Buffer): number {
  let n = 0;
  for (let i = data.indexOf(motif); i >= 0; i = data.indexOf(motif, i + motif.length)) n++;
  return n;
}

const ROW_ESPACE = Buffer.from("<row ");
const ROW_FERME = Buffer.from("<row>");

/** `count_rows` : lignes comptées par balayage d'octets (blocs de 1 Mio, 5 octets reportés). */
export async function countRows(zf: ArchiveOffice, member: string, maxRows = 1_048_576): Promise<number> {
  let total = 0;
  let reste = Buffer.alloc(0);
  let f: FluxPrefixe;
  try {
    f = await ouvrirSur(zf, member);
  } catch (e) {
    if (e instanceof ErreurXlsx) return 0;
    throw e;
  }
  try {
    for (;;) {
      const bloc = await f.lire(1 << 20);
      if (!bloc.length) break;
      const data = Buffer.concat([reste, bloc]);
      total += compter(data, ROW_ESPACE) + compter(data, ROW_FERME);
      reste = data.subarray(Math.max(0, data.length - 5));
      if (total > maxRows) return maxRows;
    }
  } finally {
    await f.fermer();
  }
  return total;
}

/** Itère les éléments terminés d'une partie (`ET.iterparse`, blocs de 16 Kio) ; `garder(el)` : vrai pour le rendre (puis il est oublié). */
async function* iterparse(f: FluxPrefixe, garder: (el: ElementXml) => boolean): AsyncGenerator<ElementXml> {
  const file: ElementXml[] = [];
  const a = new AnalyseurXml((el) => {
    if (!garder(el)) return false;
    file.push(el);
    return true;
  });
  for (;;) {
    const bloc = await f.lire(BLOC_ITERPARSE);
    let erreur: unknown = null;
    try {
      if (bloc.length) a.nourrir(bloc);
      else a.terminer();
    } catch (e) {
      erreur = e;
    }
    while (file.length) yield file.shift() as ElementXml;
    if (erreur !== null) throw erreur;
    if (!bloc.length) return;
  }
}

function longueurPoints(s: string): number {
  let n = 0;
  for (const c of s) n += c ? 1 : 0;
  return n;
}

/** `shared_strings` : table des chaînes partagées, lue en flux et bornée. */
export async function sharedStrings(zf: ArchiveOffice): Promise<string[]> {
  const out: string[] = [];
  let total = 0;
  let f: FluxPrefixe;
  try {
    f = await ouvrirSur(zf, "xl/sharedStrings.xml");
  } catch (e) {
    if (e instanceof ErreurXlsx) return out;
    throw e;
  }
  try {
    for await (const el of iterparse(f, (e) => nomLocal(e.tag) === "si")) {
      let txt = "";
      for (const t of parcourir(el)) if (nomLocal(t.tag) === "t") txt += t.text ?? "";
      out.push(txt);
      total += longueurPoints(txt);
      if (out.length >= SST_MAX_ITEMS || total >= SST_MAX_CHARS) {
        log.warn(`[office] chaînes partagées tronquées (${out.length} entrées)`);
        break;
      }
    }
  } catch (e) {
    if (!(e instanceof ErreurXml)) throw e;
  } finally {
    await f.fermer();
  }
  return out;
}

/** `number_formats` : code de format de chaque style (`s` d'une cellule → code). */
export async function numberFormats(zf: ArchiveOffice): Promise<string[]> {
  const codes: string[] = [];
  const racine = await racineDe(zf, "xl/styles.xml");
  if (racine === null) return codes;
  const custom = new Map<number, string>();
  for (const fmt of parcourir(racine)) {
    if (nomLocal(fmt.tag) !== "numFmt") continue;
    try {
      custom.set(intPy(fmt.attrib.get("numFmtId") ?? "-1"), fmt.attrib.get("formatCode") ?? "");
    } catch (e) {
      if (!(e instanceof ErreurPython)) throw e;
    }
  }
  for (const xfs of parcourir(racine)) {
    if (nomLocal(xfs.tag) !== "cellXfs") continue;
    for (const xf of xfs.children) {
      if (nomLocal(xf.tag) !== "xf") continue;
      let fid: number;
      try {
        fid = intPy(xf.attrib.get("numFmtId") ?? "0");
      } catch (e) {
        if (!(e instanceof ErreurPython)) throw e;
        fid = 0;
      }
      codes.push(custom.get(fid) ?? BUILTIN_CODES.get(fid) ?? "General");
      if (codes.length >= STYLES_MAX_XF) break;
    }
    break;
  }
  return codes;
}

/** `_strip_sections` : première section du code, couleurs et conditions retirées. */
export function stripSections(code: string): string {
  let profondeur = 0;
  let out = "";
  for (const c of code) {
    if (c === '"') profondeur ^= 1;
    if (c === ";" && !profondeur) break;
    out += c;
  }
  return out.replace(/\[(?!h\]|hh\]|mm\]|ss\])[^\]]*\]/gu, "");
}

const RETIRE_LITTERAUX = /"[^"]*"|\\[^\n]/gu;

/** `_jour_et_horloge` : (un jour ?, une horloge ?) d'un code en minuscules ; `m` après une heure ou avant des secondes = minutes. */
export function jourEtHorloge(low: string): [boolean, boolean] {
  const net = low.replace(RETIRE_LITTERAUX, "");
  let jour = /[yd]/u.test(net);
  let horloge = net.includes("h") || net.includes("s");
  for (const m of net.matchAll(/m+/gu)) {
    const avant = rstripDe(net.slice(0, m.index), " :.-/");
    const apres = lstripDe(net.slice(m.index + m[0].length), " :.-/");
    if (avant.endsWith("h") || avant.endsWith("[h]") || apres.startsWith("s")) horloge = true;
    else jour = true;
  }
  return [jour, horloge];
}

/** `is_date_format`. */
export function isDateFormat(code: string, builtinId: number | null = null): boolean {
  if (builtinId !== null && BUILTIN_DATE.has(builtinId)) return true;
  const corps = stripSections(code || "")
    .replace(/"[^"]*"/gu, "")
    .replace(/\\[^\n]/gu, "");
  return /[ymdhsYMDHSſ]/u.test(corps) && !corps.includes("General");
}

/** `Format` : format d'affichage analysé une fois par style. */
export class Format {
  readonly code: string;
  readonly general: boolean;
  readonly isDate: boolean;
  readonly elapsed: boolean;
  readonly percent: boolean;
  readonly decimals: number;
  readonly thousands: boolean;
  readonly hasDay: boolean;
  readonly hasClock: boolean;

  constructor(code: string) {
    this.code = code || "General";
    const corps = stripPy(stripSections(this.code));
    const low = lowerPy(corps);
    this.general = !corps || corps === "General" || corps === "@";
    this.isDate = isDateFormat(this.code);
    this.elapsed = low.includes("[h]");
    this.percent = corps.includes("%");
    const d = /\.([0#?]+)/u.exec(corps);
    this.decimals = d ? (d[1] ?? "").length : 0;
    this.thousands = (corps.replace(/"[^"]*"/gu, "").split(".")[0] ?? "").includes(",");
    [this.hasDay, this.hasClock] = jourEtHorloge(low);
  }
}

export const GENERAL = new Format("General");

/** `compile_formats` : un `Format` par code distinct. */
export function compileFormats(codes: readonly string[]): Format[] {
  const cache = new Map<string, Format>();
  return codes.map((c) => {
    let f = cache.get(c);
    if (f === undefined) cache.set(c, (f = new Format(c)));
    return f;
  });
}

/** `int(x)` exact d'un flottant fini (sinon ValueError / OverflowError). */
function entierExact(x: number): bigint {
  if (Number.isNaN(x)) throw new ErreurPython("ValueError", "cannot convert float NaN to integer");
  if (!Number.isFinite(x))
    throw new ErreurPython("OverflowError", "cannot convert float infinity to integer");
  return BigInt(Math.trunc(x));
}

/** `f"{n:02d}"`. */
function deux(n: bigint): string {
  return n < 0n ? `-${(-n).toString()}` : n.toString().padStart(2, "0");
}

/** `_fmt_number`. */
export function fmtNumber(valeur: number, fmt: Format): string {
  if (fmt.general) {
    const e = entierExact(valeur);
    if (Number(e) === valeur && Math.abs(valeur) < 1e15) return e.toString();
    const texte = reprFlottant(valeur);
    return texte.includes(".") && !texte.includes("e") ? rstripDe(rstripDe(texte, "0"), ".") : texte;
  }
  let v = valeur;
  if (fmt.percent) v *= 100.0;
  let s = fixePy(v, fmt.decimals);
  if (fmt.thousands && Number.isFinite(v)) {
    const signe = s.startsWith("-") ? "-" : "";
    const corps = signe ? s.slice(1) : s;
    const point = corps.indexOf(".");
    const entier = point < 0 ? corps : corps.slice(0, point);
    const groupe = entier.replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
    s = signe + groupe + (point < 0 ? "" : corps.slice(point));
  }
  return fmt.percent ? s + "%" : s;
}

function modf(x: number): [number, number] {
  const entier = Math.trunc(x);
  return [x - entier, entier];
}

/** Microsecondes de `timedelta(days=x)` (C : partie entière exacte, fraction en double, reste arrondi au pair). */
export function microsDeJours(jours: number): bigint {
  if (Number.isNaN(jours)) throw new ErreurPython("ValueError", "cannot convert float NaN to integer");
  const [frac, ent] = modf(jours);
  let x = entierExact(ent) * US_JOUR;
  if (frac !== 0) {
    const [frac2, ent2] = modf(86_400_000_000 * frac);
    x += entierExact(ent2);
    if (frac2) {
      let entier = Math.sign(frac2) * Math.round(Math.abs(frac2));
      if (Math.abs(entier - frac2) === 0.5) {
        const impair = ((x % 2n) + 2n) % 2n === 1n ? 1 : 0;
        const y = (frac2 + impair) * 0.5;
        entier = 2.0 * (Math.sign(y) * Math.round(Math.abs(y))) - impair;
      }
      x += BigInt(entier);
    }
  }
  const j = x >= 0n ? x / US_JOUR : -((-x + US_JOUR - 1n) / US_JOUR);
  if (j > 999_999_999n || j < -999_999_999n)
    throw new ErreurPython("OverflowError", "days must have magnitude <= 999999999");
  return x;
}

/** `_fmt_date`. */
export function fmtDate(serial: number, fmt: Format, date1904: boolean): string {
  if (fmt.elapsed) {
    const total = serial * 24.0;
    const h = entierExact(total);
    const reste = (total - Number(h)) * 60.0;
    const r = entierExact(reste);
    const sec = BigInt(arrondiEntierPy((reste - Number(r)) * 60));
    return `${h.toString()}:${deux(r)}:${deux(sec)}`;
  }
  let us: bigint;
  try {
    us = microsDeJours(serial);
  } catch (e) {
    if (e instanceof ErreurPython && (e.type === "OverflowError" || e.type === "ValueError"))
      return fmtNumber(serial, GENERAL);
    throw e;
  }
  const jourUs = us >= 0n ? us / US_JOUR : -((-us + US_JOUR - 1n) / US_JOUR);
  const ordinal = (date1904 ? EPOQUE_1904 : EPOQUE_1900) + Number(jourUs);
  if (ordinal < 1 || ordinal > ORDINAL_MAX) return fmtNumber(serial, GENERAL);
  const secondes = Number((us - jourUs * US_JOUR) / 1_000_000n);
  const d = new Date((ordinal - ORDINAL_1970) * 86_400_000 + secondes * 1000);
  const p2 = (n: number): string => String(n).padStart(2, "0");
  const dateTexte = `${String(d.getUTCFullYear()).padStart(4, "0")}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
  const heure = `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
  if (fmt.hasDay && fmt.hasClock) return `${dateTexte} ${heure}`;
  if (fmt.hasClock) return heure;
  return dateTexte;
}

/** `format_value` : valeur affichée d'une cellule d'après sa valeur brute, son type et son format. */
export function formatValue(
  raw: string | null,
  typeCellule: string | null,
  fmt: Format | string,
  date1904 = false,
): string {
  if (raw === null) return "";
  if (typeCellule === "s" || typeCellule === "str" || typeCellule === "inlineStr") return raw;
  if (typeCellule === "b") return ["0", "", "false", "FALSE"].includes(raw) ? "FAUX" : "VRAI";
  if (typeCellule === "e") return raw;
  let valeur: number;
  try {
    valeur = floatPy(raw);
  } catch (e) {
    if (e instanceof ErreurPython && (e.type === "ValueError" || e.type === "TypeError")) return raw;
    throw e;
  }
  const f = typeof fmt === "string" ? new Format(fmt) : fmt;
  return f.isDate ? fmtDate(valeur, f, date1904) : fmtNumber(valeur, f);
}

/** `_espace_du_flux` : espace de noms de la feuille, lu dans son en-tête. */
export function espaceDuFlux(tete: Buffer): string {
  const m = XMLNS_RE.exec(tete.toString("latin1"));
  return m ? `{${Buffer.from(m[1] ?? "", "latin1").toString("utf8")}}` : "";
}

export interface OptionsLignes {
  readonly maxCols: number;
  readonly cellChars: number;
  readonly stopRow?: number;
}

/** Tronque `txt` à `n` points de code (`txt[:n] + "…"`) ; `null` s'il tient. */
function tronquer(txt: string, n: number): string | null {
  if (txt.length <= n) return null;
  const cps = Array.from(txt);
  return cps.length > n ? cps.slice(0, n).join("") + "…" : null;
}

/** `iter_rows` : (numéro de ligne du document, cellules, tronquée) dans l'ordre ; une erreur XML arrête la lecture. */
export async function* iterRows(
  zf: ArchiveOffice,
  sheet: { member: string; date1904?: boolean },
  sst: readonly string[],
  formats: readonly Format[],
  o: OptionsLignes,
): AsyncGenerator<[number, string[], boolean]> {
  const date1904 = Boolean(sheet.date1904);
  let f: FluxPrefixe;
  try {
    f = await ouvrirSur(zf, sheet.member);
  } catch (e) {
    if (e instanceof ErreurXlsx) return;
    throw e;
  }
  const ns = espaceDuFlux(f.tete);
  const [tagRow, tagC, tagV, tagT] = [ns + "row", ns + "c", ns + "v", ns + "t"];
  try {
    for await (const el of iterparse(f, (e) => e.tag === tagRow)) {
      let r = 0;
      try {
        r = intPy(el.attrib.get("r") || 0);
      } catch (e) {
        if (!(e instanceof ErreurPython)) throw e;
      }
      const cells: string[] = [];
      let tronquee = false;
      for (const c of el.children) {
        if (c.tag !== tagC) continue;
        const ref = c.attrib.get("r");
        const idx = ref ? colOf(ref) : cells.length;
        if (idx >= o.maxCols) {
          tronquee = true;
          continue;
        }
        const t = c.attrib.get("t") ?? null;
        let txt: string;
        if (t === "inlineStr") {
          txt = "";
          for (const x of parcourir(c, tagT)) txt += x.text ?? "";
        } else {
          let raw: string | null = null;
          for (const enfant of c.children)
            if (enfant.tag === tagV) {
              raw = enfant.text;
              break;
            }
          if (t === "s") {
            let j: number;
            try {
              j = intPy(raw || 0);
            } catch (e) {
              if (!(e instanceof ErreurPython)) throw e;
              j = -1;
            }
            txt = j >= 0 && j < sst.length ? (sst[j] as string) : "";
          } else {
            const si = c.attrib.get("s");
            let fmt: Format;
            if (si === undefined) fmt = formats[0] ?? GENERAL;
            else {
              let k: number;
              try {
                k = intPy(si);
              } catch (e) {
                if (!(e instanceof ErreurPython)) throw e;
                k = 0;
              }
              fmt = k >= 0 && k < formats.length ? (formats[k] as Format) : GENERAL;
            }
            txt = formatValue(raw, t, fmt, date1904);
          }
        }
        const court = tronquer(txt, o.cellChars);
        if (court !== null) {
          txt = court;
          tronquee = true;
        }
        while (cells.length < idx) cells.push("");
        cells.push(txt);
      }
      while (cells.length && cells[cells.length - 1] === "") cells.pop();
      yield [r, cells, tronquee];
      if (o.stopRow !== undefined && r >= o.stopRow) return;
    }
  } catch (e) {
    if (!(e instanceof ErreurXml)) throw e;
    log.warn(`[office] feuille ${sheet.member} illisible (XML)`);
  } finally {
    await f.fermer();
  }
}
