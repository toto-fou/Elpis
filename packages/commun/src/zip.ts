// SPDX-License-Identifier: MIT
/** packages/commun/src/zip.ts — archives .zip comme zipfile de Python 3.13 : lecture (répertoire central, zip64, noms cp437 ou UTF-8, CRC) et écriture deflate. */
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

import { ErreurPython, reprPy } from "./python";

/** Octets 0x80 à 0xFF du codec cp437 de Python (0x00 à 0x7F = ASCII). */
const CP437_HAUT =
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»" +
  "░▒▓│┤╡╢╖╕╣║╗╝╜╛┐" +
  "└┴┬├─┼╞╟╚╔╩╦╠═╬╧" +
  "╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀" +
  "αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0";
const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_FIN = 0x06054b50;
const SIG_FIN64 = 0x06064b50;
const SIG_LOCALISATEUR64 = 0x07064b50;
const OCTETS_SIG_FIN = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const UTF8_STRICT = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const VERSION_MAX_EXTRACTION = 63;
export const NOMS_COMPRESSION: Readonly<Record<number, string>> = {
  1: "shrink",
  2: "reduce",
  3: "reduce",
  4: "reduce",
  5: "reduce",
  6: "implode",
  7: "tokenize",
  9: "deflate64",
  10: "implode",
  18: "terse",
  19: "lz77",
  97: "wavpack",
  98: "ppmd",
};

export type TypeErreurZip =
  "BadZipFile" | "NotImplementedError" | "RuntimeError" | "UnicodeDecodeError" | "EOFError" | "KeyError";

/** Exception de zipfile ; `type` = classe Python. */
export class ErreurZip extends Error {
  readonly type: TypeErreurZip;

  constructor(type: TypeErreurZip, message: string) {
    super(message);
    this.name = type;
    this.type = type;
  }
}

export type DateHeureZip = [number, number, number, number, number, number];

/** `ZipInfo` lu du répertoire central. */
export interface MembreZip {
  /** `filename` : coupé au premier NUL, ou nom Unicode de l'extra 0x7075. */
  nom: string;
  /** `orig_filename`, comparé au nom de l'en-tête local. */
  nomOrigine: string;
  versionCreation: number;
  systemeCreation: number;
  versionExtraction: number;
  drapeaux: number;
  methode: number;
  dateHeure: DateHeureZip;
  crc: number;
  tailleCompressee: number;
  taille: number;
  attributsExternes: number;
  decalage: number;
  finDecalage: number;
}

export function decoderNom(octets: Uint8Array, utf8: boolean): string {
  if (!utf8) {
    let s = "";
    for (const o of octets) s += o < 0x80 ? String.fromCharCode(o) : CP437_HAUT.charAt(o - 0x80);
    return s;
  }
  try {
    return UTF8_STRICT.decode(octets);
  } catch {
    throw new ErreurZip("UnicodeDecodeError", "'utf-8' codec can't decode the file name");
  }
}

export function assainir(nom: string): string {
  const i = nom.indexOf("\0");
  return i >= 0 ? nom.slice(0, i) : nom;
}

/** `_EndRecData` : enregistrement de fin (sans ou avec commentaire), complété par celui de zip64. */
export function finArchive(
  o: Buffer,
): { taille: number; decalage: number; position: number; zip64: boolean } | null {
  const n = o.length;
  if (n < 22) return null;
  let position: number;
  if (o.readUInt32LE(n - 22) === SIG_FIN && o.readUInt16LE(n - 2) === 0) position = n - 22;
  else {
    position = o.lastIndexOf(OCTETS_SIG_FIN);
    if (position < Math.max(n - 65535 - 22, 0) || position + 22 > n) return null;
  }
  const fin = {
    taille: o.readUInt32LE(position + 12),
    decalage: o.readUInt32LE(position + 16),
    position,
    zip64: false,
  };
  const localisateur = position - 20;
  if (localisateur < 0 || o.readUInt32LE(localisateur) !== SIG_LOCALISATEUR64) return fin;
  if (o.readUInt32LE(localisateur + 4) !== 0 || o.readUInt32LE(localisateur + 16) > 1)
    throw new ErreurZip("BadZipFile", "zipfiles that span multiple disks are not supported");
  const r = localisateur - 56;
  if (r < 0 || o.readUInt32LE(r) !== SIG_FIN64) return fin;
  return {
    taille: Number(o.readBigUInt64LE(r + 40)),
    decalage: Number(o.readBigUInt64LE(r + 48)),
    position,
    zip64: true,
  };
}

