// SPDX-License-Identifier: MIT
/** apps/toolhost/src/office/elagage.ts — élagage du cache des aperçus Office par l'hôte d'outils, son seul écrivain (sandbox/office_preview.py `prune_all`) : TTL et plafonds, dossiers de clé en conversion gardés, fichiers-verrous périmés retirés. */
import { lstat, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import { estErreurPython, intPy } from "@elpis/commun";
import { inodesVerrouilles, JOUR_S, retirerVerrousLibres } from "@elpis/verrous";

import { cacheRoot } from "./apercu";
import { cfg, dossierVerrous } from "./conversion";

const KEY_RE = /^[0-9a-f]{40}$/u;
const NOM_VERROU = /^[a-z0-9][a-z0-9_.-]{0,80}$/u;
const MANIFEST = "manifest.json";
const LIMITES_OFFICE = { cache_mb: 2048, cache_user_mb: 512, cache_ttl_days: 14 } as const;

/** `_limit` : réglage entier `office_preview.<cle>`, la valeur par défaut s'il est illisible (TypeError, ValueError). */
function limiteOffice(cle: keyof typeof LIMITES_OFFICE): number {
  try {
    return intPy(cfg(cle, LIMITES_OFFICE[cle]));
  } catch (e) {
    if (estErreurPython(e, "TypeError", "ValueError")) return LIMITES_OFFICE[cle];
    throw e;
  }
}

async function listerNoms(dossier: string): Promise<string[]> {
  try {
    return await readdir(dossier);
  } catch {
    return [];
  }
}

async function tailleDossier(dossier: string): Promise<number> {
  let total = 0;
  for (const e of await readdir(dossier, { withFileTypes: true, recursive: true }).catch(() => [])) {
    if (e.isDirectory()) continue;
    try {
      total += (await lstat(path.join(e.parentPath, e.name))).size;
    } catch {
      continue;
    }
  }
  return total;
}

interface EntreeCache {
  readonly utilise: number;
  readonly taille: number;
  readonly chemin: string;
  readonly cle: string;
}

/** `_entries` : dossiers de clé d'un compte avec leur dernier usage (date du manifeste, sinon du dossier) et leur taille, du plus ancien au plus récent. */
async function entreesCache(dossierCompte: string): Promise<EntreeCache[]> {
  const sortie: EntreeCache[] = [];
  for (const nom of await listerNoms(dossierCompte)) {
    if (!KEY_RE.test(nom)) continue;
    const chemin = path.join(dossierCompte, nom);
    let utilise: number;
    try {
      utilise = (await stat(path.join(chemin, MANIFEST))).mtimeMs / 1000;
    } catch {
      try {
        utilise = (await stat(chemin)).mtimeMs / 1000;
      } catch {
        continue;
      }
    }
    sortie.push({ utilise, taille: await tailleDossier(chemin), chemin, cle: nom });
  }
  return trier(sortie);
}

function trier(entrees: EntreeCache[]): EntreeCache[] {
  return entrees.sort(
    (a, b) =>
      a.utilise - b.utilise ||
      a.taille - b.taille ||
      (a.chemin < b.chemin ? -1 : a.chemin > b.chemin ? 1 : 0),
  );
}

/** `_remove_key_dir` : dossier de clé supprimé sauf conversion en cours (son verrou `key-<clé>.lock` est tenu). */
async function retirerDossierCle(
  chemin: string,
  cle: string,
  verrouilles: ReadonlySet<string>,
): Promise<boolean> {
  try {
    const st = await stat(path.join(dossierVerrous(), `key-${cle}.lock`), { bigint: true });
    if (verrouilles.has(String(st.ino))) return false;
  } catch {
    // pas de fichier de verrou : aucune conversion n'a tenu cette clé
  }
  await rm(chemin, { recursive: true, force: true }).catch(() => undefined);
  return true;
}

/** `prune_user` : tmp de plus d'une heure, puis dossiers de clé périmés (TTL) ou au-delà du plafond du compte. */
async function elaguerCompte(
  dossierCompte: string,
  capOctets: number,
  ttlS: number,
  maintenant: number,
  verrouilles: ReadonlySet<string>,
): Promise<number> {
  let retires = 0;
  for (const nom of await listerNoms(dossierCompte)) {
    if (!nom.startsWith(".tmp-")) continue;
    try {
      if (maintenant - (await stat(path.join(dossierCompte, nom))).mtimeMs / 1000 > 3600) {
        await rm(path.join(dossierCompte, nom), { recursive: true, force: true }).catch(() => undefined);
        retires += 1;
      }
    } catch {
      continue;
    }
  }
  const entrees = await entreesCache(dossierCompte);
  let total = entrees.reduce((n, e) => n + e.taille, 0);
  for (const e of entrees) {
    if (
      (maintenant - e.utilise > ttlS || total > capOctets) &&
      (await retirerDossierCle(e.chemin, e.cle, verrouilles))
    ) {
      total -= e.taille;
      retires += 1;
    }
  }
  return retires;
}

/** `prune_all` : TTL et plafond par compte, puis plafond global du cache d'aperçus, puis fichiers-verrous des conversions ; cache refusé ou `/proc/locks` illisible : rien n'est retiré. */
export async function elaguerCacheOffice(
  maintenant = Date.now() / 1000,
): Promise<{ removed: number; locks: number }> {
  const verrouilles = await inodesVerrouilles();
  let racine: string;
  try {
    if (verrouilles === null) return { removed: 0, locks: 0 };
    racine = cacheRoot();
  } catch {
    return { removed: 0, locks: 0 };
  }
  const ttlS = limiteOffice("cache_ttl_days") * JOUR_S;
  const capCompte = limiteOffice("cache_user_mb") * 1024 * 1024;
  const comptes: string[] = [];
  for (const e of await readdir(path.join(racine, "u"), { withFileTypes: true }).catch(() => []))
    if (e.isDirectory()) comptes.push(path.join(racine, "u", e.name));
  let removed = 0;
  for (const compte of comptes)
    removed += await elaguerCompte(compte, capCompte, ttlS, maintenant, verrouilles);
  const toutes: EntreeCache[] = [];
  for (const compte of comptes) toutes.push(...(await entreesCache(compte)));
  let total = toutes.reduce((n, e) => n + e.taille, 0);
  const plafond = limiteOffice("cache_mb") * 1024 * 1024;
  for (const e of trier(toutes)) {
    if (total <= plafond) break;
    if (await retirerDossierCle(e.chemin, e.cle, verrouilles)) {
      total -= e.taille;
      removed += 1;
    }
  }
  const locks = await retirerVerrousLibres(
    dossierVerrous(),
    JOUR_S,
    verrouilles,
    maintenant,
    (nom) => nom.endsWith(".lock") && NOM_VERROU.test(nom.slice(0, -5)),
  );
  return { removed, locks };
}
