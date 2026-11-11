// SPDX-License-Identifier: MIT
/** apps/core/test/validation.test.ts — parité avec Pydantic 2.13 et FastAPI 0.136 (vecteurs de migration-kit/vecteurs/http_pydantic.py). */
import { readFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";

import {
  canonicalJson,
  clesOrdonnees,
  decoderJsonPy,
  ErreurJsonPy,
  ErreurLecturePy,
  pyJsonDumps,
  pyJsonLoadsOctets,
  texteJsonPy,
} from "@elpis/commun";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { DefinitionRoute } from "../src/routes";
import { appTest } from "./aides";
import { analyserRequete, corpsJson, entrees, py, valider, validerPy } from "@elpis/http";
import type { Champs, SchemaPy } from "@elpis/http";

interface Spec {
  t: string;
  c?: Record<string, number | boolean>;
  v?: (string | number | boolean | null)[] | Spec;
  i?: Spec;
  k?: Spec;
  nom?: string;
  extra?: "ignore" | "forbid" | "allow";
  champs?: { nom: string; s: Spec; defaut?: unknown; alias?: string }[];
}

interface CasType {
  entree: unknown;
  sortie?: unknown;
  erreurs?: unknown;
}

interface CasJson {
  nom?: string;
  octets: string;
  valeur?: unknown;
  erreur?: { msg: string; pos: number; lineno: number; colno: number; texte: string };
  exception?: string;
}

interface ParametreRoute {
  nom: string;
  s: Spec;
  defaut?: unknown;
}

interface RouteVecteur {
  methode: "GET" | "POST";
  chemin: string;
  path?: ParametreRoute[];
  query?: ParametreRoute[];
  body?: Spec;
  body_defaut?: unknown;
}

interface RequeteVecteur {
  id: string;
  methode: "GET" | "POST";
  url: string;
  entetes: Record<string, string>;
  corps: string | null;
  statut: number;
  json?: unknown;
  json_texte?: string;
  texte?: string;
}

interface Vecteurs {
  types: { nom: string; spec: Spec; cas: CasType[] }[];
  json: CasJson[];
  http: { routes: RouteVecteur[]; requetes: RequeteVecteur[] };
}

// Relu par `pyJsonLoadsOctets` : les objets à clés entières gardent l'ordre d'insertion Python.
const vecteurs = pyJsonLoadsOctets(
  readFileSync(new URL("./vecteurs/http_pydantic.json", import.meta.url)),
) as Vecteurs;

/** Marqueurs du générateur (`$flottant`, `$octets`) vers valeurs JS, en place pour garder l'ordre des clés. */
function restaurer(v: unknown): unknown {
  if (Array.isArray(v)) {
    v.forEach((x, i) => (v[i] = restaurer(x)));
    return v;
  }
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.$flottant === "string") return { nan: NaN, inf: Infinity, "-inf": -Infinity }[o.$flottant];
    if (typeof o.$octets === "string") return Buffer.from(o.$octets, "hex");
    for (const k of Object.keys(o)) o[k] = restaurer(o[k]);
  }
  return v;
}

/** Valeurs JS vers l'encodage des vecteurs (objets ordinaires), pour comparer à l'identique. */
function encoder(v: unknown): unknown {
  if (typeof v === "number" && !Number.isFinite(v))
    return { $flottant: Number.isNaN(v) ? "nan" : v > 0 ? "inf" : "-inf" };
  if (v instanceof Uint8Array) return { $octets: Buffer.from(v).toString("hex") };
  if (Array.isArray(v)) return v.map(encoder);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encoder(x)]));
  }
  return v;
}

/** Valeur d'une clé quelconque, sans les membres d'`Object` que TypeScript prête à tout objet (`constructor`, `valueOf`). */
const champ = (o: unknown, cle: string): unknown => (o as Record<string, unknown>)[cle];

