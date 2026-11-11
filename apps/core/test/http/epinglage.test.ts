// SPDX-License-Identifier: MIT
/** apps/core/test/http/epinglage.test.ts — agent épinglé : chaque connexion jugée, jointe aux seules adresses validées, Host, SNI et certificat sur le nom d'origine, redirections rejugées. */
import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import { createServer as createServerTls } from "node:https";
import type { AddressInfo } from "node:net";
import type { TLSSocket } from "node:tls";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CA_TEST, CERT_SERVEUR, CLE_SERVEUR } from "../llm/pki-test";
import { agentEpingle, ConnexionRefusee, fetchPar } from "@elpis/http";
import type { JugeHote } from "@elpis/http";

interface Vu {
  hote: string | undefined;
  chemin: string | undefined;
  sni: string | null;
}

let clair: Server;
let chiffre: Server;
let portClair = 0;
let portChiffre = 0;
const vus: Vu[] = [];

function noter(req: IncomingMessage, sni: string | null): void {
  vus.push({ hote: req.headers.host, chemin: req.url, sni });
}

async function ecouter(s: Server): Promise<number> {
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  return (s.address() as AddressInfo).port;
}

beforeAll(async () => {
  clair = createServer((req, rep) => {
    noter(req, null);
    if (req.url === "/vers-boucle") {
      rep.writeHead(302, { location: `http://127.0.0.1:${portClair}/cible` }).end();
      return;
    }
    rep.end("ok");
  });
  chiffre = createServerTls({ cert: CERT_SERVEUR, key: CLE_SERVEUR }, (req, rep) => {
    noter(req, (req.socket as TLSSocket).servername || null);
    rep.end("tls");
  });
  portClair = await ecouter(clair);
  portChiffre = await ecouter(chiffre);
});

afterAll(async () => {
  await new Promise((r) => clair.close(r));
  await new Promise((r) => chiffre.close(r));
});

/** Juge de test : noms connus → adresses ; tout autre nom (et toute IP) refusé ; appels notés. */
function juge(table: Record<string, string[]>, appels: [string, number][] = []): JugeHote {
  return async (hote, port) => {
    appels.push([hote, port]);
    const adresses = table[hote];
    return adresses === undefined
      ? { motif: `blocked_host (${hote})`, adresses: [] }
      : { motif: null, adresses };
  };
}

describe("agent épinglé", () => {
  it("nom jugé une fois, connexion à l'adresse validée sans résolution, Host d'origine", async () => {
    vus.length = 0;
    const appels: [string, number][] = [];
    const agent = agentEpingle(juge({ "serveur.invalid": ["127.0.0.1"] }, appels));
    try {
      const r = await fetchPar(agent)(`http://serveur.invalid:${portClair}/a`);
      expect(await r.text()).toBe("ok");
      expect(appels).toEqual([["serveur.invalid", portClair]]);
      expect(vus).toEqual([{ hote: `serveur.invalid:${portClair}`, chemin: "/a", sni: null }]);
    } finally {
      await agent.close();
    }
  });

  it("destination refusée par le juge : aucune connexion, cause ConnexionRefusee", async () => {
    vus.length = 0;
    const agent = agentEpingle(juge({}));
    try {
      const e = await fetchPar(agent)(`http://ailleurs.invalid:${portClair}/`).catch((x: unknown) => x);
      expect((e as Error).cause).toBeInstanceOf(ConnexionRefusee);
      expect(((e as Error).cause as Error).message).toBe(
        "destination refusée : blocked_host (ailleurs.invalid)",
      );
      expect(vus).toEqual([]);
    } finally {
      await agent.close();
    }
  });

  it("redirection vers une adresse littérale : rejugée et refusée, rien n'y arrive", async () => {
    vus.length = 0;
    const agent = agentEpingle(juge({ "serveur.invalid": ["127.0.0.1"] }));
    try {
      const e = await fetchPar(agent)(`http://serveur.invalid:${portClair}/vers-boucle`).catch(
        (x: unknown) => x,
      );
      expect(((e as Error).cause as Error).message).toBe("destination refusée : blocked_host (127.0.0.1)");
      expect(vus.map((v) => v.chemin)).toEqual(["/vers-boucle"]);
    } finally {
      await agent.close();
    }
  });

  it("https : SNI et certificat vérifiés sur le nom d'origine, pas sur l'adresse jointe", async () => {
    vus.length = 0;
    const agent = agentEpingle(juge({ localhost: ["127.0.0.1"], "autre.invalid": ["127.0.0.1"] }), {
      ca: CA_TEST,
    });
    try {
      const r = await fetchPar(agent)(`https://localhost:${portChiffre}/s`);
      expect(await r.text()).toBe("tls");
      expect(vus).toEqual([{ hote: `localhost:${portChiffre}`, chemin: "/s", sni: "localhost" }]);
      const e = await fetchPar(agent)(`https://autre.invalid:${portChiffre}/s`).catch((x: unknown) => x);
      expect(String(((e as Error).cause as { code?: string }).code)).toBe("ERR_TLS_CERT_ALTNAME_INVALID");
      expect(vus).toHaveLength(1);
    } finally {
      await agent.close();
    }
  });

  it("aucune adresse validée : refus", async () => {
    const agent = agentEpingle(async () => ({ motif: null, adresses: [] }));
    try {
      const e = await fetchPar(agent)(`http://vide.invalid:${portClair}/`).catch((x: unknown) => x);
      expect(((e as Error).cause as Error).message).toBe(
        "destination refusée : aucune adresse validée (vide.invalid)",
      );
    } finally {
      await agent.close();
    }
  });
});
