// SPDX-License-Identifier: MIT
/** apps/toolhost/test/office-elagage.test.ts — élagage du cache des aperçus Office par l'hôte d'outils : TTL, plafonds, conversions en cours gardées, fichiers-verrous périmés, racine privée. */
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { inodesVerrouilles } from "@elpis/verrous";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { elaguerCacheOffice } from "../src/office/elagage";

const JOUR = 86_400;
const AVEC_FLOCK = spawnSync("flock", ["--version"]).status === 0 && existsSync("/proc/locks");
const MAINTENANT = Date.now() / 1000;

let dossier = "";
const detenteurs: ChildProcess[] = [];

beforeEach(() => {
  dossier = mkdtempSync(join(tmpdir(), "elpis-elagage-"));
});

function lacherVerrous(): void {
  for (const d of detenteurs.splice(0)) if (d.pid !== undefined) process.kill(-d.pid, "SIGKILL");
}

afterEach(() => {
  lacherVerrous();
  vi.unstubAllEnvs();
  rmSync(dossier, { recursive: true, force: true });
});

function fichier(chemin: string, jours: number, contenu = ""): string {
  mkdirSync(join(chemin, ".."), { recursive: true });
  writeFileSync(chemin, contenu);
  const t = MAINTENANT - jours * JOUR;
  utimesSync(chemin, t, t);
  return chemin;
}

/** Tient un `flock` exclusif sur le fichier tant que le test dure (binaire `flock` de util-linux). */
async function tenirVerrou(chemin: string): Promise<void> {
  detenteurs.push(spawn("flock", ["-x", chemin, "sleep", "60"], { stdio: "ignore", detached: true }));
  const inode = String(statSync(chemin).ino);
  const limite = Date.now() + 10_000;
  while (!(await inodesVerrouilles())?.has(inode)) {
    if (Date.now() > limite) throw new Error("flock non visible dans /proc/locks");
    await new Promise((ok) => setTimeout(ok, 50));
  }
}

describe.skipIf(!AVEC_FLOCK)("elaguerCacheOffice", () => {
  const cle = (n: number): string => n.toString(16).padStart(40, "0");
  let racine = "";
  let verrous = "";
  let restaurer: () => void;

  function reglages(office: Record<string, unknown>): void {
    writeFileSync(join(dossier, "config.json"), JSON.stringify({ office_preview: office }));
    invalidateConfigCache();
  }

  /** Dossier de clé d'un compte : manifeste daté de `jours` jours, `octets` d'octets de données. */
  function entree(compte: string, n: number, jours: number, octets = 10): string {
    const d = join(racine, "u", compte, cle(n));
    fichier(join(d, "doc.pdf"), jours, "x".repeat(octets));
    fichier(join(d, "manifest.json"), jours, "{}");
    return d;
  }

  beforeEach(() => {
    racine = join(dossier, "cache");
    verrous = join(dossier, "verrous-office");
    mkdirSync(verrous);
    vi.stubEnv("APP_OFFICE_CACHE_DIR", racine);
    vi.stubEnv("ELPIS_OFFICE_LOCK_DIR", verrous);
    restaurer = surchargerConfig({ CONFIG_JSON_PATH: join(dossier, "config.json") });
    reglages({});
  });

  afterEach(() => {
    restaurer();
    invalidateConfigCache();
  });

  it("TTL de 14 jours, tmp d'une heure, noms qui ne sont pas des clés laissés en place", async () => {
    const vieux = entree("alice", 1, 15);
    const frais = entree("alice", 2, 1);
    const autre = fichier(join(racine, "u", "alice", "pas-une-cle", "f"), 99);
    const tmpVieux = join(racine, "u", "alice", ".tmp-a");
    fichier(join(tmpVieux, "f"), 0);
    utimesSync(tmpVieux, MAINTENANT - 2 * 3600, MAINTENANT - 2 * 3600);
    const tmpFrais = join(racine, "u", "bob", ".tmp-b");
    mkdirSync(tmpFrais, { recursive: true });
    expect(await elaguerCacheOffice(MAINTENANT)).toEqual({ removed: 2, locks: 0 });
    expect([vieux, frais, autre, tmpVieux, tmpFrais].map((f) => existsSync(f))).toEqual([
      false,
      true,
      true,
      false,
      true,
    ]);
  });

  const MO = 1024 * 1024;
  function quatreEntrees(): [string, string, string, string] {
    return [
      entree("alice", 1, 5, MO * 0.6),
      entree("alice", 2, 3, MO * 0.6),
      entree("bob", 3, 4, MO * 0.9),
      entree("bob", 4, 1, MO * 0.9),
    ];
  }

  it("plafond par compte (cache_user_mb) : les plus anciens usages d'abord, jusqu'à passer sous le plafond", async () => {
    reglages({ cache_user_mb: 1, cache_mb: 100 });
    const entrees = quatreEntrees();
    expect((await elaguerCacheOffice(MAINTENANT)).removed).toBe(2);
    expect(entrees.map((f) => existsSync(f))).toEqual([false, true, false, true]);
  });

  it("plafond global (cache_mb) : tous comptes confondus, du plus ancien usage au plus récent", async () => {
    reglages({ cache_mb: 1 });
    const entrees = quatreEntrees();
    expect((await elaguerCacheOffice(MAINTENANT)).removed).toBe(3);
    expect(entrees.map((f) => existsSync(f))).toEqual([false, false, false, true]);
  });

  it("réglage illisible : défauts ; clé dont la conversion tient le verrou : conservée", async () => {
    reglages({ cache_ttl_days: "beaucoup" });
    const tenue = entree("alice", 1, 30);
    const libre = entree("alice", 2, 30);
    const verrou = fichier(join(verrous, `key-${cle(1)}.lock`), 0);
    await tenirVerrou(verrou);
    expect((await elaguerCacheOffice(MAINTENANT)).removed).toBe(1);
    expect([existsSync(tenue), existsSync(libre)]).toEqual([true, false]);
  });

  it("fichiers-verrous des conversions : anciens et libres retirés, noms invalides et verrous tenus gardés", async () => {
    const ancien = fichier(join(verrous, "conv-1.lock"), 3);
    const tenu = fichier(join(verrous, "conv-2.lock"), 3);
    const recent = fichier(join(verrous, "conv-3.lock"), 0);
    const invalide = fichier(join(verrous, "Pas Valide.lock"), 3);
    const autre = fichier(join(verrous, "notes.txt"), 3);
    await tenirVerrou(tenu);
    expect(await elaguerCacheOffice(MAINTENANT)).toEqual({ removed: 0, locks: 1 });
    expect([ancien, tenu, recent, invalide, autre].map((f) => existsSync(f))).toEqual([
      false,
      true,
      true,
      true,
      true,
    ]);
  });

  it("racine du cache ramenée à 0700 si d'autres comptes y ont des droits, même sous le groupe des données", async () => {
    mkdirSync(racine, { mode: 0o777 });
    chmodSync(racine, 0o777);
    await elaguerCacheOffice(MAINTENANT);
    expect(statSync(racine).mode & 0o777).toBe(0o700);
    vi.stubEnv("ELPIS_GROUPE_DONNEES", String(process.getgid?.() ?? 0));
    chmodSync(racine, 0o770);
    const vieux = entree("alice", 1, 15);
    expect((await elaguerCacheOffice(MAINTENANT)).removed).toBe(1);
    expect([statSync(racine).mode & 0o777, existsSync(vieux)]).toEqual([0o700, false]);
  });
});
