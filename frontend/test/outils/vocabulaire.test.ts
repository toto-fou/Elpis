// SPDX-License-Identifier: MIT
/** frontend/test/outils/vocabulaire.test.ts — vocabulaire français des pages outils : aucun libellé anglais ou jargon retiré ne revient dans les gabarits. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "../../src/components");
const lire = (f: string): string => readFileSync(join(SRC, f), "utf8");

const INTERDITS: Array<[string, string[]]> = [
  ["routines/FormulaireRoutine.vue", ["Générer un token", ">Token ", "System prompt", "pendant le run"]],
  ["studio/PageStudio.vue", ["Vol à blanc", "vol à blanc", "Capturer &amp; annoter"]],
  ["rag/DetailCollection.vue", ["l’assistant la lit pour savoir quand chercher\n"]],
];

describe("vocabulaire des pages outils", () => {
  it.each(INTERDITS)("%s ne contient plus les libellés retirés", (fichier, mots) => {
    const source = lire(fichier);
    for (const m of mots) expect(source, m).not.toContain(m);
  });

  it("aucun texte de moins de 12 px dans le Studio", () => {
    expect(lire("studio/PageStudio.vue")).not.toMatch(/text-\[(?:[0-9]|1[01])(?:\.[0-9]+)?px\]/);
  });
});
