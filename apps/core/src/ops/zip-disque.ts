// SPDX-License-Identifier: MIT
/** apps/core/src/ops/zip-disque.ts — archives .zip sur disque comme zipfile de Python 3.13 : écriture en flux (deflate, zip64, en-tête local réécrit) et lecture membre par membre. */
import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { crc32, createDeflateRaw, inflateRawSync } from "node:zlib";

import {
  decoderNom,
  ErreurPython,
  ErreurZip,
  finArchive,
  membresDuRepertoire,
  NOMS_COMPRESSION,
  reprPy,
} from "@elpis/commun";
import type { DateHeureZip, MembreZip } from "@elpis/commun";

export const ZIP64_LIMIT = 2 ** 31 - 1;
export const ZIP_FILECOUNT_LIMIT = 2 ** 16 - 1;
const ZIP64_VERSION = 45;
const DEFAULT_VERSION = 20;
const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_FIN = 0x06054b50;
const SIG_FIN64 = 0x06064b50;
const SIG_LOCALISATEUR64 = 0x07064b50;
const QUEUE_MAX = 65535 + 22 + 20 + 56;

/** `ZipInfo` à écrire : nom (coupé au premier NUL), date bornée par l'appelant, attributs (`st_mode << 16`), commentaire. */
export interface InfoZip {
  nom: string;
  dateHeure: DateHeureZip;
  attributsExternes?: number;
  /** `force_zip64` (`zf.open(…, force_zip64=…)`) ; sinon zip64 dès que la taille annoncée × 1,05 dépasse la limite. */
  forceZip64?: boolean;
  tailleAnnoncee?: number;
}

interface Ecrit {
  /** `ZipInfo.extract_version` relevé par `FileHeader(zip64)` : 45 dès que l'en-tête local est en zip64. */
  version: number;
  nom: Buffer;
  drapeaux: number;
  dosHeure: number;
  dosDate: number;
  crc: number;
  tailleCompressee: number;
  taille: number;
  decalage: number;
  attributsExternes: number;
  commentaire: Buffer;
}

function dos(d: DateHeureZip): [number, number] {
  const [an, mois, jour, heure, minute, seconde] = d;
  if (an < 1980) throw new ErreurPython("ValueError", "ZIP does not support timestamps before 1980");
  if (an > 2107) throw new Error("'H' format requires 0 <= number <= 65535");
  return [(heure << 11) | (minute << 5) | Math.floor(seconde / 2), ((an - 1980) << 9) | (mois << 5) | jour];
}

/** `ZipInfo.FileHeader(zip64)` : en-tête local, extra zip64 (tailles) quand il est demandé. */
function enTeteLocal(e: Ecrit, zip64: boolean): Buffer {
  const extra = zip64 ? Buffer.alloc(20) : Buffer.alloc(0);
  let [taille, compressee] = [e.taille, e.tailleCompressee];
  if (zip64) {
    extra.writeUInt16LE(1, 0);
    extra.writeUInt16LE(16, 2);
    extra.writeBigUInt64LE(BigInt(taille), 4);
    extra.writeBigUInt64LE(BigInt(compressee), 12);
    [taille, compressee] = [0xffffffff, 0xffffffff];
  }
  const t = Buffer.alloc(30);
  t.writeUInt32LE(SIG_LOCAL, 0);
  t.writeUInt8(zip64 ? ZIP64_VERSION : DEFAULT_VERSION, 4);
  t.writeUInt8(0, 5);
  t.writeUInt16LE(e.drapeaux, 6);
  t.writeUInt16LE(8, 8);
  t.writeUInt16LE(e.dosHeure, 10);
  t.writeUInt16LE(e.dosDate, 12);
  t.writeUInt32LE(e.crc, 14);
  t.writeUInt32LE(compressee, 18);
  t.writeUInt32LE(taille, 22);
  t.writeUInt16LE(e.nom.length, 26);
  t.writeUInt16LE(extra.length, 28);
  return Buffer.concat([t, e.nom, extra]);
}

