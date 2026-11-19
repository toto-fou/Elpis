// SPDX-License-Identifier: MIT
/** apps/core/test/relais/securite-compte-suspendu-relais.test.ts — un compte suspendu ne reçoit plus d'enveloppe d'identité (sauf opérations d'administration), n'ouvre plus d'aperçu ni de route relayée ; un autre compte est servi. */
import { surchargerConfig } from "@elpis/config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { appelerHote } from "../../src/admin/pilote-bac";
import { makePreviewToken, TTL_S } from "../../src/relais/apercu";
import { entetesRelais, identiteRelais } from "../../src/relais/identite";
import { FauxToolhost, JETON, monterBanc } from "./aides";
import type { Banc } from "./aides";

let banc: Banc;
let hote: FauxToolhost;

const suspendre = (uid: number): Promise<unknown> =>
  banc.base.base.run("UPDATE users SET suspended_at=1800000000, suspended_by='admin' WHERE id=?", [uid]);
const reactiver = (uid: number): Promise<unknown> =>
  banc.base.base.run("UPDATE users SET suspended_at=0, suspended_by=NULL WHERE id=?", [uid]);

beforeEach(async () => {
  hote = await new FauxToolhost().demarrer();
  banc = await monterBanc();
  banc.manifeste(
    { main: { url: hote.url, token: JETON, relay: true } },
    { strategy: "single", host: "main" },
  );
});

afterEach(async () => {
  await banc.fermer();
  await hote.arreter();
});

describe("enveloppe d'identité (6)", () => {
  it("identiteRelais et entetesRelais refusent un compte suspendu, sauf opération d'administration", async () => {
    const h = { id: "main", url: hote.url, token: JETON, relay: true } as never;
    expect((await identiteRelais(1)).user_id).toBe(1);
    await suspendre(1);
    await expect(identiteRelais(1)).rejects.toMatchObject({ statusCode: 401 });
    await expect(entetesRelais(h, 1)).rejects.toMatchObject({ statusCode: 401 });
    expect((await identiteRelais(2)).user_id).toBe(2);
    expect(Object.keys(await entetesRelais(h, 1, "alice", { tolererSuspension: true }))).toContain(
      "authorization",
    );
    await reactiver(1);
    expect((await identiteRelais(1)).user_id).toBe(1);
  });
});

describe("appels de l'hôte au nom d'un compte suspendu", () => {
  it("la veille périodique est refusée ; un arrêt ou un nettoyage explicite passe l'enveloppe", async () => {
    const h = { id: "main", url: hote.url, token: JETON, relay: true } as never;
    await suspendre(1);
    await expect(appelerHote(h, 1, "alice", "POST", "/api/internal/jobs/watch")).rejects.toMatchObject({
      statusCode: 401,
    });
    await appelerHote(h, 1, "alice", "POST", "/api/internal/jobs/kill", { tolererSuspension: true });
    expect(hote.requetes.at(-1)?.url).toBe("/api/internal/jobs/kill");
  });
});

describe("relais HTTP et aperçu (7)", () => {
  it("route relayée sous session : 401 dès la suspension, l'autre compte servi", async () => {
    const cookieAlice = await banc.connecter(1);
    const cookieBob = await banc.connecter(2);
    const lire = async (cookie: string): Promise<number> =>
      (await fetch(`${banc.url}/api/sandbox/tree?path=/work`, { headers: { cookie } })).status;
    expect(await lire(cookieAlice)).toBe(200);
    await suspendre(1);
    expect(await lire(cookieAlice)).toBe(401);
    expect(await lire(cookieBob)).toBe(200);
  });

  it("aperçu : jeton signé d'un compte suspendu ou supprimé refusé (403), sans appel à l'hôte ; réactivé, il passe", async () => {
    const restaurer = surchargerConfig({ SESSION_SECRET: "secret-apercu" });
    try {
      const statut = async (uid: number): Promise<number> => {
        const [jeton] = makePreviewToken(uid);
        return (await fetch(`${banc.url}/api/sandbox/pv/${jeton}/site/index.html`)).status;
      };
      expect(await statut(1)).toBe(200);
      await suspendre(1);
      hote.requetes.length = 0;
      expect(await statut(1)).toBe(403);
      expect(await statut(999)).toBe(403);
      expect(hote.requetes).toHaveLength(0);
      expect(await statut(2)).toBe(200);
      await reactiver(1);
      expect(await statut(1)).toBe(200);
    } finally {
      restaurer();
    }
  });

  it("aperçu : un jeton émis avant le plancher de session du compte (rattachement, détachement, révocation) est refusé, un jeton émis après passe", async () => {
    const restaurer = surchargerConfig({ SESSION_SECRET: "secret-apercu" });
    try {
      const statut = async (jeton: string): Promise<number> =>
        (await fetch(`${banc.url}/api/sandbox/pv/${jeton}/site/index.html`)).status;
      const maintenant = Date.now() / 1000;
      const [ancien] = makePreviewToken(1, TTL_S, { maintenant: maintenant - 600 });
      const [recent] = makePreviewToken(1, TTL_S, { maintenant });
      expect(await statut(ancien)).toBe(200);
      await banc.base.base.run("UPDATE users SET session_min_ts=? WHERE id=1", [maintenant - 60]);
      expect(await statut(ancien)).toBe(403);
      expect(await statut(recent)).toBe(200);
      expect(await statut(makePreviewToken(2)[0])).toBe(200);
    } finally {
      restaurer();
    }
  });
});
