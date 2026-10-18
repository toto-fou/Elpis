// SPDX-License-Identifier: MIT
/** apps/core/src/ops/balayages.ts — balayages des dossiers partagés de l'entretien : verrous périmés, tmp d'upload orphelins, cache des aperçus Office (shared_infra/ops/maintenance.py, sandbox/office_preview.py). */
import { chmod, lstat, mkdir, readdir, readFile, rm, stat, unlink } from "node:fs/promises";
import path from "node:path";

import { estErreurPython, intPy, strPy, stripPy, veritePy } from "@elpis/commun";
import { config, liveConfigValue, pyJoin, realpathPy } from "@elpis/config";

import { cheminExecution } from "../llm/acces-moteurs";

const JOUR_S = 86_400;
const KEY_RE = /^[0-9a-f]{40}$/u;
const NOM_VERROU = /^[a-z0-9][a-z0-9_.-]{0,80}$/u;
const MANIFEST = "manifest.json";
const LIMITES_OFFICE = { cache_mb: 2048, cache_user_mb: 512, cache_ttl_days: 14 } as const;

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

async function listerNoms(dossier: string): Promise<string[]> {
  try {
    return await readdir(dossier);
  } catch {
    return [];
  }
}

/** Retire les fichiers de `dossier` plus vieux que `maxAgeS` dont le `flock` est libre ; chacun est revérifié (date, inode) juste avant. */
async function retirerVerrousLibres(
  dossier: string,
  maxAgeS: number,
  verrouilles: ReadonlySet<string>,
  maintenant: number,
  garder: (nom: string) => boolean,
): Promise<number> {
  let retires = 0;
  const limite = maintenant - maxAgeS;
  for (const nom of await listerNoms(dossier)) {
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

/** Dossiers de verrous `flock` : verrous par conversation (`chat_locks`) et sentinelles d'écriture des outils fichiers (`<sandbox>/.write_locks`). */
export function dossiersVerrous(): string[] {
  const dossiers = [cheminExecution("chat_locks", "ELPIS_CHAT_LOCK_DIR", "/tmp/elpis_chat_locks")];
  try {
    const sandbox = stripPy(process.env["APP_SANDBOX_DIR"] ?? "") || config.SANDBOX_DIR;
    dossiers.push(pyJoin(realpathPy(sandbox), ".write_locks"));
  } catch {
    // sandbox illisible : seul le dossier des conversations est balayé
  }
  return dossiers;
}

/** `_sweep_stale_lock_files` : fichiers-verrous de plus de 24 h dont le `flock` est libre (rien n'est supprimé si `/proc/locks` est illisible). */
export async function balayerVerrousPerimes(
  dossiers: readonly string[] = dossiersVerrous(),
  maxAgeS = JOUR_S,
  maintenant = Date.now() / 1000,
): Promise<number> {
  const verrouilles = await inodesVerrouilles();
  if (verrouilles === null) return 0;
  let retires = 0;
  for (const dossier of dossiers)
    retires += await retirerVerrousLibres(dossier, maxAgeS, verrouilles, maintenant, () => true);
  return retires;
}

/** `_sweep_orphan_part_files` : partagé avec l'hôte d'outils (@elpis/bac). */
export { balayerPartsOrphelines } from "@elpis/bac";

function reglageOffice(cle: string, defaut: unknown): unknown {
  const v = liveConfigValue(`office_preview.${cle}`, defaut);
  return v === null || v === undefined ? defaut : v;
}

/** `_limit` : réglage entier `office_preview.<cle>`, la valeur par défaut s'il est illisible (TypeError, ValueError). */
function limiteOffice(cle: keyof typeof LIMITES_OFFICE): number {
  try {
    return intPy(reglageOffice(cle, LIMITES_OFFICE[cle]));
  } catch (e) {
    if (estErreurPython(e, "TypeError", "ValueError")) return LIMITES_OFFICE[cle];
    throw e;
  }
}

/** `cache_root` : racine du cache d'aperçus, créée en 0700 ; `null` si elle n'est pas à nous (le Python lève OfficeError). */
async function racineCacheOffice(): Promise<string | null> {
  const dir = stripPy(strPy(veritePy(reglageOffice("cache_dir", "")) ? reglageOffice("cache_dir", "") : ""));
  const brut = stripPy(process.env["APP_OFFICE_CACHE_DIR"] ?? "") || dir;
  const racine = brut || path.join(config.SANDBOX_DIR, ".office-cache");
  try {
    await mkdir(racine, { recursive: true, mode: 0o700 });
    const st = await lstat(racine);
    if (!st.isDirectory() || st.uid !== process.geteuid?.()) return null;
    if ((st.mode & 0o077) !== 0) await chmod(racine, 0o700);
    return racine;
  } catch {
    return null;
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
  return sortie.sort(
    (a, b) =>
      a.utilise - b.utilise ||
      a.taille - b.taille ||
      (a.chemin < b.chemin ? -1 : a.chemin > b.chemin ? 1 : 0),
  );
}

/** Dossier des verrous de conversion : un `flock` tenu sur `key-<clé>.lock` protège le dossier de cette clé. */
function dossierVerrousOffice(): string {
  return cheminExecution("office_locks", "ELPIS_OFFICE_LOCK_DIR", "/tmp/elpis_office_locks");
}

/** `_remove_key_dir` : dossier de clé supprimé sauf conversion en cours (son verrou est tenu). */
async function retirerDossierCle(
  chemin: string,
  cle: string,
  verrouilles: ReadonlySet<string>,
): Promise<boolean> {
  try {
    const st = await stat(path.join(dossierVerrousOffice(), `key-${cle}.lock`), { bigint: true });
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

/** `oc.prune_lock_files` : fichiers `*.lock` des conversions de plus de 24 h dont le `flock` est libre. */
async function balayerVerrousOffice(verrouilles: ReadonlySet<string>, maintenant: number): Promise<number> {
  return retirerVerrousLibres(
    dossierVerrousOffice(),
    JOUR_S,
    verrouilles,
    maintenant,
    (nom) => nom.endsWith(".lock") && NOM_VERROU.test(nom.slice(0, -5)),
  );
}

/** `prune_all` : TTL et plafond par compte, puis plafond global du cache d'aperçus Office, puis fichiers-verrous des conversions. */
export async function elaguerCacheOffice(
  maintenant = Date.now() / 1000,
): Promise<{ removed: number; locks: number }> {
  const verrouilles = await inodesVerrouilles();
  const racine = verrouilles === null ? null : await racineCacheOffice();
  if (verrouilles === null || racine === null) return { removed: 0, locks: 0 };
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
  toutes.sort(
    (a, b) =>
      a.utilise - b.utilise ||
      a.taille - b.taille ||
      (a.chemin < b.chemin ? -1 : a.chemin > b.chemin ? 1 : 0),
  );
  let total = toutes.reduce((n, e) => n + e.taille, 0);
  const plafond = limiteOffice("cache_mb") * 1024 * 1024;
  for (const e of toutes) {
    if (total <= plafond) break;
    if (await retirerDossierCle(e.chemin, e.cle, verrouilles)) {
      total -= e.taille;
      removed += 1;
    }
  }
  return { removed, locks: await balayerVerrousOffice(verrouilles, maintenant) };
}