const apercu = (v: unknown): string => {
  const texte = JSON.stringify(encoder(v)) ?? String(v);
  return texte.length > 300 ? `${texte.slice(0, 300)}…` : texte;
};

function construire(spec: Spec): SchemaPy<unknown> {
  switch (spec.t) {
    case "int":
      return py.int(spec.c);
    case "float":
      return py.float(spec.c);
    case "bool":
      return py.bool();
    case "str":
      return py.str(spec.c);
    case "any":
      return py.any();
    case "literal":
      return py.literal(...(spec.v as (string | number | boolean | null)[]));
    case "optional":
      return py.optional(construire(spec.i as Spec));
    case "list":
      return py.list(construire(spec.i as Spec), spec.c);
    case "dict":
      return py.dict(construire(spec.k as Spec), construire(spec.v as Spec), spec.c);
    case "model": {
      const champs: Record<string, SchemaPy<unknown>> = {};
      for (const ch of spec.champs ?? []) {
        let schema = construire(ch.s);
        if ("defaut" in ch) schema = schema.defaut(restaurer(structuredClone(ch.defaut)));
        if (ch.alias !== undefined) schema = schema.alias(ch.alias);
        champs[ch.nom] = schema;
      }
      return py.model(champs, { extra: spec.extra ?? "ignore" });
    }
  }
  throw new Error(`type inconnu : ${spec.t}`);
}

const UNS = "1".repeat(4300);
const TYPES_INT = [
  "int",
  "int_ge0_le10",
  "int_gt0_lt10",
  "int_multiple3",
  "int_ge10_le5",
  "int_gem5_multiple2",
  "opt_int",
];

interface EcartType {
  type: string;
  entree: unknown;
  python: "accepté" | "finite_number";
  raison: string;
}

const entier53 = (type: string, entree: unknown): EcartType => ({
  type,
  entree,
  python: "accepté",
  raison: "entier exact au-delà de 2^53, inexistant en JS",
});

const infini = (type: string, entree: number): EcartType => ({
  type,
  entree,
  python: "finite_number",
  raison: "±inf : 422 finite_number chez Pydantic, dont le rendu lève (500 sous FastAPI)",
});

/** Écarts admis des types, un par un : TS les signale hors bornes (400 « Paramètre hors bornes. » via `entrees()`/`valider()`). */
const ECARTS_TYPES: readonly EcartType[] = [
  ...[
    1e16,
    "9999999999999999999",
    "-9223372036854775808",
    "111111111111111111.00",
    "1_111111111111111111",
  ].map((x) => entier53("int", x)),
  ...[UNS, ` ${UNS}`, `+${UNS}`, `0${UNS}`, `${UNS}.00`].map((x) => entier53("int", x)),
  entier53("int_gem5_multiple2", 1e16),
  entier53("opt_int", 1e16),
  ...TYPES_INT.flatMap((type) => [infini(type, Infinity), infini(type, -Infinity)]),
];

describe("types : TypeAdapter(T).validate_python(x, from_attributes=True)", () => {
  const vus = new Set<number>();
  for (const type of vecteurs.types) {
    it(`${type.nom} (${type.cas.length} cas)`, () => {
      const schema = construire(type.spec);
      const ecarts: unknown[] = [];
      for (const cas of type.cas) {
        const entree = restaurer(cas.entree);
        const resultat = validerPy(schema, entree);
        const admis = ECARTS_TYPES.findIndex((e) => e.type === type.nom && Object.is(e.entree, entree));
        const ecart = ECARTS_TYPES[admis];
        if (ecart) {
          vus.add(admis);
          const python = "sortie" in cas ? "accepté" : (cas.erreurs as { type: string }[])[0]?.type;
          expect([resultat.ok, resultat.horsBornes, python], apercu(entree)).toEqual([
            true,
            true,
            ecart.python,
          ]);
          continue;
        }
        const obtenu = resultat.ok
          ? { sortie: encoder(resultat.valeur), horsBornes: resultat.horsBornes }
          : { erreurs: encoder(resultat.erreurs), horsBornes: resultat.horsBornes };
        const attendu = encoder("sortie" in cas ? { sortie: cas.sortie } : { erreurs: cas.erreurs });
        try {
          expect(obtenu).toEqual({ ...(attendu as object), horsBornes: false });
        } catch {
          ecarts.push({ entree: apercu(cas.entree), attendu: apercu(attendu), obtenu: apercu(obtenu) });
        }
      }
      expect(ecarts).toEqual([]);
    });
  }

  it("chaque écart admis des types existe encore", () => {
    expect([...vus].sort((a, b) => a - b)).toEqual(ECARTS_TYPES.map((_, i) => i));
  });
});