/** `_decodeExtra` : tailles et décalage zip64, nom Unicode (0x7075) au CRC du nom brut. */
export function decoderExtra(m: MembreZip, extra: Buffer, crcNom: number): void {
  let reste = extra;
  while (reste.length >= 4) {
    const type = reste.readUInt16LE(0);
    const longueur = reste.readUInt16LE(2);
    if (longueur + 4 > reste.length)
      throw new ErreurZip(
        "BadZipFile",
        `Corrupt extra field ${type.toString(16).padStart(4, "0")} (size=${longueur})`,
      );
    let d = reste.subarray(4, longueur + 4);
    if (type === 0x0001) {
      const lire8 = (champ: string): number => {
        if (d.length < 8) throw new ErreurZip("BadZipFile", `Corrupt zip64 extra field. ${champ} not found.`);
        const v = Number(d.readBigUInt64LE(0));
        d = d.subarray(8);
        return v;
      };
      if (m.taille === 0xffffffff) m.taille = lire8("File size");
      if (m.tailleCompressee === 0xffffffff) m.tailleCompressee = lire8("Compress size");
      if (m.decalage === 0xffffffff) m.decalage = lire8("Header offset");
    } else if (type === 0x7075) {
      if (d.length < 5) throw new ErreurZip("BadZipFile", "Corrupt unicode path extra field (0x7075)");
      if (d[0] === 1 && d.readUInt32LE(1) === crcNom) {
        let nom: string;
        try {
          nom = UTF8_STRICT.decode(d.subarray(5));
        } catch {
          throw new ErreurZip("BadZipFile", "Corrupt unicode path extra field (0x7075): invalid utf-8 bytes");
        }
        if (nom) m.nom = assainir(nom);
      }
    }
    reste = reste.subarray(longueur + 4);
  }
}

/** Membres du répertoire central (`_RealGetContents`) ; décalages corrigés d'un préfixe concaténé à l'archive. */
export function membresDuRepertoire(donnees: Buffer, taille: number, concat: number): MembreZip[] {
  const membres: MembreZip[] = [];
  for (let c = 0, total = 0; total < taille;) {
    if (c + 46 > donnees.length) throw new ErreurZip("BadZipFile", "Truncated central directory");
    if (donnees.readUInt32LE(c) !== SIG_CENTRAL)
      throw new ErreurZip("BadZipFile", "Bad magic number for central directory");
    const [ln, lx, lc] = [
      donnees.readUInt16LE(c + 28),
      donnees.readUInt16LE(c + 30),
      donnees.readUInt16LE(c + 32),
    ];
    const brut = donnees.subarray(c + 46, c + 46 + ln);
    const drapeaux = donnees.readUInt16LE(c + 8);
    const nom = decoderNom(brut, (drapeaux & 0x800) !== 0);
    const [t, d] = [donnees.readUInt16LE(c + 12), donnees.readUInt16LE(c + 14)];
    const m: MembreZip = {
      nom: assainir(nom),
      nomOrigine: nom,
      versionCreation: donnees[c + 4] ?? 0,
      systemeCreation: donnees[c + 5] ?? 0,
      versionExtraction: donnees[c + 6] ?? 0,
      drapeaux,
      methode: donnees.readUInt16LE(c + 10),
      dateHeure: [(d >> 9) + 1980, (d >> 5) & 0xf, d & 0x1f, t >> 11, (t >> 5) & 0x3f, (t & 0x1f) * 2],
      crc: donnees.readUInt32LE(c + 16),
      tailleCompressee: donnees.readUInt32LE(c + 20),
      taille: donnees.readUInt32LE(c + 24),
      attributsExternes: donnees.readUInt32LE(c + 38),
      decalage: donnees.readUInt32LE(c + 42),
      finDecalage: 0,
    };
    if (m.versionExtraction > VERSION_MAX_EXTRACTION)
      throw new ErreurZip("NotImplementedError", `zip file version ${(m.versionExtraction / 10).toFixed(1)}`);
    decoderExtra(m, donnees.subarray(c + 46 + ln, c + 46 + ln + lx), crc32(brut) >>> 0);
    m.decalage += concat;
    membres.push(m);
    c += 46 + ln + lx + lc;
    total += 46 + ln + lx + lc;
  }
  return membres;
}

