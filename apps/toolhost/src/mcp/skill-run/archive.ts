// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/skill-run/archive.ts — dossier d'un skill envoyé au conteneur (skill_tools.py `_build_tar`) : taille comme `rglob` + `is_file`, puis `tarfile.add(dossier, arcname=".")` au format pax (noms d'utilisateur et de groupe non écrits), liens gardés en liens. */
import { constants } from "node:fs";
import { lstat, open, readdir, readlink, stat } from "node:fs/promises";

import {
  arrondiEntierPy,
  comparePointsDeCode,
  messageErreurPy,
  reprFlottant,
  stMtimePy,
} from "@elpis/commun";
import { pyJoin, rglob } from "@elpis/skills";

const BLOC = 512;
/** Plus grand entier d'un champ numérique ustar de 8 octets (`8**7 - 1`) ; au-delà, 0 et un enregistrement pax. */
const MAX8 = 0o7777777n;
const ENREGISTREMENT = 20 * BLOC;
/** Erreurs que `Path.is_file()` de Python 3.13 rend en « faux » ; les autres lèvent. */
const IGNOREES: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR", "EBADF", "ELOOP"]);

/** Échec de la mise en place : `str(OSError)` de Python. */
export class ErreurArchive extends Error {}

function codeDe(e: unknown): string {
  return String((e as { code?: unknown } | null)?.code ?? "");
}

/** `sum(f.stat().st_size for f in rglob("*") if f.is_file())` (liens suivis, dossiers liés non parcourus) ; 0 sur une erreur d'OS. */
export async function tailleDossier(dossier: string): Promise<number> {
  let total = 0;
  for (const p of await rglob(dossier, () => true)) {
    try {
      const s = await stat(p);
      if (s.isFile()) total += s.size;
    } catch (e) {
      if (!IGNOREES.has(codeDe(e))) return 0;
    }
  }
  return total;
}

function octal(b: Buffer, position: number, largeur: number, valeur: number | bigint): void {
  const texte = valeur.toString(8);
  b.write(texte.padStart(largeur - 1, "0").slice(-(largeur - 1)) + "\0", position, largeur, "latin1");
}

interface Entete {
  nom: Buffer;
  mode: number;
  uid: bigint;
  gid: bigint;
  taille: number;
  mtime: number;
  type: string;
  lien: Buffer;
  majeur: number;
  mineur: number;
}

/** En-tête ustar (`ustar\0` + `00`), somme de contrôle comme `tarfile`. */
function entete(e: Entete): Buffer {
  const b = Buffer.alloc(BLOC);
  e.nom.copy(b, 0, 0, Math.min(e.nom.length, 100));
  octal(b, 100, 8, e.mode);
  octal(b, 108, 8, e.uid <= MAX8 ? e.uid : 0n);
  octal(b, 116, 8, e.gid <= MAX8 ? e.gid : 0n);
  octal(b, 124, 12, e.taille);
  octal(b, 136, 12, Math.max(0, arrondiEntierPy(e.mtime)));
  b.fill(0x20, 148, 156);
  b.write(e.type, 156, 1, "latin1");
  e.lien.copy(b, 157, 0, Math.min(e.lien.length, 100));
  b.write("ustar\0", 257, 6, "latin1");
  b.write("00", 263, 2, "latin1");
  octal(b, 329, 8, e.majeur);
  octal(b, 337, 8, e.mineur);
  let somme = 0;
  for (const octet of b) somme += octet;
  b.write(somme.toString(8).padStart(6, "0") + "\0 ", 148, 8, "latin1");
  return b;
}

function bourrage(taille: number): Buffer {
  return Buffer.alloc((BLOC - (taille % BLOC)) % BLOC);
}

/** Enregistrement pax `<longueur> clé=valeur\n`, la longueur se comptant elle-même. */
function recordPax(cle: string, valeur: Buffer): Buffer {
  const corps = Buffer.concat([Buffer.from(` ${cle}=`, "utf8"), valeur, Buffer.from("\n")]);
  let longueur = corps.length + 1;
  while (String(longueur).length + corps.length !== longueur)
    longueur = String(longueur).length + corps.length;
  return Buffer.concat([Buffer.from(String(longueur)), corps]);
}

/** Texte que `str.encode("ascii")` accepte. */
const estAscii = (s: string): boolean => [...s].every((c) => c.charCodeAt(0) < 0x80);

