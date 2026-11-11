// SPDX-License-Identifier: MIT
/** apps/core/test/observabilite/sondes.test.ts — sondes /proc et /sys rejouées contre psutil sur des arborescences figées (vecteurs), puis sur la machine. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  bootTime,
  compterPlagesCpu,
  cpuCountCores,
  cpuCountLogical,
  cpuFreq,
  cpuTimes,
  diskIoCounters,
  diskUsage,
  Enrouleur,
  frequencesParCpu,
  MesureCpu,
  RACINES_SYSTEME,
  SondeProcessus,
  taillePage,
  usageDisqueDepuis,
  virtualMemory,
} from "../../src/observabilite/sondes";
import type { Racines } from "../../src/observabilite/sondes";

interface Scenario {
  nom: string;
  pid: number | null;
  fichiers: Record<string, string>;
  dossiers: string[];
  liens: Record<string, string>;
}

type Attendu = unknown;

const VECTEURS = JSON.parse(
  readFileSync(new URL("../vecteurs/observabilite-sondes.json", import.meta.url), "utf8"),
) as {
  entrees: {
    scenarios: Scenario[];
    sequence_cpu: string[];
    sequence_disques: string[];
    statvfs: [number, number, number, number][];
  };
  sorties: {
    pagesize: number;
    scenarios: Record<string, Attendu>[];
    cpu: number[];
    disques: Attendu[];
    statvfs: Attendu[];
  };
};
const { entrees, sorties } = VECTEURS;

let dossier = "";

function racines(nom: string): Racines {
  return { proc: path.join(dossier, nom, "proc"), sys: path.join(dossier, nom, "sys") };
}

function materialiser(sc: Scenario): void {
  const base = path.join(dossier, sc.nom);
  for (const rel of sc.dossiers) mkdirSync(path.join(base, rel), { recursive: true });
  for (const [rel, texte] of Object.entries(sc.fichiers)) {
    mkdirSync(path.dirname(path.join(base, rel)), { recursive: true });
    writeFileSync(path.join(base, rel), texte, "latin1");
  }
  for (const [rel, cible] of Object.entries(sc.liens)) symlinkSync(cible, path.join(base, rel));
}

/** Rejoue une mesure : la valeur, ou l'échec attendu (`{"erreur": …}` côté Python). */
function comparer(attendu: Attendu, mesure: () => unknown): void {
  if (attendu !== null && typeof attendu === "object" && !Array.isArray(attendu) && "erreur" in attendu) {
    expect(mesure).toThrow();
    return;
  }
  expect(mesure()).toEqual(attendu);
}

beforeAll(() => {
  dossier = mkdtempSync(path.join(tmpdir(), "elpis-sondes-"));
  for (const sc of entrees.scenarios) materialiser(sc);
});

afterAll(() => {
  rmSync(dossier, { recursive: true, force: true });
});

describe.each(entrees.scenarios.map((sc, i) => [sc.nom, sc, i] as const))("scénario %s", (nom, sc, i) => {
  const attendu = sorties.scenarios[i] as Record<string, Attendu>;

  it("cpu_times", () => comparer(attendu["temps"], () => [...cpuTimes(racines(nom)).valeurs]));
  it("virtual_memory", () => comparer(attendu["memoire"], () => virtualMemory(racines(nom))));
  it("disk_io_counters", () =>
    comparer(attendu["disques"], () => diskIoCounters(racines(nom), new Enrouleur())));
  it("boot_time", () => comparer(attendu["demarrage"], () => bootTime(racines(nom))));
  it("cpu_count(logical=False)", () => comparer(attendu["coeurs"], () => cpuCountCores(racines(nom))));
  it("cpu_freq", () => {
    comparer(attendu["frequence"], () => cpuFreq(racines(nom)));
    comparer(attendu["frequences"], () => frequencesParCpu(racines(nom)));
  });
  it.runIf(sc.pid !== null)("Process", () => {
    const p = new SondeProcessus(sc.pid as number, racines(nom));
    expect({ rss: p.rss(), fds: p.numFds(), threads: p.numThreads(), creation: p.createTime() }).toEqual(
      attendu["processus"],
    );
  });
});

