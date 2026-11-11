// SPDX-License-Identifier: MIT
/** apps/core/test/jobs/livraison-sure.test.ts — événements de jobs pris pour un résultat d'outil ou un message : rendus quand la réponse n'est pas enregistrée (conflit, redémarrage du core), jamais perdus. */
import "../moteur-environnement";

import type { Dict } from "@elpis/commun";
import { afterEach, beforeEach, expect, it } from "vitest";

import { getChat, upsertChat } from "../../src/chats/stockage";
import { installerServiceJobs } from "../../src/jobs/branchements";
import { enAttente } from "../../src/jobs/magasin";
import { ServiceJobs } from "../../src/jobs/service";
import { isGenerationActive } from "../../src/tour/etat";
import { runTurn } from "../../src/tour/execution";
import { ouvrirTour } from "../../src/tour/ouverture";
import { creerBanc, creerChat, ev, lancerJob, tourActif } from "./aides";
import type { Banc } from "./aides";

let b: Banc;

beforeEach(async () => {
  b = await creerBanc();
  await creerChat(b, 1, "c1", "Projet");
});

afterEach(async () => {
  await b.fermer();
});

/** Service recréé sur la même base, comme après un redémarrage du core. */
async function redemarrer(): Promise<ServiceJobs> {
  b.service.arreter();
  const neuf = new ServiceJobs({
    base: b.t.base,
    hote: { tuer: async () => [], veiller: async () => true },
    publier: (m) => void b.publications.push(m),
    horloge: b.horloge,
  });
  b.service = neuf;
  installerServiceJobs(neuf);
  await neuf.demarrer();
  return neuf;
}

it("JB-07 : événement rendu dans un résultat d'outil, réponse finale en conflit (autre onglet) → événement rendu non livré", async () => {
  const id = await lancerJob(b, 1, "c1");
  let pris: string | null = null;
  b.pendantTour = async () => {
    await b.service.recevoir(1, [ev(id)], 0);
    pris = await b.service.prendrePourResultat(1, "c1");
    await upsertChat(b.t.base, 1, "c1", "Projet", [{ role: "user", content: "autre onglet" }], 9_999_999_999);
  };
  const chat = await getChat(b.t.base, 1, "c1");
  const messages = [...(chat?.["messages"] as Dict[]), { role: "user", content: "Où en est-on ?" }];
  const tour = await ouvrirTour({ base: b.t.base }, 1, { chat_id: "c1", messages, resumable: true });
  for await (const e of runTurn(
    { base: b.t.base },
    tour.plan,
    tour.res,
    tour.base,
    new AbortController().signal,
  ))
    void e;
  for (let i = 0; i < 300 && isGenerationActive(1, "c1"); i++) await new Promise((ok) => setTimeout(ok, 10));
  await b.service.calme();
  expect(pris).not.toBeNull();
  expect((await enAttente(b.t.base, 1, "c1")).map((e) => e.jobId)).toEqual([id]);
});

it("redémarrage du core pendant un tour : événements pris pour un résultat d'outil ou un message rendus non livrés, livraisons confirmées gardées", async () => {
  const livre = await lancerJob(b, 1, "c1");
  const fin = tourActif(1, "c1");
  await b.service.recevoir(1, [ev(livre)], 0);
  expect(await b.service.prendrePourResultat(1, "c1")).toContain(livre);
  b.service.finTour(1, "c1", "run-c1", { message: true, reponse: true, suffixe: false });
  fin();
  await b.service.calme();
  const outil = await lancerJob(b, 1, "c1");
  const fin2 = tourActif(1, "c1");
  await b.service.recevoir(1, [ev(outil)], 0);
  expect(await b.service.prendrePourResultat(1, "c1")).toContain(outil);
  await creerChat(b, 1, "c2", "Autre");
  const message = await lancerJob(b, 1, "c2");
  await b.service.recevoir(1, [ev(message)], 0);
  expect(await b.service.prendrePourMessage(1, "c2", "run-c2")).toContain(message);
  const neuf = await redemarrer();
  fin2();
  expect((await enAttente(b.t.base, 1, "c1")).map((e) => e.jobId)).toEqual([outil]);
  expect((await enAttente(b.t.base, 1, "c2")).map((e) => e.jobId)).toEqual([message]);
  expect(neuf.enAttente(1, "c1") && neuf.enAttente(1, "c2")).toBe(true);
  await b.horloge.avancer(1, neuf);
  expect(b.tours).toHaveLength(2);
  neuf.arreter();
});
