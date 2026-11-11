// SPDX-License-Identifier: MIT
/** apps/core/test/relais/ws.test.ts — relais WebSocket de bout en bout : messages, fermetures, refus avant upgrade, révocation, arrêt, battement. */
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import type { AddressInfo, Socket } from "node:net";

import { surchargerConfig } from "@elpis/config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { makePreviewToken } from "../../src/relais/apercu";
import { attendre, attendreQue, FauxToolhost, JETON, lignes, monterBanc } from "./aides";
import type { Banc } from "./aides";

interface Client {
  ws: WebSocket;
  messages: (string | Buffer)[];
  fermeture: Promise<{ code: number; raison: string }>;
}

/** Client navigateur : résout à l'ouverture, ou rejette avec le statut HTTP d'un refus de poignée de main. */
function ouvrirWs(
  banc: Banc,
  chemin: string,
  entetes: Record<string, string> = {},
  perMessageDeflate = true,
): Promise<Client> {
  return new Promise((fin, echec) => {
    const ws = new WebSocket(banc.url.replace("http://", "ws://") + chemin, {
      headers: entetes,
      perMessageDeflate,
    });
    const messages: (string | Buffer)[] = [];
    const fermeture = new Promise<{ code: number; raison: string }>((ok) =>
      ws.on("close", (code, raison) => ok({ code, raison: raison.toString() })),
    );
    ws.on("message", (d, binaire) => messages.push(binaire ? (d as Buffer) : String(d)));
    ws.on("open", () => fin({ ws, messages, fermeture }));
    ws.on("unexpected-response", (_req, res) => {
      res.resume();
      res.on("end", () =>
        echec(Object.assign(new Error(`HTTP ${res.statusCode}`), { statut: res.statusCode })),
      );
    });
    ws.on("error", (e) => echec(e));
  });
}

async function statutRefus(
  banc: Banc,
  chemin: string,
  entetes: Record<string, string> = {},
): Promise<number> {
  try {
    const c = await ouvrirWs(banc, chemin, entetes);
    c.ws.terminate();
    return 101;
  } catch (e) {
    return (e as { statut?: number }).statut ?? -1;
  }
}

/** Délai de fermeture du banc (5 s en production, `_CLOSE_TIMEOUT_S`). */
const DELAI_FERMETURE_MS = 300;

interface HoteMuet {
  url: string;
  ouvertes: number;
  /** Octets reçus après la poignée de main : l'amont du relais est ouvert. */
  recus: number;
  fermees: number;
  arreter(): Promise<void>;
}

/** Hôte qui accepte la poignée de main WebSocket puis ne répond plus à rien, pas même à la trame de fermeture. */
async function hoteMuet(): Promise<HoteMuet> {
  const sockets = new Set<Socket>();
  const serveur = createServer((s) => {
    sockets.add(s);
    let tete = "";
    const lire = (d: Buffer): void => {
      tete += d.toString("latin1");
      if (!tete.includes("\r\n\r\n")) return;
      s.off("data", lire);
      s.on("data", (suite: Buffer) => (etat.recus += suite.length));
      const cle = /sec-websocket-key:\s*(\S+)/iu.exec(tete)?.[1] ?? "";
      const accepte = createHash("sha1")
        .update(`${cle}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      s.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accepte}\r\n\r\n`,
      );
      etat.ouvertes += 1;
    };
    s.on("data", lire);
    s.on("error", () => undefined);
    s.on("close", () => {
      sockets.delete(s);
      etat.fermees += 1;
    });
  });
  await new Promise<void>((fin) => serveur.listen(0, "127.0.0.1", fin));
  const etat: HoteMuet = {
    url: `http://127.0.0.1:${(serveur.address() as AddressInfo).port}`,
    ouvertes: 0,
    recus: 0,
    fermees: 0,
    arreter: () => {
      for (const s of sockets) s.destroy();
      return new Promise<void>((fin) => serveur.close(() => fin()));
    },
  };
  return etat;
}

let banc: Banc;
let hote: FauxToolhost;
let cookie: string;

