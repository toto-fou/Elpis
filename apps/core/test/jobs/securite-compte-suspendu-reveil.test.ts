// SPDX-License-Identifier: MIT
/** apps/core/test/jobs/securite-compte-suspendu-reveil.test.ts — un compte suspendu n'ouvre aucun tour de réveil : réveil écarté, attente oubliée, reprise au démarrage muette, ouverture de tour refusée. */
import "../moteur-environnement";

import { HttpError } from "@elpis/commun";
import { afterEach, beforeEach, expect, it } from "vitest";

import { installerServiceJobs } from "../../src/jobs/branchements";
import { enAttente } from "../../src/jobs/magasin";
import { ServiceJobs } from "../../src/jobs/service";
import { ouvrirTour } from "../../src/tour/ouverture";
import { creerBanc, creerChat, ev, lancerJob, reveils } from "./aides";
import type { Banc } from "./aides";

let b: Banc;

beforeEach(async () => {
  b = await creerBanc();
  await creerChat(b, 1, "c1", "Projet");
});

afterEach(async () => {
  await b.fermer();
});

const suspendre = (uid: number): Promise<unknown> =>
  b.t.base.run("UPDATE users SET suspended_at=?, suspended_by='admin' WHERE id=?", [b.horloge.t, uid]);

it("réveil en attente d'un compte suspendu : écarté `account_suspended`, aucun tour, l'événement reste en base", async () => {
  const id = await lancerJob(b, 1, "c1");
  await b.service.recevoir(1, [ev(id)], 0);
  await suspendre(1);
  await b.horloge.avancer(10, b.service);
  expect(b.tours).toHaveLength(0);
  expect(reveils(b, "started")).toEqual([]);
  expect(reveils(b, "skipped")[0]).toMatchObject({ reason: "account_suspended" });
  expect(await enAttente(b.t.base, 1, "c1")).toHaveLength(1);
});

it("oublierCompte : le lot armé est annulé, aucun tour même sans nouvel événement, un autre compte garde son réveil", async () => {
  await creerChat(b, 2, "c2", "Autre");
  const a = await lancerJob(b, 1, "c1");
  const autre = await lancerJob(b, 2, "c2");
  await b.service.recevoir(1, [ev(a)], 0);
  await b.service.recevoir(2, [ev(autre)], 0);
  b.service.oublierCompte(1);
  await b.horloge.avancer(10, b.service);
  expect(b.tours).toHaveLength(1);
  expect(reveils(b, "started").map((d) => d["user_id"])).toEqual([2]);
});

it("reprise au démarrage : un compte suspendu avec un réveil resté en attente ne relance aucun tour", async () => {
  const id = await lancerJob(b, 1, "c1");
  await b.service.recevoir(1, [ev(id)], 0);
  b.service.arreter();
  await suspendre(1);
  const neuf = new ServiceJobs({
    base: b.t.base,
    hote: { tuer: async () => [], veiller: async () => true },
    publier: (m) => void b.publications.push(m),
    horloge: b.horloge,
  });
  b.service = neuf;
  installerServiceJobs(neuf);
  await neuf.demarrer();
  await b.horloge.avancer(60, neuf);
  expect(b.tours).toHaveLength(0);
  expect(reveils(b, "started")).toEqual([]);
});

it("ouvrirTour refuse un compte suspendu (403), l'autre compte l'ouvre", async () => {
  await suspendre(1);
  const refus = await ouvrirTour({ base: b.t.base }, 1, { chat_id: "c1", messages: [] }).catch(
    (e: unknown) => e,
  );
  expect(refus).toBeInstanceOf(HttpError);
  expect((refus as HttpError).statusCode).toBe(403);
  await creerChat(b, 2, "c2", "Autre");
  const tour = await ouvrirTour({ base: b.t.base }, 2, {
    chat_id: "c2",
    messages: [{ role: "user", content: "Bonjour" }],
  });
  expect(tour.plan.chatId).toBe("c2");
});
