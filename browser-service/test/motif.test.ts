// SPDX-License-Identifier: MIT
// test/motif.test.ts — expression régulière de l'appelant : compilée et essayée sous un délai.
import { test } from "node:test";
import assert from "node:assert/strict";
import { compilerMotif } from "../src/motif.ts";

test("un motif valide s'essaie comme une expression régulière, drapeaux compris", () => {
  assert.equal(compilerMotif("^https://[a-z.]+/api/v\\d+").test("https://exemple.test/api/v2/x"), true);
  assert.equal(compilerMotif("^https://[a-z.]+/api/v\\d+").test("http://exemple.test/api/v2"), false);
  assert.equal(compilerMotif("LOGIN", "i").test("/login"), true);
});

test("un motif invalide ou démesuré est refusé à la compilation", () => {
  assert.throws(() => compilerMotif("(sans fin"), /Invalid regular expression/);
  assert.throws(() => compilerMotif("a".repeat(2001)), /longer than 2000/);
});

test("un motif au retour arrière sans fin rend faux sans bloquer le service", () => {
  const motif = compilerMotif("^(a+)+$");
  const t0 = Date.now();
  assert.equal(motif.test(`${"a".repeat(40)}!`), false);
  assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
  // Le motif reste utilisable après un essai coupé.
  assert.equal(motif.test("aaa"), true);
});
