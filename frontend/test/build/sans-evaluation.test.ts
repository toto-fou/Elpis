// SPDX-License-Identifier: MIT
/** frontend/test/build/sans-evaluation.test.ts — CSP sans 'unsafe-eval' : Zod configuré `jitless` avant tout schéma (premier import des entrées), aucune évaluation de code dans les sources. */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SRC = path.resolve(import.meta.dirname, "../../src");
const EVALUATION = /\bnew Function\s*\(|(?<![.\w])eval\s*\(|set(?:Timeout|Interval)\s*\(\s*["'`]/;

function fichiers(dossier: string): string[] {
  return fs.readdirSync(dossier, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dossier, e.name);
    if (e.isDirectory()) return fichiers(p);
    return /\.(?:ts|vue)$/.test(e.name) ? [p] : [];
  });
}

describe("aucune évaluation de code (CSP)", () => {
  it.each(["main", "admin"])("l'entrée %s importe zod-sans-eval en premier", (nom) => {
    const texte = fs.readFileSync(path.join(SRC, "entries", `${nom}.ts`), "utf8");
    const premier = /^import\s+(?:[^"']*from\s+)?["']([^"']+)["']/m.exec(texte)?.[1];
    expect(premier).toBe("../platform/zod-sans-eval");
  });

  it("le build range Zod et zod-sans-eval dans le même fichier : le réglage précède tout schéma d'un autre fichier", () => {
    const config = fs.readFileSync(path.resolve(SRC, "../vite.config.mts"), "utf8");
    const groupe = /\{\s*name:\s*"zod",\s*test:\s*\/(.+)\/\s*\}/.exec(config)?.[1];
    expect(groupe).toBeDefined();
    const motif = new RegExp(groupe ?? "$^");
    expect(motif.test("/depot/node_modules/zod/v4/core/schemas.js")).toBe(true);
    expect(motif.test("/depot/frontend/src/platform/zod-sans-eval.ts")).toBe(true);
    expect(motif.test("/depot/packages/contracts/src/rest/commun.ts")).toBe(false);
  });

  it("zod-sans-eval pose jitless", () => {
    const texte = fs.readFileSync(path.join(SRC, "platform", "zod-sans-eval.ts"), "utf8");
    expect(texte).toMatch(/z\.config\(\{\s*jitless:\s*true\s*\}\)/);
  });

  it("aucun eval, new Function ni minuterie à chaîne dans les sources", () => {
    const fautifs = fichiers(SRC).filter((f) => EVALUATION.test(fs.readFileSync(f, "utf8")));
    expect(fautifs.map((f) => path.relative(SRC, f))).toEqual([]);
  });
});
