// SPDX-License-Identifier: MIT
/** packages/verrous/src/balayage.ts — fichiers-verrous `flock` périmés (shared_infra/ops/maintenance.py `_sweep_stale_lock_files`) : retirés après 24 h quand plus personne ne les tient, d'après `/proc/locks`. */
import { lstat, readdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";

export const JOUR_S = 86_400;

/** Numéros d'inode portant un `flock` en ce moment (`/proc/locks`, détenteurs en attente compris) ; `null` si la table est illisible. */
export async function inodesVerrouilles(source = "/proc/locks"): Promise<Set<string> | null> {
  let texte: string;
  try {
    texte = await readFile(source, "utf8");
  } catch {
    return null;
  }
  const inodes = new Set<string>();
  for (const ligne of texte.split("\n")) {
    const m = /^\d+:\s+(?:->\s+)?FLOCK\s+\S+\s+\S+\s+\d+\s+[0-9a-f]+:[0-9a-f]+:(\d+)\s/u.exec(ligne);
    if (m?.[1] !== undefined) inodes.add(m[1]);
  }
  return inodes;
}

/** Retire les fichiers de `dossier` (ceux que `garder` retient) plus vieux que `maxAgeS` dont le `flock` est libre ; chacun est revérifié (date, inode) juste avant. */
export async function retirerVerrousLibres(
  dossier: string,
  maxAgeS: number,
  verrouilles: ReadonlySet<string>,
  maintenant: number,
  garder: (nom: string) => boolean = () => true,
): Promise<number> {
  let noms: string[];
  try {
    noms = await readdir(dossier);
  } catch {
    return 0;
  }
  let retires = 0;
  const limite = maintenant - maxAgeS;
  for (const nom of noms) {
    if (!garder(nom)) continue;
    const fichier = path.join(dossier, nom);
    try {
      const st = await lstat(fichier, { bigint: true });
      if (!st.isFile() || Number(st.mtimeMs) / 1000 > limite || verrouilles.has(String(st.ino))) continue;
      const encore = await lstat(fichier, { bigint: true });
      if (encore.ino !== st.ino || Number(encore.mtimeMs) / 1000 > limite) continue;
      await unlink(fichier);
      retires += 1;
    } catch {
      continue;
    }
  }
  return retires;
}

/** Fichiers-verrous de plus de `maxAgeS` dont le `flock` est libre, dans chacun des `dossiers` ; rien n'est supprimé si `/proc/locks` est illisible. */
export async function balayerVerrousPerimes(
  dossiers: readonly string[],
  maxAgeS = JOUR_S,
  maintenant = Date.now() / 1000,
): Promise<number> {
  const verrouilles = await inodesVerrouilles();
  if (verrouilles === null) return 0;
  let retires = 0;
  for (const dossier of dossiers)
    retires += await retirerVerrousLibres(dossier, maxAgeS, verrouilles, maintenant);
  return retires;
}
