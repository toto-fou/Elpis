// SPDX-License-Identifier: MIT
/** apps/core/test/tour/routes-chat.test.ts — POST /api/chat-saved-stream3 avant le flux : corps illisible, compression ou génération en cours (409), plafond du compte (429), passation après un Stop, verrou réservé jamais réclamé, file bornée du worker. */
import "../moteur-environnement";

import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mergeUserSettings } from "@elpis/auth";
import { HttpError } from "@elpis/commun";
import { surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { brancherGardeUrl, deConfiance } from "@elpis/mcp";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { getChat, upsertChat } from "../../src/chats/stockage";
import { corpsDuTour, creerFamilleChat, ouvrirTour } from "../../src/familles/chat";
import {
  acquireGenPresence,
  manualCompressionBegin,
  manualCompressionEnd,
  pendingGenLocks,
  reclamerVerrou,
  reserverVerrou,
  sweepPendingGenLocks,
  viderAdmissionPourTests,
} from "../../src/tour/admission";
import {
  markChatCancelled,
  registerChatTask,
  unregisterChatTask,
  verrousChat,
  viderEtatPourTests,
} from "../../src/tour/etat";
import { currentUsageCtx } from "../../src/observabilite/usage-contexte";
import type { UsageContext } from "../../src/observabilite/usage-contexte";
import { FileEvenements } from "../../src/tour/evenements";
import { reglerExecutionPourTests, runTurn } from "../../src/tour/execution";
import { reglerJournalPourTests } from "../../src/tour/journal-run";
import { LlmTarget } from "../../src/llm/cible";
import { appTest } from "../aides";
import { attendre, fauxLlama } from "../llm/faux-serveur";

let t: BaseDeTest;
let app: FastifyInstance;
let dossier = "";

beforeAll(() => brancherGardeUrl(async () => null));
afterAll(() => brancherGardeUrl(null));

beforeEach(async () => {
  dossier = mkdtempSync(join(tmpdir(), "elpis-routes-chat-"));
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
    boucle: async () => ["ok", [], {}],
    titre: async () => null,
  });
});

afterEach(async () => {
  vi.useRealTimers();
  await app.close();
  await t.fermer();
  reglerExecutionPourTests(null);
  reglerJournalPourTests(null);
  viderEtatPourTests();
  viderAdmissionPourTests();
  rmSync(dossier, { recursive: true, force: true });
});

const poster = (payload: string, ct = "application/json") =>
  app.inject({ method: "POST", url: "/api/chat-saved-stream3", headers: { "content-type": ct }, payload });

describe("gardes avant le flux", () => {
  it("corps illisible ou qui n'est pas un objet : 400 invalid_json ; corps vide = {}", async () => {
    for (const corps of ["{", "[1]", "null", '"x"']) {
      const r = await poster(corps);
      expect([r.statusCode, r.json()], corps).toEqual([400, { detail: "invalid_json" }]);
    }
    expect(corpsDuTour(new Uint8Array())).toEqual({});
    expect((await poster('{"messages": []}')).json()).toEqual({
      detail: "messages: aucun message valide dans le payload",
    });
  });

  it("compression manuelle en cours sur le chat : 409 compression_running", async () => {
    manualCompressionBegin(1, "c1");
    const r = await poster('{"chat_id": " c1 ", "messages": [{"role": "user", "content": "q"}]}');
    expect([r.statusCode, r.json()]).toEqual([409, { detail: "compression_running" }]);
    manualCompressionEnd(1, "c1");
    expect(verrousChat.isHeld("compact", 1, "c1")).toBe(false);
  });

  it("deux compactions manuelles concurrentes : le verrou « compact » est rendu à la fin des deux", () => {
    manualCompressionBegin(1, "c2");
    manualCompressionBegin(1, "c2");
    manualCompressionEnd(1, "c2");
    manualCompressionEnd(1, "c2");
    expect(verrousChat.isHeld("compact", 1, "c2")).toBe(false);
  });

  it("génération en cours qui ne se libère pas : 409 generation_running ; Stop demandé : passe", async () => {
    const tour = new AbortController();
    registerChatTask(1, tour, "c1");
    const r = await poster('{"chat_id": "c1", "messages": [{"role": "user", "content": "q"}]}');
    expect([r.statusCode, r.json()]).toEqual([409, { detail: "generation_running" }]);
    markChatCancelled(1, "c1");
    unregisterChatTask(1, "c1", tour);
    expect(
      (await poster('{"chat_id": "c1", "messages": [{"role": "user", "content": "q"}]}')).statusCode,
    ).toBe(200);
  });

  it("écart voulu : plus de plafond de conversations, un autre run du compte ne refuse rien", async () => {
    for (let i = 0; i < 5; i++) verrousChat.acquire("gen", 1, `autre-${i}`);
    const r = await poster('{"chat_id": "c1", "messages": [{"role": "user", "content": "q"}]}');
    expect(r.statusCode).toBe(200);
  });

  it("tour « Images » : mêmes gardes que le tour texte, puis 503 sans moteur d'images", async () => {
    const corps = '{"chat_id": "c1", "image_gen": {}, "messages": []}';
    manualCompressionBegin(1, "c1");
    expect((await poster(corps)).json()).toEqual({ detail: "compression_running" });
    manualCompressionEnd(1, "c1");
    const r = await poster(corps);
    expect([r.statusCode, r.json()]).toEqual([
      503,
      { detail: { code: "unavailable", message: "Aucun moteur d'images n'est configuré." } },
    ]);
  });

  it("tour complet par HTTP : verrou rendu à la fin, réponse en base", async () => {
    const r = await poster('{"chat_id": "c1", "messages": [{"role": "user", "content": "q"}]}');
    expect(r.statusCode).toBe(200);
    expect(r.body.trim().split("\n").at(-1)).toContain('"type": "final"');
    expect(verrousChat.isHeld("gen", 1, "c1")).toBe(false);
    expect(((await getChat(t.base, 1, "c1"))!["messages"] as unknown[]).length).toBe(2);
  });
});

