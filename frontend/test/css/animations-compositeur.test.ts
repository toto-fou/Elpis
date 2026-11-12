// SPDX-License-Identifier: MIT
/** frontend/test/css/animations-compositeur.test.ts — les animations infinies pendant un tour (pastille du volet) n'animent que transform et opacity : le compositeur les joue sans style ni peinture. */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const STYLE = readFileSync(join(import.meta.dirname, "../../css/style.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

// Contenu entre les accolades qui suivent `debut`.
function bloc(debut: string): string {
  const depart = STYLE.indexOf(debut);
  expect(depart, debut).toBeGreaterThanOrEqual(0);
  const ouvrante = STYLE.indexOf("{", depart);
  let profondeur = 0;
  for (let i = ouvrante; i < STYLE.length; i++) {
    if (STYLE[i] === "{") profondeur++;
    if (STYLE[i] === "}" && --profondeur === 0) return STYLE.slice(ouvrante + 1, i);
  }
  throw new Error(`${debut} : accolade jamais refermée`);
}

function proprietes(animation: string): string[] {
  return [...bloc(`@keyframes ${animation} {`).matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1] ?? "");
}

describe("animations jouées par le compositeur", () => {
  it.each(["elpis-run-dot"])("%s : transform et opacity seulement", (animation) => {
    const props = proprietes(animation);
    expect(props.length).toBeGreaterThan(0);
    for (const p of props) expect(["transform", "opacity"], `${animation} anime ${p}`).toContain(p);
  });
});
