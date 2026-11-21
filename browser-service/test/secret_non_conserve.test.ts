// SPDX-License-Identifier: MIT
// test/secret_non_conserve.test.ts — une session ouverte pour un secret du coffre ne laisse aucune trace durable : états, HAR et traces refusés (la fermeture après inactivité reste celle de toute session).
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";

import type { ServiceContext, Session } from "../src/contexte.ts";
import { refusDemarrage } from "../src/routes/demarrage.ts";
import { registerMiscRoutes } from "../src/routes/divers.ts";

const ID = "abcdef12-0000-4000-8000-000000000001";

// Serveur de /save_state sur une session factice ; renvoie les chemins que storageState a reçus.
async function sauvegarder(tls: string | null) {
  const chemins: string[] = [];
  const session = {
    owner: "alice",
    page: { evaluate: async () => true },
    tabs: [],
    context: { storageState: async (o: { path: string }) => void chemins.push(o.path) },
    tls,
    lastActivity: Date.now(),
  } as unknown as Session;
  const ctx = { sessions: new Map([[ID, session]]) } as unknown as ServiceContext;
  const app = express();
  app.use(express.json());
  registerMiscRoutes(app, ctx);
  const srv = http.createServer(app as unknown as http.RequestListener).listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  try {
    const r = await fetch(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/save_state`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: ID, owner: "alice" }),
    });
    return { statut: r.status, corps: (await r.json()) as { error?: string; code?: string }, chemins };
  } finally {
    srv.close();
  }
}

test("/save_state : refusé pour une session ouverte pour un secret, rien écrit", async () => {
  const r = await sauvegarder("strict");
  assert.equal(r.statut, 403);
  assert.equal(r.corps.code, "secret_session_not_saved");
  assert.match(r.corps.error!, /used with a vault secret/);
  assert.deepEqual(r.chemins, []);
});

test("/save_state : session ordinaire sauvegardée comme avant", async () => {
  const r = await sauvegarder(null);
  assert.equal(r.statut, 200);
  assert.equal(r.chemins.length, 1);
});

test("/start : HAR et trace refusés pour un secret (tls ou liaison), permis sinon", () => {
  for (const option of [{ record_har: true }, { trace: true }]) {
    const refus = refusDemarrage({ url: "about:blank", owner: "alice", tls: "strict", ...option });
    assert.equal(refus?.code, "recording_with_credentials");
    assert.match(refus!.error, /vault secret/);
    assert.equal((refus as { fix?: string }).fix, "Start again without record_har and trace.");
  }
  assert.equal(refusDemarrage({ url: "about:blank", owner: "alice", record_har: true, trace: true }), null);
  assert.equal(
    refusDemarrage({ url: "about:blank", owner: "alice", tls: "strict", record_video: true }),
    null,
  );
});
