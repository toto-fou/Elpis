// SPDX-License-Identifier: MIT
/** frontend/test/build/icones-phosphor.test.ts — toute icône Phosphor citée par l'interface existe dans la graisse livrée (regular) : sinon elle ne s'affiche pas. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const FRONTEND = join(import.meta.dirname, "..", "..");

function fichiers(dossier: string): string[] {
  return readdirSync(dossier).flatMap((nom) => {
    const chemin = join(dossier, nom);
    if (statSync(chemin).isDirectory()) return fichiers(chemin);
    return /\.(vue|ts)$/u.test(nom) ? [chemin] : [];
  });
}

describe("icônes Phosphor", () => {
  it("chaque nom `ph-…` cité dans frontend/src a son glyphe dans vendor/src/regular/style.css", () => {
    const css = readFileSync(join(FRONTEND, "vendor", "src", "regular", "style.css"), "utf8");
    const livrees = new Set([...css.matchAll(/^\.ph\.(ph-[a-z0-9-]+):before/gmu)].map((m) => m[1]));
    expect(livrees.size).toBeGreaterThan(1000);
    const absentes = new Set<string>();
    for (const f of [...fichiers(join(FRONTEND, "src")), join(FRONTEND, "index.html")]) {
      for (const m of readFileSync(f, "utf8").matchAll(/\bph-[a-z0-9]+(?:-[a-z0-9]+)*/gu))
        if (!livrees.has(m[0])) absentes.add(m[0]);
    }
    expect([...absentes].sort()).toEqual([]);
  });
});
