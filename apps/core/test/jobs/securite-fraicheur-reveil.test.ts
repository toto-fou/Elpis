// SPDX-License-Identifier: MIT
/** apps/core/test/jobs/securite-fraicheur-reveil.test.ts — un compte dont l'accès est périmé (identité externe non revue à temps, compte local ordinaire en mode réservé) n'ouvre aucun tour de réveil et ne reçoit plus de veille ; un compte frais n'est pas gêné. */
import "../moteur-environnement";

import { HttpError } from "@elpis/commun";
import { afterEach, beforeEach, expect, it } from "vitest";

import { installerServiceJobs } from "../../src/jobs/branchements";
import { enAttente } from "../../src/jobs/magasin";
import { ServiceJobs } from "../../src/jobs/service";
import { ouvrirTour } from "../../src/tour/ouverture";
import { creerBanc, creerChat, ev, lancerJob, reveils } from "./aides";
import type { Banc } from "./aides";

const JOUR = 86_400;
let b: Banc;
let reserve = false;
const acces = {
  fraicheursFournisseurs: async (): Promise<ReadonlyMap<string, number>> => new Map([["sso", 3]]),
  localReserveAuxAdmins: (): boolean => reserve,
};

beforeEach(async () => {
  reserve = false;
  b = await creerBanc();
  b.service.arreter();
  b.service = new ServiceJobs({
    base: b.t.base,
    hote: {
      tuer: async () => [],
      veiller: async (uid, ids, since) => {
        b.veilles.push({ uid, ids: [...ids], since, t: b.horloge.t });
        return true;
      },
    },
    publier: (m) => void b.publications.push(m),
    horloge: b.horloge,
    reglages: () => b.reglages,
    acces,
  });
  installerServiceJobs(b.service);
  await creerChat(b, 1, "c1", "Projet");
});

afterEach(async () => {
  await b.fermer();
});

const identite = (uid: number, vuIlYAJours: number): Promise<unknown> =>
  b.t.base.run(
    "INSERT INTO user_identities(user_id, provider_id, subject, issuer, linked_by, linked_at, checked_at) VALUES(?,?,?,?,?,?,?)",
    [uid, "sso", `s${uid}`, "i", "auto", 0, Math.floor(b.horloge.t - vuIlYAJours * JOUR)],
  );

it("réveil d'un compte externe non revu depuis plus que la fraîcheur : écarté `account_recheck`, aucun tour, événement gardé", async () => {
  await identite(1, 10);
  const id = await lancerJob(b, 1, "c1");
  await b.service.recevoir(1, [ev(id)], 0);
  await b.horloge.avancer(10, b.service);
  expect(b.tours).toHaveLength(0);
  expect(reveils(b, "skipped")[0]).toMatchObject({ reason: "account_recheck" });
  expect(await enAttente(b.t.base, 1, "c1")).toHaveLength(1);
});

it("compte externe frais : le réveil part", async () => {
  await identite(1, 1);
  const id = await lancerJob(b, 1, "c1");
  await b.service.recevoir(1, [ev(id)], 0);
  await b.horloge.avancer(10, b.service);
  expect(b.tours).toHaveLength(1);
});

it("compte local ordinaire en mode réservé aux administrateurs : réveil écarté `account_recheck`, reprise au retour du mode « tous »", async () => {
  reserve = true;
  const id = await lancerJob(b, 1, "c1");
  await b.service.recevoir(1, [ev(id)], 0);
  await b.horloge.avancer(10, b.service);
  expect(b.tours).toHaveLength(0);
  expect(reveils(b, "skipped")[0]).toMatchObject({ reason: "account_recheck" });
});

it("veille confiée à l'hôte : sautée pour un compte à l'accès périmé", async () => {
  await lancerJob(b, 1, "c1");
  await b.service.veiller();
  expect(b.veilles).toHaveLength(1);
  await identite(1, 10);
  await b.service.veiller();
  expect(b.veilles).toHaveLength(1);
});

it("ouvrirTour d'un réveil refuse un compte à l'accès périmé (403) ; le tour d'un utilisateur devant l'écran n'est pas concerné", async () => {
  await identite(1, 10);
  await b.t.base.run("UPDATE user_identities SET checked_at=? WHERE user_id=1", [
    Math.floor(Date.now() / 1000) - 10 * JOUR,
  ]);
  const reveil = { origin: "job_wake" as const, wake: {}, depth: 1 };
  const refus = await ouvrirTour({ base: b.t.base, acces }, 1, { chat_id: "c1", messages: [] }, reveil).catch(
    (e: unknown) => e,
  );
  expect(refus).toBeInstanceOf(HttpError);
  expect([(refus as HttpError).statusCode, (refus as HttpError).message]).toEqual([403, "account_recheck"]);
  const interactif = await ouvrirTour({ base: b.t.base, acces }, 1, {
    chat_id: "c1",
    messages: [{ role: "user", content: "Bonjour" }],
  });
  expect(interactif.plan.chatId).toBe("c1");
});
