// SPDX-License-Identifier: MIT
/** packages/config/src/brut.ts — config.json brut (emplacement, lecture tolérante), chemins et coercitions de config.py. */
import { readFileSync, writeSync } from "node:fs";

import {
  ErreurPython,
  estDict,
  existePy,
  floatPy,
  getPy,
  intPy,
  ouPy,
  poserCle,
  pyJoin,
  pyJsonLoads,
  pyParent,
  pyPath,
  realpathPy,
  rstripPy,
  stripPy,
  strPy,
  veritePy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";

export { pyJoin, pyParent, pyPath, realpathPy };

export { estDict, existePy, getPy, ouPy, poserCle, rstripPy };
export type { Dict };

export type Env = Readonly<Record<string, string | undefined>>;

/** Erreur système (l'`OSError` de Python), par opposition à une erreur de programmation ou de décodage. */
export function estErreurSysteme(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return e instanceof Error && typeof code === "string" && !code.startsWith("ERR_");
}

/** Écrit tout le tampon (un `writeSync` peut écrire moins que demandé). */
export function ecrireTout(fd: number, donnees: Buffer): void {
  let ecrit = 0;
  while (ecrit < donnees.length) ecrit += writeSync(fd, donnees, ecrit, donnees.length - ecrit);
}

export function deepGet(d: unknown, chemin: string, defaut: unknown): unknown {
  let courant = d;
  for (const partie of chemin.split(".")) {
    if (!estDict(courant) || !Object.hasOwn(courant, partie)) return defaut;
    courant = courant[partie];
  }
  return courant;
}

export function asInt(v: unknown, defaut: number): number {
  try {
    return intPy(v);
  } catch {
    return defaut;
  }
}

export function asFloat(v: unknown, defaut: number): number {
  try {
    return floatPy(v);
  } catch {
    return defaut;
  }
}

/** `None` et un texte blanc valent « absent » : une variable d'env vide n'écrase pas config.json. */
export function asStr(v: unknown, defaut: string): string {
  if (v === null || v === undefined) return defaut;
  if (typeof v === "string") return stripPy(v) ? v : defaut;
  return strPy(v);
}

const ENV_VRAI: ReadonlySet<string> = new Set(["1", "true", "yes", "on"]);
const ENV_FAUX: ReadonlySet<string> = new Set(["0", "false", "no", "off"]);

/** Interrupteur d'env qui ne fait qu'allumer : 1/true/yes/on. */
export function envVrai(v: unknown): boolean {
  return ENV_VRAI.has(stripPy(asStr(v, "")).toLowerCase());
}

/** Env positionnée (1/true/yes/on ou 0/false/no/off) sinon vérité de Python du défaut (`"false"` est vrai). */
export function asBool(envVal: unknown, cfgDefaut: unknown): boolean {
  const s = stripPy(asStr(envVal, "")).toLowerCase();
  if (ENV_VRAI.has(s)) return true;
  if (ENV_FAUX.has(s)) return false;
  return veritePy(cfgDefaut);
}

/** `_resolve_rel` : absolu gardé tel quel (normalisé, `..` compris), relatif résolu sous la racine. */
export function resolveRel(p: string, racine: string): string {
  if (!p) return p;
  const chemin = pyPath(p);
  return chemin.startsWith("/") ? chemin : realpathPy(pyJoin(racine, chemin));
}

/** `_resolve_path` : `Path.resolve()` de `p` (ou du défaut), relatif à la racine. */
export function resolvePath(p: string, defaut: string, racine: string): string {
  const chemin = pyPath(p || defaut);
  return realpathPy(chemin.startsWith("/") ? chemin : pyJoin(racine, chemin));
}

const DECODEUR_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** `open(chemin, encoding="utf-8").read()` : UTF-8 strict (ValueError comme UnicodeDecodeError), BOM gardé, fins de ligne universelles. */
export function lireTextePy(chemin: string): string {
  const octets = readFileSync(chemin);
  let texte: string;
  try {
    texte = DECODEUR_UTF8.decode(octets);
  } catch {
    throw new ErreurPython("ValueError", `'utf-8' codec can't decode ${chemin}: invalid UTF-8`);
  }
  return texte.replace(/\r\n?/g, "\n");
}

const FINS_DE_LIGNE_PY: ReadonlySet<number> = new Set([
  0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x85, 0x2028, 0x2029,
]);

/** `texte.splitlines()[0]`, ou `""` pour un texte vide. */
export function premiereLignePy(texte: string): string {
  for (let i = 0; i < texte.length; i++)
    if (FINS_DE_LIGNE_PY.has(texte.charCodeAt(i))) return texte.slice(0, i);
  return texte;
}

/** `json.loads` en mode « natif » : objets de `JSON.parse`, NaN et ±Infinity admis. */
export function parseJsonPy(texte: string): unknown {
  return pyJsonLoads(texte, { mode: "natif" });
}

/** `_read_json_file` : `{}` si le fichier manque, est illisible, n'est pas du JSON ou pas un objet ; un stat refusé lève. */
export function readJsonFile(chemin: string): Dict {
  if (!existePy(chemin)) return {};
  try {
    const donnees = parseJsonPy(lireTextePy(chemin));
    return estDict(donnees) ? donnees : {};
  } catch {
    return {};
  }
}

/** `APP_CONFIG_PATH` > `<racine>/config.json` > ancien `<racine>/shared_infra/config.json` (signalé sur stdout). */
export function resolveConfigJsonPath(env: Env, racine: string, avertir = true): string {
  const explicite = env["APP_CONFIG_PATH"];
  if (explicite) return realpathPy(explicite);
  const aLaRacine = pyJoin(racine, "config.json");
  if (existePy(aLaRacine)) return realpathPy(aLaRacine);
  const ancien = pyJoin(pyJoin(racine, "shared_infra"), "config.json");
  if (!existePy(ancien)) return realpathPy(aLaRacine);
  if (avertir) {
    process.stdout.write(
      `[config] ATTENTION : config.json lu depuis son ANCIEN emplacement (${ancien}). ` +
        `Déplacez-le à la racine du dépôt (${aLaRacine}) — le repli disparaîtra. Sans lui, l'instance ` +
        "repartirait avec un secret de session neuf, sans TLS et sans clé Qdrant, en silence.\n",
    );
  }
  return realpathPy(ancien);
}

/** Gèle un objet et tout ce qu'il contient (une vue partagée ne doit pas pouvoir être modifiée). */
export function gelerProfond<T>(v: T): T {
  if (typeof v === "object" && v !== null && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) gelerProfond(x);
  }
  return v;
}
