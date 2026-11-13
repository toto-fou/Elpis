// SPDX-License-Identifier: MIT
/** frontend/test/css/mouvement-reduit.test.ts — politique de mouvement réduit : fondus d'opacité et de couleur de 150 ms au plus, aucun déplacement ni changement de taille, transitions nommées en fondu seul, animations conservées limitées à l'opacité (et à la roue de chargement). */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const FRONT = join(import.meta.dirname, "../..");
const FEUILLES = [
  "css/style.css",
  "css/editeur.css",
  ...readdirSync(join(FRONT, "css/skins"), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => readdirSync(join(FRONT, "css/skins", d.name)).map((f) => `css/skins/${d.name}/${f}`)),
  ...readdirSync(join(FRONT, "src/styles")).map((f) => `src/styles/${f}`),
  "assets/mascotte/accueil.css",
].filter((f) => f.endsWith(".css"));

interface Regle {
  selecteur: string;
  corps: string;
  contexte: string[];
}

// Règles de style et corps de @keyframes d'une feuille, avec leurs @media / @supports englobants.
function analyser(source: string): { regles: Regle[]; keyframes: Map<string, string> } {
  const sans = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const regles: Regle[] = [];
  const keyframes = new Map<string, string>();
  const pile: { tete: string; ouvre: number }[] = [];
  let debut = 0;
  for (let i = 0; i < sans.length; i++) {
    const c = sans[i];
    if (c === "{") {
      pile.push({ tete: sans.slice(debut, i).trim().replace(/\s+/g, " "), ouvre: i });
      debut = i + 1;
    } else if (c === "}") {
      const { tete, ouvre } = pile.pop() ?? { tete: "", ouvre: 0 };
      const corps = sans.slice(ouvre + 1, i);
      if (tete.startsWith("@keyframes")) keyframes.set(tete.replace("@keyframes", "").trim(), corps);
      else if (corps.trim() && !tete.startsWith("@") && !pile.some((p) => p.tete.startsWith("@keyframes"))) {
        regles.push({
          selecteur: tete,
          corps,
          contexte: pile.map((p) => p.tete).filter((t) => t.startsWith("@")),
        });
      }
      debut = i + 1;
    } else if (c === ";" && pile.length === 0) debut = i + 1;
  }
  return { regles, keyframes };
}

const SHEETS = FEUILLES.map((f) => ({ f, ...analyser(readFileSync(join(FRONT, f), "utf8")) }));
const REGLES = SHEETS.flatMap((s) => s.regles.map((r) => ({ ...r, f: s.f })));
const KEYFRAMES = new Map(SHEETS.flatMap((s) => [...s.keyframes]));
const REDUIT = REGLES.filter((r) => r.contexte.some((c) => /prefers-reduced-motion:\s*reduce/.test(c)));
const HORS_REDUIT = REGLES.filter(
  (r) => !r.contexte.some((c) => /prefers-reduced-motion:\s*no-preference/.test(c)) && !REDUIT.includes(r),
);

function declarations(corps: string, propriete: RegExp): string[] {
  return [...corps.matchAll(/(?:^|;)\s*([a-z-]+)\s*:\s*([^;]+)/g)]
    .filter((m) => propriete.test(m[1] ?? ""))
    .map((m) => (m[2] ?? "").replace(/\s*!important/, "").trim());
}

// Durées d'une valeur de transition, en millisecondes.
function durees(valeur: string): number[] {
  return [...valeur.matchAll(/(?<![\w.-])(\d*\.?\d+)(ms|s)\b/g)].map(
    (m) => Number(m[1]) * (m[2] === "s" ? 1000 : 1),
  );
}

const PROPRIETES_PERMISES = new Set([
  "none",
  "opacity",
  "color",
  "background-color",
  "border-color",
  "text-decoration-color",
  "fill",
  "stroke",
  "box-shadow",
]);

const MOTS_ANIMATION = new Set([
  "none",
  "infinite",
  "linear",
  "ease",
  "ease-in",
  "ease-out",
  "ease-in-out",
  "both",
  "forwards",
  "backwards",
  "normal",
  "alternate",
  "reverse",
]);

