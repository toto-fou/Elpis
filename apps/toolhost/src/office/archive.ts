// SPDX-License-Identifier: MIT
/** apps/toolhost/src/office/archive.ts — classeur ou document OOXML ouvert comme `zipfile.ZipFile` : membres lus en flux (`ZipExtFile`), taille plafonnée, CRC contrôlé à la fin. */
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { constants, crc32, createInflateRaw } from "node:zlib";

import { ArchiveZip, decoderNom, ErreurZip, NOMS_COMPRESSION, reprPy } from "@elpis/commun";
import type { MembreZip } from "@elpis/commun";

const BLOC = 1 << 16;

/** Flux d'un membre : `lire(n)` comme `ZipExtFile.read` (n octets sauf à la fin, -1 : tout). */
export class FluxMembre {
  private file: Buffer[] = [];
  private disponible = 0;
  private fini = false;
  private crc = 0;
  private erreurCrc: ErreurZip | null = null;
  private reste: number;
  private readonly source: AsyncIterator<Buffer>;
  private readonly membre: MembreZip;

  constructor(source: AsyncIterator<Buffer>, membre: MembreZip) {
    this.source = source;
    this.membre = membre;
    this.reste = membre.taille;
  }

  private async remplir(): Promise<boolean> {
    if (this.fini) return false;
    const r = await this.source.next();
    let morceau = r.done ? Buffer.alloc(0) : r.value;
    if (morceau.length > this.reste) morceau = morceau.subarray(0, this.reste);
    this.reste -= morceau.length;
    if (morceau.length) {
      this.crc = crc32(morceau, this.crc);
      this.file.push(morceau);
      this.disponible += morceau.length;
    }
    if (r.done || this.reste <= 0) {
      this.fini = true;
      await this.source.return?.();
      if (this.crc >>> 0 !== this.membre.crc)
        this.erreurCrc = new ErreurZip("BadZipFile", `Bad CRC-32 for file ${reprPy(this.membre.nom)}`);
    }
    return morceau.length > 0 || !this.fini;
  }

  /** Le CRC faux lève à la lecture qui prend les derniers octets (comme `_update_crc`). */
  async lire(n = -1): Promise<Buffer> {
    while (n < 0 || this.disponible < n) if (!(await this.remplir()) && this.fini) break;
    const tout = this.file.length === 1 ? (this.file[0] as Buffer) : Buffer.concat(this.file);
    const pris = n < 0 ? tout : tout.subarray(0, n);
    const garde = tout.subarray(pris.length);
    this.file = garde.length ? [garde] : [];
    this.disponible = garde.length;
    if (this.fini && !garde.length && this.erreurCrc) {
      const e = this.erreurCrc;
      this.erreurCrc = null;
      throw e;
    }
    return pris;
  }

  async fermer(): Promise<void> {
    if (!this.fini) {
      this.fini = true;
      await this.source.return?.();
    }
  }
}

/** Archive lue en mémoire (le fichier du cache, plafonné par `max_bytes`). */
export class ArchiveOffice {
  readonly zip: ArchiveZip;
  private readonly octets: Buffer;

  constructor(octets: Buffer) {
    this.octets = octets;
    this.zip = new ArchiveZip(octets);
  }

  /** `zipfile.ZipFile(chemin)` : ErreurZip (BadZipFile…) ou erreur système si illisible. */
  static async ouvrir(chemin: string): Promise<ArchiveOffice> {
    return new ArchiveOffice(await readFile(chemin));
  }

  /** `getinfo(nom)` : le dernier membre de ce nom, `undefined` (KeyError) sinon. */
  info(nom: string): MembreZip | undefined {
    const m = this.zip.membres;
    for (let i = m.length - 1; i >= 0; i--) if (m[i]?.nom === nom) return m[i];
    return undefined;
  }

  /** `zf.open(info)` : contrôles de l'en-tête local, puis flux décompressé. */
  ouvrirMembre(m: MembreZip): FluxMembre {
    const o = this.octets;
    const h = m.decalage;
    if (h < 0 || h + 30 > o.length) throw new ErreurZip("BadZipFile", "Truncated file header");
    if (o.readUInt32LE(h) !== 0x04034b50)
      throw new ErreurZip("BadZipFile", "Bad magic number for file header");
    const [ln, lx] = [o.readUInt16LE(h + 26), o.readUInt16LE(h + 28)];
    if (m.drapeaux & 0x20) throw new ErreurZip("NotImplementedError", "compressed patched data (flag bit 5)");
    if (m.drapeaux & 0x40) throw new ErreurZip("NotImplementedError", "strong encryption (flag bit 6)");
    if (decoderNom(o.subarray(h + 30, h + 30 + ln), (o.readUInt16LE(h + 6) & 0x800) !== 0) !== m.nomOrigine)
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
      const libelle = NOMS_COMPRESSION[m.methode];
      throw new ErreurZip(
        "NotImplementedError",
        m.methode === 12 || m.methode === 14
          ? `compression type ${m.methode} not supported by this port`
          : libelle === undefined
            ? "That compression method is not supported"
            : `compression type ${m.methode} (${libelle})`,
      );
    }
    const compresse = o.subarray(position, Math.min(o.length, position + m.tailleCompressee));
    const morceaux = function* (): Generator<Buffer> {
      for (let i = 0; i < compresse.length; i += BLOC) yield compresse.subarray(i, i + BLOC);
    };
    const flux =
      m.methode === 0
        ? Readable.from(morceaux(), { objectMode: false })
        : Readable.from(morceaux(), { objectMode: false }).pipe(
            createInflateRaw({ finishFlush: constants.Z_SYNC_FLUSH, chunkSize: BLOC }),
          );
    return new FluxMembre(flux[Symbol.asyncIterator]() as AsyncIterator<Buffer>, m);
  }

  /** Membre entier (`zf.read`), CRC compris. */
  async lireMembre(m: MembreZip): Promise<Buffer> {
    return this.ouvrirMembre(m).lire(-1);
  }
}
