// SPDX-License-Identifier: MIT
/** apps/core/src/observabilite/sondes.ts — mesures système lues dans /proc et /sys avec la sémantique de psutil 7 (CPU, mémoire, disques, process, cœurs, fréquence). */
import { existsSync, lstatSync, readdirSync, readFileSync, statfsSync, statSync } from "node:fs";
import { endianness, loadavg } from "node:os";
import path from "node:path";

import { arrondiPy } from "@elpis/commun";

import { sommePython } from "../llm/ordonnanceur/etat";

export interface Racines {
  readonly proc: string;
  readonly sys: string;
}

export const RACINES_SYSTEME: Racines = { proc: "/proc", sys: "/sys" };

/** `SC_CLK_TCK` : 100 sur Linux (USER_HZ fixé par l'ABI). */
export const CLOCK_TICKS = 100;
export const DISK_SECTOR_SIZE = 512;

const CHAMPS_CPU = [
  "user",
  "nice",
  "system",
  "idle",
  "iowait",
  "irq",
  "softirq",
  "steal",
  "guest",
  "guest_nice",
];

function lireTexte(chemin: string): string {
  return readFileSync(chemin, "latin1");
}

/** Itération d'un fichier texte comme Python : lignes fin comprise, aucune ligne vide ajoutée après le dernier saut. */
function lignesPy(texte: string): string[] {
  return texte === "" ? [] : texte.split(/(?<=\n)/u);
}

/** `bytes.split()` : découpe sur les blancs ASCII. */
function mots(ligne: string): string[] {
  return ligne.split(/[ \t\n\r\v\f]+/u).filter((m) => m !== "");
}

/** `int(texte)` d'un champ de /proc (chiffres, signe facultatif) ; ValueError comme Python sinon. */
function entierProc(texte: string | undefined): number {
  if (texte === undefined || !/^[+-]?\d+$/u.test(texte))
    throw new Error(`invalid literal for int(): ${String(texte)}`);
  return Number(texte);
}

export interface TempsCpu {
  readonly champs: readonly string[];
  readonly valeurs: readonly number[];
}

/** `cpu_times()` : première ligne de `stat`, chaque champ divisé par CLOCK_TICKS (7 à 10 champs selon le noyau). */
export function cpuTimes(r: Racines = RACINES_SYSTEME): TempsCpu {
  const premiere = lireTexte(path.join(r.proc, "stat")).split("\n", 1)[0] ?? "";
  const valeurs = mots(premiere).slice(1);
  const n = Math.min(CHAMPS_CPU.length, Math.max(7, valeurs.length));
  const champs = CHAMPS_CPU.slice(0, n);
  return { champs, valeurs: champs.map((_c, i) => Number(valeurs[i] ?? Number.NaN) / CLOCK_TICKS) };
}

function champ(t: TempsCpu, nom: string): number {
  const i = t.champs.indexOf(nom);
  return i < 0 ? 0 : (t.valeurs[i] ?? 0);
}

/** `_cpu_tot_time` : `sum()` compensé des champs, moins `guest` et `guest_nice` déjà comptés dans user/nice. */
function totalCpu(t: TempsCpu): number {
  return sommePython(t.valeurs) - champ(t, "guest") - champ(t, "guest_nice");
}

/** `cpu_percent` entre deux relevés : écarts négatifs ramenés à 0, `iowait` compté comme inactif, arrondi à 0,1. */
export function pourcentageCpu(t1: TempsCpu, t2: TempsCpu): number {
  const delta: TempsCpu = {
    champs: t2.champs,
    valeurs: t2.valeurs.map((v, i) => Math.max(0, v - (t1.valeurs[i] ?? 0))),
  };
  const tout = totalCpu(delta);
  const occupe = tout - champ(delta, "idle") - champ(delta, "iowait");
  if (tout === 0) return 0.0;
  return arrondiPy((occupe / tout) * 100, 1);
}

/** `cpu_percent(interval=None)` d'un appelant : écart depuis son relevé précédent (le premier compare deux relevés immédiats). */
export class MesureCpu {
  private precedent: TempsCpu | null = null;
  private readonly racines: Racines;

  constructor(r: Racines = RACINES_SYSTEME) {
    this.racines = r;
  }

  pourcentage(): number {
    const t1 = this.precedent ?? cpuTimes(this.racines);
    this.precedent = cpuTimes(this.racines);
    return pourcentageCpu(t1, this.precedent);
  }
}