describe("registre d'usage", () => {
  it("le tour et son titre comptent pour le compte et la conversation, source « chat »", async () => {
    const vus: Record<string, UsageContext> = {};
    reglerExecutionPourTests({
      boucle: async () => {
        vus["boucle"] = currentUsageCtx();
        return ["ok", [], {}];
      },
      titre: async () => {
        vus["titre"] = currentUsageCtx();
        return null;
      },
    });
    const r = await poster('{"chat_id": "c-usage", "messages": [{"role": "user", "content": "q"}]}');
    expect(r.statusCode).toBe(200);
    const attendu = { source: "chat", userId: 1, originId: "c-usage", parentId: "" };
    expect(vus["boucle"]).toEqual(attendu);
    await vi.waitFor(() => expect(vus["titre"]).toEqual(attendu));
    expect(currentUsageCtx().source).toBe("unknown");
  });
});

describe("cible du chat", () => {
  it("connecteur : jauge de fin de tour et suivi du chargement sur son serveur, pas sur l'intégré", async () => {
    const integre = await fauxLlama({
      props: { build_info: "b10600-x", default_generation_settings: { n_ctx: 32768 } },
    });
    const conn = await fauxLlama({
      props: { build_info: "b10600-x", role: "router", default_generation_settings: { n_ctx: 131072 } },
      modeles: { data: [{ id: "m", status: { value: "loading" } }] },
    });
    conn.sse("GET /models/sse", [], { ouvert: true });
    const remettre = surchargerConfig({ LLAMA_URL: `${integre.url}/v1/chat/completions` });
    reglerExecutionPourTests(null);
    reglerExecutionPourTests({
      etatFile: async () => ({ kind: "loading" }),
      admission: async (_o, fn) => fn(null),
      titre: async () => null,
      boucle: async () => {
        for (let i = 0; i < 100 && !conn.sur("/models/sse").length; i++) await attendre(20);
        return ["ok", [], { last_prompt_tokens: 50000 }];
      },
    });
    try {
      const tour = await ouvrirTour({ base: t.base }, 1, {
        chat_id: "c1",
        model: "m",
        messages: [{ role: "user", content: "q" }],
      });
      const cible = new LlmTarget({
        isDefault: false,
        providerType: "llamacpp",
        baseUrl: conn.url,
        connectorId: 7,
        model: "m",
      });
      const evs: Record<string, unknown>[] = [];
      for await (const ev of runTurn(
        { base: t.base },
        { ...tour.plan, target: cible },
        tour.res,
        tour.base,
        new AbortController().signal,
      ))
        evs.push(ev);
      expect(conn.sur("/models/sse")).toHaveLength(1);
      expect(evs.find((e) => e["type"] === "kv_cache")).toMatchObject({ used: 50000, total: 131072 });
      const dernier = ((await getChat(t.base, 1, "c1"))!["messages"] as Record<string, unknown>[]).at(-1)!;
      expect(dernier["metrics"]).toMatchObject({ kv_cache: { used: 50000, total: 131072 } });
    } finally {
      remettre();
      await integre.arreter();
      await conn.arreter();
    }
  });
});

