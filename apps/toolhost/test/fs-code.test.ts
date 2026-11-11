// SPDX-License-Identifier: MIT
/** apps/toolhost/test/fs-code.test.ts — code_intel en TS contre Python (vecteurs) : corpus réel (code Python de référence, copie figée du reste du dépôt) et cas construits ; plans, symboles, définitions, références, résumé. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import type { Dict } from "@elpis/commun";
import { describe, expect, it } from "vitest";

import {
  detecterLangage,
  listerSymboles,
  outline,
  resumer,
  trouverDefinition,
  trouverReferences,
} from "../src/mcp/fs/code";

interface Cas {
  chemin: string;
  source?: string;
  langage: string;
  texte?: string;
  sha256?: string;
  outline: Dict[];
  outline2: Dict[];
  symboles: Dict[];
  resume: string;
  ecart_treesitter?: boolean;
  definitions: Record<string, Dict[]>;
  references: Record<string, { refs: Dict[]; corrige?: boolean }>;
}

const RACINE = path.resolve(import.meta.dirname, "..", "..", "..");
const V = JSON.parse(readFileSync(new URL("./vecteurs/fs-code.json", import.meta.url), "utf-8")) as {
  langages: Record<string, string>;
  corpus: Cas[];
  cas: Cas[];
};

function texteDe(c: Cas): string {
  if (c.texte !== undefined) return c.texte;
  const t = readFileSync(path.join(RACINE, c.source ?? c.chemin), "utf-8");
  expect(
    createHash("sha256").update(t).digest("hex"),
    `${c.source ?? c.chemin} a changé : regénérer les vecteurs`,
  ).toBe(c.sha256);
  return t;
}

/** JSON trié comme Python l'écrirait (ordre des clés compris). */
const json = (v: unknown): string => JSON.stringify(v);

const SANS_MESSAGE = (j: string): string => j.replace(/"message":"(?:[^"\\]|\\.)*"/gu, '"message":"<m>"');
/** Écarts consignés, mesurés : texte de l'erreur de syntaxe (b.py : « invalid syntax » de CPython, « '(' was never closed » ici) ou d'analyse YAML (y.yaml), et `\N{…}` gardé tel quel dans une docstring (p.py : pas de table des noms Unicode hors ligne). */
const ECARTS: Readonly<Record<string, (j: string, ts: boolean) => string>> = {
  "b.py": SANS_MESSAGE,
  "y.yaml": SANS_MESSAGE,
  "p.py": (j, ts) => (ts ? j.replaceAll("\\\\N{BULLET}", "\u2022") : j),
};

describe("code_intel (vecteurs Python)", () => {
  it("detect_language", () => {
    for (const [p, l] of Object.entries(V.langages)) expect(detecterLangage(p), p).toBe(l);
  });

  it.each([...V.corpus, ...V.cas].map((c) => [c.chemin, c] as const))("%s", (_n, c) => {
    const t = texteDe(c);
    const e = ECARTS[c.chemin] ?? ((j: string) => j);
    expect(detecterLangage(c.chemin)).toBe(c.langage);
    expect(e(json(outline(t, c.langage, 4, false)), true), "outline").toBe(e(json(c.outline), false));
    expect(e(json(outline(t, c.langage, 2, false)), true), "outline profondeur 2").toBe(
      e(json(c.outline2), false),
    );
    expect(json(listerSymboles(t, c.langage, false)), "symboles").toBe(json(c.symboles));
    expect(resumer(t, c.langage), "résumé").toBe(c.resume);
    for (const [n, attendu] of Object.entries(c.definitions))
      expect(json(trouverDefinition(t, c.langage, n)), `définition ${n}`).toBe(json(attendu));
    for (const [n, attendu] of Object.entries(c.references))
      expect(json(trouverReferences(t, c.langage, n, 50)), `références ${n}`).toBe(json(attendu.refs));
  });
});

describe("outline Python fidèle : signatures à lambda et `*Ts` (relecture des outils)", () => {
  const cas: readonly [string, string][] = [
    ["def f(key=lambda a, b: a):", "def f(key=lambda a, b: a)"],
    ["def f(cb=lambda *a, **k: None):", "def f(cb=lambda *a, **k: None)"],
    [
      "def f(cb=lambda x=1: x, d: dict[str, int] = {'a': 1}):",
      "def f(cb=lambda x=1: x, d: dict[str, int] = {'a': 1})",
    ],
    ["def f(*args: *Ts):", "def f(*args: *Ts)"],
    ["def f(x: lambda: 1 = 2):", "def f(x: lambda: 1 = 2)"],
  ];
  it.each(cas)("%s", (entete, signature) => {
    const src = `${entete}\n    pass\n\ndef g():\n    pass\n`;
    expect(outline(src, "python").map((x) => [x["kind"], x["name"], x["signature"]])).toStrictEqual([
      ["function", "f", signature],
      ["function", "g", "def g()"],
    ]);
    expect(trouverDefinition(src, "python", "g")).toHaveLength(1);
  });
  it("une signature que le lecteur ne suit pas retombe sur la forme Python, sans erreur pour tout le fichier", () => {
    const src = "def f(x=(yield)):\n    pass\n\ndef g():\n    pass\n";
    const plan = outline(src, "python");
    expect(plan.map((x) => x["kind"])).toStrictEqual(["function", "function"]);
  });
});