/** Membre au format pax de `tarfile` : `path`/`linkpath` hors ASCII ou trop longs, `uid`/`gid` hors du champ, `mtime` flottant toujours. */
function membre(
  nom: string,
  lien: string,
  e: Omit<Entete, "nom" | "lien">,
  contenu: Buffer | null,
): Buffer[] {
  const records: Buffer[] = [];
  if (!estAscii(nom) || nom.length > 100) records.push(recordPax("path", Buffer.from(nom, "utf8")));
  if (!estAscii(lien) || lien.length > 100) records.push(recordPax("linkpath", Buffer.from(lien, "utf8")));
  if (e.uid > MAX8) records.push(recordPax("uid", Buffer.from(String(e.uid))));
  if (e.gid > MAX8) records.push(recordPax("gid", Buffer.from(String(e.gid))));
  records.push(recordPax("mtime", Buffer.from(reprFlottant(e.mtime))));
  const parties: Buffer[] = [];
  if (records.length > 0) {
    const pax = Buffer.concat(records);
    parties.push(
      entete({
        nom: Buffer.from("././@PaxHeader"),
        mode: 0,
        uid: 0n,
        gid: 0n,
        taille: pax.length,
        mtime: 0,
        type: "x",
        lien: Buffer.alloc(0),
        majeur: 0,
        mineur: 0,
      }),
      pax,
      bourrage(pax.length),
    );
  }
  parties.push(entete({ ...e, nom: Buffer.from(nom, "utf8"), lien: Buffer.from(lien, "utf8") }));
  if (contenu !== null) parties.push(contenu, bourrage(contenu.length));
  return parties;
}

/** `TarFile.add(chemin, nom)` récursif : dossiers (enfants triés), fichiers (jamais par un lien), liens symboliques et durs, tubes, périphériques ; sockets ignorées. */
async function ajouter(
  chemin: string,
  nom: string,
  inodes: Map<string, string>,
  parties: Buffer[],
): Promise<void> {
  const s = await lstat(chemin, { bigint: true });
  const base = {
    mode: Number(s.mode & 0o7777n),
    uid: s.uid,
    gid: s.gid,
    mtime: stMtimePy(s.mtimeNs),
    majeur: 0,
    mineur: 0,
  };
  if (s.isFile()) {
    const inode = `${s.ino}:${s.dev}`;
    const premier = inodes.get(inode);
    if (s.nlink > 1n && premier !== undefined && premier !== nom) {
      parties.push(...membre(nom, premier, { ...base, taille: 0, type: "1" }, null));
      return;
    }
    if (s.ino) inodes.set(inode, nom);
    const contenu = await lireSansLien(chemin);
    parties.push(...membre(nom, "", { ...base, taille: contenu.length, type: "0" }, contenu));
  } else if (s.isSymbolicLink()) {
    parties.push(...membre(nom, await readlink(chemin), { ...base, taille: 0, type: "2" }, null));
  } else if (s.isDirectory()) {
    parties.push(...membre(`${nom}/`, "", { ...base, taille: 0, type: "5" }, null));
    const enfants = (await readdir(chemin)).sort(comparePointsDeCode);
    for (const f of enfants) await ajouter(pyJoin(chemin, f), `${nom}/${f}`, inodes, parties);
  } else if (s.isFIFO()) {
    parties.push(...membre(nom, "", { ...base, taille: 0, type: "6" }, null));
  } else if (s.isCharacterDevice() || s.isBlockDevice()) {
    const [majeur, mineur] = majeurMineur(s.rdev);
    const type = s.isCharacterDevice() ? "3" : "4";
    parties.push(...membre(nom, "", { ...base, taille: 0, type, majeur, mineur }, null));
  }
}

/** Contenu d'un fichier ordinaire ouvert sans suivre de lien (un lien posé après le `lstat` est refusé, ELOOP). */
async function lireSansLien(chemin: string): Promise<Buffer> {
  const f = await open(chemin, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return await f.readFile();
  } finally {
    await f.close();
  }
}

/** `os.major` / `os.minor` de glibc. */
function majeurMineur(rdev: bigint): [number, number] {
  const majeur = ((rdev >> 8n) & 0xfffn) | ((rdev >> 32n) & ~0xfffn);
  const mineur = (rdev & 0xffn) | ((rdev >> 12n) & ~0xffn);
  return [Number(majeur), Number(mineur)];
}

/** `tarfile.open(mode="w")` puis `tar.add(dossier, arcname=".")` ; une erreur d'OS sort en `ErreurArchive` au texte de Python. */
export async function archiverDossier(dossier: string): Promise<Buffer> {
  const parties: Buffer[] = [];
  try {
    await ajouter(dossier, ".", new Map(), parties);
  } catch (e) {
    const p = (e as { path?: unknown } | null)?.path;
    throw new ErreurArchive(messageErreurPy(e, typeof p === "string" ? p : dossier), { cause: e });
  }
  parties.push(Buffer.alloc(2 * BLOC));
  const archive = Buffer.concat(parties);
  return Buffer.concat([
    archive,
    Buffer.alloc((ENREGISTREMENT - (archive.length % ENREGISTREMENT)) % ENREGISTREMENT),
  ]);
}