export interface MemoireVirtuelle {
  total: number;
  available: number;
  percent: number;
  used: number;
  free: number;
  active: number;
  inactive: number;
  buffers: number;
  cached: number;
  shared: number;
  slab: number;
}

const pages = new Map<string, number>();

/** `AT_PAGESZ` du vecteur auxiliaire (`getpagesize()`), mots de 64 bits en petit-boutiste ; `null` s'il est illisible. */
function pageAuxv(r: Racines): number | null {
  if (endianness() !== "LE" || !["x64", "arm64", "riscv64", "loong64", "ppc64"].includes(process.arch))
    return null;
  try {
    const b = readFileSync(path.join(r.proc, "self", "auxv"));
    for (let i = 0; i + 16 <= b.length; i += 16) {
      const type = b.readBigUInt64LE(i);
      if (type === 0n) break;
      if (type === 6n) return Number(b.readBigUInt64LE(i + 8));
    }
  } catch {
    return null;
  }
  return null;
}

/** Taille d'une page du process (`getpagesize()` par auxv, sinon `KernelPageSize` de smaps), 4096 à défaut ; lue une fois par racine. */
export function taillePage(r: Racines = RACINES_SYSTEME): number {
  const connue = pages.get(r.proc);
  if (connue !== undefined) return connue;
  let taille = pageAuxv(r);
  if (taille === null) {
    const smaps = lireBrut(path.join(r.proc, "self", "smaps"));
    const m = smaps === null ? null : /^KernelPageSize:\s+(\d+)\s+kB$/mu.exec(smaps);
    taille = m ? Number(m[1]) * 1024 : 4096;
  }
  pages.set(r.proc, taille);
  return taille;
}

/** `usage_percent(used, total, round_)`. */
export function usagePercent(used: number, total: number, chiffres: number | null = null): number {
  if (total === 0) return 0.0;
  const ret = (used / total) * 100;
  return chiffres === null ? ret : arrondiPy(ret, chiffres);
}

function lireMeminfo(r: Racines): Map<string, number> {
  const mems = new Map<string, number>();
  for (const ligne of lignesPy(lireTexte(path.join(r.proc, "meminfo")))) {
    const f = mots(ligne);
    if (f.length === 0) throw new Error("IndexError: list index out of range");
    mems.set(f[0] as string, entierProc(f[1]) * 1024);
  }
  return mems;
}

function exiger(mems: Map<string, number>, cle: string): number {
  const v = mems.get(cle);
  if (v === undefined) throw new Error(`KeyError: ${cle}`);
  return v;
}

/** `calculate_avail_vmem` : estimation de l'ancien noyau (filigranes bas de `zoneinfo`), repli libre + cache. */
function memoireDisponibleEstimee(mems: Map<string, number>, r: Racines): number {
  const free = exiger(mems, "MemFree:");
  const repli = free + (mems.get("Cached:") ?? 0);
  const actifs = mems.get("Active(file):");
  const inactifs = mems.get("Inactive(file):");
  const slab = mems.get("SReclaimable:");
  if (actifs === undefined || inactifs === undefined || slab === undefined) return repli;
  let zoneinfo: string;
  try {
    zoneinfo = lireTexte(path.join(r.proc, "zoneinfo"));
  } catch {
    return repli;
  }
  let bas = 0;
  for (const brute of lignesPy(zoneinfo)) {
    const ligne = brute.trim();
    if (ligne.startsWith("low")) bas += entierProc(mots(ligne)[1]);
  }
  bas *= taillePage(r);
  let avail = free - bas;
  let cache = actifs + inactifs;
  cache -= Math.min(cache / 2, bas);
  avail += cache;
  avail += slab - Math.min(slab / 2.0, bas);
  return Math.trunc(avail);
}

