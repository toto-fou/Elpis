// SPDX-License-Identifier: MIT
/** apps/core/test/evenements/canal.test.ts — canal interne main → admin : tampon, reprise, format, jeton interne, et bout en bout avec de vraies sessions. */
import type { AddressInfo } from "node:net";

import { jetonInterne } from "@elpis/securite";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { CycleDeVie } from "../../src/cycle";
import { brancherEvenements } from "../../src/evenements/branchement";
import type { Evenements } from "../../src/evenements/branchement";
import { CanalInterne, delaiReconnexion, lireStatutMain, publierVersMain } from "../../src/evenements/canal";
import { AnalyseurSse } from "../../src/evenements/sse";
import { Journal } from "../../src/journal";
import { journalMuet } from "../aides";
import {
  ALICE,
  appAuthentifiee,
  attendreQue,
  BOB,
  connecter,
  environnementAuth,
  JETON_INTERNE,
  JETON_TOOLHOST,
  Mandataire,
  ouvrirFlux,
  SECRET,
  SOURCE_TEST,
} from "./aides";
import type { EnvAuth, FluxBrut } from "./aides";

interface Process {
  cycle: CycleDeVie;
  evt: Evenements;
  app: FastifyInstance;
  port: number;
  arreter(): Promise<void>;
}

const nettoyages: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const n of nettoyages.splice(0).reverse()) await n();
});

/** Base et secret de session communs à main et à l'admin, comme en production. */
async function nouvelEnv(): Promise<EnvAuth> {
  const env = await environnementAuth();
  nettoyages.push(() => env.t.fermer());
  return env;
}

async function lancer(
  env: EnvAuth,
  evt: Evenements,
  cycle: CycleDeVie,
  mode: "main" | "admin",
  journal: Journal,
): Promise<Process> {
  const { app } = await appAuthentifiee(mode, evt.famille, env.dep, journal);
  await app.listen({ port: 0, host: "127.0.0.1" });
  await cycle.demarrer(mode);
  let arrete = false;
  const p: Process = {
    cycle,
    evt,
    app,
    port: (app.server.address() as AddressInfo).port,
    arreter: async () => {
      if (arrete) return;
      arrete = true;
      await cycle.executerArrets(2_000, 2_000);
      await app.close();
    },
  };
  nettoyages.push(() => p.arreter());
  return p;
}

function main(
  env: EnvAuth,
  options: { pingCanalMs?: number; capaciteCanal?: number; journal?: Journal } = {},
): Promise<Process> {
  const cycle = new CycleDeVie(journalMuet);
  const journal = options.journal ?? journalMuet;
  const evt = brancherEvenements({
    mode: "main",
    cycle,
    auth: env.dep,
    redemarrage: SOURCE_TEST,
    journal,
    pingMs: 60_000,
    pingCanalMs: options.pingCanalMs ?? 200,
    capaciteCanal: options.capaciteCanal,
  });
  return lancer(env, evt, cycle, "main", journal);
}

function admin(
  env: EnvAuth,
  urlMain: string,
  options: { journal?: Journal; secret?: string; seuilAlerteMs?: number } = {},
): Promise<Process> {
  const cycle = new CycleDeVie(journalMuet);
  const journal = options.journal ?? journalMuet;
  const secret = options.secret;
  const auth = secret === undefined ? env.dep : { ...env.dep, secret: () => secret };
  const evt = brancherEvenements({
    mode: "admin",
    cycle,
    auth,
    journal,
    pingMs: 60_000,
    canal: {
      url: urlMain,
      delaiInitialMs: 20,
      delaiMaxMs: 100,
      inactiviteMs: 1_000,
      seuilAlerteMs: options.seuilAlerteMs,
    },
  });
  return lancer(env, evt, cycle, "admin", journal);
}

function journalCapte(lignes: string[]): Journal {
  return new Journal({ niveau: "debug", sortie: (l) => lignes.push(l) });
}

function niveau(lignes: string[], nom: "ERROR" | "WARNING" | "INFO"): string[] {
  return lignes.filter((l) => l.includes(` ${nom} `));
}

