// SPDX-License-Identifier: MIT
/** apps/core/test/purge-revocations.test.ts — purge périodique de `revoked_sessions` et des rattachements préparés périmés dans main : ligne récente gardée, périmée retirée, erreur de base sans arrêt du process. */
import { createUser, dependancesParDefaut, estRevoquee, revoquerSid } from "@elpis/auth";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CycleDeVie } from "../src/cycle";
import {
  brancherPurgeRevocations,
  MARGE_PURGE_REVOCATIONS_S,
  purgerUnePasse,
} from "../src/ops/purge-revocations";
import { journalMuet } from "./aides";

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);
const MAINTENANT = 1_000_000;
const MAX_AGE = 1000;

describe.each(MOTEURS)("purge des révocations (%s)", (moteur) => {
  let t: BaseDeTest;

  const auth = (base: BaseDeTest["base"] = t.base) => ({
    ...dependancesParDefaut(base),
    maintenant: () => MAINTENANT,
    config: () => ({ security: { session: { max_age_sec: MAX_AGE } } }),
  });

  beforeEach(async () => {
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
  });

  afterEach(async () => {
    await t.fermer();
  });

  it("garde une ligne récente et retire une ligne périmée (durée de vie + marge)", async () => {
    await revoquerSid(t.base, "recente", null, MAINTENANT - MAX_AGE);
    await revoquerSid(t.base, "limite", null, MAINTENANT - MAX_AGE - MARGE_PURGE_REVOCATIONS_S);
    await revoquerSid(t.base, "perimee", null, MAINTENANT - MAX_AGE - MARGE_PURGE_REVOCATIONS_S - 1);
    expect(await purgerUnePasse(auth(), journalMuet)).toBe(1);
    expect(await estRevoquee(t.base, "recente")).toBe(true);
    expect(await estRevoquee(t.base, "limite")).toBe(true);
    expect(await estRevoquee(t.base, "perimee")).toBe(false);
  });

  it("une révocation dont la session n'a pas expiré reste, même si la durée de configuration a été raccourcie puis rallongée", async () => {
    await revoquerSid(t.base, "vivante", null, MAINTENANT - 5000, MAINTENANT + 100);
    await revoquerSid(t.base, "morte", null, MAINTENANT - 9000, MAINTENANT - MARGE_PURGE_REVOCATIONS_S - 1);
    const avecDuree = (max: number) => ({
      ...auth(),
      config: () => ({ security: { session: { max_age_sec: max } } }),
    });
    expect(await purgerUnePasse(avecDuree(10), journalMuet)).toBe(1);
    expect(await purgerUnePasse(avecDuree(10_000_000), journalMuet)).toBe(0);
    expect(await estRevoquee(t.base, "vivante")).toBe(true);
    expect(await estRevoquee(t.base, "morte")).toBe(false);
  });

  it("la même passe retire les rattachements préparés périmés et garde les autres", async () => {
    const uid = await createUser(t.base, "alice", "mdp-alice-1");
    const bob = await createUser(t.base, "bob", "mdp-bob-123");
    const ligne =
      "INSERT INTO auth_prelinks(user_id, provider_id, expected, waiver, created_by, created_at, expires_at) VALUES(?,?,?,?,?,?,?)";
    await t.base.run(ligne, [uid, "sso", "alice", 0, 1, 1, MAINTENANT - 1]);
    await t.base.run(ligne, [bob, "sso", "bob", 0, 1, 1, MAINTENANT + 1]);
    await purgerUnePasse(auth(), journalMuet);
    expect(await t.base.valeurs("SELECT expected FROM auth_prelinks")).toEqual([["bob"]]);
  });

  it("une erreur de base est journalisée sans être relancée", async () => {
    const base = { ...t.base, run: () => Promise.reject(new Error("panne")) };
    await expect(purgerUnePasse(auth(base as never), journalMuet)).resolves.toBe(0);
  });

  it("main : purge au démarrage puis à chaque période, arrêt propre au signal d'arrêt ; admin : rien", async () => {
    await revoquerSid(t.base, "perimee", null, 1);
    const cycle = new CycleDeVie(journalMuet);
    let finir: () => void = () => undefined;
    const deuxPassages = new Promise<void>((ok) => (finir = ok));
    const dormir = vi.fn(async () => {
      if (dormir.mock.calls.length >= 2) finir();
    });
    brancherPurgeRevocations("main", cycle, auth(), journalMuet, { dormir, intervalleMs: 10 });
    await cycle.demarrer("main");
    await deuxPassages;
    cycle.annoncerArret();
    await cycle.executerArrets();
    expect(await estRevoquee(t.base, "perimee")).toBe(false);
    expect(dormir).toHaveBeenCalledTimes(2);

    const cycleAdmin = new CycleDeVie(journalMuet);
    const dormirAdmin = vi.fn(async () => undefined);
    brancherPurgeRevocations("admin", cycleAdmin, auth(), journalMuet, { dormir: dormirAdmin });
    await cycleAdmin.demarrer("admin");
    expect(dormirAdmin).not.toHaveBeenCalled();
  });
});
