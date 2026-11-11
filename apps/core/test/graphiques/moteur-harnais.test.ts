// SPDX-License-Identifier: MIT
/** apps/core/test/graphiques/moteur-harnais.test.ts — graphiques : rien ne disparaît ni ne change d'ordre sans avertissement (remarques B-18, B-24 à B-27 du harnais). */
import { describe, expect, it } from "vitest";

import { runChart, toolDescription } from "../../src/graphiques/moteur/index";

type D = Record<string, unknown>;
const lancer = (type: string, args: D): { r: D; opt: D | null } => {
  const [r, opt] = runChart({ type, ...args });
  return { r, opt: opt as D | null };
};
const avert = (r: D): string =>
  JSON.stringify([...((r["warnings"] as string[]) ?? []), ...((r["fixes"] as string[]) ?? [])]);

describe("B-24 entonnoir", () => {
  const data = [
    { e: "Visites", n: 12000 },
    { e: "Panier", n: 1500 },
    { e: "Achat", n: 2000 },
  ];
  it("garde l'ordre d'entrée, calcule sur la dernière étape et avertit", () => {
    const { r, opt } = lancer("funnel", { data });
    expect(r["summary"]).toMatch(/final conversion 16,7\s%/);
    expect(avert(r)).toContain("not decreasing");
    expect(JSON.stringify(opt)).toMatch(/Achat.{1,12}17 %/);
    const s = (opt as D)["series"] as D[];
    expect((s[0]!["data"] as D[]).map((d) => d["name"])).toEqual(["Visites", "Panier", "Achat"]);
    expect(s[0]!["sort"]).toBe("none");
  });
  it("entrée décroissante : inchangé, sans avertissement", () => {
    const { r } = lancer("funnel", { data: [data[0], data[2], data[1]] });
    expect(r["summary"]).toMatch(/12,5\s%/);
    expect(r["warnings"]).toBeUndefined();
  });
});

describe("B-25 arbre", () => {
  it("cycle : les nœuds non dessinés sont annoncés", () => {
    const { r } = lancer("tree", {
      data: [
        { nom: "R", parent: "" },
        { nom: "A", parent: "R" },
        { nom: "B", parent: "A" },
        { nom: "C", parent: "D" },
        { nom: "D", parent: "C" },
      ],
    });
    expect(r["summary"]).toContain("3 nodes");
    expect(avert(r)).toContain("2 node(s) not drawn");
    expect(avert(r)).toContain("C, D");
  });
  it("doublons de noms annoncés", () => {
    const { r } = lancer("tree", {
      data: [
        { nom: "R", parent: "" },
        { nom: "A", parent: "R" },
        { nom: "A", parent: "R" },
      ],
    });
    expect(avert(r)).toContain("duplicate node name");
  });
});

describe("B-26 calendrier", () => {
  it("une date invalide écarte sa ligne, annoncée, sans « needs a date column »", () => {
    const { r } = lancer("calendar", {
      data: [
        { date: "2026-01-05", c: 1 },
        { date: "2026-02-30", c: 2 },
        { date: "2026-01-07", c: 3 },
      ],
    });
    expect(r["ok"]).toBe(true);
    expect(r["summary"]).toContain("2 days");
    expect(avert(r)).toContain("1 row(s) skipped");
    expect(avert(r)).toContain("2026-02-30");
  });
  it("JJ/MM : l'interprétation retenue est annoncée", () => {
    const { r } = lancer("calendar", {
      data: [
        { date: "05/01/2026", c: 1 },
        { date: "06/01/2026", c: 2 },
      ],
    });
    expect(avert(r)).toContain("DD/MM/YYYY");
  });
});

describe("B-27 clés, highlight, null", () => {
  it("lignes aux clés différentes : avertissement", () => {
    const { r } = lancer("bar", {
      data: [
        { cat: "a", v: 1 },
        { categorie: "b", valeur: 2 },
      ],
    });
    expect(avert(r)).toContain("do not all have the same keys");
  });
  it("highlight inconnu : annoncé et rien n'est grisé", () => {
    const { r, opt } = lancer("bar", {
      data: [
        { m: "a", v: 1 },
        { m: "b", v: 2 },
      ],
      highlight: "zzz",
    });
    expect(avert(r)).toContain("highlight not found");
    expect(JSON.stringify(opt)).not.toContain("@muted");
  });
  it("highlight connu : les autres barres restent grisées", () => {
    const { r, opt } = lancer("bar", {
      data: [
        { m: "a", v: 1 },
        { m: "b", v: 2 },
      ],
      highlight: "a",
    });
    expect(r["warnings"]).toBeUndefined();
    expect(JSON.stringify(opt)).toContain("@muted");
  });
  it("valeur null écartée : annoncée", () => {
    const { r } = lancer("bar", {
      data: [
        { m: "a", v: 1 },
        { m: "b", v: null },
        { m: "c", v: 3 },
      ],
    });
    expect(avert(r)).toContain("1 empty or non-numeric value(s) in 'v'");
  });
});

