// SPDX-License-Identifier: MIT
/** apps/core/src/observabilite/fuseau.ts — fuseaux horaires lus dans les fichiers TZif du système, comme `zoneinfo.ZoneInfo` et l'heure locale de la libc. */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export const TZPATH = [
  "/usr/share/zoneinfo",
  "/usr/lib/zoneinfo",
  "/usr/share/lib/zoneinfo",
  "/etc/zoneinfo",
];

interface TypeLocal {
  readonly decalage: number;
  readonly dst: boolean;
  readonly abbr: string;
}

/** Règle POSIX de fin de fichier (`CET-1CEST,M3.5.0,M10.5.0/3`) ou décalage fixe. */
type Regle =
  | { readonly fixe: TypeLocal }
  | {
      readonly glibc: boolean;
      readonly std: TypeLocal;
      readonly dstType: TypeLocal;
      readonly diff: number;
      readonly debut: (annee: number) => number;
      readonly fin: (annee: number) => number;
    };

export interface Instant {
  readonly decalage: number;
  readonly abbr: string;
  readonly fold: 0 | 1;
}

const EPOCH_ORDINAL = 719163;

function bissextile(a: number): boolean {
  return (a % 4 === 0 && a % 100 !== 0) || a % 400 === 0;
}

function joursAvantAnnee(a: number): number {
  const y = a - 1;
  return y * 365 + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) - EPOCH_ORDINAL;
}

/** Année civile (UTC) d'un horodatage « local » exprimé en secondes depuis 1970. */
export function anneeDe(ts: number): number {
  return new Date(Math.floor(ts) * 1000).getUTCFullYear();
}

