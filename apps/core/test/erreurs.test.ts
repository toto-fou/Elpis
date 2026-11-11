// SPDX-License-Identifier: MIT
/** apps/core/test/erreurs.test.ts — format des erreurs : `{"detail"}`, 422 de Pydantic, 400, 413, 500 texte. */
import { ErreurPython } from "@elpis/commun";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import type { DefinitionRoute } from "../src/routes";
import { appTest, lignesJournal } from "./aides";
import { HttpError } from "@elpis/commun";
import { corpsJson, entrees, py } from "@elpis/http";

const route = (methode: DefinitionRoute["methode"], chemin: string, traiter: DefinitionRoute["traiter"]) => ({
  methode,
  chemin,
  processus: ["main"] as const,
  acces: "public" as const,
  traiter,
});

const Modele = py.model({
  nom: py.str({ min_length: 2 }),
  age: py.int({ le: 150 }),
  mode: py.literal("a", "b"),
});

let app: FastifyInstance;

beforeAll(async () => {
  app = await appTest({
    limiteCorps: 1024,
    familles: [
      {
        nom: "essai",
        routes: [
          route("GET", "/introuvable", () => {
            throw new HttpError(404, "Chat introuvable");
          }),
          route("GET", "/conflit", () => {
            throw new HttpError(409, { code: "generation_running" });
          }),
          route("GET", "/occupe", () => {
            throw new HttpError(503, "Réessayer", { "Retry-After": "5" });
          }),
          route("GET", "/interdit", () => {
            throw new HttpError(403);
          }),
          route("GET", "/panne", () => {
            throw new Error("secret interne");
          }),
          route("GET", "/nom-trop-long", () => {
            throw Object.assign(new Error("ENAMETOOLONG: /srv/x"), { code: "ENAMETOOLONG" });
          }),
          route("GET", "/hors-bornes", () => {
            throw new ErreurPython("OverflowError", "Python int too large to convert to SQLite INTEGER");
          }),
          route("GET", "/valeur-invalide", () => {
            throw new ErreurPython("ValueError", "invalid literal for int()");
          }),
          route("GET", "/disque-plein", () => {
            throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
          }),
          route("POST", "/json", (req) => ({ recu: corpsJson(req) })),
          route("POST", "/sans-corps", () => ({ ok: true })),
          route("POST", "/modele", (req) => entrees(req, { body: Modele }).body),
          route("GET", "/requete", (req) => entrees(req, { query: { n: py.int() } }).query),
          route("GET", "/routines/:id", (req) => entrees(req, { path: { id: py.int() } }).path),
          route("POST", "/brut", (req) => ({ taille: req.corpsBrut.length })),
        ],
      },
    ],
  });
});

afterAll(async () => {
  await app.close();
});

describe("erreurs HTTP", () => {
  it("HttpError donne {detail}", async () => {
    const r = await app.inject({ method: "GET", url: "/introuvable" });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ detail: "Chat introuvable" });
  });

  it("detail peut être un objet", async () => {
    const r = await app.inject({ method: "GET", url: "/conflit" });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ detail: { code: "generation_running" } });
  });

  it("garde les en-têtes de l'erreur", async () => {
    const r = await app.inject({ method: "GET", url: "/occupe" });
    expect(r.statusCode).toBe(503);
    expect(r.headers["retry-after"]).toBe("5");
  });

  it("sans detail, le libellé du code comme FastAPI", async () => {
    const r = await app.inject({ method: "GET", url: "/interdit" });
    expect(r.json()).toEqual({ detail: "Forbidden" });
  });

  it("route inconnue : 404 Not Found", async () => {
    const r = await app.inject({ method: "GET", url: "/nulle-part" });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ detail: "Not Found" });
  });

  it("erreur inattendue : 500 en texte brut, sans fuite du message", async () => {
    const avant = lignesJournal.length;
    const r = await app.inject({ method: "GET", url: "/panne" });
    expect(r.statusCode).toBe(500);
    expect(r.headers["content-type"]).toContain("text/plain");
    expect(r.body).toBe("Internal Server Error");
    expect(lignesJournal.slice(avant).join("\n")).toContain("secret interne");
  });

  it("500 et 400 d'errno : le journal garde le chemin, jamais la chaîne de requête (jeton)", async () => {
    const avant = lignesJournal.length;
    expect((await app.inject({ method: "GET", url: "/panne?token=secret-abc&x=1" })).statusCode).toBe(500);
    expect((await app.inject({ method: "GET", url: "/nom-trop-long?token=secret-def" })).statusCode).toBe(
      400,
    );
    const journal = lignesJournal.slice(avant).join("\n");
    expect(journal).toContain("500 sur GET /panne");
    expect(journal).toContain("chemin inutilisable sur /nom-trop-long");
    expect(journal).not.toContain("secret-abc");
    expect(journal).not.toContain("secret-def");
    expect(journal).not.toContain("token=");
  });

  it("errno d'entrée invalide : 400 sans chemin dans la réponse", async () => {
    const r = await app.inject({ method: "GET", url: "/nom-trop-long" });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ detail: "Chemin ou nom de fichier invalide." });
  });

  it("OverflowError Python de n'importe quelle route : 400 « Paramètre hors bornes. », détail au journal seulement", async () => {
    const avant = lignesJournal.length;
    const r = await app.inject({ method: "GET", url: "/hors-bornes?token=secret-x" });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ detail: "Paramètre hors bornes." });
    const journal = lignesJournal.slice(avant).join("\n");
    expect(journal).toContain("[400] paramètre hors bornes sur /hors-bornes");
    expect(journal).toContain("OverflowError('Python int too large to convert to SQLite INTEGER')");
    expect(journal).not.toContain("secret-x");
  });

  it("une autre erreur Python reste une panne serveur 500", async () => {
    const r = await app.inject({ method: "GET", url: "/valeur-invalide" });
    expect(r.statusCode).toBe(500);
    expect(r.body).toBe("Internal Server Error");
  });

  it("autre errno : panne serveur 500", async () => {
    const r = await app.inject({ method: "GET", url: "/disque-plein" });
    expect(r.statusCode).toBe(500);
  });
});