/** Écarts admis du décodeur : Python garde deux demi-paires séparées (CESU-8, UTF-32), une chaîne JS les recolle en un point de code. */
const ECARTS_JSON: Readonly<Record<string, string>> = {
  "cesu8-position":
    "paire encodée en deux demi-paires UTF-8 : un point de code de moins avant l'erreur en JS",
  "utf32-demi-paires-position":
    "demi-paires UTF-32 séparées : un point de code de moins avant l'erreur en JS",
};

const LECTEURS: Readonly<Record<string, (octets: Buffer) => unknown>> = {
  "pyJsonLoadsOctets (JSON.parse vérifié)": pyJsonLoadsOctets,
  "scanner exact seul": (octets) => decoderJsonPy(texteJsonPy(octets)),
};

describe("json.loads(octets) de Python", () => {
  it.each(Object.entries(LECTEURS))(`${vecteurs.json.length} cas, %s`, (_nom, lire) => {
    const ecarts: unknown[] = [];
    for (const cas of vecteurs.json) {
      let obtenu: unknown;
      try {
        obtenu = { valeur: encoder(lire(Buffer.from(cas.octets, "hex"))) };
      } catch (e) {
        if (e instanceof ErreurJsonPy) {
          obtenu = {
            erreur: { msg: e.msgPy, pos: e.pos, lineno: e.lineno, colno: e.colno, texte: e.message },
          };
        } else obtenu = { exception: e instanceof ErreurLecturePy ? e.nature : String(e) };
      }
      const attendu = encoder(
        cas.exception !== undefined
          ? { exception: cas.exception }
          : cas.erreur
            ? { erreur: cas.erreur }
            : { valeur: cas.valeur },
      );
      if (cas.nom !== undefined && ECARTS_JSON[cas.nom] !== undefined) {
        const pos = (obtenu as { erreur?: { pos: number } }).erreur?.pos;
        expect(pos, cas.nom).toBe((cas.erreur?.pos ?? 0) - 1);
        continue;
      }
      try {
        expect(obtenu).toEqual(attendu);
      } catch {
        ecarts.push({ octets: cas.octets.slice(0, 80), attendu: apercu(attendu), obtenu: apercu(obtenu) });
      }
    }
    expect(ecarts).toEqual([]);
  });

  it("objets sans prototype : __proto__, constructor et valueOf restent des clés, sur les deux chemins", () => {
    const texte = '{"__proto__": {"x": 1}, "constructor": 2, "valueOf": [{"toString": 3}]}';
    for (const lire of Object.values(LECTEURS)) {
      const v = lire(Buffer.from(texte)) as object;
      expect(Object.getPrototypeOf(v)).toBeNull();
      expect(Object.keys(v)).toEqual(["__proto__", "constructor", "valueOf"]);
      expect([champ(v, "constructor"), champ(champ(v, "__proto__"), "x")]).toEqual([2, 1]);
      expect(Object.getPrototypeOf((champ(v, "valueOf") as object[])[0])).toBeNull();
    }
    expect(Object.prototype).not.toHaveProperty("x");
  });
});

