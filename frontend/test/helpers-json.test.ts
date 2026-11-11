// SPDX-License-Identifier: MIT
/** frontend/test/helpers-json.test.ts — décodage progressif des arguments JSON d'un tool_call (valeurs incomplètes jamais devinées). */
import { strict as assert } from "node:assert";
import { it } from "vitest";

import {
  extractJsonScalar as _extractJsonScalar,
  makeToolStreamKey as _makeToolStreamKey,
  pullJsonStringField as _pullJsonStringField,
  reEsc as _reEsc,
} from "../src/utils/helpers-json";
import type { EtatChampChaine, TrancheChamp } from "../src/utils/helpers-json";

const sc = (buf: string, champ: string) => _extractJsonScalar(buf, champ);

/**
 * Rejoue un champ string livré en N morceaux, comme le font les
 * ``tool_call_delta``, et rend le journal des retours + la
 * concaténation des chunks.
 */
function rejouer(morceaux: string[], champ: string) {
  const etat: EtatChampChaine = {};
  let accumule = "";
  const retours: TrancheChamp[] = [];
  for (const m of morceaux) {
    accumule += m;
    retours.push(_pullJsonStringField(accumule, champ, etat));
  }
  return { retours, texte: retours.map((r) => r.chunk).join(""), etat };
}

// ── _makeToolStreamKey ───────────────────────────────────────

it("la clé de flux compose chat × itération × index", () => {
  assert.equal(_makeToolStreamKey("c1", 2, 3), "c1:2:3");
});

it("un chat absent devient « local » — un flux sans chat reste adressable", () => {
  assert.equal(_makeToolStreamKey(null, 1, 0), "local:1:0");
  assert.equal(_makeToolStreamKey(undefined, 1, 0), "local:1:0");
  assert.equal(_makeToolStreamKey("", 1, 0), "local:1:0");
});

it("itération et index absents retombent sur 0", () => {
  assert.equal(_makeToolStreamKey("c1"), "c1:0:0");
  assert.equal(_makeToolStreamKey("c1", null, null), "c1:0:0");
});

it("deux outils du même tour ont des clés distinctes", () => {
  assert.notEqual(_makeToolStreamKey("c1", 1, 0), _makeToolStreamKey("c1", 1, 1));
});

// ── _reEsc ───────────────────────────────────────────────────

it("_reEsc neutralise les métacaractères de regex", () => {
  assert.equal(_reEsc("a.b"), "a\\.b");
  assert.equal(_reEsc("a*b+c?"), "a\\*b\\+c\\?");
  assert.equal(_reEsc("[x](y){z}"), "\\[x\\]\\(y\\)\\{z\\}");
  assert.equal(_reEsc("a|b^c$"), "a\\|b\\^c\\$");
  assert.equal(_reEsc("a\\b"), "a\\\\b");
});

it("un nom de champ sans métacaractère est rendu intact", () => {
  assert.equal(_reEsc("content"), "content");
});

it("un champ dont le nom contient un point est bien trouvé (pas pris pour « n'importe quel caractère »)", () => {
  assert.deepStrictEqual(sc('{"a.b":"z"}', "a.b"), { type: "string", value: "z", endIdx: 10 });
  // Le point ne doit PAS matcher « axb » : sinon un champ voisin serait lu à sa place.
  assert.equal(sc('{"axb":"z"}', "a.b"), undefined);
});

// ── _extractJsonScalar : attendre plutôt que deviner ─────────

it("champ absent du buffer : undefined", () => {
  assert.equal(sc('{"autre":1}', "a"), undefined);
});

it("champ présent mais rien après les deux-points : undefined", () => {
  assert.equal(sc('{"a":', "a"), undefined);
});

it("string complète : valeur décodée + index de fin", () => {
  assert.deepStrictEqual(sc('{"a":"xy"}', "a"), { type: "string", value: "xy", endIdx: 9 });
});

it("string vide : rendue, pas confondue avec « absente »", () => {
  assert.deepStrictEqual(sc('{"a":""}', "a"), { type: "string", value: "", endIdx: 7 });
});

it("GUILLEMET FERMANT PAS ENCORE ARRIVÉ : undefined, jamais une valeur tronquée", () => {
  assert.equal(sc('{"a":"xy', "a"), undefined);
});

it("ANTISLASH EN DERNIER CARACTÈRE : undefined — l'échappement est indécidable", () => {
  assert.equal(sc('{"a":"xy\\', "a"), undefined);
});

it("\\uXXXX TRONQUÉ : undefined, on n'invente pas les hex manquants", () => {
  assert.equal(sc('{"a":"\\u00', "a"), undefined);
  assert.equal(sc('{"a":"\\u', "a"), undefined);
  assert.equal(sc('{"a":"\\u0', "a"), undefined);
});

