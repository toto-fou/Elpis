// SPDX-License-Identifier: MIT
/** packages/contracts/test/capacites-agent.test.ts — capacités d'un sous-agent : ordre fixe, une catégorie par capacité, `verify` ne modifie pas, la lecture seule retire Modifier et Terminal. */
import { describe, expect, it } from "vitest";

import { capacitesAgent, CLES_CAPACITES_AGENT } from "../src";
import type { EtatCapaciteAgent } from "../src";

const etats = (type: string, categories: string[], lectureSeule: boolean): EtatCapaciteAgent[] =>
  capacitesAgent({ type, categories, lectureSeule }).map((c) => c.etat);

describe("capacitesAgent", () => {
  it("cinq entrées dans l'ordre fixe, quelles que soient les catégories", () => {
    for (const categories of [[], ["fs"], ["fs", "shell", "git", "browser"]])
      expect(capacitesAgent({ type: "custom", categories, lectureSeule: false }).map((c) => c.cle)).toEqual([
        "lire",
        "modifier",
        "terminal",
        "git",
        "web",
      ]);
    expect([...CLES_CAPACITES_AGENT]).toEqual(["lire", "modifier", "terminal", "git", "web"]);
  });

  it("chaque capacité suit sa catégorie : fs, fs, shell, git, browser", () => {
    expect(etats("custom", [], false)).toEqual(["non", "non", "non", "non", "non"]);
    expect(etats("custom", ["fs"], false)).toEqual(["oui", "oui", "non", "non", "non"]);
    expect(etats("custom", ["shell"], false)).toEqual(["non", "non", "oui", "non", "non"]);
    expect(etats("custom", ["git"], false)).toEqual(["non", "non", "non", "oui", "non"]);
    expect(etats("custom", ["browser"], false)).toEqual(["non", "non", "non", "non", "oui"]);
    expect(etats("custom", ["mem", "office"], false)).toEqual(["non", "non", "non", "non", "non"]);
  });

  it("lecture seule : Modifier et Terminal accordés deviennent `lecture_seule`, le reste est inchangé", () => {
    expect(etats("explore", ["fs", "git"], true)).toEqual(["oui", "lecture_seule", "non", "oui", "non"]);
    expect(etats("implement", ["fs", "shell", "git"], true)).toEqual([
      "oui",
      "lecture_seule",
      "lecture_seule",
      "oui",
      "non",
    ]);
    expect(etats("custom", ["fs", "browser"], true)).toEqual(["oui", "lecture_seule", "non", "non", "oui"]);
  });

  it("une capacité absente reste `non` en lecture seule (rien à retirer)", () => {
    expect(etats("custom", ["git"], true)).toEqual(["non", "non", "non", "oui", "non"]);
  });

  it("verify ne modifie jamais, lecture seule ou non ; il garde le terminal tant qu'il n'est pas en lecture seule", () => {
    expect(etats("verify", ["shell", "fs", "git"], false)).toEqual(["oui", "non", "oui", "oui", "non"]);
    expect(etats("verify", ["shell", "fs", "git"], true)).toEqual([
      "oui",
      "non",
      "lecture_seule",
      "oui",
      "non",
    ]);
  });
});