/** `zipfile.ZipFile(BytesIO(octets))` en lecture. */
export class ArchiveZip {
  readonly membres: MembreZip[] = [];
  private readonly octets: Buffer;

  constructor(octets: Uint8Array) {
    const o = Buffer.from(octets.buffer, octets.byteOffset, octets.byteLength);
    this.octets = o;
    const fin = finArchive(o);
    if (fin === null) throw new ErreurZip("BadZipFile", "File is not a zip file");
    let concat = fin.position - fin.taille - fin.decalage;
    if (fin.zip64) concat -= 56 + 20;
    const debut = fin.decalage + concat;
    if (debut < 0) throw new ErreurZip("BadZipFile", "Bad offset for central directory");
    for (const m of membresDuRepertoire(o.subarray(debut, debut + fin.taille), fin.taille, concat))
      this.membres.push(m);
    let finDecalage = debut;
    for (const m of this.membres.toSorted((a, b) => a.decalage - b.decalage).reverse()) {
      m.finDecalage = finDecalage;
      finDecalage = m.decalage;
    }
  }

  /** `ZipFile.read(info)` : en-tête local vérifié, données décompressées, CRC contrôlé. */
  lire(m: MembreZip): Buffer {
    const o = this.octets;
    const h = m.decalage;
    if (h < 0 || h + 30 > o.length) throw new ErreurZip("BadZipFile", "Truncated file header");
    if (o.readUInt32LE(h) !== SIG_LOCAL)
      throw new ErreurZip("BadZipFile", "Bad magic number for file header");
    const [ln, lx] = [o.readUInt16LE(h + 26), o.readUInt16LE(h + 28)];
    const brut = o.subarray(h + 30, h + 30 + ln);
    if (m.drapeaux & 0x20) throw new ErreurZip("NotImplementedError", "compressed patched data (flag bit 5)");
    if (m.drapeaux & 0x40) throw new ErreurZip("NotImplementedError", "strong encryption (flag bit 6)");
    if (decoderNom(brut, (o.readUInt16LE(h + 6) & 0x800) !== 0) !== m.nomOrigine)
      throw new ErreurZip("BadZipFile", `File name in directory ${reprPy(m.nomOrigine)} and header differ.`);
    const position = h + 30 + ln + lx;
    if (position + m.tailleCompressee > m.finDecalage && m.finDecalage !== m.decalage)
      throw new ErreurZip("BadZipFile", `Overlapped entries: ${reprPy(m.nomOrigine)} (possible zip bomb)`);
    if (m.drapeaux & 0x1)
      throw new ErreurZip(
        "RuntimeError",
        `File ${reprPy(m.nom)} is encrypted, password required for extraction`,
      );
    if (m.methode !== 0 && m.methode !== 8) {
      if (m.methode === 12 || m.methode === 14)
        throw new ErreurZip(
          "NotImplementedError",
          `compression type ${m.methode} not supported by this port`,
        );
      const libelle = NOMS_COMPRESSION[m.methode];
      throw new ErreurZip(
        "NotImplementedError",
        libelle === undefined
          ? "That compression method is not supported"
          : `compression type ${m.methode} (${libelle})`,
      );
    }
    const compresse = o.subarray(position, position + m.tailleCompressee);
    if (compresse.length < m.tailleCompressee) throw new ErreurZip("EOFError", "");
    let donnees: Buffer;
    if (m.methode === 0) donnees = compresse.subarray(0, m.taille);
    else {
      try {
        donnees = inflateRawSync(compresse, { maxOutputLength: Math.max(1, m.taille) }).subarray(0, m.taille);
      } catch (e) {
        throw new ErreurZip("BadZipFile", `Bad CRC-32 for file ${reprPy(m.nom)} (${(e as Error).message})`);
      }
    }
    if (crc32(donnees) >>> 0 !== m.crc)
      throw new ErreurZip("BadZipFile", `Bad CRC-32 for file ${reprPy(m.nom)}`);
    return Buffer.from(donnees);
  }
}