describe("corps des requêtes", () => {
  const J = { "content-type": "application/json" };

  it("lit le JSON quel que soit le type de contenu", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/json",
      payload: '{"a": 1}',
      headers: { "content-type": "text/plain" },
    });
    expect(r.json()).toEqual({ recu: { a: 1 } });
  });

  it("JSON invalide lu par la route : 400 avec le message de json.loads", async () => {
    const r = await app.inject({ method: "POST", url: "/json", payload: "{a", headers: J });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({
      detail:
        "Corps JSON invalide : Expecting property name enclosed in double quotes: line 1 column 2 (char 1)",
    });
    const vide = await app.inject({ method: "POST", url: "/json", headers: J });
    expect(vide.json()).toEqual({
      detail: "Corps JSON invalide : Expecting value: line 1 column 1 (char 0)",
    });
  });

  it("décodage de json.loads : BOM, UTF-16, NaN ; UTF-8 invalide ⇒ panne 500", async () => {
    const bom = await app.inject({
      method: "POST",
      url: "/json",
      payload: Buffer.from('\ufeff{"a": 1}'),
      headers: J,
    });
    expect(bom.json()).toEqual({ recu: { a: 1 } });
    const utf16 = Buffer.from('\ufeff{"a": "é"}', "utf16le");
    expect((await app.inject({ method: "POST", url: "/json", payload: utf16, headers: J })).json()).toEqual({
      recu: { a: "é" },
    });
    const invalide = await app.inject({
      method: "POST",
      url: "/json",
      payload: Buffer.from([0x22, 0xff, 0x22]),
      headers: J,
    });
    expect([invalide.statusCode, invalide.body]).toEqual([500, "Internal Server Error"]);
  });

  it("route qui ne lit pas le corps : un JSON invalide ou absent ne la casse pas", async () => {
    const r1 = await app.inject({ method: "POST", url: "/sans-corps", payload: "{a", headers: J });
    const r2 = await app.inject({ method: "POST", url: "/sans-corps", headers: J });
    expect([r1.statusCode, r2.statusCode]).toEqual([200, 200]);
  });

  it("garde les octets bruts (signatures)", async () => {
    const r = await app.inject({ method: "POST", url: "/brut", payload: "é", headers: J });
    expect(r.json()).toEqual({ taille: 2 });
  });

  it("corps trop gros : 413 au format detail", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/brut",
      payload: "x".repeat(2048),
      headers: { "content-type": "text/plain" },
    });
    expect(r.statusCode).toBe(413);
    expect(r.json()).toHaveProperty("detail");
  });
});