describe("configs MCP du tour", () => {
  it("la marque de confiance survit à la préparation (catégories posées en place, aucune copie)", async () => {
    await t.base.run("UPDATE users SET is_admin=1 WHERE id=1");
    await mergeUserSettings(t.base, 1, (r) => {
      r["mcp_servers"] = [
        { id: "srv", name: "docx", type: "sse", url: "http://10.0.0.5:8080/sse", visible: true },
      ];
    });
    const tour = await ouvrirTour({ base: t.base }, 1, {
      chat_id: "c1",
      messages: [{ role: "user", content: "q" }],
      active_mcp_servers: [{ id: "srv", filter_categories: ["lire"] }],
    });
    const reseau = tour.plan.activeMcpServers.filter((s) => s["type"] !== "stdio");
    expect(reseau.map((s) => [s["name"], s["filter_categories"] ?? null])).toEqual([["docx", ["lire"]]]);
    for (const s of reseau) expect(deConfiance(s), JSON.stringify(s)).toBe(true);
    reclamerVerrou(1, "c1");
  });
});

describe("verrou de présence", () => {
  it("passation après un Stop : attend l'unwind du run précédent puis relit la base", async () => {
    await upsertChat(t.base, 1, "c1", "T", [{ role: "user", content: "q" }], 100);
    const ancien = verrousChat.acquire("gen", 1, "c1");
    markChatCancelled(1, "c1");
    setTimeout(() => {
      void upsertChat(
        t.base,
        1,
        "c1",
        "T",
        [
          { role: "user", content: "q" },
          { role: "assistant", content: "partiel", isTruncated: true },
        ],
        200,
      ).then(() => verrousChat.release(ancien));
    }, 50);
    const tour = await ouvrirTour({ base: t.base }, 1, {
      chat_id: "c1",
      messages: [{ role: "user", content: "q" }],
    });
    expect(tour.base.messages).toEqual([
      { role: "user", content: "q" },
      { role: "assistant", content: "partiel", isTruncated: true },
    ]);
    expect(reclamerVerrou(1, "c1")).not.toBeNull();
  });

  it("sans Stop : 409 tout de suite ; Stop mais run qui ne rend pas la main : 409 après 12 s", async () => {
    verrousChat.acquire("gen", 1, "c1");
    await expect(acquireGenPresence(1, "c1")).rejects.toMatchObject({ statusCode: 409 });
    markChatCancelled(1, "c1");
    let attente = 0;
    vi.spyOn(performance, "now").mockImplementation(() => attente * 1000);
    const p = acquireGenPresence(1, "c1", [], async (s) => void (attente += s));
    await expect(p).rejects.toBeInstanceOf(HttpError);
    expect(attente).toBeGreaterThanOrEqual(12);
    vi.restoreAllMocks();
  });

  it("verrou réservé jamais réclamé : relâché par le filet (30 s) ou le balayage (120 s)", async () => {
    vi.useFakeTimers();
    const jeton = verrousChat.acquire("gen", 1, "c1")!;
    reserverVerrou(1, "c1", jeton);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(verrousChat.isHeld("gen", 1, "c1")).toBe(false);
    vi.useRealTimers();
    let ms = 0;
    vi.spyOn(performance, "now").mockImplementation(() => ms);
    const second = verrousChat.acquire("gen", 1, "c2")!;
    reserverVerrou(1, "c2", second);
    ms = 121_000;
    sweepPendingGenLocks();
    expect(pendingGenLocks.size).toBe(0);
    expect(verrousChat.isHeld("gen", 1, "c2")).toBe(false);
    vi.restoreAllMocks();
  });
});

describe("file du worker", () => {
  it("put attend une place ; couper vide la file et relance les producteurs bloqués", async () => {
    const q = new FileEvenements(2);
    await q.put({ a: 1 });
    await q.put({ a: 2 });
    let passe = false;
    const bloque = q.put({ a: 3 }).then(() => (passe = true));
    await new Promise((ok) => setImmediate(ok));
    expect(passe).toBe(false);
    expect(q.getNowait()).toEqual({ a: 1 });
    await bloque;
    expect(q.taille).toBe(2);
    let encore = false;
    const autre = q.put({ a: 4 }).then(() => (encore = true));
    q.couper();
    await autre;
    expect([encore, q.taille]).toEqual([true, 1]);
  });
});
