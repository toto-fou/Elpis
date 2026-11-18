// SPDX-License-Identifier: MIT
/** apps/core/test/securite-flux-chat-revalidation.test.ts — le flux NDJSON du chat est revalidé toutes les 60 s : session révoquée = envoi coupé, session valide ou panne transitoire = flux gardé, aucune minuterie laissée. */
import { createUser, dependancesParDefaut, leverMinSession, revoquerSid } from "@elpis/auth";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { REVALIDATION_CHAT_MS, surveillerSession } from "../src/familles/chat";
import type { DependancesChat } from "../src/familles/chat";

const LOGIN = 1_000;

describe("revalidation du flux de chat", () => {
  let t: BaseDeTest;
  let uid = 0;
  let perte: ReturnType<typeof vi.fn<() => Promise<void>>>;
  const requete = {
    session: { get: (cle: string) => (cle === "_login_ts" ? LOGIN : "sid-1") },
  } as unknown as FastifyRequest;

  const dep = (auth = dependancesParDefaut(t.base)): DependancesChat =>
    ({ auth: { ...auth, maintenant: () => LOGIN + 10 } }) as unknown as DependancesChat;

  beforeEach(async () => {
    vi.useFakeTimers();
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    uid = await createUser(t.base, "alice", "mdp-alice", { isAdmin: 0 });
    perte = vi.fn(async () => undefined);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await t.fermer();
  });

  it("session valide : rien avant ni après le contrôle", async () => {
    const arret = surveillerSession(dep(), uid, requete, perte);
    await vi.advanceTimersByTimeAsync(REVALIDATION_CHAT_MS * 3);
    expect(perte).not.toHaveBeenCalled();
    arret();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("session révoquée en cours de flux : coupure au contrôle suivant, une seule fois, sans minuterie restante", async () => {
    const arret = surveillerSession(dep(), uid, requete, perte);
    await vi.advanceTimersByTimeAsync(REVALIDATION_CHAT_MS - 1);
    await revoquerSid(t.base, "sid-1", uid, LOGIN + 5);
    expect(perte).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(perte).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(REVALIDATION_CHAT_MS * 3);
    expect(perte).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    arret();
  });

  it("révocation du compte (coupure après l'ouverture) : flux coupé", async () => {
    const arret = surveillerSession(dep(), uid, requete, perte);
    await leverMinSession(t.base, uid, LOGIN + 5);
    await vi.advanceTimersByTimeAsync(REVALIDATION_CHAT_MS);
    expect(perte).toHaveBeenCalledTimes(1);
    arret();
  });

  it("panne transitoire de la base : flux gardé", async () => {
    const base = { ...t.base, get: () => Promise.reject(new Error("panne")) };
    const arret = surveillerSession(
      dep({ ...dependancesParDefaut(t.base), base } as never),
      uid,
      requete,
      perte,
    );
    await vi.advanceTimersByTimeAsync(REVALIDATION_CHAT_MS * 2);
    expect(perte).not.toHaveBeenCalled();
    arret();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sans dépendance d'authentification : aucune minuterie", () => {
    const arret = surveillerSession({} as DependancesChat, uid, requete, perte);
    expect(vi.getTimerCount()).toBe(0);
    arret();
  });
});