it("\\uXXXX complet mais chaîne non close : undefined (il manque le guillemet)", () => {
  assert.equal(sc('{"a":"\\u00e9', "a"), undefined);
});

it("\\uXXXX complet et chaîne close : caractère décodé", () => {
  assert.deepStrictEqual(sc('{"a":"\\u00e9"}', "a"), { type: "string", value: "é", endIdx: 13 });
});

it("\\uXXXX aux hex invalides : la séquence est ABANDONNÉE, pas rendue littérale", () => {
  // isNaN(parseInt('ZZZZ', 16)) → la séquence est sautée en silence.
  // Comportement en place ; le verrouiller évite qu'il change sans décision.
  assert.deepStrictEqual(sc('{"a":"\\uZZZZ"}', "a"), { type: "string", value: "", endIdx: 13 });
});

it("les huit échappements de la table sont décodés", () => {
  assert.equal(sc('{"a":"x\\ny"}', "a")?.value, "x\ny");
  assert.equal(sc('{"a":"x\\ty"}', "a")?.value, "x\ty");
  assert.equal(sc('{"a":"x\\ry"}', "a")?.value, "x\ry");
  assert.equal(sc('{"a":"x\\by"}', "a")?.value, "x\by");
  assert.equal(sc('{"a":"x\\fy"}', "a")?.value, "x\fy");
  assert.equal(sc('{"a":"di\\"t"}', "a")?.value, 'di"t');
  assert.equal(sc('{"a":"c:\\\\tmp"}', "a")?.value, "c:\\tmp");
  assert.equal(sc('{"a":"a\\/b"}', "a")?.value, "a/b");
});

it("un échappement hors table rend le caractère nu (l'antislash est mangé)", () => {
  assert.equal(sc('{"a":"\\x"}', "a")?.value, "x");
});

it("une quote échappée ne termine pas la chaîne", () => {
  const r = sc('{"a":"av\\"ant","b":2}', "a");
  assert.equal(r?.value, 'av"ant');
});

it("nombre suivi d'un séparateur : rendu", () => {
  assert.deepStrictEqual(sc('{"a":12,"b":1}', "a"), { type: "number", value: 12, endIdx: 7 });
  assert.equal(sc('{"a":12}', "a")?.value, 12);
  assert.equal(sc('{"a":12 }', "a")?.value, 12);
  assert.equal(sc('[{"a":12}]', "a")?.value, 12);
});

it("NOMBRE EN FIN DE BUFFER : undefined — « 12 » peut encore devenir « 123 »", () => {
  assert.equal(sc('{"a":12', "a"), undefined);
  assert.equal(sc('{"a":1', "a"), undefined);
});

it("nombres négatifs, décimaux et exponentiels", () => {
  assert.equal(sc('{"a":-5}', "a")?.value, -5);
  assert.equal(sc('{"a":1.5}', "a")?.value, 1.5);
  assert.equal(sc('{"a":-1.5e2 }', "a")?.value, -150);
});

it("zéro est une valeur, pas une absence", () => {
  assert.deepStrictEqual(sc('{"a":0}', "a"), { type: "number", value: 0, endIdx: 6 });
});

it("true / false / null sont typés distinctement", () => {
  assert.deepStrictEqual(sc('{"a":true}', "a"), { type: "bool", value: true, endIdx: 9 });
  assert.deepStrictEqual(sc('{"a":false}', "a"), { type: "bool", value: false, endIdx: 10 });
  assert.deepStrictEqual(sc('{"a":null}', "a"), { type: "null", value: null, endIdx: 9 });
});

it("false n'est pas confondu avec « absent »", () => {
  const r = sc('{"a":false}', "a");
  assert.notEqual(r, undefined);
  assert.equal(r?.value, false);
});

it("un littéral tronqué (« tru ») n'est pas pris pour true", () => {
  assert.equal(sc('{"a":tru', "a"), undefined);
});

it("les espaces autour des deux-points sont tolérés", () => {
  assert.equal(sc('{"a"  :   "z"}', "a")?.value, "z");
  assert.equal(sc('{"a":\n\t"z"}', "a")?.value, "z");
});

it("endIdx pointe juste après la valeur", () => {
  const buf = '{"a":"xy"}';
  const r = sc(buf, "a");
  assert.equal(buf.slice(r?.endIdx), "}");
});

// ── _pullJsonStringField : le flux vers Monaco ───────────────

it("champ pas encore apparu : found=false, rien de consommé", () => {
  const { retours } = rejouer(['{"pa'], "content");
  assert.deepStrictEqual(retours, [{ chunk: "", complete: false, found: false }]);
});

it("livraison en trois morceaux : chaque chunk ne contient QUE le nouveau", () => {
  const { retours } = rejouer(['{"c":"ab', "cd", 'ef"}'], "c");
  assert.deepStrictEqual(
    retours.map((r) => r.chunk),
    ["ab", "cd", "ef"],
  );
  assert.deepStrictEqual(
    retours.map((r) => r.complete),
    [false, false, true],
  );
});

