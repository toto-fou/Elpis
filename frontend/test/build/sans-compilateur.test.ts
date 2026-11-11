// SPDX-License-Identifier: MIT
/** frontend/test/build/sans-compilateur.test.ts — Vue sans compilateur de gabarits : `vue` résolu vers le build runtime, et aucun chunk construit ne l'embarque (tous les gabarits sont précompilés). */
import fs from "node:fs";
import path from "node:path";

import { compile } from "vue";
import { describe, expect, it, vi } from "vitest";

const ASSETS = path.resolve(import.meta.dirname, "../../dist/assets");
// Liste des balises HTML du parseur de compiler-dom : seul le compilateur la garde en production.
const MARQUEUR_COMPILATEUR = "html,body,base,head,link,meta";

describe("Vue sans compilateur", () => {
  it("`vue` est le build runtime : compile() ne produit rien", () => {
    const avert = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(compile("<div>{{ x }}</div>")).toBeUndefined();
    avert.mockRestore();
  });

  it.skipIf(!fs.existsSync(ASSETS))("aucun chunk du build n'embarque le compilateur de gabarits", () => {
    const fautifs = fs
      .readdirSync(ASSETS)
      .filter((f) => f.endsWith(".js"))
      .filter((f) => fs.readFileSync(path.join(ASSETS, f), "utf8").includes(MARQUEUR_COMPILATEUR));
    expect(fautifs).toEqual([]);
  });
});
