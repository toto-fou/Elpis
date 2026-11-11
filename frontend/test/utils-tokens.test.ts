// SPDX-License-Identifier: MIT
/** frontend/test/utils-tokens.test.ts — compteurs de tokens : format compact fr-FR, postes disjoints, globals publiés. */
import { strict as assert } from "node:assert";
import { it } from "vitest";

import { fmtTokenCount as fmt, tokenBreakdown as parts } from "../src/utils/utils-purs";

it("format compact fr-FR", () => {
  assert.equal(fmt(0), "0");
  assert.equal(fmt(845), "845");
  assert.equal(fmt(12345), "12,3 k");
  assert.equal(fmt(14000), "14 k");
  assert.equal(fmt(245000), "245 k");
  assert.equal(fmt(1234567), "1,2 M");
  assert.equal(fmt(999600), "1 M"); // jamais « 1 000 k »
  assert.equal(fmt(999499), "999 k");
  assert.equal(fmt(null), "0");
  assert.equal(fmt(-5), "0");
});

it("quatre postes disjoints, sommes et bornes", () => {
  assert.deepStrictEqual(parts(12345, 1130, 11800, 820, 3200), {
    input: 12345,
    cache: 11800,
    input_new: 545,
    tools: 3200,
    output: 1130,
    thinking: 820,
    response: 310,
    cache_pct: 96,
  });
  assert.equal(parts(100, 0, 0, 0, 500).tools, 100); // outils ≤ entrée
  // cache ≤ entrée, réflexion ≤ sortie
  const b = parts(100, 10, 500, 50);
  assert.equal(b.cache, 100);
  assert.equal(b.input_new, 0);
  assert.equal(b.thinking, 10);
  assert.equal(b.response, 0);
  assert.equal(parts(0, 0, 0, 0).cache_pct, 0);
});
