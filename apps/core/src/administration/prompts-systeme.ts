// SPDX-License-Identifier: MIT
/** apps/core/src/administration/prompts-systeme.ts — fichiers de `system_prompts/` vus et édités par la console : catégorie contrôlée et contenue dans le dossier, lecture, écriture atomique (shared_infra/routes/admin/system_prompts.py). */
import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { chmod, open, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";

import { encoderUtf8Py, HttpError, lireTextePy, longueurPy, messageErreurOs, stMtimePy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { pyJoin, pyParent, realpathPy } from "@elpis/config";

import { dossierPromptsSysteme, listKnownCategories } from "../prompts/systeme";

const CATEGORY_RE = /^[a-zA-Z0-9_-]+$/u;
export const MAX_FILE_BYTES = 50_000;
const LETTRES_TEMPORAIRES = "abcdefghijklmnopqrstuvwxyz0123456789_";

/** Erreur du système de fichiers (OSError de Python), à distinguer d'une erreur de décodage. */
export function estErreurOs(e: unknown): boolean {
  return typeof (e as { code?: unknown } | null)?.code === "string";
}

function estDossier(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function estFichier(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function estSousRacine(chemin: string, racine: string): boolean {
  return chemin === racine || chemin.startsWith(racine === "/" ? "/" : `${racine}/`);
}

/** `_resolve_category_path` : nom `[A-Za-z0-9_-]+`, `_…` réservés sauf gabarit, chemin résolu (liens suivis) contenu dans le dossier. */
export function resoudreCategorie(categorie: string, avecGabarit = false): string {
  if (!categorie || !CATEGORY_RE.test(categorie)) throw new HttpError(400, "invalid category name");
  if (categorie.startsWith("_") && !avecGabarit) throw new HttpError(404, "reserved name");
  const dossier = dossierPromptsSysteme();
  if (!estDossier(dossier)) throw new HttpError(500, `SYSTEM_P directory missing: ${dossier}`);
  const p = realpathPy(pyJoin(dossier, `${categorie}.md`));
  if (!estSousRacine(p, realpathPy(dossier))) throw new HttpError(400, "path escapes system_prompts/");
  return p;
}

/** `GET /api/admin/system-prompts` : catégories connues avec taille (octets) et date, présence du gabarit. */
export async function listerPromptsSysteme(): Promise<Dict> {
  const dossier = dossierPromptsSysteme();
  const items: Dict[] = [];
  for (const cat of await listKnownCategories()) {
    try {
      const st = statSync(pyJoin(dossier, `${cat}.md`), { bigint: true });
      items.push({
        category: cat,
        size_chars: Number(st.size),
        mtime: Math.trunc(stMtimePy(st.mtimeNs)),
        exists: true,
      });
    } catch {
      items.push({ category: cat, size_chars: 0, mtime: 0, exists: false });
    }
  }
  return { directory: dossier, items, template_exists: estFichier(pyJoin(dossier, "_TEMPLATE.md")) };
}

/** `read_text(encoding="utf-8")` : 500 « read failed » pour une erreur d'E/S, un UTF-8 invalide remonte (500 aussi). */
export function lirePrompt(chemin: string, categorie: string): Dict {
  let texte: string;
  try {
    texte = lireTextePy(chemin);
  } catch (e) {
    if (estErreurOs(e)) throw new HttpError(500, `read failed: ${messageErreurOs(e, chemin)}`);
    throw e;
  }
  return { category: categorie, content: texte, size_chars: longueurPy(texte) };
}

/** `tempfile.mkstemp(dir, prefix=".<nom>.", suffix=".tmp")` : fichier temporaire unique créé en exclusivité (0600). */
async function temporaire(cible: string): Promise<{ fichier: FileHandle; chemin: string }> {
  const dossier = pyParent(cible);
  const nom = cible.slice(cible.lastIndexOf("/") + 1);
  for (;;) {
    const lettres = [...randomBytes(8)]
      .map((o) => LETTRES_TEMPORAIRES[o % LETTRES_TEMPORAIRES.length])
      .join("");
    const chemin = pyJoin(dossier, `.${nom}.${lettres}.tmp`);
    try {
      return { fichier: await open(chemin, "wx", 0o600), chemin };
    } catch (e) {
      if ((e as { code?: unknown }).code !== "EEXIST") echecEcriture(e, chemin);
    }
  }
}

/** `write failed: <OSError>` (500) : le chemin du temporaire, ou `'src' -> 'dst'` pour le remplacement, comme `str(OSError)`. */
function echecEcriture(e: unknown, chemin: string, cible?: string): never {
  if (!estErreurOs(e)) throw e;
  const message = messageErreurOs(e, chemin);
  throw new HttpError(500, `write failed: ${cible === undefined ? message : `${message} -> '${cible}'`}`);
}

/** `_write` hors de la boucle d'événements : cible confinée au dossier (revérifiée), temporaire unique, fsync (échec ignoré), droits 0644, remplacement atomique ; temporaire retiré en cas d'échec. */
export async function ecrirePrompt(cible: string, contenu: string): Promise<void> {
  if (!estSousRacine(realpathPy(pyParent(cible)), realpathPy(dossierPromptsSysteme())))
    throw new HttpError(400, "path escapes system_prompts/");
  const octets = encoderUtf8Py(contenu);
  const { fichier, chemin } = await temporaire(cible);
  let etape: "ecriture" | "remplacement" = "ecriture";
  try {
    try {
      await fichier.writeFile(octets);
      try {
        await fichier.sync();
      } catch {
        // comme le Python : un fsync refusé n'empêche pas l'écriture
      }
    } finally {
      await fichier.close();
    }
    await chmod(chemin, 0o644);
    etape = "remplacement";
    await rename(chemin, cible);
  } catch (e) {
    await unlink(chemin).catch(() => undefined);
    if (etape === "remplacement") echecEcriture(e, chemin, cible);
    echecEcriture(e, chemin);
  }
}
