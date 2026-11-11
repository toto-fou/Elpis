// SPDX-License-Identifier: MIT
/** packages/contracts/test/core/systeme.test.ts — flux SSE `/api/system-events` du core TS réel : chaque trame reçue décodée par le contrat. */
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { redemarrerApp } from "../../../../apps/core/src/admin/securite";
import { RECYCLAGE } from "../../../../apps/core/src/evenements/branchement";
import { logRecordToEvent } from "../../../../apps/core/src/evenements/journal-staff";
import { AnalyseurSse } from "../../../../apps/core/src/evenements/sse";
import { refreshModelCache } from "../../../../apps/core/src/llm/cache-modeles";
import { pousserNotification } from "../../../../apps/core/src/notifications/envoi";
import { journalMuet } from "../../../../apps/core/test/aides";
import { decoderEvenementSysteme, schemaEvenementSysteme } from "../../src";
import type { EvenementSysteme } from "../../src";
import { creerCompte, demarrerCore } from "./aides";
import type { CoreDeTest } from "./aides";

let core: CoreDeTest;
let port = 0;
let uid = 0;
let cookie = "";

beforeAll(async () => {
  core = await demarrerCore();
  uid = await creerCompte(core.base, "zoe", "mdp-de-zoe-1");
  cookie = await core.connecter("zoe", "mdp-de-zoe-1");
  await core.app.listen({ port: 0, host: "127.0.0.1" });
  port = (core.app.server.address() as AddressInfo).port;
});

afterAll(async () => {
  await core.fermer();
});

interface Flux {
  readonly recus: EvenementSysteme[];
  readonly fin: Promise<void>;
  attendre(n: number): Promise<void>;
  couper(): void;
}

async function ouvrirFlux(): Promise<Flux> {
  const abandon = new AbortController();
  const r = await fetch(`http://127.0.0.1:${port}/api/system-events`, {
    headers: { cookie },
    signal: abandon.signal,
  });
  expect([r.status, r.headers.get("content-type")]).toEqual([200, "text/event-stream; charset=utf-8"]);
  const recus: EvenementSysteme[] = [];
  const analyseur = new AnalyseurSse();
  const decodeur = new TextDecoder();
  const fin = (async () => {
    try {
      for await (const m of r.body ?? []) {
        for (const ev of analyseur.pousser(decodeur.decode(m as Uint8Array, { stream: true }))) {
          const d = decoderEvenementSysteme(ev.donnees);
          expect(d, ev.donnees).toMatchObject({ statut: "ok" });
          if (d.statut === "ok") recus.push(d.evenement);
        }
      }
    } catch (e) {
      if (!abandon.signal.aborted) throw e;
    }
  })();
  await new Promise((ok) => setTimeout(ok, 50));
  return {
    recus,
    fin,
    attendre: async (n) => {
      const limite = Date.now() + 5_000;
      while (recus.length < n && Date.now() < limite) await new Promise((ok) => setTimeout(ok, 20));
      expect(recus.length).toBeGreaterThanOrEqual(n);
    },
    couper: () => abandon.abort(),
  };
}

describe("contrat du SSE système (core réel)", () => {
  it("notification, redémarrage et état des modèles décodés par le contrat", async () => {
    const flux = await ouvrirFlux();
    const de = (type: string): EvenementSysteme | undefined => flux.recus.find((e) => e.type === type);
    await pousserNotification(core.base, uid, "routine_ok", "Routine terminée", {
      body: "é",
      refType: "routine",
      refId: 3,
    });
    await redemarrerApp(
      {
        journal: journalMuet,
        diffuser: (m) => core.composition.evenements.diffuserPartout(m),
        maintenant: () => 1_800_000_000.5,
        cycleVie: { redemarrerMain: () => Promise.resolve(true), programmerRechargement: () => undefined },
      },
      "Redémarrage pour HTTPS",
    );
    await refreshModelCache();
    await flux.attendre(3);
    flux.couper();
    await flux.fin;
    expect(de("notification")).toMatchObject({ data: { user_id: uid, ref_id: 3, unread: 1, body: "é" } });
    expect(de("restart")).toEqual({
      type: "restart",
      message: "Redémarrage pour HTTPS",
      started_at: 1_800_000_000.5,
    });
    expect(de("model_status")).toMatchObject({ data: { server_reachable: false, status: "unreachable" } });
  });

  it("révocation du compte : `session_expired` puis fermeture", async () => {
    const flux = await ouvrirFlux();
    await core.composition.evenements.revoquer(uid);
    await flux.fin;
    expect(flux.recus.filter((e) => e.type !== "model_status")).toEqual([{ type: "session_expired" }]);
  });

  it("recyclage du worker : `worker_recycling` puis fermeture", async () => {
    cookie = await core.connecter("zoe", "mdp-de-zoe-1");
    const flux = await ouvrirFlux();
    core.composition.evenements.systemEvents.fermer(RECYCLAGE);
    await flux.fin;
    expect(flux.recus.filter((e) => e.type !== "model_status")).toEqual([{ type: "worker_recycling" }]);
  });

  it("lignes du journal relayées au staff, vecteurs du core compris", () => {
    const v = JSON.parse(
      readFileSync(new URL("../../../../apps/core/test/vecteurs/evenements.json", import.meta.url), "utf-8"),
    ) as { journal: { rec: Record<string, unknown>; attendu: unknown }[] };
    let n = 0;
    for (const { rec, attendu } of v.journal) {
      if (attendu === null) continue;
      expect(schemaEvenementSysteme.parse(attendu)).toEqual(attendu);
      expect(logRecordToEvent(rec)).toEqual(attendu);
      n++;
    }
    expect(n).toBeGreaterThan(0);
  });

  it("décodage : type inconnu signalé, forme invalide refusée, JSON illisible refusé", () => {
    expect(decoderEvenementSysteme('{"type": "nouveau"}')).toEqual({ statut: "inconnu", type: "nouveau" });
    expect(decoderEvenementSysteme('{"type": "restart"}').statut).toBe("invalide");
    expect(decoderEvenementSysteme('{"type": "notification", "data": {"user_id": 0}}').statut).toBe(
      "invalide",
    );
    expect(decoderEvenementSysteme("ping").statut).toBe("invalide");
    expect(decoderEvenementSysteme("[]").statut).toBe("invalide");
  });
});
