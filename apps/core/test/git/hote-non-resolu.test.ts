// SPDX-License-Identifier: MIT
/** apps/core/test/git/hote-non-resolu.test.ts — test et dépôts d'un connecteur dont l'hôte enregistré ne se résout pas : refus `blocked: unresolvable_host` du Python, sans requête vers l'API. */
import { randomBytes } from "node:crypto";

import { createUser } from "@elpis/auth";
import { HttpError } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { configurerCoffre } from "@elpis/securite";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { creerFamilleGit } from "../../src/familles/git";
import { appTest } from "../aides";

describe("connecteur git dont l'hôte ne se résout pas", () => {
  let t: BaseDeTest;
  let app: FastifyInstance;
  const resolus: string[] = [];
  const appels: string[] = [];
  let resultat: () => Promise<string[]> = () =>
    Promise.reject(Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }));

  beforeAll(async () => {
    configurerCoffre({
      cleEnv: randomBytes(32).toString("base64"),
      systeme: "/nonexistent/vault.key",
      repli: "/nonexistent/.vault.key",
    });
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    await createUser(t.base, "alice", "mdp-alice", { isAdmin: 0 });
    app = await appTest({
      familles: [
        creerFamilleGit({
          base: t.base,
          resoudre: (hote) => {
            resolus.push(hote);
            return resultat();
          },
          http: (url): Promise<Dict> => {
            appels.push(url);
            return Promise.resolve({ ok: true, status: 200, body: {} });
          },
          auditer: () => undefined,
        }),
      ],
      gardes: {
        session: (req) => {
          if (req.headers["x-uid"] === undefined) throw new HttpError(401, "not logged in");
          req.utilisateur = { id: Number(req.headers["x-uid"]), username: null };
        },
      },
    });
  });

  afterAll(async () => {
    await app.close();
    await t.fermer();
  });

  it("/test et /repos : `blocked: unresolvable_host` tel que le Python, aucune requête vers l'API ; résolu, la requête part", async () => {
    const cree = await app.inject({
      method: "POST",
      url: "/api/git/connectors",
      headers: { "x-uid": "1" },
      payload: {
        provider_type: "gitea",
        host: "git.exemple.invalid",
        token: "jeton",
        username: "alice",
        api_base: "https://git.exemple.invalid/api/v1",
      },
    });
    const id = (cree.json() as { id: number }).id;
    const essai = await app.inject({
      method: "POST",
      url: `/api/git/connectors/${id}/test`,
      headers: { "x-uid": "1" },
    });
    expect([essai.statusCode, essai.body]).toEqual([
      200,
      '{"ok":false,"error":"blocked: unresolvable_host"}',
    ]);
    for (const q of ["", "?q=canari"]) {
      const depots = await app.inject({
        method: "GET",
        url: `/api/git/connectors/${id}/repos${q}`,
        headers: { "x-uid": "1" },
      });
      expect([depots.statusCode, depots.body]).toEqual([
        200,
        '{"ok":false,"error":"blocked: unresolvable_host","repos":[]}',
      ]);
    }
    resultat = () => Promise.resolve([]);
    const vide = await app.inject({
      method: "POST",
      url: `/api/git/connectors/${id}/test`,
      headers: { "x-uid": "1" },
    });
    expect(vide.body).toBe('{"ok":false,"error":"blocked: unresolvable_host"}');
    expect([resolus, appels]).toEqual([Array(4).fill("git.exemple.invalid"), []]);
    resultat = () => Promise.resolve(["10.0.0.7"]);
    const resolu = await app.inject({
      method: "POST",
      url: `/api/git/connectors/${id}/test`,
      headers: { "x-uid": "1" },
    });
    expect([resolu.statusCode, appels]).toEqual([200, ["https://git.exemple.invalid/api/v1/user"]]);
  });
});