beforeEach(async () => {
  lignes.length = 0;
  hote = await new FauxToolhost().demarrer();
  banc = await monterBanc({ battementMs: 150, delaiFermetureMs: DELAI_FERMETURE_MS });
  banc.manifeste({ main: { url: hote.url, token: JETON, relay: true } });
  cookie = await banc.connecter(1);
});

afterEach(async () => {
  await banc.fermer();
  await hote.arreter();
});

describe("relais WebSocket : messages et identité", () => {
  it("texte et binaire dans les deux sens, identité de la session vérifiée par l'hôte", async () => {
    const c = await ouvrirWs(banc, "/ws/terminal/s1?x=1", { cookie });
    await attendreQue(() => c.messages.length === 1);
    expect(c.messages[0]).toBe("hello alice /ws/terminal/s1?x=1");
    c.ws.send("ping");
    c.ws.send(Buffer.from([1, 2, 255]), { binary: true });
    await attendreQue(() => c.messages.length === 3);
    expect(c.messages[1]).toBe("echo:ping");
    expect(c.messages[2]).toEqual(Buffer.concat([Buffer.from("bin:"), Buffer.from([1, 2, 255])]));
    expect(hote.ws[0]?.identite).toMatchObject({
      user_id: 1,
      username: "alice",
      network_profile_id: "bridge",
    });
    c.ws.close(1000);
    expect(await hote.ws[0]?.fermeture).toEqual({ code: 1000, raison: "" });
  });

  it("messages envoyés avant que l'hôte réponde : gardés et relayés dans l'ordre", async () => {
    const c = await ouvrirWs(banc, "/ws/terminal", { cookie });
    for (const n of [1, 2, 3, 4]) c.ws.send(`m${n}`);
    await attendreQue(() => c.messages.length === 5);
    expect(c.messages).toEqual(["hello alice /ws/terminal", "echo:m1", "echo:m2", "echo:m3", "echo:m4"]);
    c.ws.close();
  });

  it("gros message binaire intact ; au-delà de 16 Mio, fermeture 1009 comme uvicorn", async () => {
    const c = await ouvrirWs(banc, "/ws/terminal/gros", { cookie });
    const charge = Buffer.alloc(5 * 1024 * 1024, 9);
    c.ws.send(charge, { binary: true });
    await attendreQue(() => c.messages.length === 2, 15_000);
    expect((c.messages[1] as Buffer).length).toBe(charge.length + 4);
    c.ws.send(Buffer.alloc(16 * 1024 * 1024 + 1), { binary: true });
    expect((await c.fermeture).code).toBe(1009);
    expect((await hote.ws[0]?.fermeture)?.code).toBe(1000);
    const trace = lignes.filter((l) => l.includes("Max payload size exceeded"));
    expect(trace.map((l) => /Z (\w+) /u.exec(l)?.[1]).sort()).toEqual(["DEBUG", "INFO"]);
    expect(trace.find((l) => l.includes(" INFO "))).toContain("WS /ws/terminal/gros terminé");
  });

  it("aperçu : identité du jeton du chemin, sans session", async () => {
    const restaurer = surchargerConfig({ SESSION_SECRET: "secret-apercu" });
    try {
      const [jeton] = makePreviewToken(2);
      const c = await ouvrirWs(banc, `/api/sandbox/pvs/${jeton}/3000/hmr`);
      await attendreQue(() => c.messages.length === 1);
      expect(c.messages[0]).toBe(`hello bob /api/sandbox/pvs/${jeton}/3000/hmr`);
      c.ws.close();
      expect(await statutRefus(banc, "/api/sandbox/pv/7-1-faux/x")).toBe(403);
    } finally {
      restaurer();
    }
  });
});

