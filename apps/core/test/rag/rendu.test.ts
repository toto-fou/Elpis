// SPDX-License-Identifier: MIT
/** apps/core/test/rag/rendu.test.ts — client de la visionneuse : une isolation indisponible (503) donne le message sans détail, comme l'extraction. */
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MESSAGE_ISOLATION } from "../../src/rag/extracteur";
import { ErreurRouteRag } from "../../src/rag/http";
import { localiserExtracteur, rendrePageExtracteur } from "../../src/rag/rendu";

let serveur: Server;
let avant: string | undefined;

beforeAll(async () => {
  serveur = createServer(
    (_q, res) =>
      void res
        .writeHead(503, { "content-type": "application/json" })
        .end('{"detail":{"code":"isolation_unavailable"}}'),
  );
  await new Promise<void>((r) => serveur.listen(0, "127.0.0.1", () => r()));
  avant = process.env["RAG_SERVICE_URL"];
  process.env["RAG_SERVICE_URL"] = `http://127.0.0.1:${(serveur.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (avant === undefined) delete process.env["RAG_SERVICE_URL"];
  else process.env["RAG_SERVICE_URL"] = avant;
  serveur.closeAllConnections();
  await new Promise<void>((r) => serveur.close(() => r()));
});

describe("visionneuse : isolation indisponible", () => {
  it("rendu et localisation : 503 avec le message destiné à l'utilisateur", async () => {
    for (const appel of [
      rendrePageExtracteur({ source: "s.pdf", ext: "pdf", page: 1 }),
      localiserExtracteur({ source: "s.pdf", ext: "pdf", texte: "t" }),
    ]) {
      const e: unknown = await appel.catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ErreurRouteRag);
      expect((e as ErreurRouteRag).message).toBe(MESSAGE_ISOLATION);
      expect((e as ErreurRouteRag).statut).toBe(503);
    }
  });
});
