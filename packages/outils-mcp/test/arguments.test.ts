// SPDX-License-Identifier: MIT
/** packages/outils-mcp/test/arguments.test.ts — arguments d'outils validés comme FastMCP (TypeAdapter de la fonction) : valeurs, erreurs et texte rejoués contre pydantic. */
import { estDict, FlottantPy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { py } from "@elpis/http";
import { describe, expect, it } from "vitest";

import { tronquerEntree, validerArguments } from "../src/arguments";
import type { Signature } from "../src/arguments";
import { SIGNATURES_REELLES } from "./familles-test";
import { detaguer, lireVecteurs, taguer } from "./vecteurs";

const V = lireVecteurs<{
  cas: {
    signature: string;
    args: Dict;
    ok?: unknown;
    titre?: string;
    texte?: string;
    erreurs?: unknown[];
  }[];
}>("arguments");

const item = py.model(
  {
    content: py.str(),
    status: py.optional(py.str()).defaut(""),
    n: py.int().defaut(0),
  },
  { extra: "forbid", classe: "Item" },
);

/** Équivalents TS des signatures Python des vecteurs (synthétiques et outils réels todo/memory). */
const SIGNATURES: Record<string, Signature> = {
  simple: {
    fonction: "simple",
    parametres: {
      a: py.int(),
      b: py.str().defaut("x"),
      c: py.optional(py.int()).defaut(null),
      d: py.bool().defaut(false),
      e: py.list(py.str()).fabrique(() => []),
      g: py.literal("x", "y").defaut("x"),
      h: py.float().defaut(1),
      i: py.dict(py.str(), py.any()).fabrique(() => ({})),
    },
  },
  liste: {
    fonction: "liste",
    parametres: { items: py.list(item), tags: py.optional(py.list(py.str())).defaut(null) },
  },
  bornes: {
    fonction: "bornes",
    parametres: {
      n: py.int({ ge: 1, le: 20 }).defaut(5),
      s: py.str({ min_length: 1, max_length: 5 }).defaut("q"),
      x: py.float({ gt: 0 }).defaut(1),
    },
  },
  tout: {
    fonction: "tout",
    parametres: { x: py.any().defaut(null), y: py.dict(py.str(), py.int()).fabrique(() => ({})) },
  },
  ...SIGNATURES_REELLES,
};

/** Valeurs validées en nombres JS : un `float` Python n'a pas de type à part en TS, un entier long perd sa précision (écart). */
function plat(v: unknown): unknown {
  if (v instanceof FlottantPy) return v.valeur;
  if (typeof v === "bigint") return Number(v);
  if (Array.isArray(v)) return v.map(plat);
  if (estDict(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plat(x)]));
  return v;
}

describe("arguments validés comme pydantic (vecteurs FastMCP)", () => {
  it.each(V.cas.map((c, i) => [i, c.signature, JSON.stringify(c.args).slice(0, 60), c] as const))(
    "%i %s %s",
    (_i, nom, _a, c) => {
      const sig = SIGNATURES[nom] as Signature;
      const r = validerArguments(sig, detaguer(c.args) as Dict);
      if (c.texte === undefined) {
        expect(r.ok, JSON.stringify(r)).toBe(true);
        if (r.ok && c.ok !== null) expect(plat(r.valeurs)).toEqual(plat(detaguer(c.ok)));
        return;
      }
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.titre).toBe(c.titre);
      expect(r.texte).toBe(c.texte);
      const sansCtx = r.erreurs.map(({ type, loc, msg, input }) => ({
        type,
        loc,
        msg,
        input: taguer(input),
      }));
      const attendues = (c.erreurs ?? []).map((e) => {
        const x = detaguer(e) as Dict;
        return { type: x["type"], loc: x["loc"], msg: x["msg"], input: taguer(x["input"]) };
      });
      expect(sansCtx).toEqual(attendues);
    },
  );

  it("les valeurs validées sont celles des vecteurs pour chaque signature synthétique", () => {
    const succes = V.cas.filter((c) => c.texte === undefined && c.ok !== null);
    expect(succes.length).toBeGreaterThan(10);
    expect(succes.every((c) => estDict(detaguer(c.ok)))).toBe(true);
  });
});

describe("troncature de input_value (octets UTF-8)", () => {
  it.each([
    ["a".repeat(49), "a".repeat(49)],
    [`'${"a".repeat(49)}'`, `'${"a".repeat(24)}...${"a".repeat(23)}'`],
    [`'${"é".repeat(24)}${"a".repeat(10)}'`, `'${"é".repeat(12)}...${"é".repeat(6)}${"a".repeat(10)}'`],
    [`'a${"é".repeat(30)}'`, `'a${"é".repeat(11)}...${"é".repeat(11)}'`],
    [`'${"€".repeat(20)}'`, `'${"€".repeat(8)}...${"€".repeat(7)}'`],
    [`'ab${"€".repeat(9)}${"x".repeat(30)}'`, `'ab${"€".repeat(7)}...${"x".repeat(23)}'`],
  ])("%s", (repr, attendu) => {
    expect(tronquerEntree(repr)).toBe(attendu);
  });
});