it("INVARIANT : la concaténation des chunks = la chaîne décodée", () => {
  const attendu = "ligne1\nligne2\tfin";
  const litteral = '{"c":"ligne1\\nligne2\\tfin"}';
  // Toutes les découpes possibles de ce littéral, une par position.
  for (let i = 1; i < litteral.length; i++) {
    const { texte } = rejouer([litteral.slice(0, i), litteral.slice(i)], "c");
    assert.equal(texte, attendu, "découpe à la position " + i);
  }
});

it("INVARIANT : la découpe caractère par caractère donne le même texte", () => {
  const litteral = '{"c":"a\\nb\\u00e9c\\"d"}';
  const morceaux = litteral.split("");
  const { texte } = rejouer(morceaux, "c");
  assert.equal(texte, 'a\nbéc"d');
});

it("\\uXXXX COUPÉ EN DEUX DELTAS : rien n'est émis tant qu'il est incomplet", () => {
  const { retours } = rejouer(['{"c":"\\u00', 'e9"}'], "c");
  assert.equal(retours[0]?.chunk, "", "le premier delta ne doit RIEN émettre");
  assert.equal(retours[1]?.chunk, "é");
});

it("\\uXXXX complet pile en fin de buffer : émis tout de suite", () => {
  // i + 6 === buf.length : la séquence est entière, on ne l'attend pas.
  const { retours } = rejouer(['{"c":"\\u00e9', '"}'], "c");
  assert.equal(retours[0]?.chunk, "é");
  assert.equal(retours[0]?.complete, false);
  assert.equal(retours[1]?.complete, true);
});

it("ANTISLASH en fin de delta : gardé pour le delta suivant", () => {
  const { retours } = rejouer(['{"c":"a\\', 'n"}'], "c");
  assert.equal(retours[0]?.chunk, "a", "l'antislash seul ne doit pas être émis");
  assert.equal(retours[1]?.chunk, "\n");
});

it("le cursor ne recule jamais : un delta sans nouveauté rend un chunk vide", () => {
  const etat = {};
  const buf = '{"c":"ab';
  assert.equal(_pullJsonStringField(buf, "c", etat).chunk, "ab");
  assert.equal(_pullJsonStringField(buf, "c", etat).chunk, "");
});

it("une fois complete, les appels suivants sont des no-op", () => {
  const { retours } = rejouer(['{"c":"a"}', " du bruit après"], "c");
  assert.deepStrictEqual(retours[1], { chunk: "", complete: true, found: true });
});

it("un guillemet échappé ne clôt pas le flux", () => {
  const { retours, texte } = rejouer(['{"c":"di\\"t"}'], "c");
  assert.equal(texte, 'di"t');
  assert.equal(retours[0]?.complete, true);
});

it("l'état porte valueStart, cursor et complete", () => {
  const { etat } = rejouer(['{"c":"ab"}'], "c");
  assert.equal(etat.valueStart, 6);
  assert.equal(etat.complete, true);
  assert.equal(etat.cursor, 9);
});

it("un champ homonyme plus loin n'est pas repris une fois le premier verrouillé", () => {
  const { texte } = rejouer(['{"c":"premier","c":"second"}'], "c");
  assert.equal(texte, "premier");
});

it("chaîne vide : complete immédiat, chunk vide, found vrai", () => {
  const { retours } = rejouer(['{"c":""}'], "c");
  assert.deepStrictEqual(retours[0], { chunk: "", complete: true, found: true });
});

it("un contenu multi-lignes réaliste de write_file traverse intact", () => {
  const contenu = 'def f():\n    return "ok"\n';
  const litteral = '{"path":"a.py","content":' + JSON.stringify(contenu) + "}";
  // Découpé tous les 3 caractères, comme un vrai flux.
  const morceaux = litteral.match(/[\s\S]{1,3}/g);
  const { texte } = rejouer(morceaux as string[], "content");
  assert.equal(texte, contenu);
});

it("les deux décodeurs s'accordent sur la même chaîne (les tables dupliquées ne divergent pas)", () => {
  // _helpers_json.js:79 et :140 sont deux copies de la même table.
  const cas = ["x\\ny", "x\\ty", "x\\ry", "x\\by", "x\\fy", 'di\\"t', "c:\\\\tmp", "a\\/b", "\\u00e9", "\\x"];
  for (const litteral of cas) {
    const buf = '{"c":"' + litteral + '"}';
    const parScalaire = sc(buf, "c")?.value;
    const parFlux = rejouer([buf], "c").texte;
    assert.equal(parFlux, parScalaire, "divergence sur « " + litteral + " »");
  }
});
