// SPDX-License-Identifier: MIT
/** packages/securite/test/garde-travail.test.ts — la garde de l'invariant 9 (vitest.garde-travail.mts) relève un accès du code de production au contenu d'un /work, ni celui d'un essai, ni celui d'une exception déclarée. */
import {
  closeSync,
  constants,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { tailleBac } from "@elpis/bac";
import { lireTextePy, realpathPy } from "@elpis/commun";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EXCEPTIONS, racineTravail, releverViolations } from "../../../vitest.garde-travail.mjs";

let racine: string;
let travail: string;

beforeEach(() => {
  racine = mkdtempSync(path.join(tmpdir(), "elpis-garde-travail-"));
  travail = path.join(racine, "sb", "alice", "work");
  mkdirSync(path.join(racine, "sb", "alice", "skills"), { recursive: true });
  mkdirSync(travail);
  writeFileSync(path.join(travail, "f.txt"), "contenu");
  writeFileSync(path.join(racine, "sb", "alice", "skills", "s.md"), "skill");
});

afterEach(() => {
  releverViolations();
  rmSync(racine, { recursive: true, force: true });
});

describe("garde de l'invariant 9", () => {
  it("une lecture directe d'un fichier de /work par le code de production est relevée", () => {
    expect(lireTextePy(path.join(travail, "f.txt"))).toBe("contenu");
    expect(releverViolations()).toEqual([
      `packages/commun/src/fichiers.ts : readFile(${path.join(travail, "f.txt")}) sous ${travail}`,
    ]);
  });

  it("un chemin /proc/self/fd/N est ramené au dossier du descripteur", () => {
    const fd = openSync(travail, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      lireTextePy(`/proc/self/fd/${fd}/f.txt`);
    } finally {
      closeSync(fd);
    }
    expect(releverViolations()).toEqual([
      `packages/commun/src/fichiers.ts : readFile(${path.join(travail, "f.txt")}) sous ${travail}`,
    ]);
  });

  it("lien de /work résolu par le code de production (readlink) relevé", () => {
    symlinkSync("f.txt", path.join(travail, "lien"));
    expect(realpathPy(path.join(travail, "lien"))).toBe(path.join(travail, "f.txt"));
    expect(releverViolations().map((v) => v.split(" : ")[1]?.split("(")[0])).toEqual(["readlink"]);
  });

  it("un dossier work au-dessus du dépôt (runner de la CI) n'est pas un bac ; celui d'un bac en dessous l'est", () => {
    const depot = "/home/runner/work/Elpis/Elpis";
    expect(racineTravail(`${depot}/apps/core/src/x.ts`, [depot])).toBeNull();
    expect(racineTravail(`${depot}/sb/alice/work/f`, [depot])).toBe(`${depot}/sb/alice/work`);
  });

  it("ni l'essai lui-même, ni le code de production hors de /work, ni une exception déclarée", async () => {
    expect(readFileSync(path.join(travail, "f.txt"), "utf8")).toBe("contenu");
    expect(lireTextePy(path.join(racine, "sb", "alice", "skills", "s.md"))).toBe("skill");
    expect(await tailleBac(travail)).toBeGreaterThan(0);
    expect(releverViolations()).toEqual([]);
  });

  it("chaque exception est justifiée et bornée à des opérations nommées", () => {
    for (const [source, { ops, raison }] of Object.entries(EXCEPTIONS)) {
      expect(source).toMatch(/^(apps|packages)\/[^/]+\/src\/.+\.ts$/);
      expect(ops.length).toBeGreaterThan(0);
      expect(raison.length).toBeGreaterThan(20);
    }
  });
});
