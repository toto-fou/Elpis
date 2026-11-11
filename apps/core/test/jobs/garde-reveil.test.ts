// SPDX-License-Identifier: MIT
/** apps/core/test/jobs/garde-reveil.test.ts — garde du tour de réveil : sélection d'outils COURANTE de la conversation (jamais réécrite), « Ne pas me réveiller » revérifié au départ d'un réveil en file, « Arrêter » sans réveil jusqu'au prochain tour de l'utilisateur. */
import "../moteur-environnement";

import { dependancesParDefaut } from "@elpis/auth";
import type { Dict } from "@elpis/commun";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getChat, setChatTools } from "../../src/chats/stockage";
import { creerFamilleChatControle } from "../../src/familles/chat-controle";
import { enAttente } from "../../src/jobs/magasin";
import { isGenerationActive } from "../../src/tour/etat";
import { runTurn } from "../../src/tour/execution";
import { ouvrirTour } from "../../src/tour/ouverture";
import { appTest } from "../aides";
import { compteJobsWake, corps, creerBanc, creerChat, ev, lancerJob, reveils, tourActif } from "./aides";
import type { Banc } from "./aides";

let b: Banc;

beforeEach(async () => {
  b = await creerBanc();
  await creerChat(b, 1, "c1", "Projet");
});

afterEach(async () => {
  await b.fermer();
});

const idDuTour = (t: Dict[] | undefined): string =>
  (/id="(j-[0-9a-f]{8})"/u.exec(String(t?.at(-1)?.["content"] ?? "")) ?? [])[1] ?? "";

/** Tour de l'utilisateur mené jusqu'au bout (préparation, boucle simulée, persistance). */
async function tourUtilisateur(chatId: string, texte: string): Promise<void> {
  const chat = await getChat(b.t.base, 1, chatId);
  const messages = [...(chat?.["messages"] as Dict[]), { role: "user", content: texte }];
  const tour = await ouvrirTour({ base: b.t.base }, 1, { chat_id: chatId, messages, resumable: true });
  for await (const e of runTurn(
    { base: b.t.base },
    tour.plan,
    tour.res,
    tour.base,
    new AbortController().signal,
  ))
    void e;
  for (let i = 0; i < 300 && isGenerationActive(1, chatId); i++)
    await new Promise((ok) => setTimeout(ok, 10));
  await b.service.calme();
}

/** Réveil de c1 en cours (retenu), job de c2 fini : c2 attend dans la file du compte ; rend les deux jobs. */
async function c2EnFile(): Promise<[string, string]> {
  await creerChat(b, 1, "c2", "Serveur");
  const j1 = await lancerJob(b, 1, "c1");
  const j2 = await lancerJob(b, 1, "c2");
  b.retenir = true;
  await b.service.recevoir(1, [ev(j1)], 0);
  await b.horloge.avancer(2.5, b.service, false);
  for (let i = 0; i < 200 && b.tours.length < 1; i++) await new Promise((ok) => setTimeout(ok, 10));
  await b.service.recevoir(1, [ev(j2)], 0);
  await b.horloge.avancer(3, b.service, false);
  expect(((await b.service.liste(1, null))["wake_queue"] as Dict[]).map((q) => q["chat_id"])).toEqual(["c2"]);
  return [j1, j2];
}

describe("tour de réveil : sélection d'outils de la conversation", () => {
  it("le réveil part des outils COURANTS (PUT /tools), pas de l'instantané du lancement, et ne réécrit pas la sélection", async () => {
    const fin = tourActif(1, "c1", 0, {
      active_mcp_servers: [
        { command: "DEFAULT_LOCAL_PYTHON", name: "local", filter_categories: ["shell", "git"] },
      ],
      excluded_tools: [],
    });
    const r = await b.service.enregistrer(1, corps("c1"), "local");
    fin();
    const id = String(r["job_id"]);
    await b.service.poserEtat(1, id, "running", 4242, "");
    expect(await setChatTools(b.t.base, 1, "c1", ["shell", "-execute_shell"])).toBe(true);
    await b.service.recevoir(1, [ev(id)], 0);
    await b.horloge.avancer(3, b.service);
    expect(b.tours).toHaveLength(1);
    const outils = b.outilsTours[0]!;
    expect(outils.mcp.map((s) => s["filter_categories"])).toEqual([["shell"]]);
    expect(outils.refuses).toContain("execute_shell");
    const meta = await b.t.base.get<{ meta_json: string }>("SELECT meta_json FROM chats WHERE id='c1'");
    expect((JSON.parse(String(meta?.meta_json)) as Dict)["tools"]).toEqual(["shell", "-execute_shell"]);
  });

  it("conversation sans sélection enregistrée : l'instantané du lancement sert de repli", async () => {
    const id = await lancerJob(b, 1, "c1");
    await b.service.recevoir(1, [ev(id)], 0);
    await b.horloge.avancer(3, b.service);
    expect(b.outilsTours[0]?.mcp).toHaveLength(0);
    expect(b.tours).toHaveLength(1);
  });
});

