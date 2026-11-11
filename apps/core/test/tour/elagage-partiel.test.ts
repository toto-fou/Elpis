// SPDX-License-Identifier: MIT
/** apps/core/test/tour/elagage-partiel.test.ts — un tour arrêté enregistre les clés élaguées (déjà indexées) avec son partiel ; un tour éphémère le dit à la boucle (rien d'indexé). */
import "../moteur-environnement";

import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CancelledError } from "@elpis/commun";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { brancherGardeUrl } from "@elpis/mcp";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { OptionsRun } from "../../src/boucle/orchestrateur";
import { getChat } from "../../src/chats/stockage";
import { creerFamilleChat } from "../../src/familles/chat";
import { viderAdmissionPourTests } from "../../src/tour/admission";
import { viderEtatPourTests } from "../../src/tour/etat";
import { reglerExecutionPourTests } from "../../src/tour/execution";
import { reglerJournalPourTests } from "../../src/tour/journal-run";
import { appTest } from "../aides";

let t: BaseDeTest;
let app: FastifyInstance;
let dossier = "";
const vues: OptionsRun[] = [];

beforeAll(() => brancherGardeUrl(async () => null));
afterAll(() => brancherGardeUrl(null));

beforeEach(async () => {
  vues.length = 0;
  dossier = mkdtempSync(join(tmpdir(), "elpis-elagage-partiel-"));
  chmodSync(dossier, 0o700);
  reglerJournalPourTests({ dossier: join(dossier, "runs"), balayage: false });
  t = ouvrirBaseDeTest("sqlite");
  await initialiserBase(t.base);
  await t.base.run(
    "INSERT INTO users(username, pass_salt, pass_hash, created_at, is_admin) VALUES('alice', 's', 'h', 0, 0)",
  );
  app = await appTest({
    familles: [creerFamilleChat({ base: t.base, dormir: async () => undefined })],
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
    titre: async () => null,
    boucle: async (o) => {
      vues.push(o);
      await o.onEvent?.({ type: "tool_history_partial", tool_history: [] });
      await o.onEvent?.({ type: "prune_state", keys: ["c1|9|abc|abc"] });
      throw new CancelledError("User cancelled");
    },
  });
});

afterEach(async () => {
  await app.close();
  await t.fermer();
  reglerExecutionPourTests(null);
  reglerJournalPourTests(null);
  viderEtatPourTests();
  viderAdmissionPourTests();
  rmSync(dossier, { recursive: true, force: true });
});

const poster = (corps: object) =>
  app.inject({
    method: "POST",
    url: "/api/chat-saved-stream3",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify(corps),
  });

describe("élagage d'un tour interrompu (index session_search sans doublon)", () => {
  it("Stop après un élagage en cours de run : le partiel est sauvé avec les clés, qui ne seront plus reprises", async () => {
    const r = await poster({ chat_id: "c1", messages: [{ role: "user", content: "q" }] });
    expect(r.body).toContain('"cancelled": true');
    expect((await getChat(t.base, 1, "c1"))?.["ctx_pruned_keys"]).toEqual(["c1|9|abc|abc"]);
    expect(vues[0]?.ephemeral).toBe(false);
  });

  it("tour éphémère : la boucle le sait (aucune indexation), rien n'est enregistré", async () => {
    await poster({ chat_id: "c2", ephemeral: true, messages: [{ role: "user", content: "q" }] });
    expect(vues[0]?.ephemeral).toBe(true);
    expect(await getChat(t.base, 1, "c2")).toBeNull();
  });
});
