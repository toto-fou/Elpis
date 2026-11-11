// SPDX-License-Identifier: MIT
/** apps/core/test/evenements/pipeline.test.ts — PipelineEvents : plafond par compte, rendu, saturation, révocation, désinscription. */
import { pyJsonDumps } from "@elpis/commun";
import { describe, expect, it } from "vitest";

import { FileAttente } from "../../src/evenements/file";
import { PipelineEvents } from "../../src/evenements/pipeline";
import type { ElementPipeline, Rendu } from "../../src/evenements/pipeline";
import { CLIENT_CLOSED } from "../../src/evenements/systeme";

const CONTROLE = new Set(["session_expired", "worker_recycling", "error"]);

/** Rendu de la page Code (`_render_code_event`) : `code.event` déballé, contrôle enveloppé, le reste filtré. */
const renduCode: Rendu = (m) => {
  if (m["type"] === "code.event") return pyJsonDumps(m["data"] ?? {}, { ensureAscii: false });
  if (typeof m["type"] === "string" && CONTROLE.has(m["type"])) {
    return pyJsonDumps({ __control: m }, { ensureAscii: false });
  }
  return null;
};

describe("PipelineEvents", () => {
  it("le 51e flux d'un compte reçoit l'erreur « trop de flux » et s'arrête", async () => {
    const bus = new PipelineEvents();
    const flux = Array.from({ length: PipelineEvents.MAX_CLIENTS_PER_USER }, () => bus.listen(7));
    expect(bus.nombreClients).toBe(50);
    const refuse = bus.listen(7);
    expect((await refuse.next()).value).toBe(
      '{"type": "error", "code": "too_many_streams", "message": "Too many concurrent SSE connections"}',
    );
    expect((await refuse.next()).done).toBe(true);
    expect(bus.nombreClients).toBe(50);
    bus.disconnectAll();
    for (const f of flux) expect((await f.next()).done).toBe(true);
    expect(bus.stats()).toMatchObject({ users_connected: 0, total_clients: 0 });
  });

  it("flux de la page Code : le contrôle passe enveloppé, le reste est filtré, une fois par message", async () => {
    const bus = new PipelineEvents();
    const flux = bus.listen(1, { validityCheck: () => true, render: renduCode });
    const premier = flux.next();
    for (const p of [
      { type: "code.event", data: { type: "session.idle", titre: "été" } },
      { type: "autre" },
      { type: "session_expired" },
    ]) {
      bus.distributeLocal(1, p);
    }
    const sortie = [(await premier).value, (await flux.next()).value];
    bus.disconnectUser(1);
    expect((await flux.next()).done).toBe(true);
    expect(sortie).toEqual([
      '{"type": "session.idle", "titre": "été"}',
      '{"__control": {"type": "session_expired"}}',
    ]);
    expect(bus.hasClients()).toBe(false);
  });

  it("un rendu qui lève compte une erreur et saute le message", async () => {
    const bus = new PipelineEvents();
    const flux = bus.listen(1, {
      render: (m) => {
        if (m["boum"]) throw new TypeError("non sérialisable");
        return pyJsonDumps(m);
      },
    });
    const premier = flux.next();
    bus.broadcastToUser(1, { boum: true });
    bus.broadcastToUser(1, { ok: 1 });
    expect((await premier).value).toBe('{"ok": 1}');
    expect(bus.stats().errors).toBe(1);
    await flux.return();
  });

  it("un rendu qui lève autre chose qu'une erreur de type termine le flux, comme en Python", async () => {
    const bus = new PipelineEvents();
    const flux = bus.listen(2, {
      render: () => {
        throw new Error("panne du rendu");
      },
    });
    const premier = flux.next();
    bus.broadcastToUser(2, { x: 1 });
    expect((await premier).done).toBe(true);
    expect(bus.stats()).toMatchObject({ errors: 1, total_clients: 0 });
  });

  it("client saturé : les anciens partent, le message courant est livré, le client reste inscrit", () => {
    const bus = new PipelineEvents();
    const file = new FileAttente<ElementPipeline>(2);
    expect(bus.register(987654, file)).toBe(true);
    file.deposer({ n: 1 });
    file.deposer({ n: 2 });
    bus.distributeLocal(987654, { n: 3 });
    expect(bus.snapshotQueues(987654)).toContain(file);
    expect(file.contenu()).toEqual([{ n: 3 }]);
    expect(file.contenu()).not.toContain(CLIENT_CLOSED);
    expect(bus.stats().events_dropped).toBe(1);
  });

  it("révocation : la cause passe avant la sentinelle, même file pleine", () => {
    const bus = new PipelineEvents();
    const file = new FileAttente<ElementPipeline>(2);
    bus.register(3, file);
    file.deposer({ x: 1 });
    file.deposer({ x: 2 });
    expect(bus.disconnectUser(3, { type: "session_expired" })).toBe(1);
    expect(file.contenu()).toEqual([{ type: "session_expired" }, CLIENT_CLOSED]);
  });

  it("revalidation : session expirée ⇒ trame rendue puis fin ; rendu nul ⇒ fin muette", async () => {
    const bus = new PipelineEvents({ attenteMs: 10, revalidationMs: 20 });
    const flux = bus.listen(4, { validityCheck: () => false });
    expect((await flux.next()).value).toBe('{"type": "session_expired"}');
    expect((await flux.next()).done).toBe(true);
    const muet = bus.listen(4, { validityCheck: () => false, render: () => null });
    expect((await muet.next()).done).toBe(true);
    expect(bus.hasClients()).toBe(false);
  });

  it("déconnexion du client : désinscription immédiate ; fermer() évacue et refuse les suivants", async () => {
    const bus = new PipelineEvents();
    const fin = new AbortController();
    const flux = bus.listen(5, { signal: fin.signal });
    const attente = flux.next();
    fin.abort();
    expect(bus.hasClients()).toBe(false);
    expect((await attente).done).toBe(true);
    const ouvert = bus.listen(6);
    expect(bus.fermer({ type: "worker_recycling" })).toBe(1);
    expect((await ouvert.next()).value).toBe('{"type": "worker_recycling"}');
    expect((await ouvert.next()).done).toBe(true);
    const tardif = bus.listen(6);
    expect((await tardif.next()).value).toBe('{"type": "worker_recycling"}');
    expect((await tardif.next()).done).toBe(true);
  });
});