const ENTREE_MARKUP = (() => {
  const noms = new Set<string>();
  const parcourir = (dossier: string): void => {
    for (const e of readdirSync(dossier, { withFileTypes: true })) {
      const chemin = join(dossier, e.name);
      if (e.isDirectory()) parcourir(chemin);
      else if (e.name.endsWith(".vue")) {
        for (const m of readFileSync(chemin, "utf8").matchAll(
          /<transition(?:-?group)?\b[^>]*?\bname="([\w-]+)"/gi,
        ))
          noms.add(m[1] ?? "");
      }
    }
  };
  parcourir(join(FRONT, "src"));
  return [...noms].sort();
})();

describe("mouvement réduit", () => {
  it("le test voit les règles de mouvement réduit et les transitions du markup", () => {
    expect(REDUIT.length).toBeGreaterThan(20);
    expect(ENTREE_MARKUP).toEqual(
      expect.arrayContaining([
        "modal",
        "popover",
        "popover-up",
        "toast",
        "fade",
        "tool-detail",
        "model-load",
        "adm-bar",
      ]),
    );
  });

  it("les transitions n'y animent que l'opacité, la couleur ou l'ombre", () => {
    for (const r of REDUIT) {
      for (const v of declarations(r.corps, /^transition-property$/)) {
        for (const p of v.split(",").map((x) => x.trim()))
          expect(PROPRIETES_PERMISES, `${r.f} ${r.selecteur} : ${p}`).toContain(p);
      }
      for (const v of declarations(r.corps, /^transition$/)) {
        for (const p of v.split(",").map((x) => x.trim().split(/\s+/)[0] ?? "")) {
          expect(PROPRIETES_PERMISES, `${r.f} ${r.selecteur} : ${p}`).toContain(p);
        }
      }
    }
  });

  it("les transitions n'y durent jamais plus de 150 ms", () => {
    for (const r of REDUIT) {
      for (const v of declarations(r.corps, /^transition(-duration)?$/)) {
        for (const d of durees(v)) expect(d, `${r.f} ${r.selecteur} : ${v}`).toBeLessThanOrEqual(150);
      }
    }
  });

  it.each(ENTREE_MARKUP)("transition « %s » : citée en fondu d'opacité seul", (nom) => {
    const regle = REDUIT.find((r) => r.selecteur.split(",").some((s) => s.trim() === `.${nom}-enter-active`));
    expect(regle, `.${nom}-enter-active absente du bloc`).toBeDefined();
    expect(declarations(regle?.corps ?? "", /^transition-property$/)).toEqual(["opacity"]);
  });

  it("les décalages d'entrée et de sortie des transitions nommées sont posés hors mouvement réduit", () => {
    const etats = HORS_REDUIT.filter((r) => /-(enter-from|leave-to)\b/.test(r.selecteur));
    expect(etats.length).toBeGreaterThan(8);
    for (const r of etats) {
      for (const m of r.corps.matchAll(/(?:^|;)\s*([a-z-]+)\s*:/g)) {
        expect(["opacity"], `${r.selecteur} { ${m[1]} } hors @media no-preference`).toContain(m[1]);
      }
    }
  });

  it("les animations posées en mouvement réduit n'animent que l'opacité, sauf la roue de chargement", () => {
    const noms = new Set<string>();
    for (const r of REDUIT) {
      for (const v of declarations(r.corps, /^animation(-name)?$/)) {
        const nom = v.split(/\s+/).find((t) => /^[a-zA-Z_][\w-]*$/.test(t) && !MOTS_ANIMATION.has(t));
        if (nom) noms.add(nom);
      }
    }
    expect([...noms]).toEqual(expect.arrayContaining(["elpisPulseReduced", "elpisPingReduced", "fadeIn"]));
    for (const nom of noms) {
      if (nom === "elpisSpinReduced") continue;
      const corps = KEYFRAMES.get(nom);
      expect(corps, `@keyframes ${nom} introuvable`).toBeDefined();
      const props = [...(corps ?? "").matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1] ?? "");
      expect(props.length, nom).toBeGreaterThan(0);
      for (const p of props) expect(["opacity"], `@keyframes ${nom} anime ${p}`).toContain(p);
    }
  });

  it("l'ancienne coupure à 0,01 ms a disparu", () => {
    for (const r of REDUIT) expect(r.corps, `${r.f} ${r.selecteur}`).not.toMatch(/0\.01m?s/);
  });
});

