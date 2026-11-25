// SPDX-License-Identifier: MIT
/** packages/commun/src/droits.ts — droits de l'état partagé entre services : privés au compte, ou au groupe des données (`ELPIS_GROUPE_DONNEES`) et au groupe de clé (`ELPIS_GROUPE_CLE`) quand chaque service a son compte. */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fchownSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

/** Groupe des données des services (`ELPIS_GROUPE_DONNEES`), `null` en compte unique. */
export function groupeDonnees(): string | null {
  const nom = (process.env["ELPIS_GROUPE_DONNEES"] ?? "").trim();
  return nom || null;
}

/** `mode` en compte unique ; sous le groupe des données, le groupe reçoit les droits du propriétaire (sans l'écriture si `lecture`), les autres aucun. */
export function modePartage(mode: number, lecture = false): number {
  if (groupeDonnees() === null) return mode;
  const proprietaire = mode & 0o700;
  return proprietaire | ((lecture ? proprietaire & 0o500 : proprietaire) >> 3);
}

/** Bits refusés sur un fichier ou un dossier privé : 0077, ou 0007 sous le groupe des données. */
export function bitsInterdits(): number {
  return groupeDonnees() === null ? 0o077 : 0o007;
}

/** GID d'un groupe de `/etc/group`, `null` s'il n'y est pas (ou fichier illisible). */
function gidDansAnnuaire(nom: string): number | null {
  let texte: string;
  try {
    texte = readFileSync("/etc/group", "utf8");
  } catch {
    return null;
  }
  for (const ligne of texte.split("\n")) {
    const [n, , g] = ligne.split(":");
    if (n === nom && g !== undefined && /^\d+$/u.test(g)) return Number(g);
  }
  return null;
}

const gidsConnus = new Map<string, number | null>();

/** GID d'un groupe nommé par l'environnement : valeur numérique, sinon `/etc/group` (mis en cache), `null` s'il est introuvable. */
function gidDuNom(nom: string): number | null {
  if (!gidsConnus.has(nom)) gidsConnus.set(nom, /^\d+$/u.test(nom) ? Number(nom) : gidDansAnnuaire(nom));
  return gidsConnus.get(nom) ?? null;
}

/** GID du groupe des données : celui de son nom, sinon le groupe principal du process. */
function gidDonnees(nom: string): number | null {
  return gidDuNom(nom) ?? process.getgid?.() ?? null;
}

/** GID du groupe de clé (`ELPIS_GROUPE_CLE` : secrets de main et de la console seuls) ; `null` sans lui ou s'il est introuvable, jamais un autre groupe. */
export function gidGroupeCle(): number | null {
  const nom = (process.env["ELPIS_GROUPE_CLE"] ?? "").trim();
  return nom ? gidDuNom(nom) : null;
}

/** Dossier sûr : à ce compte sans droit pour le groupe ni les autres, ou, sous le groupe des données, à ce groupe sans droit pour les autres. */
export function dossierDeConfiance(st: { uid: number; gid: number; mode: number }): boolean {
  if (st.uid === process.geteuid?.() && (st.mode & 0o077) === 0) return true;
  const nom = groupeDonnees();
  return nom !== null && st.gid === gidDonnees(nom) && (st.mode & 0o007) === 0;
}

/** Secret écrit sans suivre de lien : temporaire au nom aléatoire du même dossier, créé exclusif en 0600, groupe et droits posés sur son descripteur, puis renommé (jamais laissé). */
export function ecrireSecret(
  chemin: string,
  corps: Uint8Array,
  mode: number,
  gid: number | null = null,
): void {
  const tmp = path.join(
    path.dirname(chemin),
    `.${path.basename(chemin)}.${randomBytes(6).toString("hex")}.tmp`,
  );
  const fd = openSync(
    tmp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    try {
      writeFileSync(fd, corps);
      if (gid !== null) fchownSync(fd, -1, gid);
      fchmodSync(fd, mode);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, chemin);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}
