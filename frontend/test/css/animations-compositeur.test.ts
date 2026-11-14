// SPDX-License-Identifier: MIT
/** frontend/test/css/animations-compositeur.test.ts — les animations infinies pendant un tour (pastille du volet, éclat des libellés vivants) n'animent que transform et opacity ; la copie du libellé reste immobile sous la fenêtre qui glisse. */
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

// Largeur d'une règle en part de son parent (50 % → 0,5).
function largeur(selecteur: string): number {
  const m = /\bwidth:\s*([\d.]+)%/.exec(bloc(`${selecteur} {`));
  expect(m, `${selecteur} : width en %`).not.toBeNull();
  return Number(m?.[1]) / 100;
}

// Décalage horizontal d'une image clé, en part de la largeur de l'élément animé.
function decalage(animation: string, image: "from" | "to"): number {
  const m = new RegExp(`${image}\\s*\\{\\s*transform:\\s*translateX\\((-?[\\d.]+)%\\)`).exec(
    bloc(`@keyframes ${animation} {`),
  );
  expect(m, `${animation} ${image}`).not.toBeNull();
  return Number(m?.[1]) / 100;
}

describe("animations jouées par le compositeur", () => {
  it.each(["elpis-run-dot", "mem-wave-fenetre", "mem-wave-copie"])(
    "%s : transform et opacity seulement",
    (animation) => {
      const props = proprietes(animation);
      expect(props.length).toBeGreaterThan(0);
      for (const p of props) expect(["transform", "opacity"], `${animation} anime ${p}`).toContain(p);
    },
  );

  it("caret du flux : pouls d'opacité, coupé tant que le texte coule et en mouvement réduit", () => {
    expect(proprietes("elpis-caret-pulse")).toEqual(["opacity"]);
    expect(bloc(".elpis-stream-caret {")).toMatch(/animation:\s*elpis-caret-pulse\s/);
    expect(bloc(".elpis-texte-coule .elpis-stream-caret {").trim()).toBe("animation: none;");
    expect(STYLE).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.elpis-stream-caret \{ animation: none; \}/,
    );
  });

  it("éclat des libellés : la copie du texte se déplace à l'opposé de la fenêtre, à chaque image clé", () => {
    const fenetre = largeur(".mem-wave-fenetre");
    const copie = largeur(".mem-wave-copie") * fenetre;
    expect(copie).toBeCloseTo(1, 10);
    for (const image of ["from", "to"] as const) {
      expect(decalage("mem-wave-copie", image) * copie, image).toBeCloseTo(
        -decalage("mem-wave-fenetre", image) * fenetre,
        10,
      );
    }
  });
});