async function session(port: number, uid: number): Promise<Record<string, string>> {
  return { cookie: (await connecter(`http://127.0.0.1:${port}`, uid)).cookie };
}

async function flux(port: number, chemin: string, entetes: Record<string, string>): Promise<FluxBrut> {
  const f = await ouvrirFlux(`http://127.0.0.1:${port}${chemin}`, entetes);
  nettoyages.push(() => f.fermer());
  return f;
}

async function mandataire(cible: number): Promise<Mandataire> {
  const m = new Mandataire(cible);
  await m.ouvrir();
  nettoyages.push(() => m.couper());
  return m;
}

function notification(uid: number, n: number): Record<string, unknown> {
  return { type: "notification", data: { user_id: uid, n, titre: "été" } };
}

function trameNotification(uid: number, n: number): string {
  return `data: {"type": "notification", "data": {"user_id": ${uid}, "n": ${n}, "titre": "\\u00e9t\\u00e9"}}\r\n\r\n`;
}

describe("CanalInterne (tampon circulaire et Last-Event-ID)", () => {
  it("reprise exacte, autre génération, identifiant illisible, trop ancien ou futur", () => {
    const canal = new CanalInterne({ capacite: 3, generation: "abc" });
    for (let i = 1; i <= 5; i++) canal.publier(`{"n": ${i}}`);
    expect(canal.reprise(undefined)).toEqual({ curseur: 5, perte: false });
    expect(canal.reprise("")).toEqual({ curseur: 5, perte: false });
    expect(canal.reprise("abc-4")).toEqual({ curseur: 4, perte: false });
    expect(canal.reprise("abc-2")).toEqual({ curseur: 2, perte: false });
    expect(canal.reprise("abc-1")).toEqual({ curseur: 2, perte: true });
    expect(canal.reprise("abc-9")).toEqual({ curseur: 5, perte: true });
    expect(canal.reprise("def-4")).toEqual({ curseur: 2, perte: true });
    expect(canal.reprise("n'importe quoi")).toEqual({ curseur: 2, perte: true });
    expect(canal.lire(2).entrees.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(canal.lire(0)).toMatchObject({ perte: true });
    expect(canal.lire(5).entrees).toEqual([]);
    expect(canal.id(7)).toBe("abc-7");
  });

  it("attendre : réveil à la publication, échéance, abandon ; aucun réveil oublié", async () => {
    const canal = new CanalInterne();
    const abandon = new AbortController();
    const debut = Date.now();
    await canal.attendre(0, 30, abandon.signal);
    expect(Date.now() - debut).toBeGreaterThanOrEqual(25);
    const attente = canal.attendre(0, 10_000, abandon.signal);
    expect(canal.attentes).toBe(1);
    canal.publier("{}");
    await attente;
    expect(canal.attentes).toBe(0);
    const coupee = canal.attendre(1, 10_000, abandon.signal);
    abandon.abort();
    await coupee;
    expect(canal.attentes).toBe(0);
  });

  it("attente croissante bornée", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 50].map((t) => delaiReconnexion(t, 1_000, 30_000))).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
    ]);
  });
});

describe("AnalyseurSse", () => {
  it("CRLF, CR ou LF, morceaux coupés n'importe où, commentaires, id validé à la ligne vide", () => {
    const a = new AnalyseurSse();
    const texte =
      ': ping\r\n\r\nid: g-1\r\ndata: {"a": 1}\r\n\r\nid: g-2\revent: perte\rdata: {}\r\rdata: l1\ndata: l2\n\nretry: 1500\n\n';
    const evenements = [];
    for (const morceau of texte.match(/[\s\S]{1,3}/gu) ?? []) evenements.push(...a.pousser(morceau));
    expect(evenements).toEqual([
      { type: "message", donnees: '{"a": 1}', id: "g-1" },
      { type: "perte", donnees: "{}", id: "g-2" },
      { type: "message", donnees: "l1\nl2", id: "g-2" },
    ]);
    expect(a.retry).toBe(1500);
    const coupe = new AnalyseurSse();
    expect(coupe.pousser("id: g-9\r\ndata: x")).toEqual([]);
    expect(coupe.dernierId).toBe("");
  });
});