/** `virtual_memory()` : comme `free` (disponible = MemAvailable), utilisé = total − disponible, pourcentage arrondi à 0,1. */
export function virtualMemory(r: Racines = RACINES_SYSTEME): MemoireVirtuelle {
  const mems = lireMeminfo(r);
  const total = exiger(mems, "MemTotal:");
  const free = exiger(mems, "MemFree:");
  const buffers = mems.get("Buffers:") ?? 0;
  let cached = mems.get("Cached:") ?? 0;
  if (mems.has("Cached:")) cached += mems.get("SReclaimable:") ?? 0;
  const shared = mems.get("Shmem:") ?? mems.get("MemShared:") ?? 0;
  const active = mems.get("Active:") ?? 0;
  let inactive = mems.get("Inactive:");
  if (inactive === undefined) {
    const morceaux = ["Inact_dirty:", "Inact_clean:", "Inact_laundry:"].map((c) => mems.get(c));
    inactive = morceaux.every((m) => m !== undefined)
      ? morceaux.reduce<number>((a, b) => a + (b as number), 0)
      : 0;
  }
  const slab = mems.get("Slab:") ?? 0;
  let avail = mems.get("MemAvailable:");
  if (avail === undefined || avail === 0) avail = memoireDisponibleEstimee(mems, r);
  if (avail < 0) avail = 0;
  else if (avail > total) avail = free;
  return {
    total,
    available: avail,
    percent: usagePercent(total - avail, total, 1),
    used: total - avail,
    free,
    active,
    inactive,
    buffers,
    cached,
    shared,
    slab,
  };
}

/** `is_storage_device` : disque entier (ou virtuel) présent dans /sys/block, pas une partition. */
export function estPeripheriqueStockage(nom: string, r: Racines = RACINES_SYSTEME): boolean {
  return existsSync(path.join(r.sys, "block", nom.replaceAll("/", "!")));
}

type CompteursDisque = [number, number, number, number, number, number, number, number, number];

function* lignesDiskstats(texte: string): Generator<[string, ...CompteursDisque]> {
  for (const ligne of lignesPy(texte.replace(/\r\n?/gu, "\n"))) {
    const f = mots(ligne);
    const n = f.length;
    if (n === 15) {
      const [rm, rb, rt, w, wm, wb, wt, , busy] = f.slice(4, 14).map(entierProc) as number[];
      yield [
        f[3] as string,
        entierProc(f[2]),
        w as number,
        rb as number,
        wb as number,
        rt as number,
        wt as number,
        rm as number,
        wm as number,
        busy as number,
      ];
    } else if (n === 14 || n >= 18) {
      const [rd, rm, rb, rt, w, wm, wb, wt, , busy] = f.slice(3, 14).map(entierProc) as number[];
      yield [
        f[2] as string,
        rd as number,
        w as number,
        rb as number,
        wb as number,
        rt as number,
        wt as number,
        rm as number,
        wm as number,
        busy as number,
      ];
    } else if (n === 7) {
      const [rd, rb, w, wb] = f.slice(3).map(entierProc) as number[];
      yield [f[2] as string, rd as number, w as number, rb as number, wb as number, 0, 0, 0, 0, 0];
    } else {
      throw new Error(`not sure how to interpret line ${JSON.stringify(ligne)}`);
    }
  }
}

