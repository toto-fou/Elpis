// SPDX-License-Identifier: MIT
/** apps/core/test/tour/routes-controle.test.ts — routes chat_control rejouées contre la vraie app FastAPI (vecteurs, SQLite et PostgreSQL) ; « Répondre maintenant », Stop jusqu'au moteur, suivi NDJSON en direct par HTTP. */
import "../moteur-environnement";

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dependancesParDefaut } from "@elpis/auth";
import { CancelledError, pyJsonLoads } from "@elpis/commun";
import { surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { upsertChat } from "../../src/chats/stockage";
import { creerFamilleChatControle } from "../../src/familles/chat-controle";
import { engineCaps, invalidate as oublierCaps } from "../../src/llm/fournisseurs/llama-capacites";
import {
  controleRaisonnementDuProcess,
  isChatCancelled,
  registerChatTask,
  verrousChat,
  viderEtatPourTests,
} from "../../src/tour/etat";
import { installerPlanificateur } from "../../src/routines/planificateur";
import type { Planificateur } from "../../src/routines/planificateur";
import { reglerJournalPourTests, RunJournal } from "../../src/tour/journal-run";
import { appTest } from "../aides";
import { fauxLlama } from "../llm/faux-serveur";
import type { FauxServeur } from "../llm/faux-serveur";

interface Etat {
  uid: number;
  chat: string;
  verrou?: boolean;
  jsonl?: string;
  fin?: boolean;
  courant?: string | null;
  lignes?: string;
}
const V = pyJsonLoads(readFileSync(new URL("../vecteurs/tour-journal.json", import.meta.url), "utf-8")) as {
  etats: Etat[];
  requetes: [number, string, string, string | null][];
  reponses: {
    statut: number;
    corps: string | null;
    chat_ids?: string[];
    entetes: Record<string, string | null>;
  }[];
};
const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);
const JSON_CT = { "content-type": "application/json" };

let dossier = "";
let llama: FauxServeur;
let restaurer: () => void = () => undefined;

beforeAll(async () => {
  llama = await fauxLlama();
  llama.json("DELETE /v1/stream", { ok: true });
  restaurer = surchargerConfig({
    LLAMA_URL: `${llama.url}/v1/chat/completions`,
    LLAMA_PROVIDER_TYPE: "llamacpp",
  });
});

afterAll(async () => {
  restaurer();
  await llama.arreter();
});

beforeEach(() => {
  dossier = mkdtempSync(join(tmpdir(), "elpis-chat-controle-"));
  mkdirSync(join(dossier, "runs"), { mode: 0o700 });
  chmodSync(join(dossier, "runs"), 0o700);
  reglerJournalPourTests({ dossier: join(dossier, "runs"), balayage: false });
  oublierCaps();
});

afterEach(() => {
  reglerJournalPourTests(null);
  viderEtatPourTests();
  rmSync(dossier, { recursive: true, force: true });
});

function poser(e: Etat): void {
  if (e.verrou) verrousChat.acquire("gen", e.uid, e.chat);
  const d = new RunJournal(e.uid, e.chat, "x").dir;
  mkdirSync(d, { recursive: true, mode: 0o700 });
  if (e.courant !== undefined && e.courant !== null) writeFileSync(join(d, "current.json"), e.courant);
  if (e.jsonl) {
    writeFileSync(join(d, `${e.jsonl}.jsonl`), e.lignes ?? "");
    if (e.fin) writeFileSync(join(d, `${e.jsonl}.end`), "");
  }
}

it("sept routes, montées sur main comme dans l'inventaire, accès par session", () => {
  const inventaire = JSON.parse(
    readFileSync(new URL("../../../../migration-kit/routes.inventory.json", import.meta.url), "utf-8"),
  ) as { routes: { methodes: string[]; chemin: string; module: string; process: string[] }[] };
  const attendu = inventaire.routes
    .filter((r) => r.module === "chatbot_app/routes/chat_control.py")
    .map((r) => [r.methodes.join(","), r.chemin.replace(/\{(\w+)\}/gu, ":$1"), r.process.join(",")])
    .sort();
  const famille = creerFamilleChatControle({ base: {} as never, auth: {} as never });
  const obtenu = famille.routes
    .map((r) => [String(r.methode), r.chemin, r.processus.join(","), r.acces])
    .sort();
  expect(obtenu).toEqual(attendu.map((r) => [...r, "session"]));
  expect(obtenu).toHaveLength(7);
});