describe("relais WebSocket : fermetures", () => {
  it("code et raison de l'hôte transmis au navigateur (4001)", async () => {
    const c = await ouvrirWs(banc, "/ws/terminal/expiree", { cookie });
    expect(await c.fermeture).toEqual({ code: 4001, raison: "session expirée" });
  });

  it("hôte coupé net (1006) : 1011 vers le navigateur", async () => {
    const c = await ouvrirWs(banc, "/ws/terminal/coupe", { cookie });
    expect((await c.fermeture).code).toBe(1011);
  });

  it("hôte injoignable ou qui refuse l'enveloppe : 1011 « tool host unreachable »", async () => {
    banc.manifeste({ main: { url: "http://127.0.0.1:1", token: JETON } });
    let c = await ouvrirWs(banc, "/ws/terminal", { cookie });
    expect(await c.fermeture).toEqual({ code: 1011, raison: "tool host unreachable" });
    expect(lignes.some((l) => l.includes("WS amont ws://127.0.0.1:1/ws/terminal"))).toBe(true);
    banc.manifeste({ main: { url: hote.url, token: "faux-jeton" } });
    c = await ouvrirWs(banc, "/ws/terminal", { cookie });
    expect(await c.fermeture).toEqual({ code: 1011, raison: "tool host unreachable" });
    expect(hote.ws).toHaveLength(0);
  });

  it("navigateur parti sans fermeture : l'hôte voit 1000", async () => {
    const c = await ouvrirWs(banc, "/ws/terminal/s2", { cookie });
    await attendreQue(() => hote.ws.length === 1);
    c.ws.terminate();
    expect(await hote.ws[0]?.fermeture).toEqual({ code: 1000, raison: "" });
  });
});

describe("relais WebSocket : refus avant l'upgrade (403 comme uvicorn)", () => {
  it("sans session, session révoquée, cross-site, chemin refusé, sans hôte ou sans jeton : 403, rien vers l'hôte", async () => {
    await banc.base.base.run("INSERT INTO revoked_sessions(sid, user_id, revoked_at) VALUES ('sid-2', 2, 0)");
    const revoque = await banc.connecter(2);
    expect(await statutRefus(banc, "/ws/terminal")).toBe(403);
    expect(await statutRefus(banc, "/ws/terminal", { cookie: revoque })).toBe(403);
    expect(await statutRefus(banc, "/ws/terminal", { cookie, origin: "http://evil.example" })).toBe(403);
    expect(await statutRefus(banc, "/ws/terminal", { cookie, "sec-fetch-site": "cross-site" })).toBe(403);
    expect(await statutRefus(banc, "/ws/terminal/%2e%2e/x", { cookie })).toBe(403);
    expect(await statutRefus(banc, "/ws/terminal%2F..", { cookie })).toBe(403);
    banc.manifeste({});
    expect(await statutRefus(banc, "/ws/terminal", { cookie })).toBe(403);
    banc.manifeste({ main: { url: hote.url } });
    expect(await statutRefus(banc, "/ws/terminal", { cookie })).toBe(403);
    expect(hote.ws).toHaveLength(0);
  });

  it("même origine acceptée", async () => {
    const hoteLocal = new URL(banc.url).host;
    const c = await ouvrirWs(banc, "/ws/terminal", { cookie, origin: `http://${hoteLocal}` });
    c.ws.close();
  });
});

