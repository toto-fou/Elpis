// SPDX-License-Identifier: MIT
/** packages/verrous/scripts/verrou-croise.ts — détenteur de test elpis.verrou.v1.1 dans un autre processus Node : N prises, un incrément sous chacune. */
import { readFileSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as dormir } from "node:timers/promises";
import { parseArgs } from "node:util";

import { definirProcessus, PEREMPTION_DEFAUT_MS, VerrouFichier, VerrouOccupe } from "../src/index";

/** Lire-modifier-écrire volontairement lent : sans exclusion, des incréments se perdent. */
async function incrementer(compteur: string, pauseMs: number): Promise<void> {
  let texte = "";
  try {
    texte = (await readFile(compteur, "utf8")).trim();
  } catch (e) {
    if ((e as { code?: unknown }).code !== "ENOENT") throw e;
  }
  const valeur = Number(texte || "0");
  if (!Number.isSafeInteger(valeur)) throw new Error(`compteur illisible : ${JSON.stringify(texte)}`);
  if (pauseMs > 0) await dormir(pauseMs);
  await writeFile(compteur, `${valeur + 1}\n`, "utf8");
}

/** Même incrément, synchrone (pause bloquante) : pour la prise synchrone. */
function incrementerSync(compteur: string, pauseMs: number): void {
  let texte = "";
  try {
    texte = readFileSync(compteur, "utf8").trim();
  } catch (e) {
    if ((e as { code?: unknown }).code !== "ENOENT") throw e;
  }
  const valeur = Number(texte || "0");
  if (!Number.isSafeInteger(valeur)) throw new Error(`compteur illisible : ${JSON.stringify(texte)}`);
  if (pauseMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pauseMs);
  writeFileSync(compteur, `${valeur + 1}\n`, "utf8");
}

function secondes(texte: string | undefined, defaut: number): number {
  const v = texte === undefined ? defaut : Number(texte);
  if (!Number.isFinite(v)) throw new Error(`durée invalide : ${texte}`);
  return v * 1000;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      delai: { type: "string" },
      peremption: { type: "string" },
      pause: { type: "string" },
      proc: { type: "string", default: "test-node" },
      battement: { type: "boolean", default: false },
      synchrone: { type: "boolean", default: false },
    },
  });
  const [verrou, compteur, n] = positionals;
  if (verrou === undefined || compteur === undefined || n === undefined || !/^\d+$/.test(n)) {
    process.stderr.write(
      "usage : verrou-croise.ts VERROU COMPTEUR N [--delai s] [--peremption s] [--pause s] [--proc nom] [--battement] [--synchrone]\n",
    );
    return 2;
  }
  definirProcessus(values.proc);
  const options = {
    delaiMs: secondes(values.delai, 60),
    peremptionMs: secondes(values.peremption, PEREMPTION_DEFAUT_MS / 1000),
    battement: values.battement,
  };
  const pauseMs = secondes(values.pause, 0.001);
  for (let i = 0; i < Number(n); i++) {
    const v = new VerrouFichier(verrou, options);
    try {
      if (values.synchrone) v.acquerirSync();
      else await v.acquerir();
    } catch (e) {
      if (!(e instanceof VerrouOccupe)) throw e;
      process.stderr.write(`verrou_croise : ${e.message}\n`);
      return 3;
    }
    if (values.synchrone) {
      try {
        incrementerSync(compteur, pauseMs);
      } finally {
        v.rendreSync();
      }
      continue;
    }
    try {
      await incrementer(compteur, pauseMs);
    } finally {
      await v.rendre();
    }
  }
  return 0;
}

process.exitCode = await main();
