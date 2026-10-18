// SPDX-License-Identifier: MIT
/** apps/toolhost/src/fichiers/tar.ts — lecture en flux d'une archive tar, gzip ou non (`tarfile.open(mode="r:*")` pour le miroir des skills) : en-têtes ustar, GNU et pax, membres contenus extraits sous un dossier. */
import { createWriteStream, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

const BLOC = 512;
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Archive illisible (`tarfile.ReadError` et erreurs de décompression). */
export class ErreurTar extends Error {
  override name = "ErreurTar";
}

/** Bornes dépassées (`_ArchiveTooBig`). */
export class ArchiveTropGrosse extends Error {
  override name = "ArchiveTropGrosse";
}

/** Lecteur de blocs sur un flux d'octets. */
class Lecteur {
  private tampon: Buffer = Buffer.alloc(0);
  private fini = false;
  private readonly it: AsyncIterator<Buffer>;

  constructor(source: AsyncIterable<Buffer>) {
    this.it = source[Symbol.asyncIterator]();
  }

  /** Jusqu'à `n` octets (moins en fin de flux). */
  async lire(n: number): Promise<Buffer> {
    while (this.tampon.length < n && !this.fini) {
      let r: IteratorResult<Buffer>;
      try {
        r = await this.it.next();
      } catch (e) {
        throw new ErreurTar(`zlib error: ${(e as Error).message}`);
      }
      if (r.done) this.fini = true;
      else this.tampon = this.tampon.length ? Buffer.concat([this.tampon, r.value]) : r.value;
    }
    const sortie = this.tampon.subarray(0, n);
    this.tampon = this.tampon.subarray(sortie.length);
    return sortie;
  }

  async fermer(): Promise<void> {
    await this.it.return?.();
  }
}

/** `nti` : nombre octal (NUL et blancs de fin tolérés) ou base 256 (0x80 / 0xff). */
function nti(b: Buffer): number {
  if (b[0] === 0x80 || b[0] === 0xff) {
    let n = 0n;
    for (let i = 1; i < b.length; i++) n = (n << 8n) + BigInt(b[i] ?? 0);
    if (b[0] === 0xff) n = -((1n << BigInt(8 * (b.length - 1))) - n);
    return Number(n);
  }
  const fin = b.indexOf(0);
  const s = b
    .subarray(0, fin < 0 ? b.length : fin)
    .toString("latin1")
    .trim();
  if (!s) return 0;
  if (!/^[0-7]+$/u.test(s)) throw new ErreurTar("invalid header");
  return parseInt(s, 8);
}

/** `nts` : texte jusqu'au premier NUL, UTF-8 strict (`null` s'il n'en est pas). */
function nts(b: Buffer): string | null {
  const fin = b.indexOf(0);
  try {
    return UTF8.decode(b.subarray(0, fin < 0 ? b.length : fin));
  } catch {
    return null;
  }
}

/** Somme de contrôle valide, octets non signés ou signés (`calc_chksums`). */
function sommeValide(bloc: Buffer): boolean {
  let attendue: number;
  try {
    attendue = nti(bloc.subarray(148, 156));
  } catch {
    return false;
  }
  let nonSigne = 256;
  let signe = 256;
  for (let i = 0; i < BLOC; i++) {
    if (i >= 148 && i < 156) continue;
    const o = bloc[i] ?? 0;
    nonSigne += o;
    signe += o > 127 ? o - 256 : o;
  }
  return attendue === nonSigne || attendue === signe;
}

interface Entete {
  nom: string | null;
  type: string;
  taille: number;
}

/** En-tête brut d'un bloc ; `null` en fin d'archive (bloc nul, fin de flux, ou en-tête invalide après le premier). */
function entete(bloc: Buffer, premier: boolean): Entete | null {
  if (bloc.length === 0) {
    if (premier) throw new ErreurTar("empty file");
    return null;
  }
  if (bloc.length !== BLOC) {
    if (premier) throw new ErreurTar("truncated header");
    return null;
  }
  if (bloc.every((o) => o === 0)) return null;
  if (!sommeValide(bloc)) {
    if (premier) throw new ErreurTar("bad checksum");
    return null;
  }
  let type = bloc.toString("latin1", 156, 157);
  let nom = nts(bloc.subarray(0, 100));
  const prefixe = nts(bloc.subarray(345, 500));
  if (type === "\0" && nom !== null && nom.endsWith("/")) type = "5";
  if (type === "5" && nom !== null) nom = nom.replace(/\/+$/u, "");
  if (prefixe && nom !== null && !["L", "K", "S", "M", "N", "V", "D"].includes(type))
    nom = `${prefixe}/${nom}`;
  if (prefixe === null) nom = null;
  return { nom, type, taille: nti(bloc.subarray(124, 136)) };
}

/** Enregistrements pax `longueur clé=valeur\n` : `path` et `size`. */
function pax(donnees: Buffer): { path?: string | null; size?: number } {
  const sortie: { path?: string | null; size?: number } = {};
  let pos = 0;
  while (pos < donnees.length && donnees[pos] !== 0) {
    const espace = donnees.indexOf(0x20, pos);
    if (espace < 0) throw new ErreurTar("invalid header");
    const longueur = Number(donnees.toString("latin1", pos, espace));
    if (!Number.isInteger(longueur) || longueur <= espace - pos) throw new ErreurTar("invalid header");
    const enreg = donnees.subarray(espace + 1, pos + longueur - 1);
    const egal = enreg.indexOf(0x3d);
    if (egal < 0) throw new ErreurTar("invalid header");
    const cle = enreg.toString("utf8", 0, egal);
    const valeur = enreg.subarray(egal + 1);
    if (cle === "path") sortie.path = nts(valeur);
    else if (cle === "size") sortie.size = Number(valeur.toString("latin1"));
    pos += longueur;
  }
  return sortie;
}

const arrondi = (n: number): number => Math.ceil(n / BLOC) * BLOC;

/** Membre d'archive : nom (`null` s'il n'est pas de l'UTF-8), genre, taille. */
export interface Membre {
  readonly nom: string | null;
  readonly genre: "fichier" | "dossier" | "autre";
  readonly taille: number;
}

/** Membres d'une archive tar (en-têtes étendus appliqués) ; le contenu d'un fichier non lu par `contenu` est sauté. */
async function* membres(source: AsyncIterable<Buffer>): AsyncGenerator<[Membre, Lecteur]> {
  const l = new Lecteur(source);
  try {
    let premier = true;
    let etendu: { path?: string | null; size?: number } = {};
    let suiteAttendue = false;
    for (;;) {
      const bloc = await l.lire(BLOC);
      let e: Entete | null;
      try {
        e = entete(bloc, premier);
      } catch (err) {
        if (suiteAttendue) throw new ErreurTar((err as Error).message);
        throw err;
      }
      if (e === null) {
        if (suiteAttendue) throw new ErreurTar("missing or bad subsequent header");
        return;
      }
      premier = false;
      if (e.type === "x" || e.type === "g" || e.type === "L" || e.type === "K") {
        const donnees = await l.lire(arrondi(e.taille));
        if (donnees.length < e.taille) throw new ErreurTar("unexpected end of data");
        const utiles = donnees.subarray(0, e.taille);
        suiteAttendue = true;
        if (e.type === "x") etendu = { ...etendu, ...pax(utiles) };
        else if (e.type === "L") etendu = { ...etendu, path: nts(utiles) };
        continue;
      }
      const nom = Object.hasOwn(etendu, "path") ? (etendu.path ?? null) : e.nom;
      const taille = etendu.size ?? e.taille;
      etendu = {};
      suiteAttendue = false;
      const genre = ["0", "\0", "7"].includes(e.type) ? "fichier" : e.type === "5" ? "dossier" : "autre";
      yield [{ nom: genre === "dossier" && nom !== null ? nom.replace(/\/+$/u, "") : nom, genre, taille }, l];
      const reste = genre === "fichier" || genre === "autre" ? taille : 0;
      if (reste > 0) await sauter(l, arrondi(reste) - (consommes.get(l) ?? 0));
      consommes.delete(l);
    }
  } finally {
    await l.fermer();
  }
}

const consommes = new WeakMap<Lecteur, number>();

async function sauter(l: Lecteur, n: number): Promise<void> {
  let reste = n;
  while (reste > 0) {
    const b = await l.lire(Math.min(reste, 1 << 20));
    if (b.length === 0) throw new ErreurTar("unexpected end of data");
    reste -= b.length;
  }
}

/** Contenu d'un fichier par blocs ; les octets lus sont décomptés du saut qui suit. */
async function* contenu(l: Lecteur, taille: number): AsyncGenerator<Buffer> {
  let reste = taille;
  while (reste > 0) {
    const b = await l.lire(Math.min(reste, 1 << 20));
    if (b.length === 0) throw new ErreurTar("unexpected end of data");
    reste -= b.length;
    consommes.set(l, (consommes.get(l) ?? 0) + b.length);
    yield b;
  }
}

/** Flux décompressé : gzip reconnu à sa signature, sinon tar nu ; bzip2 et xz refusés (ni l'un ni l'autre dans Node). */
function decompresser(donnees: Buffer): AsyncIterable<Buffer> {
  if (donnees[0] === 0x1f && donnees[1] === 0x8b) return Readable.from([donnees]).pipe(createGunzip());
  return (async function* () {
    yield donnees;
  })();
}

/** `_extract_tar_bounded` : membres contenus (ni `..`, ni absolu, ni lien, ni spécial) écrits sous `dossier` ; nombre de fichiers écrits. */
export async function extraireTarBorne(
  donnees: Buffer,
  dossier: string,
  o: { maxTotal: number; maxMembres: number },
): Promise<number> {
  const racine = realpathSync(dossier);
  let n = 0;
  let total = 0;
  let vus = 0;
  for await (const [m, l] of membres(decompresser(donnees))) {
    vus += 1;
    if (vus > o.maxMembres) throw new ArchiveTropGrosse();
    if (m.nom === null) continue;
    const brut = m.nom;
    const tete =
      brut.startsWith("//") && !brut.startsWith("///") ? ["//"] : brut.startsWith("/") ? ["/"] : [];
    const parties = [...tete, ...brut.split("/").filter((p) => p !== "" && p !== ".")].filter(
      (p) => p !== "/",
    );
    if (!parties.length || parties.includes("..") || brut.startsWith("/")) continue;
    if (m.genre === "autre") continue;
    const dest = path.join(racine, ...parties);
    if (dest !== racine && !dest.startsWith(racine + path.sep)) continue;
    if (m.genre === "dossier") {
      mkdirSync(dest, { recursive: true });
      continue;
    }
    total += Math.max(0, m.taille);
    if (total > o.maxTotal) throw new ArchiveTropGrosse();
    mkdirSync(path.dirname(dest), { recursive: true });
    await pipeline(Readable.from(contenu(l, m.taille)), createWriteStream(dest));
    n += 1;
  }
  return n;
}
