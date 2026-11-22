// SPDX-License-Identifier: MIT
/** apps/core/src/memoire/migration.ts — magasin `memory` d'un compte et reprise de l'ancien quand il manque (`.memory` en place, puis `memory` et `.memory` de `<SANDBOX_DIR>/<compte>` s'ils sont à ce compte, ancienne disposition), recopié sans suivre de lien, port de llm_core/memory/_migrate.py. */
import { randomBytes } from "node:crypto";
import { closeSync, fstatSync, readFileSync } from "node:fs";
import { mkdir, rename, stat, utimes, writeFile } from "node:fs/promises";

import { config } from "@elpis/config";
import { ErreurCheminBac, ouvrirFeuille, parcourirSous, supprimerEntreeSous } from "@elpis/securite";
import type { DossierParcouru } from "@elpis/securite";

import { journal } from "../journal";
import { cheminPy, LEGACY_MEMORY_SUBDIR, MEMORY_SUBDIR, safeUsername } from "./portee";

/** Dossier des instantanés de l'ancienne disposition, jamais pris pour un compte. */
const INSTANTANES = "_snapshots";

async function existe(chemin: string): Promise<boolean> {
  try {
    await stat(chemin);
    return true;
  } catch {
    return false;
  }
}

/** Plafond d'un fichier repris d'un ancien magasin (16 Mio) : au-delà, laissé et signalé au journal. */
const PLAFOND_FICHIER = 16 * 1024 * 1024;

/** Ancien magasin `rel` sous `base` parcouru par descripteurs (sans suivre de lien : dossiers et fichiers ordinaires seuls ; avec `aCeCompte`, seulement si le dossier ouvert est à ce compte) recopié dans `cible`, dates gardées ; nombre de fichiers, 0 s'il est absent, vide, un lien ou écarté. */
async function recopier(base: string, rel: string, cible: string, aCeCompte: boolean): Promise<number> {
  const parcours = parcourirSous(base, rel);
  let suivant: IteratorResult<DossierParcouru>;
  try {
    suivant = parcours.next();
  } catch {
    return 0;
  }
  let n = 0;
  try {
    for (; !suivant.done; suivant = parcours.next()) {
      const d = suivant.value;
      if (d.relDir === rel && aCeCompte && fstatSync(d.fd).uid !== process.geteuid?.()) {
        journal("memory").warn(`ancien magasin ${cheminPy(base, rel)} laissé : il n'est pas à ce compte`);
        return 0;
      }
      const ici = d.relDir === rel ? cible : cheminPy(cible, d.relDir.slice(rel.length + 1));
      await mkdir(ici, { recursive: true });
      for (const nom of d.fichiers) {
        let fd: number;
        try {
          fd = ouvrirFeuille(d.fd, nom);
        } catch (e) {
          if (e instanceof ErreurCheminBac) continue;
          throw e;
        }
        try {
          const st = fstatSync(fd);
          if (st.size > PLAFOND_FICHIER) {
            journal("memory").warn(`ancien magasin : ${cheminPy(base, d.relDir, nom)} trop gros, laissé`);
            continue;
          }
          const vers = cheminPy(ici, nom);
          await writeFile(vers, readFileSync(fd), { flag: "wx" });
          await utimes(vers, st.atime, st.mtime);
          n += 1;
        } finally {
          closeSync(fd);
        }
      }
    }
  } finally {
    parcours.return(undefined);
  }
  return n;
}

/** Assure `{racine}/{compte}/memory` ; manquant, y recopie le premier ancien magasin non vide ; rend le dossier, ne lève jamais. */
export async function migrateLegacyMemory(
  racine: string,
  username: string | null | undefined,
  sandboxDir: string = String(config.SANDBOX_DIR),
): Promise<string> {
  const nom = safeUsername(username);
  const base = cheminPy(racine, nom);
  const neuf = cheminPy(base, MEMORY_SUBDIR);
  if (await existe(neuf)) return neuf;
  try {
    const sources: [string, string, boolean][] = [[racine, `${nom}/${LEGACY_MEMORY_SUBDIR}`, false]];
    if (nom !== INSTANTANES && cheminPy(sandboxDir) !== cheminPy(racine))
      sources.push(
        [sandboxDir, `${nom}/${MEMORY_SUBDIR}`, true],
        [sandboxDir, `${nom}/${LEGACY_MEMORY_SUBDIR}`, true],
      );
    await mkdir(base, { recursive: true });
    for (const [r, rel, aCeCompte] of sources) {
      const tmp = cheminPy(base, `.memory-reprise-${randomBytes(6).toString("hex")}`);
      try {
        if ((await recopier(r, rel, tmp, aCeCompte)) === 0) continue;
        await rename(tmp, neuf);
        journal("memory").info(`store migré ${cheminPy(r, rel)} → ${neuf}`);
        break;
      } finally {
        await supprimerEntreeSous(tmp).catch(() => undefined);
      }
    }
    await mkdir(neuf, { recursive: true });
  } catch (e) {
    journal("memory").warn(`migration legacy KO (${neuf}) : ${e instanceof Error ? e.message : String(e)}`);
    await mkdir(neuf, { recursive: true }).catch(() => undefined);
  }
  return neuf;
}
