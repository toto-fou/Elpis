// SPDX-License-Identifier: MIT
/** frontend/test/rag/bande-css.test.ts — bande d'indexation « en cours » : la pulsation n'anime que l'opacité d'un calque, ralentie (pas retirée) en mouvement réduit. */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const RAG = readFileSync(join(import.meta.dirname, "../../src/styles/rag.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** Règles (sélecteur → déclarations) de premier niveau ou d'un bloc `@media`. */
function regles(css: string): [string, string][] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1]!.trim(), m[2]!]);
}

describe("bande d'indexation", () => {
  it("rag-pulse n'anime que l'opacité, sur le calque ::before des cellules en cours", () => {
    const images = /@keyframes rag-pulse \{([\s\S]*?\})\s*\}/.exec(RAG)?.[1] ?? "";
    const props = [...images.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
    expect(props).toEqual(["opacity"]);
    const animees = regles(RAG).filter(([, d]) => /animation:\s*rag-pulse/.test(d));
    expect(animees.map(([s]) => s)).toEqual([".rag-strip.is-busy i.is-todo::before"]);
  });

  it("mouvement réduit : la pulsation est ralentie, pas retirée", () => {
    const bloc = /@media \(prefers-reduced-motion: reduce\) \{([^}]*\})\s*\}/.exec(RAG)?.[1] ?? "";
    expect(bloc).toMatch(/\.rag-strip\.is-busy i\.is-todo::before \{ animation-duration: 3\.2s; \}/);
  });
});
