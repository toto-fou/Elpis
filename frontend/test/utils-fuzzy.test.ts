// SPDX-License-Identifier: MIT
/** frontend/test/utils-fuzzy.test.ts — recherche floue : accents, sous-séquence, positions, début de segment, compacité. */
import { strict as assert } from "node:assert";
import { it } from "vitest";

import { fuzzyMatch } from "../src/utils/utils-purs";

const match = fuzzyMatch;

it("insensible aux accents dans les deux sens", () => {
  assert.ok(match("eleve", "élève.py"));
  assert.ok(match("délai", "Delai de compression"));
});

it("sous-séquence exigée : un caractère absent rejette", () => {
  assert.equal(match("xyz", "Délai de compression"), null);
  assert.equal(match("", "quoi que ce soit"), null);
});

it("positions trouvées : exploitables pour surligner la cible", () => {
  const m = match("cook", "Portée du cookie");
  // Array.from : le tableau vient du bac (autre royaume JS).
  assert.deepEqual(m?.idx, [10, 11, 12, 13]);
});

it("à longueur égale, un début de segment rapporte plus", () => {
  // Même longueur, même position : seul le caractère qui précède « p »
  // diffère (« _ » ouvre un segment, « x » non).
  const segment = match("mp", "max_path")!.score;
  const milieu = match("mp", "maxxpath")!.score;
  assert.ok(segment > milieu, `segment ${segment} ≤ milieu ${milieu}`);
});

it("un motif compact devant une cible courte l'emporte", () => {
  const court = match("rag", "RAG")!.score;
  const long = match("rag", "Rapport des appels agrégés")!.score;
  assert.ok(court > long, `court ${court} ≤ long ${long}`);
});
