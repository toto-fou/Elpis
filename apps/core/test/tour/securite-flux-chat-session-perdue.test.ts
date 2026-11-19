// SPDX-License-Identifier: MIT
/** apps/core/test/tour/securite-flux-chat-session-perdue.test.ts — session perdue en plein tour : le tour est abandonné d'abord, `session_expired` est le dernier événement du flux et la réponse se ferme (tour texte comme tour « Images »). */
import "../moteur-environnement";

import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dependancesParDefaut, installerAuth } from "@elpis/auth";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { brancherGardeUrl } from "@elpis/mcp";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { creerFamilleChat } from "../../src/familles/chat";
import { viderAdmissionPourTests } from "../../src/tour/admission";
import { viderEtatPourTests } from "../../src/tour/etat";
import { reglerExecutionPourTests } from "../../src/tour/execution";
import { reglerJournalPourTests } from "../../src/tour/journal-run";
import { reglerTourImagePourTests } from "../../src/tour/image";
import { appTest } from "../aides";

let t: BaseDeTest;
let app: FastifyInstance;
let dossier = "";
let abandonne = false;

beforeAll(() => brancherGardeUrl(async () => null));
afterAll(() => brancherGardeUrl(null));

beforeEach(async () => {
  abandonne = false;
  dossier = mkdtempSync(join(tmpdir(), "elpis-session-perdue-"));
  chmodSync(dossier, 0o700);
  reglerJournalPourTests({ dossier: join(dossier, "runs"), balayage: false });
  t = ouvrirBaseDeTest("sqlite");
  await initialiserBase(t.base);
  await t.base.run(
    "INSERT INTO users(username, pass_salt, pass_hash, created_at, is_admin) VALUES('alice', 's', 'h', 0, 0)",
  );
  const auth = dependancesParDefaut(t.base);
  app = await appTest({
    extensions: [(a) => installerAuth(a, auth)],
    familles: [creerFamilleChat({ base: t.base, dormir: async () => undefined, auth, revalidationMs: 30 })],
    gardes: {
      session: async (req) => {
        req.utilisateur = { id: 1, username: "alice" };
      },
    },
  });
  reglerExecutionPourTests({
    etatFile: async () => ({ kind: "ready" }),
    contexteModele: async () => 0,
    admission: async (_o, fn) => fn(null),
    boucle: async (o) => {
      for (let i = 0; i < 400 && !o.signal?.aborted; i++) {
        await o.onEvent?.({ type: "content_token", text: `t${i}` });
        await new Promise((ok) => setTimeout(ok, 5));
      }
      abandonne = o.signal?.aborted === true;
      await o.onEvent?.({ type: "content_token", text: "apres-abandon" });
      return ["ok", [], {}];
    },
    titre: async () => null,
  });
});

afterEach(async () => {
  await app.close();
  await t.fermer();
  reglerExecutionPourTests(null);
  reglerJournalPourTests(null);
  reglerTourImagePourTests(null);
  viderEtatPourTests();
  viderAdmissionPourTests();
  rmSync(dossier, { recursive: true, force: true });
});

describe("session perdue en plein flux de chat", () => {
  it("le tour est abandonné, `session_expired` est la dernière ligne du flux et la réponse se ferme", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/chat-saved-stream3",
      headers: { "content-type": "application/json" },
      payload: '{"chat_id": "c1", "messages": [{"role": "user", "content": "q"}]}',
    });
    expect(r.statusCode).toBe(200);
    const lignes = r.body.trim().split("\n");
    expect(lignes.at(-1)).toBe('{"type": "session_expired"}');
    expect(lignes.filter((l) => l.includes("session_expired"))).toHaveLength(1);
    await vi.waitFor(() => expect(abandonne).toBe(true));
    expect(r.body).not.toContain("apres-abandon");
  });
});