describe("B-18 colonne presque numérique", () => {
  const data = [
    { m: "a", v: 1 },
    { m: "b", v: "deux" },
    { m: "c", v: 3 },
  ];
  it("sans y : lue comme nombres, la cellule invalide est listée", () => {
    const { r, opt } = lancer("bar", { data });
    expect(r["ok"]).toBe(true);
    expect(avert(r)).toContain("deux");
    expect(((opt as D)["series"] as D[]).map((s) => s["name"])).toEqual(["v"]);
  });
  it("y explicite : jamais de séries « 1 », « 2 », « deux »", () => {
    const { r, opt } = lancer("bar", { data: [...data.slice(0, 2), { m: "c", v: "deux" }], y: ["v"] });
    expect(((opt as D)["series"] as D[]).map((s) => s["name"])).toEqual(["v"]);
    expect(avert(r)).toContain("deux");
  });
});

describe("B-28 à B-31 avertissements", () => {
  it("jauge au-delà du max, progression au-delà du total, KPI avec previous = 0", () => {
    expect(avert(lancer("gauge", { data: [{ label: "x", value: 120, max: 100 }] }).r)).toContain(
      "value exceeds max (120 > 100)",
    );
    expect(avert(lancer("progress", { data: [{ item: "MFA", done: 1600, total: 1500 }] }).r)).toContain(
      "done exceeds total for MFA",
    );
    expect(avert(lancer("kpi", { data: [{ label: "x", value: 10, previous: 0 }] }).r)).toContain(
      "previous = 0 for 'x': change not computable",
    );
  });
  it("tendance sur 2 points sautée et annoncée, sur 3 points tracée", () => {
    const deux = lancer("scatter", {
      data: [
        { a: 1, b: 2 },
        { a: 2, b: 4 },
      ],
      trend: true,
    }).r;
    expect(avert(deux)).toContain("trend needs at least 3 numeric points: skipped");
    const trois = lancer("scatter", {
      data: [
        { a: 1, b: 2 },
        { a: 2, b: 4 },
        { a: 3, b: 7 },
      ],
      trend: true,
    }).r;
    expect(trois["warnings"]).toBeUndefined();
  });
  it("candlestick : moyenne mobile annoncée seulement avec 5 bougies", () => {
    const bougie = (i: number): D => ({
      date: `2026-03-0${i}`,
      open: i,
      high: i + 2,
      low: i - 1,
      close: i + 1,
    });
    const deux = lancer("candlestick", { data: [bougie(1), bougie(2)], trend: true }).r;
    expect(avert(deux)).not.toContain("5-period moving average");
    expect(avert(deux)).toContain("at least 5 candles");
    const cinq = lancer("candlestick", { data: [1, 2, 3, 4, 5].map(bougie), trend: true }).r;
    expect(avert(cinq)).toContain("5-period moving average");
  });
  it("heatmap : cellule manquante signalée", () => {
    const { r } = lancer("heatmap", {
      data: [
        { jour: "Lun", heure: "9 h", appels: 1 },
        { jour: "Lun", heure: "10 h", appels: 2 },
        { jour: "Mar", heure: "9 h", appels: 3 },
      ],
    });
    expect(avert(r)).toContain("1 cell(s) missing (Mar × 10 h): left empty");
  });
  it("heatmap creuse de 10 000 lignes uniques : absentes comptées sans parcourir |x|×|y|", () => {
    const n = 10_000;
    const data = Array.from({ length: n }, (_v, i) => ({ capteur: `c${i}`, heure: `h${i}`, v: i % 97 }));
    const t0 = performance.now();
    const { r } = lancer("heatmap", { data, x: "capteur", y: "heure", value: "v" });
    expect(performance.now() - t0).toBeLessThan(5_000);
    expect(r["ok"]).toBe(true);
    expect(avert(r)).toContain(`${n * n - n} cell(s) missing (c0 × h1, c0 × h2, c0 × h3): left empty`);
  });
  it("description de chart_pie : 8 parts, comme MAX_SERIES (B-30)", () => {
    expect(toolDescription("pie")).toContain("up to 8 parts");
  });
});
