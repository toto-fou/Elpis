// SPDX-License-Identifier: MIT
/** apps/core/src/memoire/migration.ts — relocalisation unique de l'ancien `{sandbox}/{compte}/.memory` vers `memory`, port de llm_core/memory/_migrate.py. */
import { cp, mkdir, readdir, stat } from "node:fs/promises";

import { journal } from "../journal";
import { cheminPy, LEGACY_MEMORY_SUBDIR, MEMORY_SUBDIR, safeUsername } from "./portee";

async function existe(chemin: string): Promise<boolean> {
  try {
    await stat(chemin);
    return true;
  } catch {
    return false;
  }
}

async function nonVide(dossier: string): Promise<boolean> {
  try {
    return (await stat(dossier)).isDirectory() && (await readdir(dossier)).length > 0;
  } catch {
    return false;
  }
}

/** Assure `{sandbox}/{compte}/memory`, y copie une fois l'ancien `.memory` non vide ; rend le dossier, ne lève jamais. */
export async function migrateLegacyMemory(
  sandboxDir: string,
  username: string | null | undefined,
): Promise<string> {
  const base = cheminPy(sandboxDir, safeUsername(username));
  const neuf = cheminPy(base, MEMORY_SUBDIR);
  const ancien = cheminPy(base, LEGACY_MEMORY_SUBDIR);
  if (await existe(neuf)) return neuf;
  try {
    if (await nonVide(ancien)) {
      await cp(ancien, neuf, {
        recursive: true,
        dereference: true,
        preserveTimestamps: true,
        errorOnExist: true,
        force: false,
      });
      journal("memory").info(`store migré ${ancien} → ${neuf}`);
    } else {
      await mkdir(neuf, { recursive: true });
    }
  } catch (e) {
    journal("memory").warn(`migration legacy KO (${ancien}) : ${e instanceof Error ? e.message : String(e)}`);
    await mkdir(neuf, { recursive: true }).catch(() => undefined);
  }
  return neuf;
}