describe("GET /api/internal/events (main)", () => {
  it("format à l'octet : id, data, perte ; rejeu depuis Last-Event-ID ; jeton interne exigé, celui du toolhost refusé", async () => {
    const m = await main(await nouvelEnv());
    const canal = m.evt.canal as CanalInterne;
    const g = canal.generation;
    const essais: Record<string, string>[] = [{}, { authorization: `Bearer ${JETON_TOOLHOST}` }];
    for (const entetes of essais) {
      const refuse = await flux(m.port, "/api/internal/events", entetes);
      await refuse.fini;
      expect(refuse.statut).toBe(401);
    }
    const auth = { authorization: `Bearer ${JETON_INTERNE}` };
    const direct = await flux(m.port, "/api/internal/events", auth);
    expect(direct.entetes["content-type"]).toBe("text/event-stream; charset=utf-8");
    await attendreQue(() => canal.attentes === 1);
    m.evt.systemEvents.broadcast(notification(1, 1));
    m.evt.systemEvents.broadcast({ type: "log", message: "jamais sur le canal" });
    m.evt.systemEvents.broadcast({ type: "model_status", data: { kv: 0.5 } });
    const attendu1 = `id: ${g}-1\r\ndata: {"type": "notification", "data": {"user_id": 1, "n": 1, "titre": "\\u00e9t\\u00e9"}}\r\n\r\n`;
    const attendu2 = `id: ${g}-2\r\ndata: {"type": "model_status", "data": {"kv": 0.5}}\r\n\r\n`;
    await direct.attendreTexte(attendu2);
    expect(direct.texte()).toBe(`id: ${g}-0\r\n\r\n` + attendu1 + attendu2);
    const reprise = await flux(m.port, "/api/internal/events", { ...auth, "last-event-id": `${g}-1` });
    await reprise.attendreTexte(attendu2);
    expect(reprise.texte()).toBe(`id: ${g}-1\r\n\r\n` + attendu2);
    const ailleurs = await flux(m.port, "/api/internal/events", { ...auth, "last-event-id": "0123-9" });
    await ailleurs.attendreTexte(attendu2);
    expect(ailleurs.texte()).toBe(`id: ${g}-0\r\nevent: perte\r\ndata: {}\r\n\r\n` + attendu1 + attendu2);
  });

  it("ping après un silence seulement ; le flux se ferme à l'arrêt de main", async () => {
    const m = await main(await nouvelEnv(), { pingCanalMs: 1_000 });
    const f = await flux(m.port, "/api/internal/events", { authorization: `Bearer ${JETON_INTERNE}` });
    await attendreQue(() => (m.evt.canal as CanalInterne).attentes === 1);
    for (let i = 0; i < 10; i++) {
      m.evt.systemEvents.broadcast({ type: "restart", n: i });
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(f.texte()).not.toContain(": ping");
    await f.attendreTexte(": ping\r\n\r\n", 4_000);
    m.cycle.annoncerArret();
    await f.fini;
  });

  it("un abonné trop lent pour le tampon reçoit une perte puis la suite", async () => {
    const m = await main(await nouvelEnv(), { capaciteCanal: 2 });
    const canal = m.evt.canal as CanalInterne;
    for (let i = 1; i <= 4; i++) m.evt.systemEvents.broadcast({ type: "restart", n: i });
    const f = await flux(m.port, "/api/internal/events", {
      authorization: `Bearer ${JETON_INTERNE}`,
      "last-event-id": `${canal.generation}-1`,
    });
    await f.attendreTexte('"n": 4');
    expect(f.texte()).toBe(
      `id: ${canal.generation}-2\r\nevent: perte\r\ndata: {}\r\n\r\n` +
        `id: ${canal.generation}-3\r\ndata: {"type": "restart", "n": 3}\r\n\r\n` +
        `id: ${canal.generation}-4\r\ndata: {"type": "restart", "n": 4}\r\n\r\n`,
    );
  });
});

describe("bout en bout : main et admin, deux apps Fastify", () => {
  it("republication, puis reprise sans perte après une coupure courte et après un gel du réseau", async () => {
    const env = await nouvelEnv();
    const m = await main(env);
    const relais = await mandataire(m.port);
    const a = await admin(env, `http://127.0.0.1:${relais.port}`);
    const abonnement = a.evt.abonnement;
    if (abonnement === undefined) throw new Error("abonnement absent");
    await attendreQue(() => abonnement.connecte, 5_000, "abonnement de l'admin");
    const console1 = await flux(a.port, "/api/system-events", await session(a.port, ALICE));
    await attendreQue(() => a.evt.systemEvents.nombreClients === 1);

    m.evt.systemEvents.broadcast(notification(ALICE, 0));
    m.evt.systemEvents.broadcast(notification(BOB, 99));
    m.evt.systemEvents.broadcast({ type: "log", message: "par le journal, pas par le canal" });
    m.evt.systemEvents.broadcast({ type: "inconnu" });
    m.evt.systemEvents.broadcast({ type: "restart", message: "local" }, { relais: false });
    m.evt.systemEvents.broadcast({ type: "model_status", data: { models: ["q"] } });
    await console1.attendreTexte("model_status");
    expect(console1.texte()).toBe(
      trameNotification(1, 0) + 'data: {"type": "model_status", "data": {"models": ["q"]}}\r\n\r\n',
    );

    await relais.couper();
    await attendreQue(() => !abonnement.connecte, 2_000, "coupure vue par l'admin");
    for (let n = 1; n <= 3; n++) m.evt.systemEvents.broadcast(notification(ALICE, n));
    await relais.retablir();
    await console1.attendreTexte(trameNotification(1, 3));
    expect(abonnement.connexions).toBe(2);

    relais.geler();
    m.evt.systemEvents.broadcast(notification(ALICE, 4));
    await new Promise((r) => setTimeout(r, 1_300));
    relais.degeler();
    await console1.attendreTexte(trameNotification(1, 4), 8_000);
    const attendu = [0, 1, 2, 3, 4].map((n) => trameNotification(1, n));
    expect(console1.texte()).toBe(
      attendu[0] +
        'data: {"type": "model_status", "data": {"models": ["q"]}}\r\n\r\n' +
        attendu.slice(1).join(""),
    );
    expect(console1.texte()).not.toContain("worker_recycling");
  });

  it("redémarrage de main, même sans événement reçu : perte signalée, console resynchronisée, rejeu ; statut", async () => {
    const env = await nouvelEnv();
    const m1 = await main(env);
    const relais = await mandataire(m1.port);
    const url = `http://127.0.0.1:${relais.port}`;
    const a = await admin(env, url);
    const abonnement = a.evt.abonnement;
    if (abonnement === undefined) throw new Error("abonnement absent");
    await attendreQue(() => abonnement.connecte, 5_000, "abonnement de l'admin");
    await attendreQue(
      () => abonnement.dernierId === (m1.evt.canal as CanalInterne).id(0),
      2_000,
      "repère reçu",
    );
    const console1 = await flux(a.port, "/api/system-events", await session(a.port, ALICE));
    await attendreQue(() => a.evt.systemEvents.nombreClients === 1);

    await m1.arreter();
    const m2 = await main(env);
    m2.evt.systemEvents.broadcast(notification(ALICE, 2));
    relais.cible = m2.port;
    await console1.fini;
    expect(console1.texte()).toBe('data: {"type": "worker_recycling"}\r\n\r\n');
    await attendreQue(() => abonnement.dernierId === (m2.evt.canal as CanalInterne).id(1), 5_000, "rejeu");

    const statut = await lireStatutMain({ url, jeton: () => JETON_INTERNE });
    expect(statut).toMatchObject({
      generation: (m2.evt.canal as CanalInterne).generation,
      mode: "main",
      pending: [],
    });
    expect(await lireStatutMain({ url, jeton: () => JETON_TOOLHOST })).toBeNull();
    expect(
      await lireStatutMain({ url: "http://127.0.0.1:1", jeton: () => JETON_INTERNE, delaiMs: 500 }),
    ).toBeNull();
  });

  it("admin → main par appel interne : révocation et bannière, sans écho vers l'admin", async () => {
    const env = await nouvelEnv();
    const m = await main(env);
    const a = await admin(env, `http://127.0.0.1:${m.port}`);
    const abonnement = a.evt.abonnement;
    if (abonnement === undefined) throw new Error("abonnement absent");
    await attendreQue(() => abonnement.connecte, 5_000, "abonnement de l'admin");
    const surMain1 = await flux(m.port, "/api/system-events", await session(m.port, ALICE));
    const surMain2 = await flux(m.port, "/api/system-events", await session(m.port, BOB));
    const surAdmin1 = await flux(a.port, "/api/system-events", await session(a.port, ALICE));
    const surAdmin2 = await flux(a.port, "/api/system-events", await session(a.port, BOB));
    await attendreQue(() => m.evt.systemEvents.nombreClients === 2 && a.evt.systemEvents.nombreClients === 2);

    const bilan = await a.evt.revoquer(ALICE);
    expect(bilan).toMatchObject({ uid: ALICE, systeme: 1 });
    await Promise.all([surMain1.fini, surAdmin1.fini]);
    expect(surMain1.texte()).toBe('data: {"type": "session_expired"}\r\n\r\n');
    expect(surAdmin1.texte()).toBe('data: {"type": "session_expired"}\r\n\r\n');

    expect(await a.evt.diffuserPartout({ type: "restart", message: "Bascule de base" })).toBe(true);
    const banniere = 'data: {"type": "restart", "message": "Bascule de base"}\r\n\r\n';
    await surMain2.attendreTexte(banniere);
    await surAdmin2.attendreTexte(banniere);
    m.evt.systemEvents.broadcast({ type: "model_changed" });
    await surAdmin2.attendreTexte("model_changed");
    expect(surAdmin2.texte()).toBe(banniere + 'data: {"type": "model_changed"}\r\n\r\n');

    expect(
      await publierVersMain(
        { type: "restart" },
        { url: `http://127.0.0.1:${m.port}`, jeton: () => JETON_TOOLHOST },
      ),
    ).toBe(false);
    expect(
      await publierVersMain({ type: "restart" }, { url: "http://127.0.0.1:1", jeton: () => JETON_INTERNE }),
    ).toBe(false);
  });

  it("secret de session différent (jeton interne refusé, 401) : une erreur de configuration, puis le silence", async () => {
    const env = await nouvelEnv();
    const m = await main(env);
    const lignes: string[] = [];
    const a = await admin(env, `http://127.0.0.1:${m.port}`, {
      journal: journalCapte(lignes),
      secret: "un-autre-secret",
    });
    await new Promise((r) => setTimeout(r, 400));
    expect(a.evt.abonnement?.connexions).toBe(0);
    expect(niveau(lignes, "ERROR")).toHaveLength(1);
    expect(niveau(lignes, "ERROR")[0]).toContain("HTTP 401");
    expect(lignes.filter((l) => l.includes(" DEBUG ") && l.includes("HTTP 401")).length).toBeGreaterThan(1);
  });

  it("réponse 200 qui n'est pas un flux SSE : pas une connexion, une erreur, une attente qui croît", async () => {
    let requetes = 0;
    const faux = Fastify();
    faux.get("/api/internal/events", (_requete, reponse) => {
      requetes += 1;
      void reponse.type("text/html").send("<html></html>");
    });
    await faux.listen({ port: 0, host: "127.0.0.1" });
    nettoyages.push(() => faux.close());
    const lignes: string[] = [];
    const a = await admin(
      await nouvelEnv(),
      `http://127.0.0.1:${(faux.server.address() as AddressInfo).port}`,
      {
        journal: journalCapte(lignes),
      },
    );
    await new Promise((r) => setTimeout(r, 600));
    expect(a.evt.abonnement?.connexions).toBe(0);
    expect(requetes).toBeGreaterThan(2);
    expect(requetes).toBeLessThan(12);
    expect(niveau(lignes, "ERROR")).toHaveLength(1);
    expect(niveau(lignes, "ERROR")[0]).toContain("text/html");
  });

  it("panne réseau : silence sous le seuil, un avertissement au-delà, « rétabli » au retour", async () => {
    const env = await nouvelEnv();
    const relais = new Mandataire(1);
    await relais.ouvrir();
    await relais.couper();
    const lignes: string[] = [];
    const a = await admin(env, `http://127.0.0.1:${relais.port}`, {
      journal: journalCapte(lignes),
      seuilAlerteMs: 300,
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(niveau(lignes, "WARNING")).toEqual([]);
    await attendreQue(() => niveau(lignes, "WARNING").length === 1, 3_000, "avertissement de panne");
    const m = await main(env);
    relais.cible = m.port;
    await relais.retablir();
    nettoyages.push(() => relais.couper());
    await attendreQue(() => a.evt.abonnement?.connecte === true, 5_000, "reconnexion");
    expect(niveau(lignes, "INFO").some((l) => l.includes("rétabli"))).toBe(true);
    expect(niveau(lignes, "WARNING")).toHaveLength(1);
    expect(niveau(lignes, "ERROR")).toEqual([]);
  });

  it("aucune trace du jeton interne, du secret ni du jeton du toolhost dans les journaux de main et de l'admin", async () => {
    const env = await nouvelEnv();
    const lignes: string[] = [];
    const m = await main(env, { journal: journalCapte(lignes) });
    const url = `http://127.0.0.1:${m.port}`;
    const a = await admin(env, url, { journal: journalCapte(lignes) });
    await attendreQue(() => a.evt.abonnement?.connecte === true, 5_000, "abonnement accepté");
    await admin(env, url, { journal: journalCapte(lignes), secret: "un-autre-secret" });
    const horsBoucle = await m.app.inject({
      method: "GET",
      url: "/api/internal/status",
      remoteAddress: "10.0.0.9",
      headers: { authorization: `Bearer ${JETON_INTERNE}` },
    });
    expect(horsBoucle.statusCode).toBe(403);
    expect(
      await publierVersMain(
        { type: "restart" },
        { url, jeton: () => JETON_TOOLHOST, journal: journalCapte(lignes) },
      ),
    ).toBe(false);
    expect(await a.evt.diffuserPartout({ type: "restart", message: "m" })).toBe(true);
    await attendreQue(
      () => niveau(lignes, "ERROR").some((l) => l.includes("HTTP 401")),
      3_000,
      "refus journalisé",
    );
    expect(lignes.some((l) => l.includes("[interne]"))).toBe(true);
    for (const secret of [
      JETON_INTERNE,
      jetonInterne("un-autre-secret"),
      SECRET,
      "un-autre-secret",
      JETON_TOOLHOST,
    ]) {
      expect(lignes.filter((l) => l.includes(secret))).toEqual([]);
    }
  });

  it("arrêt de l'admin : l'abonnement s'arrête net et ne se reconnecte plus ; main injoignable au départ : il insiste", async () => {
    const env = await nouvelEnv();
    const relais = new Mandataire(1);
    await relais.ouvrir();
    await relais.couper();
    const a = await admin(env, `http://127.0.0.1:${relais.port}`);
    const abonnement = a.evt.abonnement;
    if (abonnement === undefined) throw new Error("abonnement absent");
    await new Promise((r) => setTimeout(r, 150));
    expect(abonnement.connexions).toBe(0);
    const m = await main(env);
    relais.cible = m.port;
    await relais.retablir();
    nettoyages.push(() => relais.couper());
    await attendreQue(() => abonnement.connecte, 5_000, "connexion après l'attente croissante");
    const debut = Date.now();
    await a.arreter();
    expect(Date.now() - debut).toBeLessThan(1_500);
    expect(abonnement.connecte).toBe(false);
    const connexions = abonnement.connexions;
    await new Promise((r) => setTimeout(r, 200));
    expect(abonnement.connexions).toBe(connexions);
    await attendreQue(() => (m.evt.canal as CanalInterne).attentes === 0, 2_000, "abonné retiré côté main");
  });
});