/** `zipfile.ZipFile(chemin, "w", ZIP_DEFLATED)` sur un fichier : chaque membre compressé en flux, son en-tête réécrit à la fin. */
export class EcrivainZip {
  private readonly fichier: FileHandle;
  private position = 0;
  private readonly ecrits: Ecrit[] = [];
  readonly noms: string[] = [];

  private constructor(fichier: FileHandle) {
    this.fichier = fichier;
  }

  /** Fichier existant (créé 0600 par l'appelant), tronqué. */
  static async ouvrir(chemin: string): Promise<EcrivainZip> {
    const f = await open(chemin, "r+");
    await f.truncate(0);
    return new EcrivainZip(f);
  }

  private async ecrire(octets: Buffer, position = this.position): Promise<void> {
    let fait = 0;
    while (fait < octets.length) {
      const { bytesWritten } = await this.fichier.write(octets, fait, octets.length - fait, position + fait);
      fait += bytesWritten;
    }
    if (position === this.position) this.position += octets.length;
  }

  /** `with zf.open(info, "w")` puis copie : une source en échec laisse son membre partiel (fermé comme par `__exit__`) puis l'erreur remonte. */
  async ajouterFlux(
    info: InfoZip,
    source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  ): Promise<number> {
    const nomTexte = ((i) => (i >= 0 ? info.nom.slice(0, i) : info.nom))(info.nom.indexOf("\0"));
    const [dosHeure, dosDate] = dos(info.dateHeure);
    const ascii = /^\p{ASCII}*$/u.test(nomTexte);
    const zip64 = (info.forceZip64 ?? false) || (info.tailleAnnoncee ?? 0) * 1.05 > ZIP64_LIMIT;
    const e: Ecrit = {
      version: zip64 ? ZIP64_VERSION : DEFAULT_VERSION,
      nom: Buffer.from(nomTexte, "utf8"),
      drapeaux: ascii ? 0 : 0x800,
      dosHeure,
      dosDate,
      crc: 0,
      tailleCompressee: 0,
      taille: 0,
      decalage: this.position,
      attributsExternes: (info.attributsExternes ?? 0) || 0o600 << 16,
      commentaire: Buffer.alloc(0),
    };
    await this.ecrire(enTeteLocal(e, zip64));
    const debutDonnees = this.position;
    const deflate = createDeflateRaw();
    const sortie: Buffer[] = [];
    deflate.on("data", (b: Buffer) => sortie.push(b));
    const vider = async (): Promise<void> => {
      while (sortie.length) await this.ecrire(sortie.shift() as Buffer);
    };
    let echec: unknown = null;
    try {
      for await (const morceau of source) {
        const b = Buffer.from(morceau.buffer, morceau.byteOffset, morceau.byteLength);
        e.crc = crc32(b, e.crc) >>> 0;
        e.taille += b.length;
        if (!deflate.write(b)) await new Promise((r) => deflate.once("drain", r));
        await vider();
      }
    } catch (x) {
      echec = x;
    }
    await new Promise<void>((ok, ko) => {
      deflate.once("end", ok);
      deflate.once("error", ko);
      deflate.end();
    });
    await vider();
    e.tailleCompressee = this.position - debutDonnees;
    if (!zip64) {
      if (e.taille > ZIP64_LIMIT) throw new Error("File size too large, try using force_zip64");
      if (e.tailleCompressee > ZIP64_LIMIT)
        throw new Error("Compressed size too large, try using force_zip64");
    }
    await this.ecrire(enTeteLocal(e, zip64), e.decalage);
    this.ecrits.push(e);
    this.noms.push(nomTexte);
    if (echec !== null) throw echec;
    return e.taille;
  }

  /** `zf.writestr(nom, texte)` : date courante, droits 0600. */
  async ecrireTexte(nom: string, texte: string, dateHeure: DateHeureZip): Promise<void> {
    const octets = Buffer.from(texte, "utf8");
    await this.ajouterFlux({ nom, dateHeure, tailleAnnoncee: octets.length }, [octets]);
  }