describe("relais WebSocket : révocation, arrêt, battement, contre-pression", () => {
  it("révocation (fermerTerminauxDuCompte) comme l'expiration : session_expired puis 4001 au navigateur, 4001 à l'hôte qui tue les PTY ; -1 pour tous", async () => {
    const a1 = await ouvrirWs(banc, "/ws/terminal/a", { cookie });
    const a2 = await ouvrirWs(banc, "/ws/terminal/b", { cookie });
    const b1 = await ouvrirWs(banc, "/ws/terminal/c", { cookie: await banc.connecter(2) });
    await attendreQue(() => hote.ws.length === 3 && [a1, a2, b1].every((c) => c.messages.length === 1));
    const expiree = { code: 4001, raison: "session expired" };
    expect(banc.relais.fermerTerminauxDuCompte(99)).toBe(0);
    expect(banc.relais.fermerTerminauxDuCompte(1)).toBe(2);
    for (const c of [a1, a2]) {
      expect(await c.fermeture).toEqual(expiree);
      expect(c.messages.at(-1)).toBe('{"type": "session_expired"}');
    }
    const parUrl = (u: string) => hote.ws.find((w) => w.url === u);
    expect([await parUrl("/ws/terminal/a")?.fermeture, await parUrl("/ws/terminal/b")?.fermeture]).toEqual([
      expiree,
      expiree,
    ]);
    expect(b1.ws.readyState).toBe(WebSocket.OPEN);
    expect(banc.relais.fermerTerminauxDuCompte(1)).toBe(0);
    expect(banc.relais.fermerTerminauxDuCompte(null)).toBe(-1);
    expect(await b1.fermeture).toEqual(expiree);
    expect(b1.messages.at(-1)).toBe('{"type": "session_expired"}');
    expect(await parUrl("/ws/terminal/c")?.fermeture).toEqual(expiree);
  });

  it("arrêt du process : 1012 vers le navigateur, 1000 vers l'hôte ; une connexion tardive est refermée sans joindre l'hôte", async () => {
    const c = await ouvrirWs(banc, "/ws/terminal", { cookie });
    await attendreQue(() => hote.ws.length === 1);
    banc.arret.abort();
    expect((await c.fermeture).code).toBe(1012);
    expect((await hote.ws[0]?.fermeture)?.code).toBe(1000);
    const tard = await ouvrirWs(banc, "/ws/terminal", { cookie });
    expect((await tard.fermeture).code).toBe(1012);
    await attendre(100);
    expect([hote.ws.length, hote.sockets.size]).toEqual([1, 0]);
  });

  it("battement : hôte muet → 1011 « keepalive ping timeout »", async () => {
    const c = await ouvrirWs(banc, "/ws/terminal/muet", { cookie });
    expect(await c.fermeture).toEqual({ code: 1011, raison: "keepalive ping timeout" });
  });

  it("battement : navigateur muet → coupé, l'hôte voit 1000", async () => {
    const c = await ouvrirWs(banc, "/ws/terminal/s", { cookie });
    await attendreQue(() => hote.ws.length === 1);
    (c.ws as unknown as { _socket: Socket })._socket.pause();
    expect(await hote.ws[0]?.fermeture).toEqual({ code: 1000, raison: "" });
    c.ws.terminate();
  });

  it("contre-pression : un navigateur qui ne lit pas met l'hôte en attente, rien n'est perdu ensuite", async () => {
    await banc.fermer();
    banc = await monterBanc({ battementMs: 60_000 });
    banc.manifeste({ main: { url: hote.url, token: JETON } });
    cookie = await banc.connecter(1);
    const c = await ouvrirWs(banc, "/ws/terminal/inonde", { cookie }, false);
    const socket = (c.ws as unknown as { _socket: Socket })._socket;
    socket.pause();
    try {
      await attendre(800);
      expect(hote.inondes).toBeLessThan(hote.totalInondation / 2);
    } finally {
      socket.resume();
    }
    await attendreQue(() => c.messages.length === hote.totalInondation, 20_000);
    expect(hote.inondes).toBe(hote.totalInondation);
    c.ws.close();
  });
});

describe("relais WebSocket : fermeture bornée (_CLOSE_TIMEOUT_S)", () => {
  let muet: HoteMuet;

  beforeEach(async () => {
    muet = await hoteMuet();
    banc.manifeste({ main: { url: muet.url, token: JETON } });
  });

  afterEach(async () => {
    await muet.arreter();
  });

  it("arrêt face à un hôte qui ne répond pas à la fermeture : transport amont coupé dans le délai, attendu par fermer()", async () => {
    const c = await ouvrirWs(banc, "/ws/terminal", { cookie });
    c.ws.send("x");
    await attendreQue(() => muet.recus > 0);
    const debut = performance.now();
    banc.arret.abort();
    await banc.relais.fermer();
    const duree = performance.now() - debut;
    expect(duree).toBeGreaterThanOrEqual(DELAI_FERMETURE_MS - 50);
    expect(duree).toBeLessThan(DELAI_FERMETURE_MS + 1_500);
    await attendreQue(() => muet.fermees === 1);
    expect((await c.fermeture).code).toBe(1012);
  });

  it("navigateur parti, hôte muet : transport amont coupé dans le délai", async () => {
    const c = await ouvrirWs(banc, "/ws/terminal", { cookie });
    c.ws.send("x");
    await attendreQue(() => muet.recus > 0);
    const debut = performance.now();
    c.ws.close(1000);
    await attendreQue(() => muet.fermees === 1, DELAI_FERMETURE_MS + 1_500);
    expect(performance.now() - debut).toBeGreaterThanOrEqual(DELAI_FERMETURE_MS - 50);
  });

  it("arrêt avec un navigateur qui ne lit plus : sa connexion est coupée dans le délai, fermer() rendu", async () => {
    banc.manifeste({ main: { url: hote.url, token: JETON, relay: true } });
    const c = await ouvrirWs(banc, "/ws/terminal/s", { cookie });
    await attendreQue(() => hote.ws.length === 1);
    (c.ws as unknown as { _socket: Socket })._socket.pause();
    const debut = performance.now();
    banc.arret.abort();
    await banc.relais.fermer();
    const duree = performance.now() - debut;
    expect(duree).toBeGreaterThanOrEqual(DELAI_FERMETURE_MS - 50);
    expect(duree).toBeLessThan(DELAI_FERMETURE_MS + 1_500);
    expect((await hote.ws[0]?.fermeture)?.code).toBe(1000);
    c.ws.terminate();
  });
});

