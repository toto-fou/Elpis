// SPDX-License-Identifier: MIT
/** apps/core/test/tour/securite-fichier-joint.test.ts — titre du premier message : blocs de fichiers retirés en temps linéaire, mêmes résultats que l'ancienne regex. */
import "../moteur-environnement";

import { BLANC_PY } from "@elpis/commun";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { invalidateCache } from "../../src/llm/acces-moteurs";
import { retirerFichiersJoints } from "../../src/tour/fichiers-joints";
import { prepareTurn } from "../../src/tour/preparation";
import type { DependancesTour } from "../../src/tour/preparation";

const B = BLANC_PY;
const ANCIENNE = new RegExp(
  `---${B}*FILE:${B}*[^\\n]+?${B}*---[\\s\\S]*?---${B}*END FILE${B}*---${B}*`,
  "gu",
);

const JETONS = [
  "---",
  "--",
  "-",
  "FILE:",
  "END FILE",
  "FILE",
  "END",
  " ",
  "  ",
  "\n",
  "\r\n",
  "\t",
  " ",
  " ",
  "x",
  "a.txt",
  "é",
  "😀",
  "--- FILE: a.txt ---\n",
  "\n--- END FILE ---",
  "--- FILE: ---",
  "---END FILE---",
];

function generateur(graine: number): () => number {
  let x = graine >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

describe("retirerFichiersJoints", () => {
  it.each([
    ["sans bloc", "Bonjour, peux-tu relire ceci ?", "Bonjour, peux-tu relire ceci ?"],
    [
      "bloc puis question",
      "--- FILE: a.txt ---\nligne\n--- END FILE ---\n\nRésume ce fichier",
      "Résume ce fichier",
    ],
    [
      "deux blocs puis question",
      "--- FILE: a.txt ---\nun\n--- END FILE ---\n\n--- FILE: b.md ---\ndeux\n--- END FILE ---\n\nCompare",
      "Compare",
    ],
    ["question puis bloc", "Lis\n--- FILE: a.txt ---\nun\n--- END FILE ---\n", "Lis\n"],
    ["en-tête sans pied", "--- FILE: a.txt ---\ncorps", "--- FILE: a.txt ---\ncorps"],
    ["tirets ordinaires", "a --- b --- c\n---\nd", "a --- b --- c\n---\nd"],
    ["fichier vide", "--- FILE: a.txt ---\n\n--- END FILE ---\nQuoi ?", "Quoi ?"],
    ["nom composé de tirets", "--- FILE: a---b.txt ---\ncorps\n--- END FILE ---\nOk", "Ok"],
    ["fin de ligne CRLF", "--- FILE: a.txt ---\r\ncorps\r\n--- END FILE ---\r\nOk", "Ok"],
  ])("%s", (_nom, entree, attendu) => {
    expect(retirerFichiersJoints(entree)).toBe(attendu);
    expect(entree.replace(ANCIENNE, "")).toBe(attendu);
  });

  it("donne le même résultat que l'ancienne regex sur des textes tirés au sort", () => {
    const hasard = generateur(0x5eed);
    for (let i = 0; i < 40_000; i++) {
      let texte = "";
      for (let n = Math.floor(hasard() * 14); n >= 0; n--)
        texte += JETONS[Math.floor(hasard() * JETONS.length)];
      if (retirerFichiersJoints(texte) !== texte.replace(ANCIENNE, ""))
        expect.fail(`écart sur ${JSON.stringify(texte)}`);
    }
  });

  it.each([
    ["en-têtes répétés", "---FILE:".repeat(300_000)],
    ["en-têtes et pieds tronqués", "---FILE:x---END FILE--\n".repeat(150_000)],
    ["tirets seuls", "-".repeat(2_000_000)],
    ["blancs entre tirets", `--- FILE: ${" ".repeat(1_000_000)}x`],
    ["une ligne par en-tête", "---FILE:x\n".repeat(200_000)],
  ])("reste linéaire : %s", (_nom, texte) => {
    const debut = performance.now();
    const sortie = retirerFichiersJoints(texte);
    expect(performance.now() - debut).toBeLessThan(2000);
    expect(sortie === texte).toBe(true);
  });

  it("garde le texte qui suit un très gros fichier joint", () => {
    const texte = `--- FILE: gros.log ---\n${"ligne\n".repeat(2_000_000)}--- END FILE ---\n\nRésume`;
    expect(retirerFichiersJoints(texte)).toBe("Résume");
  });
});

describe("prepareTurn : titre du premier message", () => {
  let t: BaseDeTest;
  const ALICE = 2;

  beforeEach(async () => {
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    await t.base.run(
      "INSERT INTO users(id, username, pass_salt, pass_hash, created_at, is_admin) VALUES (?, ?, 's', 'h', 0, 0)",
      [ALICE, "alice"],
    );
    invalidateCache(t.base);
  });

  afterEach(async () => {
    invalidateCache(t.base);
    await t.fermer();
  });

  const preparer = (content: string) =>
    prepareTurn(
      { base: t.base } as unknown as DependancesTour,
      { messages: [{ role: "user", content }] },
      ALICE,
      "c".repeat(24),
    );

  it("ignore le bloc de fichier joint", async () => {
    const [plan] = await preparer("--- FILE: a.txt ---\ncontenu\n--- END FILE ---\n\nRésume ce fichier");
    expect(plan.titleContent).toBe("Résume ce fichier");
  });

  it("ne bloque pas sur des en-têtes répétés", async () => {
    const debut = performance.now();
    const [plan] = await preparer("---FILE:".repeat(4000));
    expect(performance.now() - debut).toBeLessThan(3000);
    expect(plan.titleContent === "---FILE:".repeat(4000)).toBe(true);
  });
});