describe("séquences", () => {
  it("taille de page : KernelPageSize de smaps, 4096 sans smaps", () => {
    expect(taillePage(racines("moderne"))).toBe(sorties.pagesize);
    expect(taillePage(racines("sysfs"))).toBe(4096);
    expect(taillePage(RACINES_SYSTEME)).toBe(sorties.pagesize);
  });

  it("cpu_percent(interval=None) successifs (écarts négatifs ramenés à 0, invités retirés)", () => {
    const r = racines("moderne");
    const fichier = path.join(r.proc, "stat");
    const reste = readFileSync(fichier, "latin1").split("\n").slice(1).join("\n");
    const mesure = new MesureCpu(r);
    const obtenus = entrees.sequence_cpu.map((premiere) => {
      writeFileSync(fichier, `${premiere}\n${reste}`, "latin1");
      return mesure.pourcentage();
    });
    expect(obtenus).toEqual(sorties.cpu);
  });

  it("disk_io_counters successifs (débordement prolongé, disque qui disparaît)", () => {
    const r = racines("moderne");
    const enrouleur = new Enrouleur();
    const obtenus = entrees.sequence_disques.map((texte) => {
      writeFileSync(path.join(r.proc, "diskstats"), texte, "latin1");
      return diskIoCounters(r, enrouleur);
    });
    expect(obtenus).toEqual(sorties.disques);
  });

  it("disk_usage depuis statvfs", () => {
    expect(entrees.statvfs.map(([b, f, a, t]) => usageDisqueDepuis(b, f, a, t))).toEqual(sorties.statvfs);
  });
});

describe("UC logiques (sémantique de la glibc, SC_NPROCESSORS_ONLN)", () => {
  it("plages de /sys/devices/system/cpu/online", () => {
    expect(compterPlagesCpu("0-3\n")).toBe(4);
    expect(compterPlagesCpu("0,2-3,8-15\n")).toBe(11);
    expect(compterPlagesCpu("0\n")).toBe(1);
    expect(cpuCountLogical(racines("moderne"))).toBe(4);
  });

  it("repli sur les lignes cpuN de stat, null sans UC", () => {
    expect(cpuCountLogical(racines("ancien"))).toBe(1);
    expect(cpuCountLogical(racines("limites"))).toBeNull();
  });

  it("sur la machine : autant d'UC que libuv", () => {
    expect(cpuCountLogical()).toBe(cpus().length);
  });
});

describe("sur la machine", () => {
  it("mesures cohérentes du process courant", () => {
    const p = new SondeProcessus();
    expect(p.rss()).toBeGreaterThan(1024 * 1024);
    expect(p.numFds()).toBeGreaterThan(2);
    expect(p.numThreads()).toBeGreaterThanOrEqual(1);
    const creation = p.createTime();
    expect(creation).toBeLessThanOrEqual(Date.now() / 1000 + 1);
    expect(creation).toBeGreaterThan(Date.now() / 1000 - 86400 * 365);
  });

  it("mémoire, disques et UC lisibles", () => {
    const m = virtualMemory(RACINES_SYSTEME);
    expect(m.total).toBeGreaterThan(0);
    expect(m.percent).toBeGreaterThanOrEqual(0);
    expect(m.percent).toBeLessThanOrEqual(100);
    expect(diskUsage("/").total).toBeGreaterThan(0);
    const premier = new MesureCpu().pourcentage();
    expect(premier).toBeGreaterThanOrEqual(0);
    expect(premier).toBeLessThanOrEqual(100);
    expect(cpuTimes().valeurs.length).toBeGreaterThanOrEqual(7);
  });
});