/** Date locale d'un mtime en millisecondes, comme `time.localtime(st_mtime)[:6]`. */
export function dateHeureLocale(mtimeMs: number): DateHeureZip {
  const d = new Date(Math.floor(mtimeMs / 1000) * 1000);
  return [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()];
}

/** Fichier à écrire : nom, contenu, date, attributs (`st_mode << 16` ou `0o600 << 16`), `stocke` pour `ZIP_STORED`, `compresse` si déjà calculé. */
export interface EntreeZipEcrite {
  nom: string;
  donnees: Uint8Array;
  dateHeure: DateHeureZip;
  attributsExternes: number;
  stocke?: boolean;
  compresse?: Uint8Array;
}

/** `ZipFile(BytesIO(), "w", ZIP_DEFLATED)` : en-têtes de Python (version 20, système Unix, UTF-8 si non ASCII). */
export function ecrireZip(entrees: readonly EntreeZipEcrite[]): Buffer {
  const morceaux: Buffer[] = [];
  const central: Buffer[] = [];
  let decalage = 0;
  for (const e of entrees) {
    const [an, mois, jour, heure, minute, seconde] = e.dateHeure;
    if (an < 1980) throw new ErreurPython("ValueError", "ZIP does not support timestamps before 1980");
    const nom = Buffer.from(e.nom, "utf8");
    const drapeaux = /^\p{ASCII}*$/u.test(e.nom) ? 0 : 0x800;
    const methode = e.stocke ? 0 : 8;
    const compresse = Buffer.from(e.stocke ? e.donnees : (e.compresse ?? deflateRawSync(e.donnees)));
    const crc = crc32(e.donnees) >>> 0;
    const dosDate = ((an - 1980) << 9) | (mois << 5) | jour;
    const dosHeure = (heure << 11) | (minute << 5) | Math.floor(seconde / 2);
    if (compresse.length > 0xffffffff || e.donnees.length > 0xffffffff || decalage > 0xffffffff)
      throw new ErreurZip("NotImplementedError", "zip64 not supported by this port");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt8(20, 4);
    local.writeUInt16LE(drapeaux, 6);
    local.writeUInt16LE(methode, 8);
    local.writeUInt16LE(dosHeure, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compresse.length, 18);
    local.writeUInt32LE(e.donnees.length, 22);
    local.writeUInt16LE(nom.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(SIG_CENTRAL, 0);
    c.writeUInt8(20, 4);
    c.writeUInt8(3, 5);
    c.writeUInt8(20, 6);
    c.writeUInt16LE(drapeaux, 8);
    c.writeUInt16LE(methode, 10);
    c.writeUInt16LE(dosHeure, 12);
    c.writeUInt16LE(dosDate, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(compresse.length, 20);
    c.writeUInt32LE(e.donnees.length, 24);
    c.writeUInt16LE(nom.length, 28);
    c.writeUInt32LE(e.attributsExternes >>> 0, 38);
    c.writeUInt32LE(decalage, 42);
    morceaux.push(local, nom, compresse);
    central.push(c, nom);
    decalage += 30 + nom.length + compresse.length;
  }
  const repertoire = Buffer.concat(central);
  if (entrees.length > 0xffff || decalage > 0xffffffff)
    throw new ErreurZip("NotImplementedError", "zip64 not supported by this port");
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(SIG_FIN, 0);
  fin.writeUInt16LE(entrees.length, 8);
  fin.writeUInt16LE(entrees.length, 10);
  fin.writeUInt32LE(repertoire.length, 12);
  fin.writeUInt32LE(decalage, 16);
  return Buffer.concat([...morceaux, repertoire, fin]);
}
