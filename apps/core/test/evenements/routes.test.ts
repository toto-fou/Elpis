// SPDX-License-Identifier: MIT
/** apps/core/test/evenements/routes.test.ts — `/api/system-events` à l'octet près avec de vraies sessions, routes internes de main (accès interne). */
import { getEventListeners } from "node:events";
import { request } from "node:http";
import type { AddressInfo } from "node:net";

import { leverMinSession, revoquerSid } from "@elpis/auth";
import type { DependancesAuth } from "@elpis/auth";
import type { Executeur } from "@elpis/db";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { CycleDeVie } from "../../src/cycle";
import { FileAttente } from "../../src/evenements/file";
import type { ElementSysteme } from "../../src/evenements/systeme";
import { brancherEvenements } from "../../src/evenements/branchement";
import type { Evenements, OptionsMain } from "../../src/evenements/branchement";
import type { RouteMontee } from "../../src/routes";
import { journalMuet } from "../aides";
import {
  ADMIN,
  ALICE,
  appAuthentifiee,
  attendreQue,
  BOB,
  connecter,
  environnementAuth,
  JETON_INTERNE,
  JETON_TOOLHOST,
  ouvrirFlux,
  SOURCE_TEST,
} from "./aides";
import type { EnvAuth, FluxBrut } from "./aides";
import { ENTETES_SECURITE } from "@elpis/http";

interface Banc {
  env: EnvAuth;
  cycle: CycleDeVie;
  evt: Evenements;
  app: FastifyInstance;
  routes: RouteMontee[];
  base: string;
}

const ouverts: FluxBrut[] = [];
const bancs: Banc[] = [];

async function flux(url: string, entetes: Record<string, string> = {}): Promise<FluxBrut> {
  const f = await ouvrirFlux(url, entetes);
  ouverts.push(f);
  return f;
}

type OptionsBanc = Partial<Omit<OptionsMain, "auth">> & { lente?: boolean };

/** Base dont chaque lecture prend 150 ms : la garde et l'identité laissent au client le temps de partir. */
function baseLente(base: Executeur): Executeur {
  return new Proxy(base, {
    get(cible, nom) {
      const valeur: unknown = Reflect.get(cible, nom);
      if (nom === "get" && typeof valeur === "function") {
        return async (...args: unknown[]) => {
          await new Promise((suite) => setTimeout(suite, 150));
          return (valeur as (...a: unknown[]) => unknown).apply(cible, args);
        };
      }
      return typeof valeur === "function" ? (valeur as (...a: unknown[]) => unknown).bind(cible) : valeur;
    },
  });
}

