// SPDX-License-Identifier: MIT
/** apps/toolhost/test/fs-yaml.test.ts — read_file(format='yaml') : safe_load puis safe_dump de PyYAML rejoués (vecteurs) ; écarts mesurés et consignés, plafonds contre les entrées hostiles. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { charger, dumpPy, ErreurYaml } from "../src/mcp/fs/yaml-py";

interface Cas {
  texte?: string;
  chemin?: string;
  /** Copie figée d'un fichier du dépôt qui a changé depuis les vecteurs. */
  source?: string;
  sha256?: string;
  dump?: string;
  erreur?: string;
}

const RACINE = path.resolve(import.meta.dirname, "..", "..", "..");
const V = JSON.parse(readFileSync(new URL("./vecteurs/fs-yaml.json", import.meta.url), "utf-8")) as {
  cas: Cas[];
  corpus: Cas[];
};

function rendu(texte: string): Cas {
  try {
    return { dump: dumpPy(charger(texte)) };
  } catch (e) {
    if (!(e instanceof ErreurYaml)) throw e;
    return { erreur: e.message };
  }
}

/** Écarts consignés : U+2028, U+2029 et U+0085 coupent la ligne pour PyYAML, pas pour le paquet `yaml`. */
const SAUTS_UNICODE = /[\u2028\u2029\u0085]/u;

const ECARTS_MESSAGE: string[] = [];
/** Erreurs d'analyse dont le texte diffère (le refus est le même) : mesurées sur les vecteurs, consignées. */
const MESSAGES_DIFFERENTS = [
  "a: -\n",
  "a: '\n",
  "a: [1, 2\n",
  "a:\n\tb: 1\n",
  "a: b: c\n",
  "- a\nb: c\n",
  "key: @x\n",
  "key: `x`\n",
  "x: '''\n",
];

/** Les deux refusent : le message peut différer (paquet `yaml` ≠ scanner de PyYAML), écart mesuré et consigné. */
function comparer(c: Cas, texte: string): void {
  const r = rendu(texte);
  if (c.erreur !== undefined && r.erreur !== undefined) {
    if (r.erreur !== c.erreur) ECARTS_MESSAGE.push(texte);
    return;
  }
  if (SAUTS_UNICODE.test(texte) && c.erreur !== undefined) return;
  expect(r, JSON.stringify(texte)).toEqual(c.dump !== undefined ? { dump: c.dump } : { erreur: c.erreur });
}

describe("safe_load + safe_dump (vecteurs PyYAML)", () => {
  it.each(V.cas.map((c) => [JSON.stringify(c.texte), c] as const))("%s", (_n, c) => {
    comparer(c, c.texte as string);
  });

  it.each(V.corpus.map((c) => [c.chemin, c] as const))("dépôt : %s", (_n, c) => {
    const t = readFileSync(path.join(RACINE, c.source ?? (c.chemin as string)), "utf-8");
    expect(createHash("sha256").update(t).digest("hex"), "regénérer les vecteurs").toBe(c.sha256);
    comparer(c, t);
  });

  it("écarts de message mesurés (erreurs d'analyse seulement)", () => {
    expect(ECARTS_MESSAGE).toEqual(MESSAGES_DIFFERENTS);
  });
});

describe("plafonds contre les entrées hostiles", () => {
  it("alias en cascade (billion laughs) : partagés comme PyYAML (ancres à l'émission), rien n'est déplié", () => {
    const lignes = ['a: &a ["x","x","x","x","x","x","x","x","x"]'];
    for (let i = 1; i < 12; i++) {
      const p = String.fromCharCode(97 + i - 1);
      const q = String.fromCharCode(97 + i);
      lignes.push(`${q}: &${q} [${Array(9).fill(`*${p}`).join(",")}]`);
    }
    const t0 = performance.now();
    const sortie = dumpPy(charger(lignes.join("\n")));
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(sortie.length).toBeLessThan(10_000);
    expect(sortie).toContain("&id001");
  });

  it("au-delà des plafonds : trop d'alias, de clés fusionnées, de profondeur (refus immédiat, sans récursion)", () => {
    const alias = `a: &a x\nb: [${Array(10_001).fill("*a").join(",")}]\n`;
    expect(() => charger(alias)).toThrow("too many aliases");
    const fusions =
      "l0: &l0 {a: 1, b: 2}\n" +
      Array.from(
        { length: 6 },
        (_, k) => `l${k + 1}: &l${k + 1}\n  <<: [${Array(10).fill(`*l${k}`).join(", ")}]`,
      ).join("\n");
    expect(() => charger(fusions)).toThrow("too many merged keys");
    for (const t of [`${"[".repeat(2000)}${"]".repeat(2000)}`, `${"- ".repeat(600)}x\n`])
      expect(() => charger(t)).toThrow("maximum recursion depth exceeded");
  });

  it("alias nombreux sur un gros document : coût linéaire (index des ancres)", () => {
    const base = Array.from({ length: 10_000 }, (_, i) => `k${i}: &a${i} [1, 2, 3]`).join("\n");
    const alias = Array.from({ length: 4000 }, (_, i) => `r${i}: *a${i}`).join("\n");
    const t0 = performance.now();
    charger(`${base}\n${alias}\n`);
    expect(performance.now() - t0).toBeLessThan(4000);
  });
});
