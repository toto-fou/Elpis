// SPDX-License-Identifier: MIT
/** apps/core/test/rag/routes-evenements.test.ts — routes RAG montées avec la vraie authentification : l'événement `rag_job` d'un dépôt arrive par `/api/system-events` au seul propriétaire, jamais à un autre compte ni à l'administrateur. */
import type { AddressInfo } from "node:net";

import { schemaSystemeTravailRag } from "@elpis/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { CycleDeVie } from "../../src/cycle";
import { brancherEvenements } from "../../src/evenements/branchement";
import { creerFamilleRag } from "../../src/familles/rag";
import { ServiceIndexationRag } from "../../src/rag/service";
import { journalMuet } from "../aides";
import {
  ADMIN,
  ALICE,
  appAuthentifiee,
  attendreQue,
  BOB,
  connecter,
  environnementAuth,
  ouvrirFlux,
  SOURCE_TEST,
} from "../evenements/aides";
import type { FluxBrut } from "../evenements/aides";
import { FauxQdrant } from "./aides-indexation";
import { corpsMultipart, demarrerEnvironnement } from "./aides-routes";
import type { Environnement } from "./aides-routes";

let env: Environnement;

beforeAll(async () => {
  env = await demarrerEnvironnement();
});

afterAll(async () => {
  await env.arreter();
});

const ouverts: FluxBrut[] = [];

afterEach(() => {
  for (const f of ouverts.splice(0)) f.fermer();
});

/** Trames `data:` d'un flux d'événements, décodées. */
function trames(f: FluxBrut): { type: string; data?: unknown }[] {
  return f
    .texte()
    .split("\r\n\r\n")
    .filter((t) => t.startsWith("data: "))
    .map((t) => JSON.parse(t.slice(6)) as { type: string; data?: unknown });
}

describe("rag_job par /api/system-events", () => {
  it("le dépôt d'alice produit un rag_job pour alice seule ; ni bob ni l'administrateur ne le reçoivent", async () => {
    const auth = await environnementAuth();
    const cycle = new CycleDeVie(journalMuet);
    const evt = brancherEvenements({
      mode: "main",
      cycle,
      auth: auth.dep,
      redemarrage: SOURCE_TEST,
      journal: journalMuet,
      pingMs: 60_000,
    });
    const service = new ServiceIndexationRag({
      base: auth.t.base,
      diffuser: (m) => evt.diffuserPartout(m),
      qdrant: () => new FauxQdrant(),
      hoteSandbox: async () => null,
    });
    const { app } = await appAuthentifiee(
      "main",
      [evt.famille, creerFamilleRag({ base: auth.t.base, service: () => service })],
      auth.dep,
      journalMuet,
      { multipart: true },
    );
    await app.listen({ port: 0, host: "127.0.0.1" });
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    try {
      const flux = async (uid: number): Promise<{ f: FluxBrut; cookie: string }> => {
        const { cookie } = await connecter(base, uid);
        const f = await ouvrirFlux(`${base}/api/system-events`, { cookie });
        ouverts.push(f);
        return { f, cookie };
      };
      const alice = await flux(ALICE);
      const bob = await flux(BOB);
      const admin = await flux(ADMIN);
      await attendreQue(() => evt.systemEvents.nombreClients === 3);

      const creation = await app.inject({
        method: "POST",
        url: "/api/rag/collections",
        headers: { cookie: alice.cookie },
        payload: { name: "Contrats" },
      });
      expect(creation.statusCode, creation.body).toBe(200);
      const col = creation.json<{ collection: { id: string } }>().collection.id;
      const m = corpsMultipart([{ nom: "a.txt", contenu: "Le contrat se renouvelle." }]);
      const depot = await app.inject({
        method: "POST",
        url: `/api/rag/collections/${col}/documents`,
        headers: { cookie: alice.cookie, "content-type": m.contentType },
        payload: m.payload,
      });
      expect(depot.statusCode, depot.body).toBe(200);
      const job = depot.json<{ job: { id: string } }>().job;

      await alice.f.attendreTexte('"type": "rag_job"');
      const recus = trames(alice.f).filter((t) => t.type === "rag_job");
      expect(recus.length).toBeGreaterThanOrEqual(1);
      for (const t of recus) {
        const decode = schemaSystemeTravailRag.parse(t);
        expect(decode.data).toMatchObject({ user_id: ALICE, collection_id: col });
        expect(decode.data.job.id).toBe(job.id);
      }
      evt.systemEvents.broadcast({ type: "notification", data: { user_id: BOB, title: "sentinelle" } });
      evt.systemEvents.broadcast({ type: "notification", data: { user_id: ADMIN, title: "sentinelle" } });
      await bob.f.attendreTexte("sentinelle");
      await admin.f.attendreTexte("sentinelle");
      expect(trames(bob.f).map((t) => t.type)).toEqual(["notification"]);
      expect(trames(admin.f).map((t) => t.type)).toEqual(["notification"]);
      expect(bob.f.texte()).not.toContain(col);
      expect(admin.f.texte()).not.toContain(col);
    } finally {
      cycle.annoncerArret();
      await app.close();
      await auth.t.fermer();
    }
  });
});
