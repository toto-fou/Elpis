// SPDX-License-Identifier: MIT
/** frontend/test/chat/outils/format-resultat.test.ts — formatToolResult (cascade des stratégies, `error` avant les champs texte) et fmtToolArgVal (vrais retours à la ligne). */
import { strict as assert } from "node:assert";
import { it } from "vitest";

import { fmtToolArgVal, formatToolResult } from "../../../src/features/chat/outils/format";

/** Sérialise comme le backend, puis formate. */
const f = (v: unknown): string => formatToolResult(JSON.stringify(v));

// ── Entrées vides ────────────────────────────────────────────

it("null, undefined et chaîne vide rendent « -- »", () => {
  assert.equal(formatToolResult(null), "--");
  assert.equal(formatToolResult(undefined), "--");
  assert.equal(formatToolResult(""), "--");
});

it("zéro et false ne sont PAS traités comme vides", () => {
  assert.equal(formatToolResult("0"), "0");
  assert.equal(formatToolResult("false"), "false");
});

// ── Stratégie 1 : ce qui n'est pas du JSON passe tel quel ────

it("une chaîne non-JSON est rendue intacte", () => {
  assert.equal(formatToolResult("bonjour"), "bonjour");
  assert.equal(formatToolResult("erreur: fichier absent"), "erreur: fichier absent");
});

it("du JSON malformé passe tel quel, il n'est pas avalé", () => {
  assert.equal(formatToolResult('{"a": '), '{"a": ');
  assert.equal(formatToolResult("{pas du json}"), "{pas du json}");
});

it("les retours à la ligne d'une sortie brute sont préservés", () => {
  assert.equal(formatToolResult("ligne1\nligne2"), "ligne1\nligne2");
});

// ── Stratégie 2 : scalaires JSON ─────────────────────────────

it("une chaîne JSON est dé-quotée", () => {
  assert.equal(formatToolResult('"déjà du texte"'), "déjà du texte");
});

it("un nombre ou un booléen JSON devient sa chaîne", () => {
  assert.equal(formatToolResult("42"), "42");
  assert.equal(formatToolResult("true"), "true");
});

it("le littéral null JSON rend « null », pas « -- »", () => {
  // JSON.parse('null') → null : typeof object, mais obj === null.
  assert.equal(formatToolResult("null"), "null");
});

// ── Stratégie 3 : tableaux ───────────────────────────────────

it("un tableau vide rend « (aucun résultat) »", () => {
  assert.equal(f([]), "(aucun résultat)");
});

it("un tableau de chaînes devient une liste à puces", () => {
  assert.equal(f(["a", "b"]), "• a\n• b");
});

it("les objets d'un tableau sont résumés par leur premier libellé connu", () => {
  // Ordre des alias : text, content, name, path, value, output.
  assert.equal(f([{ text: "T", content: "C" }]), "• T");
  assert.equal(f([{ content: "C", name: "N" }]), "• C");
  assert.equal(f([{ name: "N", path: "P" }]), "• N");
  assert.equal(f([{ path: "P", value: "V" }]), "• P");
  assert.equal(f([{ value: "V", output: "O" }]), "• V");
  assert.equal(f([{ output: "O" }]), "• O");
});

it("un objet de tableau sans libellé connu est rendu en JSON", () => {
  assert.equal(f([{ zzz: 1 }]), '• {"zzz":1}');
});

it("les scalaires et null d'un tableau sont stringifiés", () => {
  assert.equal(f([1, true, null]), "• 1\n• true\n• null");
});

// ── Stratégie 4 : « error » PRIME, c'est le point critique ───

it("ERROR PRIME sur content — un échec ne doit jamais se déguiser en succès", () => {
  // Si la boucle sur les champs texte passait avant, l'utilisateur
  // lirait « sortie partielle » et l'erreur serait invisible.
  assert.equal(f({ error: "accès refusé", content: "sortie partielle" }), "Erreur : accès refusé");
});

it("error prime aussi sur text, output, stdout, message et ok", () => {
  for (const champ of ["text", "output", "result", "stdout", "data", "message"]) {
    const o: Record<string, string> = { error: "boum" };
    o[champ] = "du contenu";
    assert.equal(f(o), "Erreur : boum", "champ " + champ);
  }
  assert.equal(f({ error: "boum", ok: true }), "Erreur : boum");
});

it("une erreur non-chaîne est stringifiée, pas perdue", () => {
  assert.equal(f({ error: 404 }), "Erreur : 404");
  assert.equal(f({ error: false }), "Erreur : false");
});

it("error à null n'est PAS une erreur (c'est le marqueur « pas d'erreur »)", () => {
  // `obj.error !== undefined` : null passe la garde. Comportement en
  // place, verrouillé pour qu'il ne change pas par inadvertance.
  assert.equal(f({ error: null, content: "ok" }), "Erreur : null");
});

// ── Stratégie 5 : le premier champ texte, dans l'ordre ───────

it("les sept champs texte sont essayés dans l'ordre déclaré", () => {
  assert.equal(f({ content: "C", text: "T" }), "C\ntext: T");
  assert.equal(f({ text: "T", output: "O" }), "T\noutput: O");
  assert.equal(f({ output: "O", result: "R" }), "O\nresult: R");
  assert.equal(f({ result: "R", stdout: "S" }), "R\nstdout: S");
  assert.equal(f({ stdout: "S", data: "D" }), "S\ndata: D");
  assert.equal(f({ data: "D", message: "M" }), "D\nmessage: M");
  assert.equal(f({ message: "M" }), "M");
});