const HORS_BORNES = { statut: 400, json: { detail: "Paramètre hors bornes." } };

/** Écarts admis du HTTP, un par un : entier au-delà de 2^53 (Python l'accepte jusqu'au liage SQLite, à 2^63) ou infini. */
const ECARTS_ADMIS: Readonly<Record<string, { raison: string; statut: number; json: unknown }>> = {
  "requete-2p53p1": { raison: "entier de requête entre 2^53 et 2^63, accepté en Python", ...HORS_BORNES },
  "chemin-2p53p1": { raison: "entier de chemin entre 2^53 et 2^63, accepté en Python", ...HORS_BORNES },
  "corps-entier-2p53p1": { raison: "entier de corps entre 2^53 et 2^63, accepté en Python", ...HORS_BORNES },
  "corps-entier-400-chiffres": {
    raison: "entier de corps de 400 chiffres, accepté en Python",
    ...HORS_BORNES,
  },
  "corps-entier-1e400": {
    raison: "1e400 lu Infinity : 400 en TS, 500 au rendu de finite_number en Python",
    ...HORS_BORNES,
  },
  "modele-age-1e400": {
    raison: "1e400 lu Infinity : 400 en TS, 500 au rendu de finite_number en Python",
    ...HORS_BORNES,
  },
};

function champs(parametres: ParametreRoute[] | undefined): Champs {
  const sortie: Record<string, SchemaPy<unknown>> = {};
  for (const p of parametres ?? []) {
    const schema = construire(p.s);
    sortie[p.nom] = "defaut" in p ? schema.defaut(restaurer(structuredClone(p.defaut))) : schema;
  }
  return sortie;
}

function routeVecteur(r: RouteVecteur): DefinitionRoute {
  const corps = r.body === undefined ? undefined : construire(r.body);
  const body = corps && "body_defaut" in r ? corps.defaut(r.body_defaut) : corps;
  const spec = { path: champs(r.path), query: champs(r.query), ...(body ? { body } : {}) };
  return {
    methode: r.methode,
    chemin: r.chemin.replace(/\{(\w+)\}/g, ":$1"),
    processus: ["main"],
    acces: "public",
    traiter: (requete) => {
      const e = entrees(requete, spec);
      return { path: e.path, query: e.query, body: e.body ?? null };
    },
  };
}

const publique = (
  methode: DefinitionRoute["methode"],
  chemin: string,
  traiter: DefinitionRoute["traiter"],
): DefinitionRoute => ({ methode, chemin, processus: ["main"], acces: "public", traiter });