describe("relais WebSocket : session revalidée par main", () => {
  beforeEach(async () => {
    await banc.fermer();
    banc = await monterBanc({ battementMs: 60_000, revalidationMs: 100 });
    banc.manifeste({ main: { url: hote.url, token: JETON } });
    cookie = await banc.connecter(1);
  });

  it("session révoquée : session_expired puis 4001 au navigateur, 4001 à l'hôte (qui tue les terminaux du compte)", async () => {
    const c = await ouvrirWs(banc, "/ws/terminal/s1", { cookie });
    await attendreQue(() => c.messages.length === 1);
    await banc.base.base.run("INSERT INTO revoked_sessions(sid, user_id, revoked_at) VALUES ('sid-1', 1, 0)");
    expect(await c.fermeture).toEqual({ code: 4001, raison: "session expired" });
    expect(c.messages).toEqual(["hello alice /ws/terminal/s1", '{"type": "session_expired"}']);
    expect(await hote.ws[0]?.fermeture).toEqual({ code: 4001, raison: "session expired" });
  });

  it("session valide : le terminal reste ouvert au fil des revalidations", async () => {
    const c = await ouvrirWs(banc, "/ws/terminal/s1", { cookie });
    await attendre(450);
    c.ws.send("encore");
    await attendreQue(() => c.messages.length === 2);
    expect(c.messages).toEqual(["hello alice /ws/terminal/s1", "echo:encore"]);
    c.ws.close(1000);
    expect(await hote.ws[0]?.fermeture).toEqual({ code: 1000, raison: "" });
  });

  it("fermeture : la minuterie de revalidation s'arrête, plus aucune revalidation ensuite", async () => {
    let revalidations = 0;
    const config = banc.dep.config.bind(banc.dep);
    banc.dep.config = () => {
      revalidations++;
      return config();
    };
    const c = await ouvrirWs(banc, "/ws/terminal/s1", { cookie });
    revalidations = 0;
    await attendreQue(() => revalidations >= 2);
    c.ws.close(1000);
    await c.fermeture;
    await attendreQue(() => hote.ws.length === 1);
    await hote.ws[0]?.fermeture;
    const apres = revalidations;
    await attendre(350);
    expect(revalidations).toBe(apres);
  });

  it("erreur pendant la revalidation (réglage illisible) : session gardée, comme _session_valide", async () => {
    const c = await ouvrirWs(banc, "/ws/terminal/s1", { cookie });
    banc.config["security"] = { session: { max_age_sec: "abc" } };
    await attendre(350);
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    c.ws.close();
  });

  it("aperçu (pvs) : jamais revalidé, son identité est celle du jeton", async () => {
    const restaurer = surchargerConfig({ SESSION_SECRET: "secret-apercu" });
    try {
      const [jeton] = makePreviewToken(2);
      const c = await ouvrirWs(banc, `/api/sandbox/pvs/${jeton}/5173/hmr`);
      await attendre(450);
      expect([c.ws.readyState, c.messages.length]).toEqual([WebSocket.OPEN, 1]);
      c.ws.close();
      expect((await hote.ws[0]?.fermeture)?.code).toBe(1000);
    } finally {
      restaurer();
    }
  });
});
