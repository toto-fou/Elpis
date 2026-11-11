// SPDX-License-Identifier: MIT
/** apps/core/test/routines/meneur.test.ts — leader unique des planificateurs (flock de la 0.0.1 remplacé par elpis.verrou.v1.1) : exclusion entre instances, avec le protocole v1.1 dans un autre processus et avec un planificateur 0.0.1 vivant, arrêt, verrou perdu, ancien fichier flock, chemin du verrou. */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pythonDisponible, tenirParAutreProcessus } from "@elpis/verrous/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cheminVerrouMeneur, detenteurFlock, Meneur } from "../../src/routines/meneur";

const PYTHON = pythonDisponible();
const PROC_LOCKS = existsSync("/proc/locks");

/** Le verrou du planificateur de la 0.0.1 (cron_lock.py : flock exclusif, PID nu) tenu par un process Python jusqu'à sa mort. */
async function cronLockPython(chemin: string): Promise<ChildProcess> {
  const code =
    "import fcntl, os, sys, time\nfd = open(sys.argv[1], 'a')\n" +
    "fcntl.flock(fd.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)\n" +
    "fd.seek(0)\nfd.truncate()\nfd.write(str(os.getpid()))\nfd.flush()\n" +
    "print(True, flush=True)\ntime.sleep(60)\n";
  const enfant = spawn(PYTHON as string, ["-c", code, chemin], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const [ligne] = (await once(enfant.stdout as NodeJS.ReadableStream, "data")) as [Buffer];
  expect(ligne.toString().trim()).toBe("True");
  return enfant;
}
let dossier: string;
let verrou: string;
const rendre: Meneur[] = [];

function meneur(arret?: AbortSignal): Meneur {
  const m = new Meneur({ chemin: () => verrou, arret });
  rendre.push(m);
  return m;
}

beforeEach(() => {
  dossier = mkdtempSync(join(tmpdir(), "elpis-meneur-"));
  verrou = join(dossier, "cron.lock");
});

afterEach(async () => {
  for (const m of rendre.splice(0)) await m.rendre();
  rmSync(dossier, { recursive: true, force: true });
});

describe("leader des planificateurs", () => {
  it("un seul leader à la fois ; re-sondé, il le reste ; rendu, un autre le devient", async () => {
    const a = meneur();
    const b = meneur();
    expect(await a.essayer()).toBe(true);
    expect([await b.essayer(), await a.essayer(), a.tenu, b.tenu]).toEqual([false, true, true, false]);
    const contenu = JSON.parse(readFileSync(verrou, "utf8")) as { pid: number; proc: string; v: number };
    expect([contenu.v, contenu.pid, contenu.proc]).toEqual([1, process.pid, a.processus]);
    await a.rendre();
    expect(existsSync(verrou)).toBe(false);
    expect([a.tenu, await b.essayer(), b.tenu]).toEqual([false, true, true]);
  });

  it("tentatives concurrentes d'une même instance : une seule prise", async () => {
    const a = meneur();
    expect(await Promise.all([a.essayer(), a.essayer(), a.essayer()])).toEqual([true, true, true]);
    expect(meneur().tenu).toBe(false);
    expect(await meneur().essayer()).toBe(false);
  });

  it("process en arrêt : leadership rendu dès l'annonce et refusé ensuite (`_is_draining`)", async () => {
    const arret = new AbortController();
    const a = meneur(arret.signal);
    expect(await a.essayer()).toBe(true);
    arret.abort();
    expect(a.tenu).toBe(false);
    await a.rendre();
    expect(existsSync(verrou)).toBe(false);
    expect([await a.essayer(), a.tenu, existsSync(verrou)]).toEqual([false, false, false]);
    expect(await meneur().essayer()).toBe(true);
  });

  it("verrou repris par un autre process : détecté au tick suivant, leadership abandonné sans toucher au fichier de l'autre", async () => {
    const a = meneur();
    expect(await a.essayer()).toBe(true);
    unlinkSync(verrou);
    const b = meneur();
    expect(await b.essayer()).toBe(true);
    const avant = readFileSync(verrou, "utf8");
    expect([await a.essayer(), a.tenu]).toEqual([false, false]);
    expect(readFileSync(verrou, "utf8")).toBe(avant);
  });

  it("ancien fichier du verrou flock de Python (un PID nu) : repris comme illisible", async () => {
    writeFileSync(verrou, "12345");
    const vieux = Date.now() / 1000 - 60;
    utimesSync(verrou, vieux, vieux);
    const a = meneur();
    expect(await a.essayer()).toBe(true);
    expect((JSON.parse(readFileSync(verrou, "utf8")) as { pid: number }).pid).toBe(process.pid);
  });

  it("même protocole v1.1 dans un autre processus : exclu tant qu'il vit, repris quand il meurt", async () => {
    const detenteur = await tenirParAutreProcessus(verrou, join(dossier, "compteur"), 30);
    try {
      const a = meneur();
      expect(await a.essayer()).toBe(false);
      detenteur.tuer();
      await detenteur.fin;
      expect(await a.essayer()).toBe(true);
    } finally {
      detenteur.tuer();
    }
  }, 60_000);
});

describe("planificateur 0.0.1 vivant sur le même fichier (flock)", () => {
  it.skipIf(PYTHON === null || !PROC_LOCKS)(
    "Python d'abord : la main lui reste tant qu'il vit ; mort, son fichier (PID nu) est repris une fois périmé",
    async () => {
      const py = await cronLockPython(verrou);
      try {
        expect(await detenteurFlock(verrou)).toBe(py.pid);
        const a = meneur();
        expect([await a.essayer(), await a.essayer(), a.tenu]).toEqual([false, false, false]);
        expect(readFileSync(verrou, "utf8")).toBe(String(py.pid));
        py.kill("SIGKILL");
        await once(py, "exit");
        const vieux = Date.now() / 1000 - 60;
        utimesSync(verrou, vieux, vieux);
        expect([await detenteurFlock(verrou), await a.essayer()]).toEqual([null, true]);
      } finally {
        py.kill("SIGKILL");
      }
    },
    60_000,
  );

  it.skipIf(PYTHON === null || !PROC_LOCKS)(
    "TS d'abord puis le planificateur 0.0.1 : la main est rendue au tick suivant sans toucher à son fichier",
    async () => {
      const a = meneur();
      expect(await a.essayer()).toBe(true);
      const py = await cronLockPython(verrou);
      try {
        expect([await a.essayer(), a.tenu]).toEqual([false, false]);
        expect(readFileSync(verrou, "utf8")).toBe(String(py.pid));
      } finally {
        py.kill("SIGKILL");
      }
    },
    60_000,
  );

  it("lecture de /proc/locks : prises FLOCK seules, attentes ignorées, absence = null", async () => {
    writeFileSync(verrou, "1");
    const table = join(dossier, "locks");
    writeFileSync(table, "1: POSIX  ADVISORY  WRITE 7 00:00:1 0 EOF\n");
    expect(await detenteurFlock(verrou, table)).toBe(null);
    expect(await detenteurFlock(join(dossier, "absent"), table)).toBe(null);
    expect(await detenteurFlock(verrou, join(dossier, "pas-de-table"))).toBe(null);
  });
});

describe("chemin du verrou", () => {
  const avant = { cron: process.env["CRON_LOCK_PATH"], racine: process.env["ELPIS_RUNTIME_DIR"] };

  afterEach(() => {
    for (const [cle, valeur] of [
      ["CRON_LOCK_PATH", avant.cron],
      ["ELPIS_RUNTIME_DIR", avant.racine],
    ] as const)
      if (valeur === undefined) delete process.env[cle];
      else process.env[cle] = valeur;
  });

  it("CRON_LOCK_PATH, sinon ELPIS_RUNTIME_DIR/cron.lock, sinon le chemin historique", () => {
    delete process.env["CRON_LOCK_PATH"];
    delete process.env["ELPIS_RUNTIME_DIR"];
    expect(cheminVerrouMeneur()).toBe("/tmp/.elpis_cron.lock");
    process.env["ELPIS_RUNTIME_DIR"] = "/srv/run";
    expect(cheminVerrouMeneur()).toBe("/srv/run/cron.lock");
    process.env["CRON_LOCK_PATH"] = " /x/cron.lock ";
    expect(cheminVerrouMeneur()).toBe("/x/cron.lock");
  });
});
