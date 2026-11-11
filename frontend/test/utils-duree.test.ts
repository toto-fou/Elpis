// SPDX-License-Identifier: MIT
/** frontend/test/utils-duree.test.ts — durées lisibles : sous la seconde (défaut, live, precise), paliers min et h, entrées dégradées, variante en millisecondes. */
import { strict as assert } from "node:assert";
import { it } from "vitest";

import { fmtElapsed, fmtElapsedMs } from "../src/utils/utils-purs";

// ── Sous la seconde : trois modes distincts ──────────────────

it("mode par défaut : « <1 s » (0 s se lirait comme « pas de mesure »)", () => {
  assert.equal(fmtElapsed(0), "<1 s");
  assert.equal(fmtElapsed(0.4), "<1 s");
  assert.equal(fmtElapsed(0.99), "<1 s");
});

it("mode live : « 0 s » (un chrono qui démarre doit afficher zéro)", () => {
  assert.equal(fmtElapsed(0, { live: true }), "0 s");
  assert.equal(fmtElapsed(0.4, { live: true }), "0 s");
  assert.equal(fmtElapsed(0.99, { live: true }), "0 s");
});

it("mode precise : un dixième, TRONQUÉ et jamais arrondi", () => {
  assert.equal(fmtElapsed(0.2, { precise: true }), "0.2 s");
  assert.equal(fmtElapsed(0.9, { precise: true }), "0.9 s");
  // 990 ms arrondi donnerait « 1.0 s » juste avant « 1 s » : interdit.
  assert.equal(fmtElapsed(0.99, { precise: true }), "0.9 s");
  assert.equal(fmtElapsed(0.999, { precise: true }), "0.9 s");
});

it("mode precise : sous 100 ms, « <0.1 s »", () => {
  assert.equal(fmtElapsed(0, { precise: true }), "<0.1 s");
  assert.equal(fmtElapsed(0.05, { precise: true }), "<0.1 s");
  assert.equal(fmtElapsed(0.0999, { precise: true }), "<0.1 s");
  assert.equal(fmtElapsed(0.1, { precise: true }), "0.1 s");
});

it("live gagne sur precise quand les deux sont posés", () => {
  assert.equal(fmtElapsed(0.5, { live: true, precise: true }), "0 s");
});

// ── Au-dessus de la seconde : plus jamais de décimales ────────

it("de 1 à 59 s : secondes entières, jamais de dixième", () => {
  assert.equal(fmtElapsed(1), "1 s");
  assert.equal(fmtElapsed(1.9), "1 s");
  assert.equal(fmtElapsed(42), "42 s");
  assert.equal(fmtElapsed(59.99), "59 s");
});

it("au-delà d'une seconde, les trois modes convergent", () => {
  for (const s of [1, 5, 42, 59, 60, 125, 3600, 7503]) {
    assert.equal(fmtElapsed(s, { live: true }), fmtElapsed(s), "live diverge à " + s);
    assert.equal(fmtElapsed(s, { precise: true }), fmtElapsed(s), "precise diverge à " + s);
  }
});

it("de 60 s à 59 min : « m min SS s », secondes paddées", () => {
  assert.equal(fmtElapsed(60), "1 min 00 s");
  assert.equal(fmtElapsed(61), "1 min 01 s");
  assert.equal(fmtElapsed(69), "1 min 09 s");
  assert.equal(fmtElapsed(125), "2 min 05 s");
  assert.equal(fmtElapsed(599), "9 min 59 s");
  assert.equal(fmtElapsed(3599), "59 min 59 s");
});

it("à partir d'une heure : « h h MM min », minutes paddées", () => {
  assert.equal(fmtElapsed(3600), "1 h 00 min");
  assert.equal(fmtElapsed(3660), "1 h 01 min");
  assert.equal(fmtElapsed(3840), "1 h 04 min");
  assert.equal(fmtElapsed(7503), "2 h 05 min");
  assert.equal(fmtElapsed(86400), "24 h 00 min");
});

it("les frontières exactes basculent d'unité au bon moment", () => {
  assert.equal(fmtElapsed(59.999), "59 s");
  assert.equal(fmtElapsed(60), "1 min 00 s");
  assert.equal(fmtElapsed(3599.999), "59 min 59 s");
  assert.equal(fmtElapsed(3600), "1 h 00 min");
});

it("le padding garde une largeur stable (colonnes en tabular-nums)", () => {
  // « 1 min 05 s » et non « 1 min 5 s » : sinon la colonne saute.
  assert.ok(/^\d+ min \d\d s$/.test(fmtElapsed(65)));
  assert.ok(/^\d+ h \d\d min$/.test(fmtElapsed(3665)));
});

// ── Entrées dégénérées ───────────────────────────────────────

it("les durées négatives sont ramenées à zéro, pas rendues négatives", () => {
  assert.equal(fmtElapsed(-5), "<1 s");
  assert.equal(fmtElapsed(-5, { live: true }), "0 s");
});

it("null, undefined, NaN et une chaîne non numérique valent zéro", () => {
  for (const v of [null, undefined, NaN, "abc", {}, []]) {
    assert.equal(fmtElapsed(v), "<1 s", "entrée : " + JSON.stringify(v));
  }
});

it("une chaîne numérique est acceptée", () => {
  assert.equal(fmtElapsed("42"), "42 s");
  assert.equal(fmtElapsed("7503"), "2 h 05 min");
});

it("le résultat est toujours une chaîne non vide", () => {
  for (const v of [0, -1, null, NaN, 1e12, 0.0001]) {
    const r = fmtElapsed(v);
    assert.equal(typeof r, "string");
    assert.ok(r.length > 0);
  }
});

// ── La variante millisecondes ────────────────────────────────

it("elpisFmtElapsedMs divise par 1000 et délègue", () => {
  assert.equal(fmtElapsedMs(42000), "42 s");
  assert.equal(fmtElapsedMs(7503000), "2 h 05 min");
  assert.equal(fmtElapsedMs(200, { precise: true }), "0.2 s");
  assert.equal(fmtElapsedMs(0, { live: true }), "0 s");
});

it("elpisFmtElapsedMs encaisse null / NaN", () => {
  assert.equal(fmtElapsedMs(null), "<1 s");
  assert.equal(fmtElapsedMs(NaN), "<1 s");
});

// ── MIROIR : les deux implémentations ne doivent pas diverger ─