/** `DirEntry.is_dir()` de `os.walk` : un lien vers un dossier compte comme dossier. */
function estDossier(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function* lignesSysBlock(r: Racines): Generator<[string, ...CompteursDisque]> {
  const parcourir = function* (dossier: string): Generator<string> {
    let entrees: string[];
    try {
      entrees = readdirSync(dossier);
    } catch {
      return;
    }
    if (entrees.some((e) => e === "stat" && !estDossier(path.join(dossier, e)))) yield dossier;
    for (const e of entrees) {
      const p = path.join(dossier, e);
      try {
        if (lstatSync(p).isDirectory()) yield* parcourir(p);
      } catch {
        continue;
      }
    }
  };
  for (const bloc of readdirSync(path.join(r.sys, "block"))) {
    for (const racine of parcourir(path.join(r.sys, "block", bloc))) {
      const f = mots(lireTexte(path.join(racine, "stat")).trim())
        .slice(0, 10)
        .map(entierProc);
      if (f.length < 10)
        throw new Error(`ValueError: not enough values to unpack (expected 10, got ${f.length})`);
      const [rd, rm, rb, rt, w, wm, wb, wt, , busy] = f as number[];
      yield [
        path.basename(racine),
        rd as number,
        w as number,
        rb as number,
        wb as number,
        rt as number,
        wt as number,
        rm as number,
        wm as number,
        busy as number,
      ];
    }
  }
}

/** `_WrapNumbers` : un compteur qui redescend (débordement) est prolongé par l'ancienne valeur. */
export class Enrouleur {
  private cache: Map<string, CompteursDisque> | null = null;
  private readonly rappels = new Map<string, number>();

  appliquer(entree: Map<string, CompteursDisque>): Map<string, CompteursDisque> {
    if (this.cache === null) {
      this.cache = entree;
      return entree;
    }
    for (const cle of [...this.rappels.keys()]) {
      if (!entree.has(cle.slice(0, cle.lastIndexOf("#")))) this.rappels.delete(cle);
    }
    const sortie = new Map<string, CompteursDisque>();
    for (const [disque, valeurs] of entree) {
      const anciennes = this.cache.get(disque);
      if (anciennes === undefined) {
        sortie.set(disque, valeurs);
        continue;
      }
      sortie.set(
        disque,
        valeurs.map((v, i) => {
          const cle = `${disque}#${i}`;
          if (v < (anciennes[i] ?? 0))
            this.rappels.set(cle, (this.rappels.get(cle) ?? 0) + (anciennes[i] ?? 0));
          return v + (this.rappels.get(cle) ?? 0);
        }) as CompteursDisque,
      );
    }
    this.cache = entree;
    return sortie;
  }
}

export interface CompteursEs {
  read_count: number;
  write_count: number;
  read_bytes: number;
  write_bytes: number;
  read_time: number;
  write_time: number;
  read_merged_count: number;
  write_merged_count: number;
  busy_time: number;
}

const enrouleurDisques = new Enrouleur();

/** `disk_io_counters()` : totaux des disques entiers (partitions écartées), octets = secteurs × 512 ; `null` sans disque. */
export function diskIoCounters(
  r: Racines = RACINES_SYSTEME,
  enrouleur: Enrouleur = enrouleurDisques,
): CompteursEs | null {
  const fichier = path.join(r.proc, "diskstats");
  let source: Iterable<[string, ...CompteursDisque]>;
  if (existsSync(fichier)) source = lignesDiskstats(lireTexte(fichier));
  else if (existsSync(path.join(r.sys, "block"))) source = lignesSysBlock(r);
  else throw new Error(`${fichier} nor /sys/block are available on this system`);
  const brut = new Map<string, CompteursDisque>();
  for (const [nom, reads, writes, rbytes, wbytes, rtime, wtime, rmerged, wmerged, busy] of source) {
    if (!estPeripheriqueStockage(nom, r)) continue;
    brut.set(nom, [
      reads,
      writes,
      rbytes * DISK_SECTOR_SIZE,
      wbytes * DISK_SECTOR_SIZE,
      rtime,
      wtime,
      rmerged,
      wmerged,
      busy,
    ]);
  }
  if (brut.size === 0) return null;
  const somme = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const valeurs of enrouleur.appliquer(brut).values())
    valeurs.forEach((v, i) => (somme[i] = (somme[i] ?? 0) + v));
  const [rc, wc, rb, wb, rt, wt, rm, wm, busy] = somme as CompteursDisque;
  return {
    read_count: rc,
    write_count: wc,
    read_bytes: rb,
    write_bytes: wb,
    read_time: rt,
    write_time: wt,
    read_merged_count: rm,
    write_merged_count: wm,
    busy_time: busy,
  };
}

/** `boot_time()` : ligne `btime` de `stat`. */
export function bootTime(r: Racines = RACINES_SYSTEME): number {
  for (const ligne of lignesPy(lireTexte(path.join(r.proc, "stat")))) {
    if (ligne.startsWith("btime")) return Number(mots(ligne.trim())[1]);
  }
  throw new Error(`line 'btime' not found in ${path.join(r.proc, "stat")}`);
}

/** Mesures d'un process (`psutil.Process`) : RSS, descripteurs, threads, date de création. */
export class SondeProcessus {
  private readonly dossier: string;
  private readonly racines: Racines;
  private creation: number | null = null;

  constructor(pid: number | "self" = process.pid, r: Racines = RACINES_SYSTEME) {
    this.racines = r;
    this.dossier = path.join(r.proc, String(pid));
  }

  /** `memory_info().rss` : pages résidentes de `statm` × taille de page. */
  rss(): number {
    const f = mots(lireTexte(path.join(this.dossier, "statm")).split("\n", 1)[0] ?? "");
    return entierProc(f[1]) * taillePage(this.racines);
  }

  numFds(): number {
    return readdirSync(path.join(this.dossier, "fd")).length;
  }

