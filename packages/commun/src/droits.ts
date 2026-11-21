// SPDX-License-Identifier: MIT
/** packages/commun/src/droits.ts — droits de l'état partagé entre services : privés au compte, ou au groupe des données (`ELPIS_GROUPE_DONNEES`) quand chaque service a son compte. */
import { readFileSync } from "node:fs";

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

let gidConnu: { nom: string; gid: number | null } | null = null;

/** GID du groupe des données : valeur numérique, sinon `/etc/group`, sinon le groupe principal du process. */
function gidDonnees(nom: string): number | null {
  if (gidConnu?.nom !== nom) {
    const gid = /^\d+$/u.test(nom) ? Number(nom) : gidDansAnnuaire(nom);
    gidConnu = { nom, gid: gid ?? process.getgid?.() ?? null };
  }
  return gidConnu.gid;
}

/** Dossier sûr : à ce compte sans droit pour le groupe ni les autres, ou, sous le groupe des données, à ce groupe sans droit pour les autres. */
export function dossierDeConfiance(st: { uid: number; gid: number; mode: number }): boolean {
  if (st.uid === process.geteuid?.() && (st.mode & 0o077) === 0) return true;
  const nom = groupeDonnees();
  return nom !== null && st.gid === gidDonnees(nom) && (st.mode & 0o007) === 0;
}
