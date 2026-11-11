// SPDX-License-Identifier: MIT
/** apps/core/test/outils/mcp/garde.test.ts — client MCP réseau gardé par défaut (garde stricte rejouée à chaque connexion, adresses validées seules) ; bibliothèque, manifeste et admin de confiance. */
import { DOSSIER_MOTEUR } from "../../moteur-environnement";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import {
  brancherGardeUrl,
  createShared,
  deConfiance,
  invaliderServeursPerso,
  makeKey,
  oublierVerdictsUrl,
  personalToConfig,
  resolveConfig,
} from "@elpis/mcp";
import type { ClientMcp, ConfigMcp, PoolMcp } from "@elpis/mcp";

import {
  brancherResolutionGardee,
  friendlyMcpError,
  resoudreClientMcp,
} from "../../../src/outils/mcp/clients";
import { demarrerFauxServeur } from "./faux-serveur";
import type { FauxServeur } from "./faux-serveur";

void DOSSIER_MOTEUR;

let srv: FauxServeur;
const ouverts: ClientMcp[] = [];

beforeAll(async () => {
  srv = await demarrerFauxServeur();
  // Première résolution (garde de la config) favorable : seule la garde de connexion peut refuser.
  brancherGardeUrl(async () => null);
});

afterEach(async () => {
  for (const c of ouverts.splice(0)) await c.fermer();
  brancherResolutionGardee(null);
  oublierVerdictsUrl();
  srv.requetes = [];
});

afterAll(async () => {
  brancherGardeUrl(null);
  await srv.fermer();
});

const perso = (url: string, type = "http") => ({ id: "p1", name: "Perso", type, url });

/** Messages de toute la chaîne des causes d'une erreur. */
function causes(e: unknown): string {
  const vus: string[] = [];
  for (let x: unknown = e; x instanceof Error && vus.length < 10; x = x.cause) vus.push(x.message);
  return vus.join(" | ");
}

async function connecter(cfg: ConfigMcp): Promise<unknown> {
  const c = resoudreClientMcp(cfg);
  if (c === null) throw new Error("config inexploitable");
  ouverts.push(c);
  try {
    await c.connecter(new AbortController().signal);
    return null;
  } catch (e) {
    return e;
  }
}

describe("client MCP réseau : gardé par défaut", () => {
  it("serveur perso : non-admin sans marque, admin de confiance ; marque invisible au JSON et aux clés ; clé distincte", async () => {
    const nonAdmin = await personalToConfig(perso(`${srv.base}/mcp`));
    const admin = await personalToConfig(perso(`${srv.base}/mcp`), { allowStdio: true });
    expect(deConfiance(nonAdmin)).toBe(false);
    expect(deConfiance(admin)).toBe(true);
    expect(deConfiance({ ...admin })).toBe(false);
    expect(JSON.stringify(nonAdmin)).toBe(JSON.stringify(admin));
    expect(Object.keys(nonAdmin)).toEqual(Object.keys(admin));
    expect(makeKey(nonAdmin)).not.toBe(makeKey(admin));
  });

  for (const type of ["http", "sse"]) {
    it(`nom de la boucle locale (${type}) : refusé à la connexion, aucune requête reçue`, async () => {
      const cfg = await personalToConfig(
        perso(`http://localhost:${srv.port}/${type === "sse" ? "sse" : "mcp"}`, type),
      );
      const e = await connecter(cfg);
      expect(e).toBeInstanceOf(Error);
      expect(friendlyMcpError(e)).toBe("Connexion impossible : serveur injoignable à cette adresse.");
      expect(srv.requetes).toEqual([]);
    });
  }

  it("adresse NAT64 traduite vers une IPv4 interne : refusée, par nom comme littérale", async () => {
    brancherResolutionGardee(async () => ["64:ff9b::a00:5"]);
    const e = await connecter(await personalToConfig(perso(`http://nat64.exemple.invalid:${srv.port}/mcp`)));
    expect(causes(e)).toContain("resolves_to_blocked (64:ff9b::a00:5)");
    const lit = await connecter(await personalToConfig(perso(`http://[64:ff9b::7f00:1]:${srv.port}/mcp`)));
    expect(causes(lit)).toContain("resolves_to_blocked (64:ff9b::7f00:1)");
    expect(srv.requetes).toEqual([]);
  });

  it("nom qui résout autrement à la connexion (boucle locale) : refusé, aucune requête reçue", async () => {
    brancherResolutionGardee(async () => ["127.0.0.1"]);
    const e = await connecter(await personalToConfig(perso(`http://mcp.exemple.invalid:${srv.port}/mcp`)));
    expect(e).toBeInstanceOf(Error);
    expect(srv.requetes).toEqual([]);
  });

  it("adresse littérale interne, type absent ou streamable-http, copie d'une config de confiance : refusés", async () => {
    const admin = await personalToConfig(perso(`${srv.base}/mcp`), { allowStdio: true });
    for (const cfg of [
      await personalToConfig(perso(`${srv.base}/mcp`)),
      { name: "sans type", url: `${srv.base}/sse` },
      { name: "streamable", type: "streamable-http", url: `${srv.base}/mcp` },
      { ...admin },
    ]) {
      expect(await connecter(cfg), JSON.stringify(cfg)).toBeInstanceOf(Error);
      expect(srv.requetes).toEqual([]);
    }
  });

  it("serveur perso d'un admin : connexion directe", async () => {
    const cfg = await personalToConfig(perso(`${srv.base}/mcp`), { allowStdio: true });
    expect(await connecter(cfg)).toBeNull();
    expect(srv.requetes.length).toBeGreaterThan(0);
  });

  it("bibliothèque partagée : config de confiance, connexion directe", async () => {
    const t = ouvrirBaseDeTest("sqlite");
    try {
      await initialiserBase(t.base);
      const id = await createShared(
        t.base,
        { name: "Intranet", type: "http", url: `${srv.base}/mcp`, enabled: true },
        { userId: null, username: null },
      );
      const cfg = await resolveConfig(t.base, id);
      expect(deConfiance(cfg)).toBe(true);
      expect(await connecter(cfg as ConfigMcp)).toBeNull();
    } finally {
      await t.fermer();
    }
  });

  it("invalidation d'un serveur perso modifié : clés de confiance et gardée fermées", async () => {
    const fermees: string[] = [];
    const pool = {
      invalidate: async (cfg: ConfigMcp) => {
        fermees.push(makeKey(cfg));
      },
      reset: async () => undefined,
    } as unknown as PoolMcp;
    const avant = perso(`${srv.base}/mcp`);
    await invaliderServeursPerso(
      pool,
      [await personalToConfig(avant, { allowStdio: true })],
      [await personalToConfig({ ...avant, url: `${srv.base}/autre` }, { allowStdio: true })],
    );
    const attendues = [
      makeKey(await personalToConfig(avant, { allowStdio: true })),
      makeKey(await personalToConfig(avant)),
    ];
    for (const cle of attendues) expect(fermees).toContain(cle);
  });
});
