// SPDX-License-Identifier: MIT
/** frontend/test/build/composants-resolus.test.ts — chaque composant d'un gabarit SFC est importé : sans enregistrement global, une balise non importée reste un élément inconnu (vide à l'écran). */
import fs from "node:fs";
import path from "node:path";

import { compileScript, parse } from "vue/compiler-sfc";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(import.meta.dirname, "../../src");

// Fichiers .vue de l'arbre, récursivement.
function fichiersVue(dossier: string): string[] {
  return fs.readdirSync(dossier, { withFileTypes: true }).flatMap((e) => {
    const chemin = path.join(dossier, e.name);
    if (e.isDirectory()) return fichiersVue(chemin);
    return e.name.endsWith(".vue") ? [chemin] : [];
  });
}

describe("composants des gabarits SFC", () => {
  it("aucun composant résolu à l'exécution (hors auto-référence du fichier)", () => {
    const fautifs: string[] = [];
    for (const fichier of fichiersVue(SRC)) {
      const { descriptor } = parse(fs.readFileSync(fichier, "utf8"), { filename: fichier });
      if (!descriptor.template || !descriptor.scriptSetup) continue;
      const { content } = compileScript(descriptor, {
        id: path.relative(SRC, fichier),
        inlineTemplate: true,
      });
      // L'auto-référence (composant récursif) est compilée en `resolveComponent("Nom", true)` : seule exception admise.
      for (const m of content.matchAll(/resolveComponent\("([^"]+)"\)/g)) {
        fautifs.push(`${path.relative(SRC, fichier)} : <${m[1]}>`);
      }
    }
    expect(fautifs).toEqual([]);
  });
});
