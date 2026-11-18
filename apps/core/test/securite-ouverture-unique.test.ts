// SPDX-License-Identifier: MIT
/** apps/core/test/securite-ouverture-unique.test.ts — seul `ouvrirSession` écrit l'identité d'un compte (`user_id`) dans une session. */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const RACINE = join(__dirname, "..", "..", "..");
const AUTORISE = join("packages", "auth", "src", "ouverture.ts");

function sources(dossier: string): string[] {
  return readdirSync(dossier, { withFileTypes: true }).flatMap((e) => {
    if (e.name === "node_modules" || e.name === "dist" || e.name === "test") return [];
    const chemin = join(dossier, e.name);
    if (e.isDirectory()) return sources(chemin);
    return /\.(ts|mts|vue)$/u.test(e.name) ? [chemin] : [];
  });
}

describe("ouverture de session unique", () => {
  it("aucun autre fichier de apps/ ou packages/ n'écrit user_id dans une session", () => {
    const fautifs = [...sources(join(RACINE, "apps")), ...sources(join(RACINE, "packages"))]
      .map((f) => relative(RACINE, f))
      .filter((f) => f !== AUTORISE)
      .filter((f) => /session\s*\.\s*set\(\s*["'`]user_id["'`]/u.test(readFileSync(join(RACINE, f), "utf8")));
    expect(fautifs).toEqual([]);
  });

  it("le fichier autorisé existe et écrit bien user_id", () => {
    expect(readFileSync(join(RACINE, AUTORISE), "utf8")).toContain('session.set("user_id"');
  });
});
