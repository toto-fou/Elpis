// SPDX-License-Identifier: MIT
/** apps/core/test/websocket.test.ts — socle : WebSocket par route (garde avant l'upgrade), upgrade refusé sans fuite, contexte propre à une famille. */
import { request } from "node:http";
import { connect } from "node:net";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import type { Famille } from "../src/routes";
import { appTest } from "./aides";
import { HttpError } from "@elpis/commun";
import { corpsJson } from "@elpis/http";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function ecouter(familles: Famille[]): Promise<number> {
  app = await appTest({
    familles,
    gardes: {
      session: (requete) => {
        if (requete.headers["x-session"] !== "ok") throw new HttpError(401, "not logged in");
      },
    },
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const adresse = app.server.address();
  return typeof adresse === "object" && adresse ? adresse.port : 0;
}

/** Poignée de main brute : première ligne de la réponse et fermeture de la socket par le serveur. */
function poigneeDeMain(
  port: number,
  chemin: string,
  entetes = "",
): Promise<{ ligne: string; fermee: boolean }> {
  return new Promise((fin) => {
    const s = connect(port, "127.0.0.1");
    let recu = "";
    const minuterie = setTimeout(() => {
      s.destroy();
      fin({ ligne: recu.split("\r\n")[0] ?? "", fermee: false });
    }, 1_500);
    s.on("data", (d) => (recu += d.toString("latin1")));
    s.on("close", () => {
      clearTimeout(minuterie);
      fin({ ligne: recu.split("\r\n")[0] ?? "", fermee: true });
    });
    s.write(
      `GET ${chemin} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${entetes}\r\n`,
    );
  });
}

const echo: Famille = {
  nom: "echo",
  routes: [
    {
      methode: "GET",
      chemin: "/echo",
      processus: ["main"],
      acces: "session",
      traiter: () => ({ http: true }),
      ws: (socket) => {
        socket.on("message", (d) => socket.send(`echo:${String(d)}`));
      },
    },
    {
      methode: "GET",
      chemin: "/simple",
      processus: ["main"],
      acces: "public",
      traiter: () => ({ ok: true }),
    },
    {
      methode: "GET",
      chemin: "/salon/:id",
      processus: ["main"],
      acces: "public",
      traiter: () => ({ salon: true }),
      ws: (socket) => socket.close(),
    },
  ],
};

describe("WebSocket déclarée sur une route", () => {
  it("garde passée : upgrade et échanges ; même route en HTTP ordinaire", async () => {
    const port = await ecouter([echo]);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/echo`, { headers: { "x-session": "ok" } });
    await new Promise((fin) => ws.once("open", fin));
    ws.send("a");
    expect(String(await new Promise((fin) => ws.once("message", fin)))).toBe("echo:a");
    ws.close();
    const r = await fetch(`http://127.0.0.1:${port}/echo`, { headers: { "x-session": "ok" } });
    expect(await r.json()).toEqual({ http: true });
  });

  it("garde refusée : réponse HTTP de la garde à la poignée de main, socket fermée", async () => {
    const port = await ecouter([echo]);
    expect(await poigneeDeMain(port, "/echo")).toEqual({ ligne: "HTTP/1.1 401 Unauthorized", fermee: true });
  });

  it("upgrade vers une route sans WebSocket, un chemin inconnu ou un paramètre vide : 403 comme uvicorn, socket fermée", async () => {
    const port = await ecouter([echo]);
    expect(await poigneeDeMain(port, "/simple")).toEqual({ ligne: "HTTP/1.1 403 Forbidden", fermee: true });
    expect(await poigneeDeMain(port, "/inconnu")).toEqual({ ligne: "HTTP/1.1 403 Forbidden", fermee: true });
    expect(await poigneeDeMain(port, "/salon/")).toEqual({ ligne: "HTTP/1.1 403 Forbidden", fermee: true });
  });

  it("upgrade autre que websocket (h2c) : servi en HTTP ordinaire, comme uvicorn", async () => {
    const port = await ecouter([echo]);
    for (const [chemin, attendu] of [
      ["/simple", { ok: true }],
      ["/echo", { http: true }],
    ] as const) {
      const r = await new Promise<{ statut: number; corps: string }>((fin, echec) => {
        const q = request(
          {
            host: "127.0.0.1",
            port,
            path: chemin,
            agent: false,
            headers: {
              connection: "Upgrade, HTTP2-Settings",
              upgrade: "h2c",
              "http2-settings": "AAMAAABkAARAAAAAAAIAAAAA",
              "x-session": "ok",
            },
          },
          (res) => {
            let corps = "";
            res.on("data", (d: Buffer) => (corps += d.toString()));
            res.on("end", () => fin({ statut: res.statusCode ?? 0, corps }));
          },
        );
        q.on("upgrade", () => echec(new Error("upgrade inattendu")));
        q.on("error", echec);
        q.end();
      });
      expect(r).toEqual({ statut: 200, corps: JSON.stringify(attendu) });
    }
  });

  it("sous-protocole demandé : aucun n'est choisi, comme uvicorn", async () => {
    const port = await ecouter([echo]);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/echo`, ["x-proto"], { headers: { "x-session": "ok" } });
    const erreur = await new Promise<Error>((fin) => ws.once("error", fin));
    expect(erreur.message).toMatch(/subprotocol/u);
  });

  it("WebSocket ailleurs que sur une route GET seule : refus au montage", async () => {
    const mauvaise: Famille = {
      nom: "mauvaise",
      routes: [
        {
          methode: ["GET", "POST"],
          chemin: "/x",
          processus: ["main"],
          acces: "public",
          traiter: () => null,
          ws: () => undefined,
        },
      ],
    };
    await expect(appTest({ familles: [mauvaise] })).rejects.toThrow(/route GET seule/u);
  });
});

describe("contexte propre à une famille", () => {
  it("analyseur et gestionnaire d'erreurs de la famille ; le reste du socle inchangé", async () => {
    const flux: Famille = {
      nom: "flux",
      contexte: (sous) => {
        sous.removeAllContentTypeParsers();
        sous.addContentTypeParser("*", (_r, _p, fini) => fini(null));
        sous.setErrorHandler((erreur, _r, reponse) => {
          if (erreur instanceof HttpError && erreur.statusCode === 418)
            return reponse.code(400).send({ propre: true });
          throw erreur;
        });
      },
      routes: [
        {
          methode: "POST",
          chemin: "/flux",
          processus: ["main"],
          acces: "public",
          traiter: async (requete) => {
            let n = 0;
            for await (const m of requete.raw) n += (m as Buffer).length;
            return { lus: n, analyse: requete.body === undefined };
          },
        },
        {
          methode: "GET",
          chemin: "/flux/erreur/:code",
          processus: ["main"],
          acces: "public",
          traiter: (requete) => {
            throw new HttpError(Number((requete.params as { code: string }).code), "x");
          },
        },
      ],
    };
    const lu: Famille = {
      nom: "lu",
      routes: [
        {
          methode: "POST",
          chemin: "/lu",
          processus: ["main"],
          acces: "public",
          traiter: (r) => corpsJson(r),
        },
      ],
    };
    const port = await ecouter([flux, lu]);
    const base = `http://127.0.0.1:${port}`;
    const corps = JSON.stringify({ a: 1 });
    const r = await fetch(`${base}/flux`, {
      method: "POST",
      body: corps,
      headers: { "content-type": "application/json" },
    });
    expect(await r.json()).toEqual({ lus: corps.length, analyse: true });
    expect(await (await fetch(`${base}/lu`, { method: "POST", body: corps })).json()).toEqual({ a: 1 });
    expect(await (await fetch(`${base}/flux/erreur/418`)).json()).toEqual({ propre: true });
    const parent = await fetch(`${base}/flux/erreur/409`);
    expect([parent.status, await parent.json()]).toEqual([409, { detail: "x" }]);
    expect(app?.elpis.routes.map((x) => x.chemin)).toEqual(["/flux", "/flux/erreur/:code", "/lu"]);
  });
});
