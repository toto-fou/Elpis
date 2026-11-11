// SPDX-License-Identifier: MIT
/** packages/bac/test/croise.test.ts — essais croisés réels avec le Python (même machine, mêmes fichiers) : verrou de cycle de vie par compte et migration de `/work`. */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { surchargerConfig } from "@elpis/config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bwrap, ensureWorkSubdir, reglagesCycle, sousVerrouDeCycle, WORK_RESERVED } from "../src/index";
import { dossierTemporaire } from "./aides";

const RACINE = fileURLToPath(new URL("../../../", import.meta.url));

/** `ELPIS_PYTHON`, sinon `python3` : seuls la bibliothèque standard et shared_infra sont importés. */
function trouverPython(): string | null {
  for (const candidat of [process.env["ELPIS_PYTHON"], "python3"]) {
    if (!candidat) continue;
    const r = spawnSync(candidat, ["-c", "import shared_infra.sandbox.paths"], {
      cwd: RACINE,
      env: { ...process.env, PYTHONPATH: RACINE },
    });
    if (r.status === 0) return candidat;
  }
  return null;
}

const PYTHON = trouverPython();

function python(code: string): { fin: Promise<number | null>; sortie: () => string } {
  const p = spawn(PYTHON as string, ["-c", code], {
    cwd: RACINE,
    env: { ...process.env, PYTHONPATH: RACINE, PYTHONDONTWRITEBYTECODE: "1" },
  });
  const morceaux: string[] = [];
  p.stdout.on("data", (b: Buffer) => morceaux.push(b.toString()));
  p.stderr.on("data", (b: Buffer) => morceaux.push(b.toString()));
  return { fin: new Promise((ok) => p.once("exit", ok)), sortie: () => morceaux.join("") };
}

async function attendreFichier(chemin: string): Promise<void> {
  for (let i = 0; i < 500 && !existsSync(chemin); i++) await new Promise((r) => setTimeout(r, 10));
  expect(existsSync(chemin), chemin).toBe(true);
}

let tmp = "";
let nettoyer: () => void = () => undefined;
let restaurer: () => void = () => undefined;

beforeEach(() => {
  [tmp, nettoyer] = dossierTemporaire("elpis-bac-croise-");
  restaurer = surchargerConfig({ SANDBOX_DIR: path.join(tmp, "sb") });
});

afterEach(() => {
  restaurer();
  nettoyer();
});

describe.skipIf(PYTHON === null)("croisé Python ↔ TS", () => {
  it("verrou de cycle de vie : tenu par le Python, le TS attend sa fin ; tenu par le TS, le Python ne l'obtient pas", async () => {
    const verrou = path.join(tmp, "sb", ".lifecycle_locks", "u9.lock");
    const pris = path.join(tmp, "pris");
    const rendu = path.join(tmp, "rendu");
    const py = python(`
import time, pathlib
from shared_infra.runtime.verrou_fichier import VerrouFichier
p = pathlib.Path(${JSON.stringify(verrou)}); p.parent.mkdir(parents=True, exist_ok=True)
v = VerrouFichier(p, peremption=120, battement=True)
v.acquerir()
pathlib.Path(${JSON.stringify(pris)}).write_text("1")
time.sleep(0.8)
pathlib.Path(${JSON.stringify(rendu)}).write_text(repr(time.time()))
v.rendre()
`);
    await attendreFichier(pris);
    const debut = await sousVerrouDeCycle(9, async () => Date.now() / 1000);
    expect(await py.fin, py.sortie()).toBe(0);
    expect(debut).toBeGreaterThanOrEqual(Number(readFileSync(rendu, "utf-8")) - 0.05);

    const essai = path.join(tmp, "essai");
    await sousVerrouDeCycle(9, async () => {
      const py2 = python(`
import pathlib
from shared_infra.runtime.verrou_fichier import VerrouFichier
pathlib.Path(${JSON.stringify(essai)}).write_text(repr(VerrouFichier(pathlib.Path(${JSON.stringify(verrou)})).essayer()))
`);
      expect(await py2.fin, py2.sortie()).toBe(0);
    });
    expect(readFileSync(essai, "utf-8")).toBe("False");
    expect(existsSync(verrou)).toBe(false);
  }, 30_000);

  it("verrou de cycle de vie tenu par le Python au-delà du délai : le TS continue sans (fail-open)", async () => {
    const verrou = path.join(tmp, "sb", ".lifecycle_locks", "u4.lock");
    const pris = path.join(tmp, "pris");
    const py = python(`
import time, pathlib
from shared_infra.runtime.verrou_fichier import VerrouFichier
p = pathlib.Path(${JSON.stringify(verrou)}); p.parent.mkdir(parents=True, exist_ok=True)
v = VerrouFichier(p); v.acquerir()
pathlib.Path(${JSON.stringify(pris)}).write_text("1")
time.sleep(1.5)
v.rendre()
`);
    await attendreFichier(pris);
    const delai = reglagesCycle.delaiMs;
    reglagesCycle.delaiMs = 200;
    try {
      const tenuAilleurs = await sousVerrouDeCycle(4, async () => existsSync(verrou));
      expect(tenuAilleurs).toBe(true);
    } finally {
      reglagesCycle.delaiMs = delai;
    }
    expect(await py.fin, py.sortie()).toBe(0);
  }, 30_000);

  it("bwrap : même verdict de sonde et même binaire que le Python sur cette machine", async () => {
    const py = spawnSync(
      PYTHON as string,
      ["-c", "from shared_infra.sandbox import bwrap; print(bwrap.probe(), bwrap.binary())"],
      { cwd: RACINE, env: { ...process.env, PYTHONPATH: RACINE }, encoding: "utf-8" },
    );
    const ok = await bwrap.probe(true);
    expect(`${ok ? "True" : "False"} ${bwrap.binary()}`).toBe(py.stdout.trim());
    expect(await bwrap.probe()).toBe(ok);
  }, 30_000);

  it("migration de /work : trois Python et trois appels TS sur le même compte, un seul déplacement par entrée", async () => {
    const p = path.join(tmp, "sb", "frank");
    mkdirSync(path.join(p, "skills"), { recursive: true });
    const fichiers = Array.from({ length: 20 }, (_, i) => `f${i}.txt`);
    for (const n of fichiers) writeFileSync(path.join(p, n), `contenu-${n}`);
    const pythons = Array.from({ length: 3 }, () =>
      python(`
import pathlib
from shared_infra.sandbox.paths import ensure_work_subdir
ensure_work_subdir(pathlib.Path(${JSON.stringify(p)}))
`),
    );
    await Promise.all(Array.from({ length: 3 }, () => ensureWorkSubdir(p)));
    for (const py of pythons) expect(await py.fin, py.sortie()).toBe(0);
    for (const n of fichiers) expect(readFileSync(path.join(p, "work", n), "utf-8")).toBe(`contenu-${n}`);
    expect(readdirSync(p).filter((n) => !WORK_RESERVED.has(n))).toEqual([]);
    expect(existsSync(path.join(p, "skills"))).toBe(true);
  }, 30_000);
});
