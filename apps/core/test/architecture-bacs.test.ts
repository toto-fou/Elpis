// SPDX-License-Identifier: MIT
/** apps/core/test/architecture-bacs.test.ts — seul l'hôte d'outils pilote Docker et joint les bacs : imports statiques gardés par eslint.config.mjs (PERMIS_BACS), ici les imports dynamiques, le client docker et les sockets. */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SOURCES = path.join(RACINE, "apps/core/src");
const DYNAMIQUE =
  /\b(?:import|require)\(\s*["'`]@elpis\/(?:bac|navigateur|fichiers)(?:\/[^"'`]*)?["'`]\s*\)/gu;
/** Seul import dynamique permis : la sonde bubblewrap de `./elpis bwrap`, rien d'autre de ce paquet. */
const SONDE = {
  fichier: "apps/core/src/exploitation.ts",
  texte: 'const { bwrap: prison } = await import("@elpis/bac");',
};

const fichiers = readdirSync(SOURCES, { recursive: true, encoding: "utf8" })
  .filter((f) => f.endsWith(".ts"))
  .map((f) => path.relative(RACINE, path.join(SOURCES, f)));
const texte = (f: string): string => readFileSync(path.join(RACINE, f), "utf8");

describe("Docker et bacs réservés à l'hôte d'outils", () => {
  it("le cœur n'importe dynamiquement des paquets des bacs que la sonde bubblewrap", () => {
    expect(fichiers.length).toBeGreaterThan(100);
    const vus = fichiers.flatMap((f) => [...texte(f).matchAll(DYNAMIQUE)].map((m) => `${f} : ${m[0]}`));
    expect(vus).toEqual([`${SONDE.fichier} : import("@elpis/bac")`]);
    expect(texte(SONDE.fichier)).toContain(SONDE.texte);
  });

  it("le cœur ne lance jamais le client docker ni ne joint un socket de bac ou du démon", () => {
    const motifs = [
      /\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\(\s*["'`][^"'`]*\bdocker\b/u,
      /\bdocker\.sock\b/u,
      /\bDOCKER_HOST\b/u,
      /\bsocketPath\b/u,
      /\.sock["'`]/u,
    ];
    expect(fichiers.filter((f) => motifs.some((m) => m.test(texte(f))))).toEqual([]);
  });

  it("le motif des imports dynamiques voit les formes de contournement, pas un autre paquet", () => {
    const formes = [
      'await import("@elpis/bac")',
      "await import(`@elpis/navigateur`)",
      "require('@elpis/fichiers/agent')",
      'import("@elpis/bacs")',
    ].join("\n");
    expect([...formes.matchAll(DYNAMIQUE)].map((m) => m[0])).toEqual([
      'import("@elpis/bac")',
      "import(`@elpis/navigateur`)",
      "require('@elpis/fichiers/agent')",
    ]);
  });
});
