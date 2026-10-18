// SPDX-License-Identifier: MIT
/** apps/core/src/relais/tar.ts — archive tar (ustar, nom long en en-tête pax) des fichiers ordinaires d'un dossier, comme `tarfile` pour le miroir des skills. */
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";

import { estAscii } from "./chemins";

const BLOC = 512;
const ENREGISTREMENT = 20 * BLOC;

function octal(tampon: Buffer, position: number, largeur: number, valeur: number): void {
  const texte = Math.trunc(valeur).toString(8);
  if (texte.length > largeur - 1) throw new RangeError(`valeur ${valeur} trop grande pour l'en-tête tar`);
  tampon.write(texte.padStart(largeur - 1, "0") + "\0", position, largeur, "latin1");
}

function entete(nom: Buffer, taille: number, mode: number, mtime: number, type: "0" | "x"): Buffer {
  const b = Buffer.alloc(BLOC);
  nom.copy(b, 0, 0, Math.min(nom.length, 100));
  octal(b, 100, 8, mode);
  octal(b, 108, 8, 0);
  octal(b, 116, 8, 0);
  octal(b, 124, 12, taille);
  octal(b, 136, 12, mtime);
  b.fill(0x20, 148, 156);
  b.write(type, 156, 1, "latin1");
  b.write("ustar\0", 257, 6, "latin1");
  b.write("00", 263, 2, "latin1");
  let somme = 0;
  for (const octet of b) somme += octet;
  b.write(somme.toString(8).padStart(6, "0") + "\0 ", 148, 8, "latin1");
  return b;
}

function bourrage(taille: number): Buffer {
  return Buffer.alloc((BLOC - (taille % BLOC)) % BLOC);
}

/** Enregistrement pax `<longueur> path=<nom>\n`, la longueur se comptant elle-même. */
function recordPax(cle: string, valeur: Buffer): Buffer {
  const corps = Buffer.concat([Buffer.from(` ${cle}=`, "utf8"), valeur, Buffer.from("\n")]);
  let longueur = corps.length + 1;
  while (String(longueur).length + corps.length !== longueur)
    longueur = String(longueur).length + corps.length;
  return Buffer.concat([Buffer.from(String(longueur)), corps]);
}

function membre(nom: string, contenu: Buffer, mode: number, mtime: number): Buffer[] {
  const octets = Buffer.from(nom, "utf8");
  const parties: Buffer[] = [];
  if (octets.length > 100 || !estAscii(nom)) {
    const pax = recordPax("path", octets);
    parties.push(
      entete(Buffer.from("././@PaxHeader"), pax.length, 0o644, mtime, "x"),
      pax,
      bourrage(pax.length),
    );
  }
  parties.push(entete(octets, contenu.length, mode, mtime, "0"), contenu, bourrage(contenu.length));
  return parties;
}

/** Fichiers ordinaires (liens et dossiers liés ignorés), hors `__pycache__`, chemins relatifs triés. */
function fichiers(racine: string, relatif = ""): string[] {
  const trouves: string[] = [];
  for (const entree of readdirSync(join(racine, relatif), { withFileTypes: true })) {
    const chemin = relatif ? `${relatif}/${entree.name}` : entree.name;
    if (entree.isDirectory()) trouves.push(...fichiers(racine, chemin));
    else if (entree.isFile()) trouves.push(chemin);
  }
  return trouves;
}

/** Archive tar du dossier, bourrée à l'enregistrement de 10 Kio comme `tarfile`. */
export function archiverDossier(racine: string): Buffer {
  const parties: Buffer[] = [];
  const exclus = racine.split(sep).includes("__pycache__");
  for (const relatif of fichiers(racine).sort()) {
    if (exclus || relatif.split("/").includes("__pycache__")) continue;
    const chemin = join(racine, relatif);
    const etat = lstatSync(chemin);
    parties.push(...membre(relatif, readFileSync(chemin), etat.mode & 0o7777, etat.mtimeMs / 1000));
  }
  parties.push(Buffer.alloc(2 * BLOC));
  const archive = Buffer.concat(parties);
  return Buffer.concat([
    archive,
    Buffer.alloc((ENREGISTREMENT - (archive.length % ENREGISTREMENT)) % ENREGISTREMENT),
  ]);
}