async function banc(options: OptionsBanc = {}, mode: "main" | "admin" = "main"): Promise<Banc> {
  const env = await environnementAuth();
  const { lente, ...reste } = options;
  const auth: DependancesAuth = lente ? { ...env.dep, base: baseLente(env.dep.base) } : env.dep;
  const cycle = new CycleDeVie(journalMuet);
  const evt =
    mode === "main"
      ? brancherEvenements({
          mode: "main",
          cycle,
          auth,
          redemarrage: SOURCE_TEST,
          journal: journalMuet,
          pingMs: 60_000,
          ...reste,
        })
      : brancherEvenements({
          mode: "admin",
          cycle,
          auth,
          journal: journalMuet,
          pingMs: 60_000,
          canal: { url: "http://127.0.0.1:1" },
        });
  const { app, routes } = await appAuthentifiee(mode, evt.famille, auth);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const b = {
    env,
    cycle,
    evt,
    app,
    routes,
    base: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`,
  };
  bancs.push(b);
  return b;
}

async function fermerBanc(b: Banc): Promise<void> {
  bancs.splice(bancs.indexOf(b), 1);
  b.cycle.annoncerArret();
  await b.app.close();
  await b.env.t.fermer();
}

afterEach(async () => {
  for (const f of ouverts.splice(0)) f.fermer();
  for (const b of [...bancs]) await fermerBanc(b);
});

async function session(b: Banc, uid: number): Promise<Record<string, string>> {
  return { cookie: (await connecter(b.base, uid)).cookie };
}

describe("/api/system-events avec de vraies sessions", () => {
  it("en-têtes d'EventSourceResponse, réécriture de la session et trames identiques à l'octet à sse-starlette", async () => {
    const b = await banc();
    b.env.config = { security: { session: { idle_timeout_sec: 600 } } };
    const f = await flux(`${b.base}/api/system-events`, await session(b, ALICE));
    expect(f.statut).toBe(200);
    expect(f.entetes["content-type"]).toBe("text/event-stream; charset=utf-8");
    expect(f.entetes["cache-control"]).toBe("no-store");
    expect(f.entetes["connection"]).toBe("keep-alive");
    expect(f.entetes["x-accel-buffering"]).toBe("no");
    expect(f.entetes["transfer-encoding"]).toBe("chunked");
    expect(String(f.entetes["set-cookie"])).toMatch(/^mcpwebui_session=/u);
    for (const [nom, valeur] of ENTETES_SECURITE) expect(f.entetes[nom], nom).toBe(valeur);
    await attendreQue(() => b.evt.systemEvents.nombreClients === 1);
    b.evt.systemEvents.broadcast({ type: "model_status", data: { é: "x\ny", n: 1.5, l: [1, null, true] } });
    const titre = String.fromCodePoint(0x1f600) + " " + String.fromCharCode(0x2028);
    b.evt.systemEvents.broadcast({ type: "notification", data: { user_id: ALICE, title: titre } });
    b.evt.systemEvents.broadcast({ type: "notification", data: { user_id: BOB, title: "pas pour alice" } });
    b.evt.systemEvents.disconnectUser(ALICE, { type: "session_expired" });
    await f.fini;
    expect(f.texte()).toBe(
      'data: {"type": "model_status", "data": {"\\u00e9": "x\\ny", "n": 1.5, "l": [1, null, true]}}\r\n\r\n' +
        'data: {"type": "notification", "data": {"user_id": 1, "title": "\\ud83d\\ude00 \\u2028"}}\r\n\r\n' +
        'data: {"type": "session_expired"}\r\n\r\n',
    );
    expect(b.evt.systemEvents.nombreClients).toBe(0);
  });

  it("ping horodaté toutes les 15 s (ici raccourci), même quand des données passent", async () => {
    const b = await banc({ pingMs: 40 });
    const f = await flux(`${b.base}/api/system-events`, await session(b, ALICE));
    await f.attendreTexte(/: ping - \d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d{6})?\+00:00\r\n\r\n/u);
    b.evt.systemEvents.broadcast({ type: "restart" });
    await f.attendreTexte('data: {"type": "restart"}\r\n\r\n');
    expect(f.texte()).toMatch(/^(: ping - [^\r\n]+\r\n\r\n|data: [^\r\n]+\r\n\r\n)+$/u);
  });

  it("sans session ou cookie forgé : 401 au format detail, aucun abonné ; staff lu en base ; client parti : abonné retiré", async () => {
    const b = await banc();
    const essais: Record<string, string>[] = [{}, { cookie: "mcpwebui_session=eyJ1c2VyX2lkIjogM30.faux" }];
    for (const entetes of essais) {
      const refuse = await flux(`${b.base}/api/system-events`, entetes);
      await refuse.fini;
      expect(refuse.statut).toBe(401);
      expect(JSON.parse(refuse.texte())).toEqual({ detail: "not logged in" });
    }
    expect(b.evt.systemEvents.nombreClients).toBe(0);
    const alice = await flux(`${b.base}/api/system-events?logs=1`, await session(b, ALICE));
    await attendreQue(() => b.evt.systemEvents.nombreClients === 1);
    expect(b.evt.systemEvents.aUnAbonneJournal).toBe(false);
    const adminChat = await flux(`${b.base}/api/system-events`, await session(b, ADMIN));
    await attendreQue(() => b.evt.systemEvents.nombreClients === 2);
    expect(b.evt.systemEvents.aUnAbonneJournal).toBe(false);
    const admin = await flux(`${b.base}/api/system-events?logs=1`, await session(b, ADMIN));
    await attendreQue(() => b.evt.systemEvents.nombreClients === 3);
    expect(b.evt.systemEvents.aUnAbonneJournal).toBe(true);
    b.evt.systemEvents.fanout({ type: "log", message: "m", level: "INFO" });
    await admin.attendreTexte('data: {"type": "log", "message": "m", "level": "INFO"}\r\n\r\n');
    expect([alice.texte(), adminChat.texte()]).toEqual(["", ""]);
    admin.fermer();
    adminChat.fermer();
    alice.fermer();
    await attendreQue(
      () => b.evt.systemEvents.nombreClients === 0,
      2_000,
      "désinscription des clients partis",
    );
  });

  it("révocation du _sid, révocation du compte, staff rétrogradé : session_expired puis fin (revaliderFlux)", async () => {
    const b = await banc({ attenteMs: 20, revalidationMs: 30 });
    const alice = await connecter(b.base, ALICE);
    const bob = await connecter(b.base, BOB);
    const fAlice = await flux(`${b.base}/api/system-events`, { cookie: alice.cookie });
    const fBob = await flux(`${b.base}/api/system-events`, { cookie: bob.cookie });
    const fAdmin = await flux(`${b.base}/api/system-events`, await session(b, ADMIN));
    await attendreQue(() => b.evt.systemEvents.nombreClients === 3);
    await new Promise((suite) => setTimeout(suite, 120));
    expect(b.evt.systemEvents.nombreClients).toBe(3);
    await revoquerSid(b.env.t.base, alice.sid, ALICE, Date.now() / 1000);
    await fAlice.fini;
    expect(fAlice.texte()).toBe('data: {"type": "session_expired"}\r\n\r\n');
    await leverMinSession(b.env.t.base, BOB, Date.now() / 1000 + 5);
    await fBob.fini;
    expect(fBob.texte()).toBe('data: {"type": "session_expired"}\r\n\r\n');
    await b.env.t.base.run("UPDATE users SET is_admin=0 WHERE id=?", [ADMIN]);
    await fAdmin.fini;
    expect(fAdmin.texte()).toBe('data: {"type": "session_expired"}\r\n\r\n');
    expect(b.evt.systemEvents.nombreClients).toBe(0);
  });

  it("arrêt gracieux : worker_recycling puis fin du flux ; un flux ouvert pendant l'arrêt est évacué aussitôt", async () => {
    const b = await banc();
    const entetes = await session(b, ALICE);
    const f = await flux(`${b.base}/api/system-events`, entetes);
    await attendreQue(() => b.evt.systemEvents.nombreClients === 1);
    b.cycle.annoncerArret();
    await f.fini;
    expect(f.texte()).toBe('data: {"type": "worker_recycling"}\r\n\r\n');
    const tardif = await flux(`${b.base}/api/system-events`, entetes);
    await tardif.fini;
    expect(tardif.texte()).toBe('data: {"type": "worker_recycling"}\r\n\r\n');
    expect(b.evt.systemEvents.nombreClients).toBe(0);
  });

  it("monté aussi dans l'admin, sans les routes internes de main", async () => {
    const b = await banc({}, "admin");
    expect(b.routes.map((r) => `${r.methodes.join(",")} ${r.chemin} ${r.acces}`)).toEqual([
      "GET /api/system-events session",
    ]);
    const f = await flux(`${b.base}/api/system-events`, await session(b, ADMIN));
    await attendreQue(() => b.evt.systemEvents.nombreClients === 1);
    b.evt.systemEvents.broadcast({ type: "restart", message: "m" });
    await f.attendreTexte('data: {"type": "restart", "message": "m"}\r\n\r\n');
    const interne = await b.app.inject({
      method: "GET",
      url: "/api/internal/status",
      headers: { authorization: `Bearer ${JETON_INTERNE}` },
    });
    expect(interne.statusCode).toBe(404);
  });
});

describe("journal en direct : plafonds d'abonnés", () => {
  const REFUS = 'data: {"type": "log_unavailable"}\r\n\r\n';

  it("au-delà de 2 flux journal par compte : le plus ancien reçoit log_replaced puis se ferme, le nouveau est servi ; un flux ordinaire reste accepté", async () => {
    const b = await banc();
    const entetes = await session(b, ADMIN);
    const url = `${b.base}/api/system-events?logs=1`;
    const premier = await flux(url, entetes);
    await attendreQue(() => b.evt.systemEvents.nombreAbonnesJournal === 1);
    await flux(url, entetes);
    await attendreQue(() => b.evt.systemEvents.nombreAbonnesJournal === 2);
    const troisieme = await flux(url, entetes);
    await premier.fini;
    expect(premier.texte()).toBe('data: {"type": "log_replaced"}\r\n\r\n');
    await attendreQue(() => b.evt.systemEvents.nombreAbonnesJournal === 2);
    expect(troisieme.texte()).not.toContain("log_unavailable");
    await flux(`${b.base}/api/system-events`, entetes);
    await attendreQue(() => b.evt.systemEvents.nombreClients === 3);
  });

  it("plafond de 5 abonnés par process : le suivant est refusé explicitement", async () => {
    const b = await banc();
    for (let i = 0; i < 5; i++)
      b.evt.systemEvents.clients.set(new FileAttente<ElementSysteme>(), {
        staff: true,
        uid: 100 + i,
        journal: true,
      });
    const refuse = await flux(`${b.base}/api/system-events?logs=1`, await session(b, ADMIN));
    await refuse.fini;
    expect(refuse.texte()).toBe(REFUS);
    expect(b.evt.systemEvents.nombreAbonnesJournal).toBe(5);
  });
});

function trames(texte: string): Record<string, unknown>[] {
  const completes = texte.split("\r\n\r\n").slice(0, -1);
  return completes
    .filter((t) => t.startsWith("data: "))
    .map((t) => JSON.parse(t.slice(6)) as Record<string, unknown>);
}

describe("robustesse du flux : départ précoce, contre-pression, arrêt", () => {
  it("client parti pendant la garde et l'identité : aucun abonné ne reste, l'app se ferme", async () => {
    const b = await banc({ lente: true });
    const { cookie } = await connecter(b.base, ADMIN);
    const ecouteurs = getEventListeners(b.cycle.signalArret, "abort").length;
    const debutRequete = Date.now();
    const req = request(`${b.base}/api/system-events`, { headers: { cookie } });
    req.on("error", () => undefined);
    req.end();
    setTimeout(() => req.destroy(), 30);
    await new Promise((suite) => setTimeout(suite, 700));
    expect(Date.now() - debutRequete).toBeGreaterThanOrEqual(600);
    expect(b.evt.systemEvents.nombreClients).toBe(0);
    expect(b.evt.systemEvents.aUnAbonneJournal).toBe(false);
    expect(getEventListeners(b.cycle.signalArret, "abort")).toHaveLength(ecouteurs);
    const debut = Date.now();
    await fermerBanc(b);
    expect(Date.now() - debut).toBeLessThan(2_000);
  });

  it.each([
    ["/api/system-events", "session"],
    ["/api/internal/events", "interne"],
  ])("client parti (%s) : plus aucun écouteur sur le signal d'arrêt du process", async (chemin, acces) => {
    const b = await banc();
    const ecouteurs = getEventListeners(b.cycle.signalArret, "abort").length;
    const entetes =
      acces === "session" ? await session(b, ALICE) : { authorization: `Bearer ${JETON_INTERNE}` };
    const f = await flux(`${b.base}${chemin}`, entetes);
    expect(f.statut).toBe(200);
    await attendreQue(() => getEventListeners(b.cycle.signalArret, "abort").length > ecouteurs);
    f.fermer();
    await attendreQue(
      () => getEventListeners(b.cycle.signalArret, "abort").length === ecouteurs,
      2_000,
      "écouteurs retirés",
    );
    expect(b.evt.systemEvents.nombreClients).toBe(0);
  });

  it("contre-pression : un client lent retient le flux sans rien perdre, puis tout arrive dans l'ordre", async () => {
    const b = await banc();
    const f = await flux(`${b.base}/api/system-events`, await session(b, ALICE));
    await attendreQue(() => b.evt.systemEvents.nombreClients === 1);
    f.suspendre();
    const charge = "a".repeat(100_000);
    for (let n = 0; n < 120; n++) b.evt.systemEvents.broadcast({ type: "restart", n, charge });
    const file = [...b.evt.systemEvents.clients.keys()][0];
    await new Promise((suite) => setTimeout(suite, 300));
    expect(file?.taille ?? 0).toBeGreaterThan(0);
    f.reprendre();
    await attendreQue(() => trames(f.texte()).length === 120, 10_000, "les 120 trames");
    expect(trames(f.texte()).map((t) => t["n"])).toEqual(Array.from({ length: 120 }, (_, i) => i));
    expect(file?.taille).toBe(0);
  });

  it.each([
    ["/api/system-events", "session"],
    ["/api/internal/events", "interne"],
  ])(
    "client qui ne lit plus (%s) : l'arrêt le coupe après la grâce, app.close() se termine",
    async (chemin, acces) => {
      const b = await banc({ graceArretMs: 150 });
      const entetes =
        acces === "session" ? await session(b, ALICE) : { authorization: `Bearer ${JETON_INTERNE}` };
      const f = await flux(`${b.base}${chemin}`, entetes);
      await attendreQue(() => b.evt.systemEvents.nombreClients === 1 || (b.evt.canal?.attentes ?? 0) === 1);
      f.suspendre();
      const charge = "b".repeat(100_000);
      for (let n = 0; n < 120; n++) b.evt.systemEvents.broadcast({ type: "restart", n, charge });
      await new Promise((suite) => setTimeout(suite, 200));
      const debut = Date.now();
      await fermerBanc(b);
      expect(Date.now() - debut).toBeLessThan(3_000);
      expect(b.evt.systemEvents.nombreClients).toBe(0);
      f.reprendre();
      await f.fini;
    },
  );
});

describe("routes internes de main : accès interne (boucle locale et jeton interne)", () => {
  it("montées avec l'accès « interne » ; jeton du toolhost, absent ou faux : 401 ; hors boucle locale : 403", async () => {
    const b = await banc();
    expect(b.routes.map((r) => `${r.methodes.join(",")} ${r.chemin} ${r.acces}`)).toEqual([
      "GET /api/system-events session",
      "GET /api/internal/events interne",
      "POST /api/internal/events interne",
      "GET /api/internal/status interne",
    ]);
    for (const authorization of [undefined, `Bearer ${JETON_TOOLHOST}`, "Bearer faux"]) {
      for (const [methode, url] of [
        ["GET", "/api/internal/status"],
        ["GET", "/api/internal/events"],
        ["POST", "/api/internal/events"],
      ] as const) {
        const r = await b.app.inject({
          method: methode,
          url,
          headers: authorization ? { authorization } : {},
          ...(methode === "POST" ? { payload: '{"type": "restart"}' } : {}),
        });
        expect([r.statusCode, r.json(), r.headers["www-authenticate"]], `${methode} ${url}`).toEqual([
          401,
          { detail: "jeton interne requis" },
          "Bearer",
        ]);
      }
    }
    const ailleurs = await b.app.inject({
      method: "GET",
      url: "/api/internal/status",
      remoteAddress: "10.0.0.7",
      headers: { authorization: `Bearer ${JETON_INTERNE}` },
    });
    expect([ailleurs.statusCode, ailleurs.json()]).toEqual([
      403,
      { detail: "Endpoint restricted to loopback" },
    ]);
    const relaye = await flux(`${b.base}/api/internal/events`, {
      authorization: `Bearer ${JETON_INTERNE}`,
      "x-forwarded-for": "10.0.0.7",
    });
    await relaye.fini;
    expect(relaye.statut).toBe(403);
    const direct = await flux(`${b.base}/api/internal/events`, { authorization: `Bearer ${JETON_INTERNE}` });
    expect(direct.statut).toBe(200);
  });

  it("GET /api/internal/status : l'ancien restart_pending, sans valeur de configuration", async () => {
    let courant: Record<string, unknown> = { llama: { ip: "10.0.0.5" } };
    const b = await banc({ redemarrage: { ...SOURCE_TEST, vueCourante: () => courant } });
    b.evt.empreinte?.enregistrer();
    const auth = { authorization: `Bearer ${JETON_INTERNE}` };
    const r = await b.app.inject({ method: "GET", url: "/api/internal/status", headers: auth });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      generation: b.evt.canal?.generation,
      mode: "main",
      pid: process.pid,
      pending: [],
    });
    expect(r.body).not.toContain("10.0.0.5");
    courant = { llama: { ip: "10.0.0.9" } };
    expect(
      (await b.app.inject({ method: "GET", url: "/api/internal/status", headers: auth })).json(),
    ).toMatchObject({ pending: ["llama.ip"] });
  });

  it("POST /api/internal/events : contrôle appliqué, diffusion locale sans écho vers le canal, refus motivés", async () => {
    const rafraichis: string[] = [];
    const b = await banc({ rafraichirModeles: () => rafraichis.push("x") });
    const auth = { authorization: `Bearer ${JETON_INTERNE}`, "content-type": "application/json" };
    const poster = (payload: string) =>
      b.app.inject({ method: "POST", url: "/api/internal/events", headers: auth, payload });
    expect((await poster("{pas du json")).statusCode).toBe(400);
    expect((await poster("{}")).json()).toEqual({ detail: "Événement invalide : champ « type » requis." });
    expect((await poster("[1]")).statusCode).toBe(400);
    expect((await poster('{"type": "log", "message": "x"}')).statusCode).toBe(400);
    for (const type of ["session_expired", "app_restarting", "model_status", "worker_recycling"]) {
      const refus = await poster(`{"type": "${type}", "force_logout": true, "data": {"user_id": 1}}`);
      expect(refus.json(), type).toEqual({ detail: `Type d'événement refusé sur ce canal : ${type}` });
    }
    const un = await flux(`${b.base}/api/system-events`, await session(b, ALICE));
    const deux = await flux(`${b.base}/api/system-events`, await session(b, BOB));
    await attendreQue(() => b.evt.systemEvents.nombreClients === 2);
    const seq = b.evt.canal?.dernierSeq;
    const banniere = await poster('{"type": "restart", "message": "Le serveur redémarre"}');
    expect(banniere.json()).toEqual({ ok: true });
    await un.attendreTexte('data: {"type": "restart", "message": "Le serveur red\\u00e9marre"}\r\n\r\n');
    expect(b.evt.canal?.dernierSeq).toBe(seq);
    expect((await poster('{"type": "model_cache_refresh"}')).json()).toEqual({ ok: true });
    expect(rafraichis).toEqual(["x"]);
    expect((await poster(`{"type": "session_revoked", "uid": "${ALICE}"}`)).json()).toEqual({ ok: true });
    await un.fini;
    expect(un.texte()).toMatch(/data: \{"type": "session_expired"\}\r\n\r\n$/u);
    expect(b.evt.systemEvents.nombreClients).toBe(1);
    expect(deux.texte()).not.toContain("session_expired");
    expect((await poster('{"type": "session_revoked", "uid": [1]}')).json()).toEqual({ ok: true });
    expect(b.evt.systemEvents.nombreClients).toBe(1);
  });

  it("POST /api/internal/events : notification de l'admin poussée aux seuls flux de son destinataire, sans écho ; forme vérifiée", async () => {
    const b = await banc();
    const auth = { authorization: `Bearer ${JETON_INTERNE}`, "content-type": "application/json" };
    const poster = (payload: unknown) =>
      b.app.inject({
        method: "POST",
        url: "/api/internal/events",
        headers: auth,
        payload: JSON.stringify(payload),
      });
    const donnees = {
      user_id: ALICE,
      id: 27,
      kind: "daily_report",
      title: "Rapport quotidien",
      body: "Résumé",
      ref_type: "",
      ref_id: null,
      unread: 3,
    };
    const alice = await flux(`${b.base}/api/system-events`, await session(b, ALICE));
    const alice2 = await flux(`${b.base}/api/system-events`, await session(b, ALICE));
    const bob = await flux(`${b.base}/api/system-events`, await session(b, BOB));
    const admin = await flux(`${b.base}/api/system-events`, await session(b, ADMIN));
    await attendreQue(() => b.evt.systemEvents.nombreClients === 4);
    const seq = b.evt.canal?.dernierSeq;
    const mauvaises: unknown[] = [
      { type: "notification" },
      { type: "notification", data: [] },
      { type: "notification", data: { ...donnees, user_id: String(ALICE) } },
      { type: "notification", data: { ...donnees, user_id: 0 } },
      { type: "notification", data: { ...donnees, user_id: 1.5 } },
      { type: "notification", data: { ...donnees, user_id: undefined } },
      { type: "notification", data: { ...donnees, title: 7 } },
      { type: "notification", data: { ...donnees, unread: -1 } },
      { type: "notification", data: { ...donnees, ref_id: [1] } },
      { type: "notification", data: { ...donnees, title: "x".repeat(301) } },
      { type: "notification", data: { ...donnees, body: "x".repeat(281) } },
      { type: "notification", data: { ...donnees, html: "<b>" } },
      { type: "notification", data: donnees, force_logout: true },
    ];
    for (const m of mauvaises) {
      const r = await poster(m);
      expect([r.statusCode, r.json()], JSON.stringify(m)).toEqual([
        400,
        { detail: "Événement invalide : notification mal formée." },
      ]);
    }
    expect((await poster({ type: "notification", data: donnees })).json()).toEqual({ ok: true });
    const attendu =
      'data: {"type": "notification", "data": {"user_id": 1, "id": 27, "kind": "daily_report", ' +
      '"title": "Rapport quotidien", "body": "R\\u00e9sum\\u00e9", "ref_type": "", "ref_id": null, "unread": 3}}\r\n\r\n';
    await alice.attendreTexte(attendu);
    await alice2.attendreTexte(attendu);
    expect(
      (await poster({ type: "notification", data: { ...donnees, user_id: BOB, ref_id: "r-1" } })).json(),
    ).toEqual({
      ok: true,
    });
    await bob.attendreTexte('"ref_id": "r-1"');
    expect([bob.texte(), admin.texte()].map((t) => t.includes('"user_id": 1,'))).toEqual([false, false]);
    expect(admin.texte()).not.toContain("notification");
    expect(alice.texte()).not.toContain('"user_id": 2');
    expect(b.evt.canal?.dernierSeq).toBe(seq);
  });
});
