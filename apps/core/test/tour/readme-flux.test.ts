// SPDX-License-Identifier: MIT
/** apps/core/test/tour/readme-flux.test.ts — invariant 8 : les invariants du flux de chat sont écrits dans apps/core/src/tour/README.md, son ordre des événements tient sur chaque golden flux_route_outils_* et ne cite que des types du registre et des fichiers existants. */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { LOOP_EVENTS, STREAM_EVENT_TYPES } from "@elpis/contracts";
import { describe, expect, it } from "vitest";

const RACINE = path.resolve(import.meta.dirname, "../../../..");
const README = readFileSync(path.join(RACINE, "apps/core/src/tour/README.md"), "utf8");
const GOLDENS = path.join(RACINE, "tests/goldens");

/** Étapes du bloc `ordre-du-flux` : types permis à chacune ; un type cité n'est permis qu'à ses étapes, `<boucle>` donne le reste de `LOOP_EVENTS`. */
function etapes(): Set<string>[] {
  const bloc = /```ordre-du-flux\n([\s\S]*?)\n```/.exec(README)?.[1];
  if (bloc === undefined) throw new Error("bloc ordre-du-flux absent du README");
  const lignes = bloc.split("\n").map((ligne, i) => {
    const [numero, ...types] = ligne.trim().split(/\s+/);
    expect(Number(numero), ligne).toBe(i + 1);
    return types;
  });
  const cites = new Set(lignes.flat());
  return lignes.map(
    (types) =>
      new Set(types.flatMap((t) => (t === "<boucle>" ? [...LOOP_EVENTS].filter((e) => !cites.has(e)) : [t]))),
  );
}

/** Premier écart à l'ordre (étape la plus basse permise après la précédente), ou `null`. */
function ecart(types: readonly string[], ordre: readonly Set<string>[]): string | null {
  let etape = 0;
  for (const [i, type] of types.entries()) {
    if (type === "ping") continue;
    const suivante = ordre.findIndex((permis, j) => j >= etape && permis.has(type));
    if (suivante < 0) return `${i} : ${type} après l'étape ${etape + 1}`;
    etape = suivante;
  }
  return null;
}

describe("invariant 8 : README du flux de chat", () => {
  it("chaque golden flux_route_outils_* suit l'ordre écrit", () => {
    const ordre = etapes();
    const fichiers = readdirSync(GOLDENS).filter((f) => /^flux_route_outils.*\.json$/.test(f));
    expect(fichiers.length).toBeGreaterThanOrEqual(11);
    for (const f of fichiers) {
      const g = JSON.parse(readFileSync(path.join(GOLDENS, f), "utf8")) as Record<string, unknown>;
      const evenements = (g["evenements"] ?? g["evenements_avant_depart"]) as { type: string }[];
      expect(
        ecart(
          evenements.map((e) => e.type),
          ordre,
        ),
        f,
      ).toBeNull();
    }
  });

  it("types du registre et fichiers cités existants", () => {
    const registre = new Set<string>(STREAM_EVENT_TYPES);
    for (const etape of etapes()) for (const type of etape) expect(registre.has(type), type).toBe(true);
    const cites = [...README.matchAll(/`((?:apps|packages)\/[\w./-]+)`/g)].map((m) => m[1] ?? "");
    expect(cites.length).toBeGreaterThan(10);
    expect(cites.filter((c) => !existsSync(path.join(RACINE, c)))).toEqual([]);
  });
});