it("un champ texte seul est rendu nu, sans décoration", () => {
  assert.equal(f({ content: "bonjour" }), "bonjour");
});

it("« ok » est exclu des extras : c'est du transport, pas un résultat", () => {
  assert.equal(f({ content: "bonjour", ok: true }), "bonjour");
  assert.equal(f({ content: "bonjour", ok: false }), "bonjour");
});

it("les autres extras sont listés sous le texte", () => {
  assert.equal(f({ content: "texte", lignes: 3 }), "texte\nlignes: 3");
  assert.equal(f({ content: "texte", meta: { a: 1 } }), 'texte\nmeta: {"a":1}');
});

it("un champ texte NON-chaîne est ignoré par la boucle", () => {
  // typeof obj[f] === 'string' : un content numérique ne compte pas,
  // on retombe sur le dépliage générique.
  assert.equal(f({ content: 42 }), "content: 42");
});

it("un champ texte vide est rendu (vide n'est pas absent)", () => {
  assert.equal(f({ content: "" }), "");
});

it("les retours à la ligne d'un content sont préservés", () => {
  assert.equal(f({ content: "a\nb" }), "a\nb");
});

// ── Stratégie 6 : le résumé « ok » ───────────────────────────

it("ok seul rend un statut coché", () => {
  assert.equal(f({ ok: true }), "✓ OK");
  assert.equal(f({ ok: false }), "✗ Erreur");
});

it("ok + extras : statut puis extras séparés par « · »", () => {
  assert.equal(f({ ok: true, path: "a.txt" }), "✓ OK -- path: a.txt");
  assert.equal(f({ ok: true, a: 1, b: 2 }), "✓ OK -- a: 1 · b: 2");
});

it("le résumé ok s'arrête à quatre clés — au-delà on déplie tout", () => {
  // Sinon un vrai contenu se retrouverait écrasé derrière « ✓ OK ».
  assert.equal(f({ ok: true, a: 1, b: 2, c: 3 }), "✓ OK -- a: 1 · b: 2 · c: 3");
  const cinq = f({ ok: true, a: 1, b: 2, c: 3, d: 4 });
  assert.ok(!cinq.startsWith("✓ OK"), "reçu : " + cinq);
  assert.equal(cinq, "ok: true\na: 1\nb: 2\nc: 3\nd: 4");
});

it("ok à false avec extras garde la croix", () => {
  assert.equal(f({ ok: false, code: 2 }), "✗ Erreur -- code: 2");
});

// ── Stratégie 7 : dépliage générique ─────────────────────────

it("un objet quelconque est déplié clé par clé, une par ligne", () => {
  assert.equal(f({ a: 1, b: "deux" }), "a: 1\nb: deux");
});

it("les valeurs imbriquées du dépliage générique sont indentées", () => {
  assert.equal(f({ a: { b: 1 } }), 'a: {\n  "b": 1\n}');
});

it("un objet vide rend une chaîne vide", () => {
  assert.equal(f({}), "");
});

// ── fmtToolArgVal ────────────────────────────────────────────

it("null et undefined sont rendus littéralement (visible, pas escamoté)", () => {
  assert.equal(fmtToolArgVal(null), "null");
  assert.equal(fmtToolArgVal(undefined), "undefined");
});

it("un objet ou un tableau est indenté à 2 espaces", () => {
  assert.equal(fmtToolArgVal({ a: 1 }), '{\n  "a": 1\n}');
  assert.equal(fmtToolArgVal([1, 2]), "[\n  1,\n  2\n]");
});

it("une chaîne QUI EST du JSON est ré-indentée", () => {
  // Un modèle qui passe son argument déjà stringifié ne doit pas
  // s'afficher sur une seule ligne compacte.
  assert.equal(fmtToolArgVal('{"a":1}'), '{\n  "a": 1\n}');
  assert.equal(fmtToolArgVal("  [1,2]  "), "[\n  1,\n  2\n]");
});

it("une chaîne qui RESSEMBLE à du JSON sans en être passe telle quelle", () => {
  assert.equal(fmtToolArgVal("{pas du json}"), "{pas du json}");
  assert.equal(fmtToolArgVal("[a, b]"), "[a, b]");
});

it("une chaîne simple est rendue intacte, retours à la ligne COMPRIS", () => {
  // Le contenu d'un write_file doit s'afficher sur N lignes ; un
  // JSON.stringify les aurait transformés en « \n » littéraux.
  assert.equal(fmtToolArgVal("def f():\n    pass\n"), "def f():\n    pass\n");
  assert.equal(fmtToolArgVal("simple"), "simple");
  assert.equal(fmtToolArgVal(""), "");
});

it("les scalaires non-chaînes sont stringifiés", () => {
  assert.equal(fmtToolArgVal(42), "42");
  assert.equal(fmtToolArgVal(true), "true");
  assert.equal(fmtToolArgVal(0), "0");
});

it("une chaîne à accolade ouvrante seule ne casse pas le formatage", () => {
  assert.equal(fmtToolArgVal("{"), "{");
  assert.equal(fmtToolArgVal("}"), "}");
});
