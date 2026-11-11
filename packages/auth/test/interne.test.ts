// SPDX-License-Identifier: MIT
/** packages/auth/test/interne.test.ts — garde `interne` du canal main ↔ admin : boucle locale ET jeton interne, jamais celui du toolhost. */
import { HttpError } from "@elpis/commun";
import { jetonInterne } from "@elpis/securite";
import Fastify, { LogController } from "fastify";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { creerGardes } from "../src/index";
import type { DependancesAuth } from "../src/index";

const JETON_TOOLHOST = "jeton-du-toolhost";
let app: FastifyInstance | undefined;

/** Comme le contrôleur de `creerApp` : pas de ligne par requête, erreurs de flux et d'écriture journalisées. */
class ControleurSansRequetes extends LogController {
  override incomingRequest(): void {}
  override requestCompleted(): void {}
  override routeNotFound(): void {}
}

function texte(valeur: unknown): string {
  if (typeof valeur === "string") return valeur;
  try {
    return JSON.stringify(valeur);
  } catch {
    return String(valeur);
  }
}

function journalCapte(lignes: string[]): FastifyBaseLogger {
  const ecrire = (...args: unknown[]): void => {
    lignes.push(args.map(texte).join(" "));
  };
  const journal = {
    level: "trace",
    trace: ecrire,
    debug: ecrire,
    info: ecrire,
    warn: ecrire,
    error: ecrire,
    fatal: ecrire,
    silent: () => undefined,
    child: () => journal,
  };
  return journal as unknown as FastifyBaseLogger;
}

async function monter(secret: string, lignes: string[] = []): Promise<FastifyInstance> {
  const dep = {
    base: undefined,
    config: () => ({}),
    attributsCookie: () => ({ cookie_name: "s", same_site: "lax", https_only: false, max_age: 60 }),
    secret: () => secret,
    jetonService: () => JETON_TOOLHOST,
  } as unknown as DependancesAuth;
  const a = Fastify({ loggerInstance: journalCapte(lignes), logController: new ControleurSansRequetes() });
  a.setErrorHandler((e, _req, rep) => {
    if (e instanceof HttpError)
      return rep
        .code(e.statusCode)
        .headers(e.entetes ?? {})
        .send({ detail: e.detail });
    return rep.code(500).send({ detail: String(e) });
  });
  const g = creerGardes(dep);
  a.get("/api/internal/status", { onRequest: g.interne }, async () => ({ ok: true }));
  await a.ready();
  app = a;
  return a;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function appel(a: FastifyInstance, remoteAddress: string, entetes: Record<string, string> = {}) {
  return a.inject({ method: "GET", url: "/api/internal/status", remoteAddress, headers: entetes });
}

describe("garde interne", () => {
  it("boucle locale et jeton interne : accepté (IPv4, IPv6, IPv4 mappée, casse et blancs du schéma)", async () => {
    const jeton = jetonInterne("secret-partage");
    const a = await monter("secret-partage");
    for (const adresse of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      expect((await appel(a, adresse, { authorization: `Bearer ${jeton}` })).statusCode, adresse).toBe(200);
    }
    expect((await appel(a, "127.0.0.1", { authorization: `bearer  ${jeton} ` })).statusCode).toBe(200);
  });

  it("jeton du toolhost, autre secret, schéma faux ou absent : 401 avec WWW-Authenticate", async () => {
    const a = await monter("secret-partage");
    for (const authorization of [
      `Bearer ${JETON_TOOLHOST}`,
      `Bearer ${jetonInterne("autre-secret")}`,
      `Basic ${jetonInterne("secret-partage")}`,
      "Bearer",
      "",
    ]) {
      const r = await appel(a, "127.0.0.1", authorization ? { authorization } : {});
      expect([r.statusCode, r.json(), r.headers["www-authenticate"]], authorization).toEqual([
        401,
        { detail: "jeton interne requis" },
        "Bearer",
      ]);
    }
  });

  it("jeton interne hors boucle locale ou derrière un relais : 403", async () => {
    const jeton = jetonInterne("secret-partage");
    const a = await monter("secret-partage");
    const auth = { authorization: `Bearer ${jeton}` };
    for (const [adresse, entetes] of [
      ["10.0.0.2", auth],
      ["192.0.2.20", auth],
      ["127.0.0.1", { ...auth, "x-forwarded-for": "10.0.0.1" }],
      ["127.0.0.1", { ...auth, forwarded: "for=10.0.0.1" }],
      ["::1", { ...auth, "x-real-ip": "10.0.0.1" }],
    ] as const) {
      const r = await appel(a, adresse, entetes);
      expect([r.statusCode, r.json()], adresse).toEqual([403, { detail: "Endpoint restricted to loopback" }]);
    }
  });

  it("sans secret de session : 503, jamais un jeton dérivé d'une clé vide", async () => {
    const a = await monter("");
    const r = await appel(a, "127.0.0.1", { authorization: "Bearer " });
    expect([r.statusCode, r.json()]).toEqual([503, { detail: "aucun jeton interne configuré" }]);
  });

  it("aucune trace du jeton dans les journaux, acceptée comme refusée", async () => {
    const lignes: string[] = [];
    const jeton = jetonInterne("secret-partage");
    const a = await monter("secret-partage", lignes);
    await appel(a, "127.0.0.1", { authorization: `Bearer ${jeton}` });
    await appel(a, "10.0.0.2", { authorization: `Bearer ${jeton}` });
    await appel(a, "127.0.0.1", { authorization: `Bearer ${JETON_TOOLHOST}` });
    expect(lignes.some((l) => l.includes("[interne]"))).toBe(true);
    for (const secret of [jeton, JETON_TOOLHOST, "secret-partage"]) {
      expect(lignes.filter((l) => l.includes(secret))).toEqual([]);
    }
  });
});