  numThreads(): number {
    const m = /Threads:\t(\d+)/u.exec(lireTexte(path.join(this.dossier, "status")));
    if (!m) throw new Error("IndexError: list index out of range");
    return Number(m[1]);
  }

  /** `create_time()` : `starttime` (22e champ de `stat`, en ticks depuis le démarrage) / CLOCK_TICKS + `btime`. */
  createTime(): number {
    if (this.creation === null) {
      const data = lireTexte(path.join(this.dossier, "stat"));
      const champs = mots(data.slice(data.lastIndexOf(")") + 2));
      this.creation = Number(champs[19] ?? Number.NaN) / CLOCK_TICKS;
    }
    return this.creation + bootTime(this.racines);
  }
}

/** Plages d'UC en ligne (`0-3,6`) : leur nombre. */
export function compterPlagesCpu(texte: string): number {
  let n = 0;
  for (const morceau of texte.trim().split(",")) {
    if (!morceau) continue;
    const [a, b] = morceau.split("-").map(Number);
    if (a === undefined || Number.isNaN(a)) continue;
    n += b === undefined || Number.isNaN(b) ? 1 : b - a + 1;
  }
  return n;
}

/** `cpu_count()` : UC logiques en ligne (`SC_NPROCESSORS_ONLN`), lignes `cpuN` de `stat` à défaut ; `null` si inconnu. */
export function cpuCountLogical(r: Racines = RACINES_SYSTEME): number | null {
  const enLigne = lireBrut(path.join(r.sys, "devices", "system", "cpu", "online"));
  if (enLigne !== null && compterPlagesCpu(enLigne) >= 1) return compterPlagesCpu(enLigne);
  try {
    const n = lignesPy(lireTexte(path.join(r.proc, "stat"))).filter((l) =>
      /^cpu\d/u.test(l.split(" ")[0] ?? ""),
    ).length;
    return n >= 1 ? n : null;
  } catch {
    return null;
  }
}

function dossiersCpu(r: Racines, suffixe: string[]): string[] {
  const base = path.join(r.sys, "devices", "system", "cpu");
  let entrees: string[];
  try {
    entrees = readdirSync(base);
  } catch {
    return [];
  }
  return entrees
    .filter((e) => /^cpu[0-9]/u.test(e))
    .sort()
    .map((e) => path.join(base, e, ...suffixe))
    .filter((p) => existsSync(p));
}

/** `cpu_count(logical=False)` : listes de cœurs distinctes de la topologie, sinon `physical id` × `cpu cores` de cpuinfo. */
export function cpuCountCores(r: Racines = RACINES_SYSTEME): number | null {
  const fichiers = dossiersCpu(r, ["topology", "core_cpus_list"]);
  const listes = new Set<string>();
  for (const f of fichiers.length ? fichiers : dossiersCpu(r, ["topology", "thread_siblings_list"]))
    listes.add(lireTexte(f).trim());
  if (listes.size) return listes.size;
  const parSocle = new Map<number, number>();
  let courant = new Map<string, number>();
  for (const brute of lignesPy(lireTexte(path.join(r.proc, "cpuinfo")))) {
    const ligne = brute.trim().toLowerCase();
    if (!ligne) {
      const socle = courant.get("physical id");
      const coeurs = courant.get("cpu cores");
      if (socle !== undefined && coeurs !== undefined) parSocle.set(socle, coeurs);
      courant = new Map();
    } else if (ligne.startsWith("physical id") || ligne.startsWith("cpu cores")) {
      const i = ligne.indexOf("\t:");
      if (i < 0) throw new Error("ValueError: not enough values to unpack");
      courant.set(ligne.slice(0, i), entierProc(ligne.slice(i + 2).trim()));
    }
  }
  let total = 0;
  for (const c of parSocle.values()) total += c;
  return total >= 1 ? total : null;
}

function frequencesCpuinfo(r: Racines): number[] {
  return lignesPy(lireTexte(path.join(r.proc, "cpuinfo")))
    .filter((l) => l.toLowerCase().startsWith("cpu mhz"))
    .map((l) => Number(l.slice(l.indexOf(":") + 1).trim()));
}

/** `bcat(chemin, fallback=None)` / `cat(...)` : contenu brut, `null` s'il est illisible. */
function lireBrut(chemin: string): string | null {
  try {
    return lireTexte(chemin);
  } catch {
    return null;
  }
}

export interface FrequenceCpu {
  current: number;
  min: number | null;
  max: number | null;
}