const JOURS_AVANT_MOIS = [-1, 0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

function heureTransition(texte: string | undefined): number {
  if (texte === undefined) return 2 * 3600;
  const m = /^([+-])?(\d{1,3})(?::(\d{2})(?::(\d{2}))?)?$/u.exec(texte);
  if (!m) throw new Error(`Invalid time: ${texte}`);
  const [h, mi, s] = [Number(m[2]), Number(m[3] ?? 0), Number(m[4] ?? 0)];
  if (h > 167) throw new Error(`Hour must be in [0, 167]: ${texte}`);
  const total = h * 3600 + mi * 60 + s;
  return m[1] === "-" ? -total : total;
}

/** `_parse_dst_start_end` : `Mm.w.d`, `Jn` ou `n`, heure locale facultative (2 h par défaut) ; jours `Jn`/`n` comptés comme zoneinfo ou comme la glibc. */
function dateTransition(texte: string, glibc: boolean): (annee: number) => number {
  const [date = "", heure] = texte.split("/", 2) as [string, string | undefined];
  const secondes = heureTransition(heure);
  if (date.startsWith("M")) {
    const m = /^M(\d{1,2})\.(\d).(\d)$/u.exec(date);
    if (!m) throw new Error(`Invalid dst start/end date: ${texte}`);
    const [mois, semaine, jour] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (mois < 1 || mois > 12 || semaine < 1 || semaine > 5 || jour > 6) throw new Error("rule out of range");
    return (annee) => {
      const premier = new Date(Date.UTC(annee, mois - 1, 1)).getUTCDay();
      const longueur = new Date(Date.UTC(annee, mois, 0)).getUTCDate();
      let jourMois = ((((jour - premier) % 7) + 7) % 7) + 1 + (semaine - 1) * 7;
      if (jourMois > longueur) jourMois -= 7;
      const ordinal =
        joursAvantAnnee(annee) +
        (JOURS_AVANT_MOIS[mois] ?? 0) +
        (mois > 2 && bissextile(annee) ? 1 : 0) +
        jourMois;
      return ordinal * 86400 + secondes;
    };
  }
  const julien = date.startsWith("J");
  const chiffres = julien ? date.slice(1) : date;
  if (!/^[+-]?\d+$/u.test(chiffres)) throw new Error(`Invalid dst start/end date: ${texte}`);
  const n = Number(chiffres);
  if (n < (julien ? 1 : 0) || n > 365) throw new Error(`d out of range: ${texte}`);
  if (glibc)
    return (annee) => {
      const d = julien ? n - 1 + (n >= 60 && bissextile(annee) ? 1 : 0) : n;
      return (joursAvantAnnee(annee) + 1 + d) * 86400 + secondes;
    };
  return (annee) => {
    const d = julien && n >= 59 && bissextile(annee) ? n + 1 : n;
    return (joursAvantAnnee(annee) + d) * 86400 + secondes;
  };
}

function decalagePosix(texte: string): number {
  const m = /^([+-])?(\d{1,3})(?::(\d{2})(?::(\d{2}))?)?$/u.exec(texte);
  if (!m) throw new Error(`invalid offset ${texte}`);
  const [h, mi, s] = [Number(m[2]), Number(m[3] ?? 0), Number(m[4] ?? 0)];
  if (h > 24) throw new Error(`Offset hours must be in [0, 24]: ${texte}`);
  const total = h * 3600 + mi * 60 + s;
  return m[1] === "-" ? total : 0 - total;
}

const MOTIF_POSIX =
  /^([^<0-9:.+-]+|<[a-zA-Z0-9+-]+>)(?:([+-]?\d{1,3}(?::\d{2}(?::\d{2})?)?)(?:([^0-9:.+-]+|<[a-zA-Z0-9+-]+>)([+-]?\d{1,3}(?::\d{2}(?::\d{2})?)?)?)?)?$/u;

/** `_parse_tz_str` : décalages, abréviations et règles de passage à l'heure d'été (variante glibc pour la libc). */
export function analyserRegle(texte: string, glibc = false): Regle {
  const virgule = texte.indexOf(",");
  const partie = virgule < 0 ? texte : texte.slice(0, virgule);
  const regles = virgule < 0 ? null : texte.slice(virgule + 1);
  const m = MOTIF_POSIX.exec(partie);
  if (!m) throw new Error(`${texte} is not a valid TZ string`);
  const stdAbbr = (m[1] ?? "").replace(/^[<>]+|[<>]+$/gu, "");
  const stdOff = m[2] ? decalagePosix(m[2]) : 0;
  if (m[3] === undefined) {
    if (regles !== null) throw new Error(`Transition rule present without DST: ${texte}`);
    return { fixe: { decalage: stdOff, dst: false, abbr: stdAbbr } };
  }
  const dstAbbr = m[3].replace(/^[<>]+|[<>]+$/gu, "");
  const dstOff = m[4] ? decalagePosix(m[4]) : stdOff + 3600;
  if (regles === null) throw new Error(`Missing transition rules: ${texte}`);
  const [a, b] = regles.split(",", 2);
  if (a === undefined || b === undefined) throw new Error(`Invalid TZ string: ${texte}`);
  return {
    glibc,
    std: { decalage: stdOff, dst: false, abbr: stdAbbr },
    dstType: { decalage: dstOff, dst: true, abbr: dstAbbr },
    diff: dstOff - stdOff,
    debut: dateTransition(a, glibc),
    fin: dateTransition(b, glibc),
  };
}

function bornes(r: Exclude<Regle, { fixe: TypeLocal }>, annee: number): [number, number] {
  return [r.debut(annee), r.fin(annee)];
}

function infoRegleLocale(r: Regle, ts: number, annee: number, fold: 0 | 1): TypeLocal {
  if ("fixe" in r) return r.fixe;
  let [debut, fin] = bornes(r, annee);
  if ((fold === 1) === r.diff >= 0) fin -= r.diff;
  else debut += r.diff;
  const ete = debut < fin ? debut <= ts && ts < fin : !(fin <= ts && ts < debut);
  return ete ? r.dstType : r.std;
}

function infoRegleUtc(r: Regle, ts: number, annee: number): [TypeLocal, 0 | 1] {
  if ("fixe" in r) return [r.fixe, 0];
  let [debut, fin] = bornes(r, annee);
  debut -= r.std.decalage;
  fin -= r.dstType.decalage;
  const ete =
    debut < fin || (r.glibc && debut === fin) ? debut <= ts && ts < fin : !(fin <= ts && ts < debut);
  const [aDebut, aFin] = r.diff > 0 ? [fin, fin + r.diff] : [debut, debut - r.diff];
  return [ete ? r.dstType : r.std, aDebut <= ts && ts < aFin ? 1 : 0];
}

function bisectDroite(liste: readonly number[], x: number): number {
  let [lo, hi] = [0, liste.length];
  while (lo < hi) {
    const mi = (lo + hi) >> 1;
    if (x < (liste[mi] as number)) hi = mi;
    else lo = mi + 1;
  }
  return lo;
}

/** Fuseau d'un fichier TZif : `fromutc` (décalage, abréviation, repli) et décalage d'une heure murale. */
export class Zone {
  private readonly transUtc: number[];
  private readonly transLocal: [number[], number[]];
  private readonly types: TypeLocal[];
  private readonly avant: TypeLocal | null;
  private readonly apres: Regle | TypeLocal | null;

  constructor(donnees: Buffer) {
    if (donnees.subarray(0, 4).toString("latin1") !== "TZif")
      throw new Error("Invalid TZif file: magic not found");
    const version = donnees[4] === 0 ? 1 : 2;
    let pos = 0;
    let lu = lireBloc(donnees, pos, 4);
    if (version >= 2) {
      pos = lu.fin;
      lu = lireBloc(donnees, pos, 8);
    }
    const { transitions, indices, infos } = lu;
    this.transUtc = transitions;
    this.types = indices.map((i) => infos[i] as TypeLocal);
    const premierStd = infos.find((t) => !t.dst);
    this.avant = premierStd ?? this.types[0] ?? null;
    let apres: Regle | TypeLocal | null = null;
    if (version >= 2) {
      const pied = donnees.subarray(lu.fin).toString("latin1");
      const regle = pied.split("\n")[1] ?? "";
      if (regle) apres = analyserRegle(regle);
    }
    if (apres === null) apres = this.types[this.types.length - 1] ?? infos[infos.length - 1] ?? null;
    if (apres === null) throw new Error("No time zone information found.");
    this.apres = apres;
    this.transLocal = enHeuresLocales(transitions, indices, infos);
  }

  /** `fromutc` : type en vigueur à l'instant UTC `ts`, `fold` = 1 dans l'heure répétée d'un retour à l'heure d'hiver. */
  versLocal(ts: number): Instant {
    const n = this.transUtc.length;
    let type: TypeLocal | null;
    let fold: 0 | 1 = 0;
    if (n >= 1 && ts < (this.transUtc[0] as number)) {
      type = this.avant;
    } else if (
      (n === 0 || ts > (this.transUtc[n - 1] as number)) &&
      this.apres !== null &&
      "debut" in this.apres
    ) {
      [type, fold] = infoRegleUtc(this.apres, ts, anneeDe(ts));
    } else if (n === 0) {
      type = this.apres !== null && "fixe" in this.apres ? this.apres.fixe : (this.apres as TypeLocal | null);
    } else {
      const idx = bisectDroite(this.transUtc, ts);
      let precedent: TypeLocal | null;
      if (n > 1 && ts >= (this.transUtc[1] as number)) {
        precedent = this.types[idx - 2] ?? null;
        type = this.types[idx - 1] ?? null;
      } else if (ts > (this.transUtc[n - 1] as number)) {
        precedent = this.types[n - 1] ?? null;
        type =
          this.apres !== null && "fixe" in this.apres ? this.apres.fixe : (this.apres as TypeLocal | null);
      } else {
        precedent = this.avant;
        type = this.types[0] ?? null;
      }
      if (precedent && type)
        fold = precedent.decalage - type.decalage > ts - (this.transUtc[idx - 1] as number) ? 1 : 0;
    }
    return { decalage: type?.decalage ?? 0, abbr: type?.abbr ?? "", fold };
  }

  /** `utcoffset` d'une heure murale (secondes « locales » depuis 1970) et de son repli. */
  decalageMural(local: number, fold: 0 | 1 = 0): number {
    const lt = this.transLocal[fold];
    const n = lt.length;
    if (n && local < (lt[0] as number)) return this.avant?.decalage ?? 0;
    if (!n || local > (lt[n - 1] as number)) {
      if (this.apres !== null && "debut" in this.apres)
        return infoRegleLocale(this.apres, local, anneeDe(local), fold).decalage;
      if (this.apres !== null && "fixe" in this.apres) return this.apres.fixe.decalage;
      return (this.apres as TypeLocal | null)?.decalage ?? 0;
    }
    return this.types[bisectDroite(lt, local) - 1]?.decalage ?? 0;
  }
}

function lireBloc(
  d: Buffer,
  debut: number,
  largeur: 4 | 8,
): { transitions: number[]; indices: number[]; infos: TypeLocal[]; fin: number } {
  const compte = (i: number): number => d.readUInt32BE(debut + 20 + 4 * i);
  const [isut, isstd, leap, timecnt, typecnt, charcnt] = [0, 1, 2, 3, 4, 5].map(compte) as number[];
  let pos = debut + 44;
  const transitions: number[] = [];
  for (let i = 0; i < (timecnt as number); i++) {
    transitions.push(largeur === 8 ? Number(d.readBigInt64BE(pos)) : d.readInt32BE(pos));
    pos += largeur;
  }
  const indices: number[] = [];
  for (let i = 0; i < (timecnt as number); i++) indices.push(d[pos++] as number);
  const brutes: [number, boolean, number][] = [];
  for (let i = 0; i < (typecnt as number); i++) {
    brutes.push([d.readInt32BE(pos), d[pos + 4] === 1, d[pos + 5] as number]);
    pos += 6;
  }
  const abbrs = d.subarray(pos, pos + (charcnt as number));
  pos += charcnt as number;
  pos += (leap as number) * (largeur + 4) + (isstd as number) + (isut as number);
  const infos = brutes.map(([decalage, dst, i]) => {
    const fin = abbrs.indexOf(0, i);
    return { decalage, dst, abbr: abbrs.subarray(i, fin < 0 ? undefined : fin).toString("latin1") };
  });
  return { transitions, indices, infos, fin: pos };
}

/** `_ts_to_local` : transitions en heure murale, la plus grande puis la plus petite des deux heures encadrantes. */
function enHeuresLocales(trans: number[], indices: number[], infos: TypeLocal[]): [number[], number[]] {
  if (!trans.length) return [[], []];
  const murales: [number[], number[]] = [[...trans], [...trans]];
  let o0: number;
  let o1: number;
  if (infos.length > 1) {
    o0 = infos[0]?.decalage ?? 0;
    o1 = infos[indices[0] as number]?.decalage ?? 0;
    if (o1 > o0) [o1, o0] = [o0, o1];
  } else {
    o0 = o1 = infos[0]?.decalage ?? 0;
  }
  murales[0][0] = (murales[0][0] as number) + o0;
  murales[1][0] = (murales[1][0] as number) + o1;
  for (let i = 1; i < indices.length; i++) {
    let a = infos[indices[i - 1] as number]?.decalage ?? 0;
    let b = infos[indices[i] as number]?.decalage ?? 0;
    if (b > a) [b, a] = [a, b];
    murales[0][i] = (murales[0][i] as number) + a;
    murales[1][i] = (murales[1][i] as number) + b;
  }
  return murales;
}

/** `_validate_tzfile_path` puis recherche dans TZPATH : `null` si la clé est invalide ou introuvable. */
export function fichierZone(cle: string, chemins: readonly string[] = TZPATH): string | null {
  if (!cle || path.isAbsolute(cle)) return null;
  const normalisee = path.posix.normalize(cle);
  if (normalisee.length !== cle.length || normalisee.startsWith("..")) return null;
  for (const dossier of chemins) {
    const candidat = path.join(dossier, normalisee);
    try {
      if (statSync(candidat).isFile()) return candidat;
    } catch {
      continue;
    }
  }
  return null;
}

/** `ZoneInfo(cle)` : lève si la clé est inconnue ou le fichier invalide. */
export function zoneNommee(cle: string, chemins: readonly string[] = TZPATH): Zone {
  const fichier = fichierZone(cle, chemins);
  if (fichier === null) throw new Error(`No time zone found with key ${cle}`);
  return new Zone(readFileSync(fichier));
}

/** Règle POSIX lue comme `__tzset_parse_tz` : en cas d'échec, le nom standard lisible reste, décalage nul. */
function regleGlibc(nom: string): Regle {
  try {
    return analyserRegle(nom, true);
  } catch {
    const m = /^(?:<([A-Za-z0-9+-]{3,})>|([A-Za-z]{3,}))([+-]?\d{1,2}(?::\d{1,2}(?::\d{1,2})?)?)?/u.exec(nom);
    let decalage = 0;
    try {
      if (m?.[3]) decalage = decalagePosix(m[3]);
    } catch {
      decalage = 0;
    }
    return { fixe: { decalage, dst: false, abbr: m ? (m[1] ?? m[2] ?? "") : "" } };
  }
}

/** Fichier TZif nommé par `TZ` (chemin absolu ou clé de TZPATH) ; `null` s'il manque ou est invalide (lu alors comme une règle POSIX). */
function zoneDuFichier(nom: string): Zone | null {
  try {
    const fichier = path.isAbsolute(nom) ? (existsSync(nom) ? nom : null) : fichierZone(nom);
    return fichier === null ? null : new Zone(readFileSync(fichier));
  } catch {
    return null;
  }
}

/** Fuseau du process comme la glibc : `TZ` (fichier, `:fichier` ou règle POSIX, vide = « Universal »), sinon /etc/localtime, UTC à défaut. */
export function zoneDuProcess(env: NodeJS.ProcessEnv = process.env): Zone | Regle {
  const tz = env["TZ"];
  const utc: Regle = { fixe: { decalage: 0, dst: false, abbr: "UTC" } };
  if (tz === undefined) {
    try {
      return new Zone(readFileSync("/etc/localtime"));
    } catch {
      return utc;
    }
  }
  let nom = tz === "" ? "Universal" : tz;
  if (nom.startsWith(":")) nom = nom.slice(1);
  return zoneDuFichier(nom) ?? (nom === "" ? zoneDuProcess({}) : regleGlibc(nom));
}

/** Décalage et abréviation de l'heure locale du process à l'instant `ts` (`tm_gmtoff`, `tm_zone`). */
export function heureLocale(ts: number, env: NodeJS.ProcessEnv = process.env): Instant {
  const z = zoneDuProcess(env);
  if (z instanceof Zone) return z.versLocal(ts);
  if ("fixe" in z) return { decalage: z.fixe.decalage, abbr: z.fixe.abbr, fold: 0 };
  const [type, fold] = infoRegleUtc(z, ts, anneeDe(ts));
  return { decalage: type.decalage, abbr: type.abbr, fold };
}
