// SPDX-License-Identifier: MIT
/** apps/core/test/skill-apparence.test.ts — le skill livré `apparence` : exemples valides au vérificateur, artefact d'aperçu sans script ni réseau, jetons de la liste seulement. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { JETONS_PERSO, verifierSkinPerso } from "../src/apparence/perso";

const DOSSIER = resolve(__dirname, "../../../skills/apparence");
const lire = (rel: string): string => readFileSync(resolve(DOSSIER, rel), "utf8");

function blocs(texte: string): string[] {
  return [...texte.matchAll(/```elpis-skin\n([\s\S]*?)\n```/g)].map((m) => m[1] ?? "");
}

describe("skill apparence", () => {
  it("les deux exemples passent la vérification, sans erreur ni contraste en échec", () => {
    const exemples = blocs(lire("references/exemples.md"));
    expect(exemples.length).toBe(2);
    for (const e of exemples) {
      const r = verifierSkinPerso(JSON.parse(e));
      expect(r.erreurs).toEqual([]);
      expect(r.ok).toBe(true);
      expect(r.css).toContain("body.elpis-skin-perso");
    }
  });

  it("apercu.html : ni script, ni url(), ni @import, ni gestionnaire d'événement ; emplacement des jetons présent", () => {
    const html = lire("assets/apercu.html");
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/url\s*\(/i);
    expect(html).not.toMatch(/@import/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).toContain('<style id="elpis-jetons"></style>');
    expect(html).toContain('<body class="elpis-skin-perso">');
  });

  it("apercu.html : tous les jetons var(--x) sont connus (liste blanche ou dérivés émis)", () => {
    const connus = new Set(JETONS_PERSO);
    const derives = new Set(
      [
        ...verifierSkinPerso(JSON.parse(blocs(lire("references/exemples.md"))[0] ?? "{}")).css.matchAll(
          /(--[a-z0-9-]+):/g,
        ),
      ].map((m) => m[1]),
    );
    const utilises = new Set(
      [...lire("assets/apercu.html").matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]),
    );
    for (const j of utilises) expect(connus.has(j ?? "") || derives.has(j ?? ""), j).toBe(true);
  });

  it("references/jetons.md cite chaque jeton de la liste", () => {
    const ref = lire("references/jetons.md");
    for (const j of JETONS_PERSO) expect(ref.includes(j) || /--surface-\d/.test(j), j).toBe(true);
  });
});