/** Fréquences par UC : sysfs (`policyN` ou `cpuN/cpufreq`) si présent au démarrage, sinon les « cpu MHz » de cpuinfo. */
export function frequencesParCpu(r: Racines = RACINES_SYSTEME): FrequenceCpu[] {
  const sysCpu = path.join(r.sys, "devices", "system", "cpu");
  const avecSysfs =
    existsSync(path.join(sysCpu, "cpufreq", "policy0")) || existsSync(path.join(sysCpu, "cpu0", "cpufreq"));
  const cpuinfo = frequencesCpuinfo(r);
  if (!avecSysfs) return cpuinfo.map((x) => ({ current: x, min: 0.0, max: 0.0 }));
  let chemins: string[] = [];
  try {
    chemins = readdirSync(path.join(sysCpu, "cpufreq"))
      .filter((e) => /^policy[0-9]/u.test(e))
      .map((e) => path.join(sysCpu, "cpufreq", e));
  } catch {
    chemins = [];
  }
  if (!chemins.length) chemins = dossiersCpu(r, ["cpufreq"]);
  const numero = (p: string): number => Number(/[0-9]+/u.exec(p.slice(sysCpu.length))?.[0] ?? 0);
  chemins.sort((a, b) => numero(a) - numero(b));
  const sortie: FrequenceCpu[] = [];
  chemins.forEach((p, i) => {
    let courant: string | number | null =
      chemins.length === cpuinfo.length
        ? (cpuinfo[i] ?? 0) * 1000
        : lireBrut(path.join(p, "scaling_cur_freq"));
    if (courant === null) {
      courant = lireBrut(path.join(p, "cpuinfo_cur_freq"));
      if (courant === null) {
        if (lireBrut(path.join(sysCpu, `cpu${i}`, "online")) === "0\n") {
          sortie.push({ current: 0.0, min: 0.0, max: 0.0 });
          return;
        }
        throw new Error("can't find current frequency file");
      }
    }
    const lire = (f: string): number => {
      const brut = lireBrut(path.join(p, f));
      if (brut === null) throw new Error(`FileNotFoundError: ${path.join(p, f)}`);
      return Math.trunc(Number(brut.trim()));
    };
    sortie.push({
      current: Math.trunc(Number(courant)) / 1000,
      min: lire("scaling_min_freq") / 1000,
      max: lire("scaling_max_freq") / 1000,
    });
  });
  return sortie;
}

/** `cpu_freq()` : la seule UC, ou la moyenne de toutes ; `null` sans mesure. */
export function cpuFreq(r: Racines = RACINES_SYSTEME): FrequenceCpu | null {
  const liste = frequencesParCpu(r);
  if (liste.length === 0) return null;
  if (liste.length === 1) return liste[0] ?? null;
  let [cour, mins, maxs] = [0.0, 0.0, 0.0];
  let aucun = false;
  for (const f of liste) {
    cour += f.current;
    if (f.min === null || f.max === null) {
      aucun = true;
      continue;
    }
    mins += f.min;
    maxs += f.max;
  }
  return {
    current: cour / liste.length,
    min: aucun ? null : mins / liste.length,
    max: aucun ? null : maxs / liste.length,
  };
}

export interface UsageDisque {
  total: number;
  used: number;
  free: number;
  percent: number;
}

/** Calcul de `disk_usage` sur les champs de statvfs (blocs × taille de bloc). */
export function usageDisqueDepuis(
  blocs: number,
  libres: number,
  disponibles: number,
  taille: number,
): UsageDisque {
  const total = blocs * taille;
  const libresRoot = libres * taille;
  const libresUtilisateur = disponibles * taille;
  const used = total - libresRoot;
  return { total, used, free: libresUtilisateur, percent: usagePercent(used, used + libresUtilisateur, 1) };
}

/** `disk_usage(chemin)` : espace vu par un utilisateur ordinaire ; blocs comptés en `f_bsize` (Node n'expose pas `f_frsize`, égal sur ext4/xfs/btrfs). */
export function diskUsage(chemin = "/"): UsageDisque {
  const s = statfsSync(chemin);
  return usageDisqueDepuis(s.blocks, s.bfree, s.bavail, s.bsize);
}

/** `os.getloadavg()[0]`. */
export function chargeUneMinute(): number {
  return loadavg()[0] ?? 0;
}