describe("HTTP : app FastAPI de référence ↔ app Fastify bâtie sur la boîte à outils", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await appTest({
      familles: [
        {
          nom: "parite",
          routes: [
            publique("POST", "/json", (requete) => {
              corpsJson(requete);
              return { ok: true };
            }),
            publique("POST", "/entete", (requete) => ({ type: requete.headers["content-type"] ?? null })),
            ...vecteurs.http.routes.map(routeVecteur),
          ],
        },
      ],
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it(`${vecteurs.http.requetes.length} requêtes : statut et corps identiques, sauf écarts admis listés`, async () => {
    const ecarts: unknown[] = [];
    for (const r of vecteurs.http.requetes) {
      const reponse = await app.inject({
        method: r.methode,
        url: r.url,
        headers: r.entetes,
        ...(r.corps === null ? {} : { payload: Buffer.from(r.corps, "hex") }),
      });
      const obtenu = {
        statut: reponse.statusCode,
        ...(reponse.headers["content-type"]?.startsWith("application/json")
          ? { json: encoder(reponse.json()) }
          : { texte: reponse.body }),
      };
      const json = r.json_texte !== undefined ? (JSON.parse(r.json_texte) as unknown) : r.json;
      const admis = ECARTS_ADMIS[r.id];
      const python = {
        statut: r.statut,
        ...(json !== undefined ? { json: encoder(json) } : { texte: r.texte }),
      };
      const attendu = admis ? { statut: admis.statut, json: admis.json } : python;
      if (admis) expect(python, `${r.id} : l'écart admis existe encore`).not.toEqual(attendu);
      try {
        expect(obtenu).toEqual(attendu);
      } catch {
        ecarts.push({ id: r.id, attendu: apercu(attendu), obtenu: apercu(obtenu) });
      }
    }
    expect(ecarts).toEqual([]);
  });
});

/** `pyJsonLoadsOctets` de 2,4 Mo en 30 000 petits objets : 40 ms mesurées (prépasse de profondeur comprise), seuil à dix fois. */
const SEUIL_2MO = 400;

/** Vraie requête HTTP : `app.inject` normalise l'URL et retire le fragment `#`. */
function requeteBrute(
  port: number,
  methode: string,
  chemin: string,
  corps?: string,
): Promise<{ statut: number; json: unknown }> {
  return new Promise((resoudre, rejeter) => {
    const entetes = corps === undefined ? {} : { "content-type": "application/json" };
    const req = request(
      { host: "127.0.0.1", port, method: methode, path: chemin, headers: entetes },
      (rep) => {
        const morceaux: Buffer[] = [];
        rep.on("data", (m: Buffer) => morceaux.push(m));
        rep.on("end", () => {
          resoudre({
            statut: rep.statusCode ?? 0,
            json: JSON.parse(Buffer.concat(morceaux).toString("utf8")),
          });
        });
      },
    );
    req.on("error", rejeter);
    req.end(corps);
  });
}

describe("boîte à outils", () => {
  it("littéral : booléens et nombres mêlés refusés (1 et 1.0 indiscernables en JS)", () => {
    expect(() => py.literal(true, 1)).toThrow(/indiscernables/);
    expect(() => py.literal(1.5)).toThrow(/non entier/);
  });

  it("entier au-delà de 2^53 : valide pour Pydantic, 400 « Paramètre hors bornes. » pour valider()", () => {
    expect(validerPy(py.int(), "9007199254740993")).toEqual({
      ok: true,
      valeur: 9007199254740992,
      horsBornes: true,
    });
    expect(validerPy(py.int(), Infinity)).toEqual({ ok: true, valeur: Infinity, horsBornes: true });
    expect(() => valider(py.int(), 1e20)).toThrow("Paramètre hors bornes.");
    expect(() => valider(py.list(py.int()), [1, "1".repeat(400)])).toThrow("Paramètre hors bornes.");
    expect(validerPy(py.int({ le: 150 }), 1e20)).toMatchObject({ ok: false, horsBornes: false });
    // Texte de plus de 309 chiffres (Infinity en JS) : Python borne la valeur exacte, son signe suffit.
    const plus400 = "1".repeat(400);
    expect(validerPy(py.int({ le: 150 }), plus400)).toMatchObject({
      ok: false,
      erreurs: [{ type: "less_than_equal", input: plus400, ctx: { le: 150 } }],
    });
    expect(validerPy(py.int({ ge: 0 }), `-${plus400}`)).toMatchObject({
      ok: false,
      erreurs: [{ type: "greater_than_equal" }],
    });
  });

  it("rognage linéaire : 64 000 blancs entre deux lettres, en int comme en float", () => {
    const texte = `x${" ".repeat(64_000)}x`;
    const debut = performance.now();
    expect(validerPy(py.int(), texte)).toMatchObject({ ok: false, erreurs: [{ type: "int_parsing" }] });
    expect(validerPy(py.float(), texte)).toMatchObject({ ok: false, erreurs: [{ type: "float_parsing" }] });
    expect(validerPy(py.int(), ` ${" ".repeat(64_000)}12${"\u3000".repeat(64_000)}`)).toMatchObject({
      valeur: 12,
    });
    expect(performance.now() - debut).toBeLessThan(100);
  });

  it("défaut : refusé dès la déclaration s'il n'est pas clonable, copié à chaque usage ; fabrique appelée à chaque usage", () => {
    expect(() => py.int().defaut(() => 1)).toThrow(/could not be cloned/);
    const schema = py.model({ l: py.list(py.int()).defaut([1]), n: py.int().defaut(null) });
    const a = validerPy(schema, {});
    const b = validerPy(schema, {});
    expect(a).toMatchObject({ ok: true, valeur: { l: [1], n: null } });
    if (a.ok && b.ok) expect(a.valeur.l).not.toBe(b.valeur.l);
    let appels = 0;
    const fabrique = py.model({ id: py.int().fabrique(() => ++appels) });
    expect([
      validerPy(fabrique, {}),
      validerPy(fabrique, { id: "7" }),
      validerPy(fabrique, {}),
    ]).toMatchObject([
      { ok: true, valeur: { id: 1 } },
      { ok: true, valeur: { id: 7 } },
      { ok: true, valeur: { id: 2 } },
    ]);
  });

  it("optional : .alias() et .defaut() posés avant ou après donnent le même schéma", () => {
    const paires: [SchemaPy<unknown>, SchemaPy<unknown>][] = [
      [py.optional(py.str().alias("chatId")), py.optional(py.str()).alias("chatId")],
      [py.optional(py.int().defaut(5)), py.optional(py.int()).defaut(5)],
      [py.optional(py.str().alias("chatId").defaut("z")), py.optional(py.str()).alias("chatId").defaut("z")],
    ];
    const entrees = [{ chatId: "x" }, { chatId: null }, {}, { champ: 7 }, { champ: "y" }, { chatId: 3 }];
    for (const [avant, apres] of paires) {
      for (const entree of entrees) {
        const attendu = validerPy(py.model({ champ: apres }), entree);
        expect(validerPy(py.model({ champ: avant }), entree), JSON.stringify(entree)).toEqual(attendu);
      }
    }
    expect(validerPy(py.model({ champ: py.optional(py.int().defaut(5)) }), {})).toMatchObject({
      valeur: { champ: 5 },
    });
    expect(
      validerPy(py.model({ champ: py.optional(py.str().alias("chatId")) }), { chatId: "x" }),
    ).toMatchObject({
      valeur: { champ: "x" },
    });
  });

  it("sorties sans prototype et ordre Python des clés entières : py.dict et extras allow", () => {
    const corps = pyJsonLoadsOctets(
      Buffer.from('{"b": 1, "10": 2, "2": 3, "__proto__": 4, "constructor": 5, "valueOf": 6}'),
    ) as object;
    const dict = validerPy(py.dict(py.str(), py.int()), corps);
    const modele = validerPy(py.model({ b: py.int() }, { extra: "allow" }), corps);
    for (const r of [dict, modele]) {
      if (!r.ok) throw new Error("validation refusée");
      expect(Object.getPrototypeOf(r.valeur)).toBeNull();
      expect(Object.keys(r.valeur)).toEqual(["2", "10", "b", "__proto__", "constructor", "valueOf"]);
      expect(clesOrdonnees(r.valeur)).toEqual(["b", "10", "2", "__proto__", "constructor", "valueOf"]);
      expect(["__proto__", "constructor", "valueOf"].map((k) => champ(r.valeur, k))).toEqual([4, 5, 6]);
    }
    expect(Object.prototype).not.toHaveProperty("b");
  });

  it("objets sans prototype acceptés par pyJsonDumps, canonicalJson et une colonne JSON de @elpis/db", async () => {
    const v = pyJsonLoadsOctets(
      Buffer.from('{"constructor": {"__proto__": [1]}, "valueOf": "é", "toString": null}'),
    );
    expect(Object.getPrototypeOf(v)).toBeNull();
    const texte = pyJsonDumps(v);
    expect(texte).toBe('{"constructor": {"__proto__": [1]}, "valueOf": "\\u00e9", "toString": null}');
    expect(canonicalJson(v)).toBe('{"constructor":{"__proto__":[1]},"toString":null,"valueOf":"é"}');
    const { base, fermer } = ouvrirBaseDeTest("sqlite");
    try {
      await base.exec("CREATE TABLE t (j TEXT NOT NULL)");
      await base.run("INSERT INTO t (j) VALUES (?)", [texte]);
      const ligne = await base.get<{ x: number; j: string }>(
        "SELECT json_extract(j, '$.constructor.__proto__[0]') AS x, j FROM t",
      );
      expect(ligne?.x).toBe(1);
      expect(pyJsonLoadsOctets(Buffer.from(ligne?.j ?? ""))).toEqual(v);
    } finally {
      await fermer();
    }
  });

  it("parse_qsl de Starlette : +, %XX, valeurs vides, clé sans =", () => {
    expect(analyserRequete("a=1+2&b=%C3%A9&c&&d=&e=%zz&%ff=x")).toEqual([
      ["a", "1 2"],
      ["b", "é"],
      ["c", ""],
      ["d", ""],
      ["e", "%zz"],
      ["\ufffd", "x"],
    ]);
  });

  it("entrees() : un seul 422 dans l'ordre de FastAPI (chemin, requête, corps), flottant, fragment # ignoré", async () => {
    const app = await appTest({
      familles: [
        {
          nom: "entrees",
          routes: [
            publique("POST", "/a/:id", (req) =>
              entrees(req, {
                path: { id: py.int() },
                query: {
                  n: py.int(),
                  m: py.bool().defaut(false),
                  depuis: py.optional(py.float()).defaut(null),
                },
                body: py.model({ nom: py.str({ min_length: 2 }) }),
              }),
            ),
          ],
        },
      ],
    });
    try {
      const r = await app.inject({ method: "POST", url: "/a/x?n=y&m=2&depuis=z", payload: { nom: 1 } });
      expect(r.statusCode).toBe(422);
      const detail = (r.json() as { detail: { loc: unknown[]; type: string }[] }).detail;
      expect(detail.map((e) => [e.loc, e.type])).toEqual([
        [["path", "id"], "int_parsing"],
        [["query", "n"], "int_parsing"],
        [["query", "m"], "bool_parsing"],
        [["query", "depuis"], "float_parsing"],
        [["body", "nom"], "string_type"],
      ]);
      const ok = await app.inject({
        method: "POST",
        url: "/a/+7?n=3&depuis=-1e3&n=4",
        payload: { nom: "Lou" },
      });
      expect(ok.json()).toEqual({
        path: { id: 7 },
        query: { n: 4, m: false, depuis: -1000 },
        body: { nom: "Lou" },
      });
      await app.listen({ port: 0, host: "127.0.0.1" });
      const { port } = app.server.address() as AddressInfo;
      expect(await requeteBrute(port, "POST", "/a/7?n=3#&n=x", '{"nom": "Lou"}')).toEqual({
        statut: 200,
        json: { path: { id: 7 }, query: { n: 3, m: false, depuis: null }, body: { nom: "Lou" } },
      });
    } finally {
      await app.close();
    }
  });

  it("décodeur JSON : 2 Mo sous dix fois le temps mesuré", () => {
    const gros = Buffer.from(
      JSON.stringify(
        Array.from({ length: 30_000 }, (_, i) => ({ i, t: "é😀 ".repeat(6), l: [1.5, null, true] })),
      ),
    );
    expect(gros.length).toBeGreaterThan(2_000_000);
    const debut = performance.now();
    const v = pyJsonLoadsOctets(gros) as unknown[];
    expect(v).toHaveLength(30_000);
    expect(performance.now() - debut).toBeLessThan(SEUIL_2MO);
  });
});