describe.each(MOTEURS)("routes chat_control (%s)", (moteur) => {
  let t: BaseDeTest;
  let app: FastifyInstance;

  beforeAll(async () => {
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
    for (const nom of ["alice", "bob"])
      await t.base.run(
        "INSERT INTO users(username, pass_salt, pass_hash, created_at, is_admin) VALUES(?,?,?,?,?)",
        [nom, "s", "h", 0, 0],
      );
    await upsertChat(t.base, 1, "c1", "Titre", [], 1.0);
    app = await appTest({
      familles: [creerFamilleChatControle({ base: t.base, auth: dependancesParDefaut(t.base) })],
      gardes: {
        session: async (req) => {
          req.utilisateur = { id: Number(req.headers["x-uid"]), username: "x" };
          Object.assign(req, { session: { get: () => undefined } });
        },
      },
    });
  });

  afterAll(async () => {
    await app.close();
    await t.fermer();
  });

  it("réponses identiques au routeur Python (statut, corps à l'octet près, en-têtes)", async () => {
    for (const e of V.etats) poser(e);
    for (const [i, [uid, method, url, corps]] of V.requetes.entries()) {
      const r = await app.inject({
        method: method as "GET" | "POST",
        url,
        headers: { "x-uid": String(uid), ...(corps === null ? {} : JSON_CT) },
        ...(corps === null ? {} : { payload: corps }),
      });
      const attendu = V.reponses[i]!;
      const cle = `${method} ${url} ${corps ?? ""}`;
      if (attendu.chat_ids !== undefined) {
        expect([r.statusCode, ((r.json() as { chat_ids: string[] }).chat_ids ?? []).sort()], cle).toEqual([
          attendu.statut,
          attendu.chat_ids,
        ]);
      } else expect([r.statusCode, r.body], cle).toEqual([attendu.statut, attendu.corps]);
      const type = String(r.headers["content-type"]);
      expect(type.startsWith("application/json") ? type.replace("; charset=utf-8", "") : type, cle).toBe(
        attendu.entetes["content-type"],
      );
      expect(r.headers["cache-control"] ?? null, cle).toBe(attendu.entetes["cache-control"]);
      expect(r.headers["x-accel-buffering"] ?? null, cle).toBe(attendu.entetes["x-accel-buffering"]);
    }
  });

  it("Stop : drapeau, tour abandonné, session du moteur arrêtée ; sans chat_id, seuls les tours sans chat", async () => {
    const tour = new AbortController();
    const autre = new AbortController();
    const sansChat = new AbortController();
    registerChatTask(1, tour, "c1");
    registerChatTask(1, autre, "c2");
    registerChatTask(1, sansChat, null);
    const avant = llama.sur("/v1/stream").length;
    const r = await app.inject({
      method: "POST",
      url: "/api/chat/cancel",
      headers: { "x-uid": "1", ...JSON_CT },
      payload: '{"chat_id": "c1"}',
    });
    expect(r.json()).toEqual({ status: "cancelled" });
    expect(tour.signal.reason).toBeInstanceOf(CancelledError);
    expect([isChatCancelled(1, "c1"), autre.signal.aborted, sansChat.signal.aborted]).toEqual([
      true,
      false,
      false,
    ]);
    const arret = llama.sur("/v1/stream").slice(avant);
    expect(arret.map((q) => [q.methode, q.url.searchParams.get("conv_id")?.length])).toEqual([
      ["DELETE", 32],
    ]);
    await app.inject({
      method: "POST",
      url: "/api/chat/cancel",
      headers: { "x-uid": "1", ...JSON_CT },
      payload: "{}",
    });
    expect([autre.signal.aborted, sansChat.signal.aborted, isChatCancelled(1, "__none__")]).toEqual([
      false,
      true,
      true,
    ]);
  });

  it("Stop d'un run de routine : arrêt demandé au planificateur pour le propriétaire seulement", async () => {
    for (const [id, nom] of [
      [3, "r3"],
      [4, "r4"],
    ] as const)
      await t.base.run(
        "INSERT INTO editor_routines(id, owner_user_id, name, cron_expr, created_at, updated_at) VALUES(?, 1, ?, '* * * * *', 0, 0)",
        [id, nom],
      );
    await t.base.run(
      "INSERT INTO editor_routine_runs(id, routine_id, owner_user_id, started_at) VALUES(9, 3, 1, 0)",
    );
    const arrets: number[][] = [];
    installerPlanificateur({
      demanderArret: (...a: number[]) => void arrets.push(a),
    } as unknown as Planificateur);
    const stop = (uid: string, chatId: string) =>
      app.inject({
        method: "POST",
        url: "/api/chat/cancel",
        headers: { "x-uid": uid, ...JSON_CT },
        payload: JSON.stringify({ chat_id: chatId }),
      });
    try {
      for (const [uid, chatId] of [
        ["2", "routine:3:run:9"],
        ["1", "routine:4:run:9"],
        ["1", "routine:3:run:9:x"],
        ["1", "routine:3:run:9"],
      ] as const)
        expect((await stop(uid, chatId)).json()).toEqual({ status: "cancelled" });
    } finally {
      installerPlanificateur(null);
      await t.base.run("DELETE FROM editor_routine_runs");
      await t.base.run("DELETE FROM editor_routines");
    }
    expect(arrets).toEqual([[1, 3, 9]]);
    expect(isChatCancelled(1, "routine:3:run:9")).toBe(true);
  });

  it("Stop d'un run sur un connecteur retiré : aucun arrêt moteur ailleurs", async () => {
    const j = new RunJournal(1, "c5", "r5", { engine_key: "conn:999" });
    await j.open({});
    const avant = llama.sur("/v1/stream").length;
    await app.inject({
      method: "POST",
      url: "/api/chat/cancel",
      headers: { "x-uid": "1", ...JSON_CT },
      payload: '{"chat_id": "c5"}',
    });
    expect(llama.sur("/v1/stream").length).toBe(avant);
    await j.close();
  });

  it("« Répondre maintenant » : complétion close sur le serveur qui la porte ; désactivé, refusé, non pris en charge", async () => {
    const appel = (uid = 1): Promise<unknown> =>
      app
        .inject({
          method: "POST",
          url: "/api/chat/reasoning-end",
          headers: { "x-uid": String(uid), ...JSON_CT },
          payload: '{"chat_id": "c1"}',
        })
        .then((r) => r.json());
    let succes = true;
    llama.route("POST /v1/chat/completions/control", (_q, rep) => {
      rep.writeHead(200, { "content-type": "application/json" });
      rep.end(JSON.stringify({ success: succes }));
    });
    controleRaisonnementDuProcess.noteCompletion("c1", "cmpl-9", "m", "builtin");
    expect(await appel()).toEqual({ ok: true, reason: "" });
    expect(llama.sur("/v1/chat/completions/control").at(-1)?.json()).toEqual({
      id: "cmpl-9",
      action: "reasoning_end",
      model: "m",
    });
    succes = false;
    expect(await appel()).toEqual({ ok: false, reason: "engine_refused" });
    const coupe = surchargerConfig({ LLAMA_REASONING_CONTROL: false });
    expect(await appel()).toEqual({ ok: false, reason: "disabled" });
    coupe();
    controleRaisonnementDuProcess.noteCompletion("c1", "cmpl-9", "m", "conn:999");
    expect(await appel()).toEqual({ ok: false, reason: "unsupported" });
  });

  it("moteur d'une version trop ancienne (lue) : ni arrêt de session, ni « Répondre maintenant »", async () => {
    const ancien = await fauxLlama({ build: "b9000-abc" });
    const remettre = surchargerConfig({ LLAMA_URL: `${ancien.url}/v1/chat/completions` });
    try {
      await engineCaps();
      await app.inject({
        method: "POST",
        url: "/api/chat/cancel",
        headers: { "x-uid": "1", ...JSON_CT },
        payload: '{"chat_id": "c1"}',
      });
      expect(ancien.sur("/v1/stream")).toEqual([]);
      controleRaisonnementDuProcess.noteCompletion("c1", "cmpl-9", "m", "builtin");
      const r = await app.inject({
        method: "POST",
        url: "/api/chat/reasoning-end",
        headers: { "x-uid": "1", ...JSON_CT },
        payload: '{"chat_id": "c1"}',
      });
      expect(r.json()).toEqual({ ok: false, reason: "unsupported" });
      expect(ancien.sur("/v1/chat/completions/control")).toEqual([]);
    } finally {
      remettre();
      await ancien.arreter();
    }
  });

  it("suivi en direct par HTTP : rejeu, événements écrits après la connexion, fin à run_end", async () => {
    verrousChat.acquire("gen", 1, "c1");
    const j = new RunJournal(1, "c1", "r1");
    await j.open({ chat_id: "c1" });
    j.append({ type: "content_token", text: "Bon" });
    await j.flush();
    setTimeout(() => {
      j.append({ type: "tool_call", id: "t1" });
      void j.close("done");
    }, 300);
    const r = await app.inject({ method: "GET", url: "/api/chat/c1/run/events", headers: { "x-uid": "1" } });
    expect(r.headers["content-type"]).toBe("application/x-ndjson; charset=utf-8");
    expect(
      r.body
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as unknown),
    ).toEqual([
      { chat_id: "c1", type: "run_started", run_id: "r1", _s: 1 },
      { type: "content_token", text: "Bon", _s: 2 },
      { type: "replay_done" },
      { type: "tool_call", id: "t1", _s: 3 },
      { type: "run_end", status: "done", _s: 4 },
    ]);
  });
});
