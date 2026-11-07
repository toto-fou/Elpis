// SPDX-License-Identifier: MIT
/** packages/verrous/src/test.ts — aides des tests : un autre processus Node (scripts/verrou-croise.ts) qui tient un verrou elpis.verrou.v1.1, et le Python du système. */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as dormir } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const RACINE = fileURLToPath(new URL("../../../", import.meta.url));
export const SCRIPT_DETENTEUR = path.join(RACINE, "packages", "verrous", "scripts", "verrou-croise.ts");

/** `ELPIS_PYTHON`, sinon `python3` ; `null` sans Python 3.9+ (l'agent du bac en a besoin). */
export function pythonDisponible(): string | null {
  for (const candidat of [process.env["ELPIS_PYTHON"], "python3"]) {
    if (!candidat) continue;
    const r = spawnSync(candidat, ["-c", "import sys; assert sys.version_info >= (3, 9)"], {
      encoding: "utf8",
    });
    if (r.status === 0) return candidat;
  }
  return null;
}

export interface DetenteurExterne {
  pid: number;
  fin: Promise<number | null>;
  tuer(): void;
}

/** Autre processus qui prend `verrou` (un incrément de `compteur` sous lui, `pauseS` secondes), rendu une fois qu'il le tient. */
export async function tenirParAutreProcessus(
  verrou: string,
  compteur: string,
  pauseS: number,
  delaiMs = 60_000,
): Promise<DetenteurExterne> {
  const proc = `detenteur-externe-${process.pid}`;
  const enfant = spawn(
    process.execPath,
    ["--import", "tsx", SCRIPT_DETENTEUR, verrou, compteur, "1", "--pause", String(pauseS), "--proc", proc],
    { cwd: RACINE, stdio: "ignore" },
  );
  const detenteur: DetenteurExterne = {
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
  throw new Error(`l'autre processus n'a pas pris ${verrou}`);
}