  /** Commentaire du dernier membre écrit (`zf.filelist[-1].comment`). */
  commenterDernier(commentaire: string): void {
    const e = this.ecrits.at(-1);
    if (e) e.commentaire = Buffer.from(commentaire, "utf8");
  }

  /** `_write_end_record` : répertoire central (extra zip64 au besoin), fin d'archive zip64 puis classique. */
  async fermer(): Promise<void> {
    try {
      const debut = this.position;
      for (const e of this.ecrits) {
        const extra: bigint[] = [];
        let [taille, compressee, decalage] = [e.taille, e.tailleCompressee, e.decalage];
        if (e.taille > ZIP64_LIMIT || e.tailleCompressee > ZIP64_LIMIT) {
          extra.push(BigInt(e.taille), BigInt(e.tailleCompressee));
          [taille, compressee] = [0xffffffff, 0xffffffff];
        }
        if (e.decalage > ZIP64_LIMIT) {
          extra.push(BigInt(e.decalage));
          decalage = 0xffffffff;
        }
        const x = Buffer.alloc(extra.length ? 4 + 8 * extra.length : 0);
        if (extra.length) {
          x.writeUInt16LE(1, 0);
          x.writeUInt16LE(8 * extra.length, 2);
          extra.forEach((v, i) => x.writeBigUInt64LE(v, 4 + 8 * i));
        }
        const version = Math.max(extra.length ? ZIP64_VERSION : 0, e.version);
        const c = Buffer.alloc(46);
        c.writeUInt32LE(SIG_CENTRAL, 0);
        c.writeUInt8(version, 4);
        c.writeUInt8(3, 5);
        c.writeUInt8(version, 6);
        c.writeUInt8(0, 7);
        c.writeUInt16LE(e.drapeaux, 8);
        c.writeUInt16LE(8, 10);
        c.writeUInt16LE(e.dosHeure, 12);
        c.writeUInt16LE(e.dosDate, 14);
        c.writeUInt32LE(e.crc, 16);
        c.writeUInt32LE(compressee, 20);
        c.writeUInt32LE(taille, 24);
        c.writeUInt16LE(e.nom.length, 28);
        c.writeUInt16LE(x.length, 30);
        c.writeUInt16LE(e.commentaire.length, 32);
        c.writeUInt32LE(e.attributsExternes >>> 0, 38);
        c.writeUInt32LE(decalage, 42);
        await this.ecrire(Buffer.concat([c, e.nom, x, e.commentaire]));
      }
      const fin = this.position;
      let [nombre, taille, decalage] = [this.ecrits.length, fin - debut, debut];
      if (nombre > ZIP_FILECOUNT_LIMIT || decalage > ZIP64_LIMIT || taille > ZIP64_LIMIT) {
        const r = Buffer.alloc(56 + 20);
        r.writeUInt32LE(SIG_FIN64, 0);
        r.writeBigUInt64LE(44n, 4);
        r.writeUInt16LE(45, 12);
        r.writeUInt16LE(45, 14);
        r.writeBigUInt64LE(BigInt(nombre), 24);
        r.writeBigUInt64LE(BigInt(nombre), 32);
        r.writeBigUInt64LE(BigInt(taille), 40);
        r.writeBigUInt64LE(BigInt(decalage), 48);
        r.writeUInt32LE(SIG_LOCALISATEUR64, 56);
        r.writeBigUInt64LE(BigInt(fin), 64);
        r.writeUInt32LE(1, 72);
        await this.ecrire(r);
        [nombre, taille, decalage] = [
          Math.min(nombre, 0xffff),
          Math.min(taille, 0xffffffff),
          Math.min(decalage, 0xffffffff),
        ];
      }
      const f = Buffer.alloc(22);
      f.writeUInt32LE(SIG_FIN, 0);
      f.writeUInt16LE(nombre, 8);
      f.writeUInt16LE(nombre, 10);
      f.writeUInt32LE(taille, 12);
      f.writeUInt32LE(decalage, 16);
      await this.ecrire(f);
    } finally {
      await this.fichier.close();
    }
  }

