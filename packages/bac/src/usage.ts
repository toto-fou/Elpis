// SPDX-License-Identifier: MIT
/** packages/bac/src/usage.ts — occupation du bac d'un compte (routes/_helpers.py : `_sandbox_size_bytes`, `sandbox_usage_bytes` en cache et à vol unique, `bump`, `invalidate`) et ménage des envois abandonnés (`_sweep_orphan_part_files`). */
import { execFile } from "node:child_process";
import { lstat, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { strPy } from "@elpis/commun";
import { config, pyPath, realpathPy } from "@elpis/config";

import { appelDocker, decoderRemplace, labelFilter, which } from "./docker";

const USAGE_TTL_S = 30;
/** Au-delà de ce remplissage, un chemin qui fait respecter le quota recalcule au lieu de croire le cache. */
const USAGE_EXACT_ABOVE_PCT = 0.9;
const DU_DELAI_MS = 15_000;
const JOUR_S = 86_400;
export const UPLOAD_TMP_SUFFIX = ".elpis-upload.part";

async function estDossierSuivi(chemin: string): Promise<boolean> {
  try {
    return (await stat(chemin)).isDirectory();
  } catch {
    return false;
  }
}

/** Repli de `du` : `os.walk` sans suivre les liens, taille `lstat` de chaque fichier. */
async function parcourir(dossier: string): Promise<number> {
  let total = 0;
  let entrees;
  try {
    entrees = await readdir(dossier, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entrees) {
    const chemin = join(dossier, e.name);
    if (e.isDirectory()) total += await parcourir(chemin);
    else if (!(e.isSymbolicLink() && (await estDossierSuivi(chemin)))) {
      try {
        total += (await lstat(chemin)).size;
      } catch {
        continue;
      }
    }
  }
  return total;
}

function du(racine: string): Promise<number | null> {
  if (which("du") === null) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile("du", ["-sb", racine], { timeout: DU_DELAI_MS, encoding: "utf8" }, (erreur, sortie) => {
      const premier = !erreur && sortie.trim() ? sortie.split(/\s+/u)[0] : undefined;
      resolve(premier !== undefined && /^\d+$/u.test(premier) ? Number(premier) : null);
    });
  });
}

/** `_sandbox_size_bytes` : `du -sb`, sinon somme des tailles des fichiers (liens non suivis). */
export async function tailleBac(racine: string): Promise<number> {
  return (await du(racine)) ?? (await parcourir(racine));
}

const cache = new Map<string, { t: number; octets: number; uid: number }>();
const enCours = new Map<string, Promise<number>>();

const maintenantS = (): number => performance.now() / 1000;

/** `sandbox_usage_bytes` : occupation gardée `maxAgeS` par (compte, racine), un seul calcul à la fois ; `quotaBytes` : recalculée près de la limite. */
export async function sandboxUsageBytes(
  uid: number,
  racine: string,
  o: { maxAgeS?: number; quotaBytes?: number } = {},
): Promise<number> {
  const maxAgeS = o.maxAgeS ?? USAGE_TTL_S;
  const quota = o.quotaBytes ?? 0;
  const cle = `${uid}\0${racine}`;
  const valide = (): number | null => {
    const hit = cache.get(cle);
    if (hit === undefined || maxAgeS <= 0 || maintenantS() - hit.t > maxAgeS) return null;
    return quota > 0 && hit.octets >= quota * USAGE_EXACT_ABOVE_PCT ? null : hit.octets;
  };
  let v = valide();
  if (v !== null) return v;
  for (let vol = enCours.get(cle); vol !== undefined; vol = enCours.get(cle)) {
    await vol.catch(() => undefined);
    v = valide();
    if (v !== null) return v;
  }
  const calcul = tailleBac(racine).then((octets) => {
    cache.set(cle, { t: maintenantS(), octets, uid });
    return octets;
  });
  enCours.set(cle, calcul);
  try {
    return await calcul;
  } finally {
    enCours.delete(cle);
  }
}

/** `bump_sandbox_usage` : delta d'une écriture connue appliqué à toutes les racines du compte, sans relancer `du` ni rajeunir la mesure. */
export function bumpSandboxUsage(uid: number, delta: number): void {
  for (const [cle, hit] of cache)
    if (hit.uid === uid) cache.set(cle, { ...hit, octets: Math.max(0, hit.octets + delta) });
}

/** `invalidate_sandbox_usage` : recalcul au prochain accès, pour toutes les racines du compte. */
export function invalidateSandboxUsage(uid: number): void {
  for (const [cle, hit] of [...cache]) if (hit.uid === uid) cache.delete(cle);
}

/** `reset_sandbox_usage_cache` (tests). */
export function oublierOccupations(): void {
  cache.clear();
}

/** Conteneurs dont le montage `/work` est sous `racine` (bacs de CETTE instance) ; inspection en échec : aucun. */
async function conteneursDeLInstance(noms: readonly string[], racine: string): Promise<string[]> {
  if (noms.length === 0 || !racine) return [];
  const bases = new Set([pyPath(racine), realpathPy(racine)].map((b) => b.replace(/\/+$/u, "")));
  const sous = (source: string): boolean => [...bases].some((b) => b && source.startsWith(`${b}/`));
  try {
    const r = await appelDocker(
      [
        "inspect",
        "--format",
        '{{.Name}}|{{range .Mounts}}{{if eq .Destination "/work"}}{{.Source}}{{end}}{{end}}',
        ...noms,
      ],
      15_000,
    );
    if (r.delaiDepasse) return [];
    const retenus = new Set<string>();
    for (const ligne of decoderRemplace(r.sortie).split("\n")) {
      const i = ligne.indexOf("|");
      if (i > 0 && sous(ligne.slice(i + 1).trim())) retenus.add(ligne.slice(0, i).replace(/^\//u, ""));
    }
    return noms.filter((n) => retenus.has(n));
  } catch {
    return [];
  }
}

/** `_sweep_orphan_part_files` : dans chaque conteneur de bac en marche DE CETTE INSTANCE (`/work` sous `racineBacs`, écart : le Python les prenait tous), les tmp d'envoi par morceaux de plus de `maxAgeS` secondes sous /work. */
export async function balayerPartsOrphelines(
  maxAgeS = JOUR_S,
  racineBacs: string = strPy(config.SANDBOX_DIR || ""),
): Promise<number> {
  if (which("docker") === null) return 0;
  let noms: string[];
  try {
    const ps = await appelDocker(["ps", ...labelFilter("user_id"), "--format", "{{.Names}}"], 15_000);
    if (ps.delaiDepasse) return 0;
    noms = decoderRemplace(ps.sortie).split(/\s+/u).filter(Boolean);
  } catch {
    return 0;
  }
  noms = await conteneursDeLInstance(noms, racineBacs);
  const minutes = String(Math.max(1, Math.floor(maxAgeS / 60)));
  let retires = 0;
  for (const nom of noms) {
    try {
      const r = await appelDocker(
        [
          ...["exec", "-u", "0:0", nom, "find", "/work", "-xdev", "-type", "f"],
          ...["-name", `*${UPLOAD_TMP_SUFFIX}`, "-mmin", `+${minutes}`, "-print", "-delete"],
        ],
        120_000,
      );
      if (r.delaiDepasse) continue;
      retires += decoderRemplace(r.sortie)
        .split("\n")
        .filter((ligne) => ligne.trim() !== "").length;
    } catch {
      continue;
    }
  }
  return retires;
}