describe("transitions nommées : jetons et mise en page", () => {
  const RACINE = REGLES.find((r) => r.f === "css/style.css" && r.selecteur === ":root")?.corps ?? "";
  const jeton = (nom: string): string => new RegExp(`${nom}:\\s*([^;]+);`).exec(RACINE)?.[1]?.trim() ?? "";

  it("les durées et les courbes sont définies une fois, dans :root", () => {
    expect(["--duree-courte", "--duree", "--duree-longue"].map((n) => durees(jeton(n))[0])).toEqual([
      150, 200, 260,
    ]);
    for (const n of ["--courbe-fondu", "--courbe-entree", "--courbe-volet"]) expect(jeton(n), n).not.toBe("");
  });

  it("les transitions nommées n'écrivent aucune durée en dur", () => {
    const concernees = HORS_REDUIT.filter((r) => /-(enter|leave)-active|-move\b/.test(r.selecteur));
    expect(concernees.length).toBeGreaterThan(8);
    for (const r of concernees) {
      for (const v of declarations(r.corps, /^transition(-duration)?$/)) {
        expect(durees(v), `${r.f} ${r.selecteur} : ${v}`).toEqual([]);
      }
    }
  });

  it("les volets coulissants n'animent aucune propriété de mise en page, dans aucune feuille", () => {
    const regles = REGLES.filter((r) => /elpis-slide-panel|\.volet-/.test(r.selecteur));
    expect(regles.length).toBeGreaterThan(20);
    for (const r of regles) {
      for (const v of declarations(r.corps, /^transition-property$/))
        for (const p of v.split(","))
          expect(["opacity", "transform"], `${r.f} ${r.selecteur}`).toContain(p.trim());
      for (const v of declarations(r.corps, /^transition$/))
        for (const p of v.split(",").map((x) => x.trim().split(/\s+/)[0] ?? ""))
          expect(["opacity", "transform"], `${r.f} ${r.selecteur} : ${v}`).toContain(p);
    }
  });

  it("volet : la racine s'estompe, ses enfants glissent hors mouvement réduit, la sortie plus courte que l'entrée", () => {
    const corps = (selecteur: string, media: RegExp | null): string =>
      REGLES.find(
        (r) =>
          r.f === "css/style.css" &&
          r.selecteur.split(",").some((s) => s.trim() === selecteur) &&
          (media ? r.contexte.some((c) => media.test(c)) : r.contexte.length === 0),
      )?.corps ?? "";
    const glisse = /prefers-reduced-motion:\s*no-preference/;
    expect(declarations(corps(".volet-enter-active", null), /^transition$/)).toEqual([
      "opacity var(--duree-longue) var(--courbe-volet)",
    ]);
    expect(declarations(corps(".volet-leave-active", null), /^transition$/)).toEqual([
      "opacity var(--duree-courte) var(--courbe-volet)",
    ]);
    expect(declarations(corps(".volet-enter-from", null), /^opacity$/)).toEqual(["0"]);
    expect(declarations(corps(".volet-enter-active > *", glisse), /^transition$/)).toEqual([
      "transform var(--duree-longue) var(--courbe-volet)",
    ]);
    expect(declarations(corps(".volet-leave-active > *", glisse), /^transition$/)).toEqual([
      "transform var(--duree-courte) var(--courbe-volet)",
    ]);
    expect(declarations(corps(".volet-enter-from > *", glisse), /^transform$/)).toEqual([
      "translateX(var(--volet-decalage, 1.5rem))",
    ]);
  });

  it("le détail d'un outil n'anime aucune propriété de mise en page", () => {
    const regles = REGLES.filter((r) => /\.tool-detail-/.test(r.selecteur));
    expect(regles.length).toBeGreaterThanOrEqual(3);
    for (const r of regles) {
      for (const v of declarations(
        r.corps,
        /^(transition|transition-property|max-height|height|overflow)$/,
      )) {
        expect(v, `${r.f} ${r.selecteur}`).not.toMatch(/height|width|grid|margin|padding|^hidden$/);
      }
    }
  });
});