describe("validation (422 de Pydantic)", () => {
  const J = { "content-type": "application/json" };
  const detail = (r: { json: () => unknown }) => (r.json() as { detail: unknown }).detail;

  it('modèle valide, mode lax : "30" → 30, true → 1, 12.0 → 12', async () => {
    for (const [age, attendu] of [
      ["30", 30],
      [" 30 ", 30],
      [true, 1],
      [12.0, 12],
      [30, 30],
    ] as const) {
      const r = await app.inject({ method: "POST", url: "/modele", payload: { nom: "Lou", age, mode: "a" } });
      expect([r.statusCode, r.json()]).toEqual([200, { nom: "Lou", age: attendu, mode: "a" }]);
    }
  });

  it("corps absent ou null : missing, input null", async () => {
    const attendu = [{ type: "missing", loc: ["body"], msg: "Field required", input: null }];
    expect(detail(await app.inject({ method: "POST", url: "/modele" }))).toEqual(attendu);
    expect(detail(await app.inject({ method: "POST", url: "/modele", payload: "null", headers: J }))).toEqual(
      attendu,
    );
  });

  it("JSON illisible : json_invalid à la position Python (points de code), ctx.error", async () => {
    const r = await app.inject({ method: "POST", url: "/modele", payload: '{"nom": "😀é",, }', headers: J });
    expect(r.statusCode).toBe(422);
    expect(detail(r)).toEqual([
      {
        type: "json_invalid",
        loc: ["body", 13],
        msg: "JSON decode error",
        input: {},
        ctx: { error: "Expecting property name enclosed in double quotes" },
      },
    ]);
  });

  it("type de contenu non JSON : model_attributes_type avec le texte du corps (strict_content_type)", async () => {
    const corps = '{"nom": "Lou", "age": 30, "mode": "a"}';
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "application/jsonx"]) {
      const r = await app.inject({
        method: "POST",
        url: "/modele",
        payload: corps,
        headers: { "content-type": type },
      });
      expect(detail(r)).toEqual([
        {
          type: "model_attributes_type",
          loc: ["body"],
          msg: "Input should be a valid dictionary or object to extract fields from",
          input: corps,
        },
      ]);
    }
    const plus = await app.inject({
      method: "POST",
      url: "/modele",
      payload: corps,
      headers: { "content-type": "application/vnd.api+json; charset=utf-8" },
    });
    expect(plus.statusCode).toBe(200);
  });

  it("champs : messages, ctx et input exacts ; missing porte l'objet parent", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/modele",
      payload: { nom: "L", age: 200, mode: "c" },
    });
    expect(detail(r)).toEqual([
      {
        type: "string_too_short",
        loc: ["body", "nom"],
        msg: "String should have at least 2 characters",
        input: "L",
        ctx: { min_length: 2 },
      },
      {
        type: "less_than_equal",
        loc: ["body", "age"],
        msg: "Input should be less than or equal to 150",
        input: 200,
        ctx: { le: 150 },
      },
      {
        type: "literal_error",
        loc: ["body", "mode"],
        msg: "Input should be 'a' or 'b'",
        input: "c",
        ctx: { expected: "'a' or 'b'" },
      },
    ]);
    const r2 = await app.inject({ method: "POST", url: "/modele", payload: { age: "x", mode: "a" } });
    expect(detail(r2)).toEqual([
      { type: "missing", loc: ["body", "nom"], msg: "Field required", input: { age: "x", mode: "a" } },
      {
        type: "int_parsing",
        loc: ["body", "age"],
        msg: "Input should be a valid integer, unable to parse string as an integer",
        input: "x",
      },
    ]);
  });

  it("paramètre de requête : int_parsing, missing avec input null", async () => {
    const r = await app.inject({ method: "GET", url: "/requete?n=abc" });
    expect(r.statusCode).toBe(422);
    expect(detail(r)).toEqual([
      {
        type: "int_parsing",
        loc: ["query", "n"],
        msg: "Input should be a valid integer, unable to parse string as an integer",
        input: "abc",
      },
    ]);
    expect(detail(await app.inject({ method: "GET", url: "/requete" }))).toEqual([
      { type: "missing", loc: ["query", "n"], msg: "Field required", input: null },
    ]);
    expect((await app.inject({ method: "GET", url: "/requete?n=1&n=%2012" })).json()).toEqual({ n: 12 });
  });

  it("entier de chemin : lax, 422 si texte, 400 hors bornes", async () => {
    for (const [brut, n] of [
      ["12", 12],
      ["%2012", 12],
      ["+12", 12],
      ["1_000", 1000],
      ["12.0", 12],
      ["-0", 0],
    ] as const) {
      expect((await app.inject({ method: "GET", url: `/routines/${brut}` })).json()).toEqual({ id: n });
    }
    const texte = await app.inject({ method: "GET", url: "/routines/abc" });
    expect(texte.statusCode).toBe(422);
    expect((texte.json() as { detail: { type: string }[] }).detail[0]?.type).toBe("int_parsing");
    const enorme = await app.inject({ method: "GET", url: "/routines/99999999999999999999" });
    expect(enorme.statusCode).toBe(400);
    expect(enorme.json()).toEqual({ detail: "Paramètre hors bornes." });
  });
});