describe("réveil en file revérifié à son départ", () => {
  it("« Ne pas me réveiller » posé pendant l'attente : c2 retiré de la file, écarté, aucun tour", async () => {
    const [j1] = await c2EnFile();
    expect(await b.service.poserReveil(1, "c2", true)).toBe(true);
    expect((await b.service.liste(1, null))["wake_queue"]).toEqual([]);
    expect(reveils(b, "skipped").at(-1)).toMatchObject({ chat_id: "c2", reason: "wake_disabled" });
    b.retenir = false;
    b.relacher();
    await b.horloge.avancer(5, b.service);
    expect(b.tours.map(idDuTour)).toEqual([j1]);
    expect(await enAttente(b.t.base, 1, "c2")).toHaveLength(1);
  });

  it("défaut du compte `jobs_wake=false` posé pendant l'attente : le réveil de c2 ne part pas", async () => {
    const [j1] = await c2EnFile();
    await compteJobsWake(b, 1, false);
    b.retenir = false;
    b.relacher();
    await b.horloge.avancer(5, b.service);
    expect(b.tours.map(idDuTour)).toEqual([j1]);
    expect(reveils(b, "skipped").at(-1)).toMatchObject({ chat_id: "c2", reason: "wake_disabled" });
    expect(await enAttente(b.t.base, 1, "c2")).toHaveLength(1);
  });
});

describe("« Arrêter » de l'utilisateur", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await appTest({
      familles: [creerFamilleChatControle({ base: b.t.base, auth: dependancesParDefaut(b.t.base) })],
      gardes: {
        session: async (req) => {
          req.utilisateur = { id: Number(req.headers["x-uid"]), username: "alice" };
          Object.assign(req, { session: { get: () => undefined } });
        },
      },
    });
  });

  afterEach(async () => {
    await app.close();
  });

  const arreter = (chatId: string) =>
    app.inject({
      method: "POST",
      url: "/api/chat/cancel",
      headers: { "x-uid": "1", "content-type": "application/json" },
      payload: JSON.stringify({ chat_id: chatId }),
    });

  it("aucun réveil après Stop, même pour un événement arrivé ensuite ; événements joints au message suivant, réveils repris après", async () => {
    const id = await lancerJob(b, 1, "c1");
    const id2 = await lancerJob(b, 1, "c1");
    const fin = tourActif(1, "c1");
    await b.service.recevoir(1, [ev(id)], 0);
    expect((await arreter("c1")).statusCode).toBe(200);
    fin();
    await b.horloge.avancer(5, b.service);
    await b.service.recevoir(1, [ev(id2)], 0);
    await b.horloge.avancer(15, b.service);
    expect(b.tours).toHaveLength(0);
    expect(reveils(b, "queued")).toEqual([]);
    expect(await enAttente(b.t.base, 1, "c1")).toHaveLength(2);
    await tourUtilisateur("c1", "Où en est-on ?");
    expect(b.tours).toHaveLength(1);
    const question = String(b.tours[0]?.at(-1)?.["content"] ?? "");
    expect(question).toContain(id);
    expect(question).toContain(id2);
    expect(await enAttente(b.t.base, 1, "c1")).toHaveLength(0);
    const id3 = await lancerJob(b, 1, "c1");
    await b.service.recevoir(1, [ev(id3)], 0);
    await b.horloge.avancer(3, b.service);
    expect(b.tours.map(idDuTour).at(-1)).toBe(id3);
  });

  it("Stop d'une conversation dont le réveil attend dans la file : retiré, écarté `stopped`", async () => {
    await c2EnFile();
    expect((await arreter("c2")).statusCode).toBe(200);
    expect((await b.service.liste(1, null))["wake_queue"]).toEqual([]);
    expect(reveils(b, "skipped").at(-1)).toMatchObject({ chat_id: "c2", reason: "stopped" });
    b.retenir = false;
    b.relacher();
    await b.horloge.avancer(5, b.service);
    expect(b.tours).toHaveLength(1);
  });
});