  /** Abandon sans fin d'archive (l'appelant supprime le fichier). */
  async abandonner(): Promise<void> {
    await this.fichier.close().catch(() => undefined);
  }
}

async function lirePosition(f: FileHandle, position: number, longueur: number): Promise<Buffer> {
  const b = Buffer.alloc(Math.max(0, longueur));
  let lu = 0;
  while (lu < b.length) {
    const { bytesRead } = await f.read(b, lu, b.length - lu, position + lu);
    if (bytesRead === 0) break;
    lu += bytesRead;
  }
  return b.subarray(0, lu);
}

/** `zipfile.ZipFile(chemin)` en lecture : répertoire central lu une fois, membres lus à la demande (en-tête local, chevauchement, CRC). */
export class LecteurZip {
  readonly membres: MembreZip[];
  private readonly fichier: FileHandle;
  private readonly parNom = new Map<string, MembreZip>();

  private constructor(fichier: FileHandle, membres: MembreZip[]) {
    this.fichier = fichier;
    this.membres = membres;
    for (const m of membres) this.parNom.set(m.nom, m);
  }

  /** `namelist()`. */
  noms(): string[] {
    return this.membres.map((m) => m.nom);
  }

  /** `zf.read(nom)` : le dernier membre de ce nom, comme `NameToInfo`. */
  async lireNom(nom: string): Promise<Buffer> {
    const m = this.parNom.get(nom);
    if (m === undefined)
      throw new ErreurZip("KeyError", `There is no item named ${reprPy(nom)} in the archive`);
    return this.lire(m);
  }

  static async ouvrir(chemin: string): Promise<LecteurZip> {
    const f = await open(chemin, "r");
    try {
      const taille = (await f.stat()).size;
      const debutQueue = Math.max(0, taille - QUEUE_MAX);
      const queue = await lirePosition(f, debutQueue, taille - debutQueue);
      const fin = finArchive(queue);
      if (fin === null) throw new ErreurZip("BadZipFile", "File is not a zip file");
      let concat = debutQueue + fin.position - fin.taille - fin.decalage;
      if (fin.zip64) concat -= 56 + 20;
      const debut = fin.decalage + concat;
      if (debut < 0) throw new ErreurZip("BadZipFile", "Bad offset for central directory");
      const membres = membresDuRepertoire(await lirePosition(f, debut, fin.taille), fin.taille, concat);
      let finDecalage = debut;
      for (const m of membres.toSorted((a, b) => a.decalage - b.decalage).reverse()) {
        m.finDecalage = finDecalage;
        finDecalage = m.decalage;
      }
      return new LecteurZip(f, membres);
    } catch (e) {
      await f.close();
      throw e;
    }
  }

  /** `ZipFile.read(info)`. */
  async lire(m: MembreZip): Promise<Buffer> {
    const h = m.decalage;
    const tete = await lirePosition(this.fichier, h, 30);
    if (h < 0 || tete.length < 30) throw new ErreurZip("BadZipFile", "Truncated file header");
    if (tete.readUInt32LE(0) !== SIG_LOCAL)
      throw new ErreurZip("BadZipFile", "Bad magic number for file header");
    const [ln, lx] = [tete.readUInt16LE(26), tete.readUInt16LE(28)];
    const brut = await lirePosition(this.fichier, h + 30, ln);
    if (m.drapeaux & 0x20) throw new ErreurZip("NotImplementedError", "compressed patched data (flag bit 5)");
    if (m.drapeaux & 0x40) throw new ErreurZip("NotImplementedError", "strong encryption (flag bit 6)");
    if (decoderNom(brut, (tete.readUInt16LE(6) & 0x800) !== 0) !== m.nomOrigine)
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
    const compresse = await lirePosition(this.fichier, position, m.tailleCompressee);
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

  async fermer(): Promise<void> {
    await this.fichier.close();
  }
}
