// SPDX-License-Identifier: MIT
/** packages/verrous/src/test.ts — aide des tests croisés : un processus Python (tests/verrou_croise.py) qui tient un verrou elpis.verrou.v1.1. */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as dormir } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export const SCRIPT_PYTHON = path.join(
  fileURLToPath(new URL("../../../", import.meta.url)),
  "tests",
  "verrou_croise.py",
);

/** `ELPIS_PYTHON`, sinon `python3` ; `null` sans Python 3.9+ ou sans le client du dépôt. */
export function pythonDisponible(): string | null {
  if (!existsSync(SCRIPT_PYTHON)) return null;
  for (const candidat of [process.env["ELPIS_PYTHON"], "python3"]) {
    if (!candidat) continue;
    const r = spawnSync(candidat, ["-c", "import sys; assert sys.version_info >= (3, 9)"], {
      encoding: "utf8",
    });
    if (r.status === 0) return candidat;
  }
  return null;
}

export interface DetenteurPython {
  pid: number;
  fin: Promise<number | null>;
  tuer(): void;
}

/** Processus Python qui prend `verrou` (un incrément de `compteur` sous lui, `pauseS` secondes), rendu une fois qu'il le tient. */
export async function tenirParPython(
  python: string,
  verrou: string,
  compteur: string,
  pauseS: number,
  delaiMs = 60_000,
): Promise<DetenteurPython> {
  const proc = `detenteur-python-${process.pid}`;
  const enfant = spawn(
    python,
    [SCRIPT_PYTHON, verrou, compteur, "1", "--pause", String(pauseS), "--proc", proc],
    {
      stdio: "ignore",
    },
  );
  const detenteur: DetenteurPython = {
    pid: enfant.pid ?? -1,
    fin: new Promise((resolve) => enfant.on("exit", (code) => resolve(code))),
    tuer: () => enfant.kill("SIGKILL"),
  };
  const limite = performance.now() + delaiMs;
  while (performance.now() < limite) {
    try {
      const c = JSON.parse(readFileSync(verrou, "utf8")) as { proc?: unknown; pid?: unknown };
      if (c.proc === proc && c.pid === detenteur.pid) return detenteur;
    } catch {
      /* pas encore pris */
    }
    await dormir(20);
  }
  detenteur.tuer();
  throw new Error(`le processus Python n'a pas pris ${verrou}`);
}
