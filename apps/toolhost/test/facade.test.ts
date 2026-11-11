// SPDX-License-Identifier: MIT
/** apps/toolhost/test/facade.test.ts — façade MCP sans relais (elpis-tools retiré) : famille non servie refusée (503) ou introuvable, corps jamais lu ni validé, requête native prise avant l'analyse, échec ou refus de l'aiguillage. */
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { creerAppToolhost } from "../src/app";
import type { Famille } from "../src/app";
import {
  CHEMINS_FACADE,
  contexteFacade,
  MESSAGE_NON_SERVIE,
  METHODES,
  traiterFacade,
} from "../src/mcp/facade";
import type { AiguillageNatif } from "../src/mcp/facade";
import { configTest, hoteTest, journalMuet, lignesJournal, SVC } from "./aides";

const ouverts: { fermer: () => Promise<void> }[] = [];

afterEach(async () => {
  for (const o of ouverts.splice(0).reverse()) await o.fermer();
});

const AUTH = { authorization: `Bearer ${SVC}` };

/** Façade montée comme dans la composition, sur un aiguillage natif de test. */
async function avecAiguillage(natif: AiguillageNatif): Promise<string> {
  const famille: Famille = {
    nom: "mcp",
    contexte: contexteFacade({ natif, journal: journalMuet }),
    routes: CHEMINS_FACADE.map((chemin) => ({
      methode: METHODES,
      chemin,
      processus: ["toolhost"],
      acces: "mcp",
      traiter: traiterFacade(),
    })),
  };
  const app = await creerAppToolhost({ tc: configTest(), familles: [famille], journal: journalMuet });
  await app.listen({ port: 0, host: "127.0.0.1" });
  ouverts.push({
    fermer: async () => {
      app.server.closeAllConnections();
      await app.close();
    },
  });
  return `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
}

describe("façade MCP sans amont", () => {
  it("aucune famille native : /mcp et /mcp/<famille> refusés en 503 (detail), /sse et /messages/ introuvables, corps jamais validé", async () => {
    const h = await hoteTest(configTest({ families: ["fs", "git"], familles_natives: [] }));
    ouverts.push(h);
    expect(h.composition.natif).toBeNull();
    expect(h.composition).not.toHaveProperty("service");
    for (const url of ["/mcp", "/mcp/", "/mcp/fs", "/mcp/office"]) {
      const r = await h.app.inject({
        method: "POST",
        url,
        headers: { ...AUTH, "content-type": "application/json" },
        payload: "{ pas du json",
      });
      expect(r.statusCode, url).toBe(503);
      expect(r.json(), url).toEqual({ detail: MESSAGE_NON_SERVIE });
    }
    for (const url of ["/sse", "/sse/fs", "/messages/?session_id=" + "a".repeat(32)]) {
      const r = await h.app.inject({
        method: url.startsWith("/messages") ? "POST" : "GET",
        url,
        headers: AUTH,
      });
      expect(r.statusCode, url).toBe(404);
    }
    const sansJeton = await h.app.inject({ method: "GET", url: "/mcp" });
    expect(sansJeton.statusCode).toBe(503);
    const inconnue = await h.app.inject({ method: "POST", url: "/mcp/office/x", headers: AUTH });
    expect([inconnue.statusCode, inconnue.json()]).toEqual([
      404,
      { error: "famille d'outils inconnue : office/x" },
    ]);
  });

  it("requête prise par une famille native avant toute analyse : corps brut et en-têtes intacts ; non traitée : 404 ; échec : 500 journalisé", async () => {
    const vus: { url: string; type: string | undefined; corps: string }[] = [];
    const base = await avecAiguillage({
      prend: (chemin) => chemin === "/mcp/git",
      async traiter(req, res) {
        const morceaux: Buffer[] = [];
        for await (const m of req) morceaux.push(m as Buffer);
        vus.push({
          url: req.url ?? "",
          type: req.headers["content-type"],
          corps: Buffer.concat(morceaux).toString(),
        });
        if (req.url?.includes("panne")) throw new Error("panne du serveur natif");
        if (req.url?.includes("rien")) return false;
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
        return true;
      },
    });
    const pris = await fetch(`${base}/mcp/git?x=1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ pas du json",
    });
    expect([pris.status, await pris.text()]).toEqual([200, '{"ok":true}']);
    expect(vus[0]).toEqual({ url: "/mcp/git?x=1", type: "application/json", corps: "{ pas du json" });
    expect((await fetch(`${base}/mcp/git?rien`, { method: "POST", body: "{}" })).status).toBe(404);
    lignesJournal.length = 0;
    const panne = await fetch(`${base}/mcp/git?panne`, { method: "POST", body: "{}" });
    expect([panne.status, await panne.text()]).toEqual([500, "Internal Server Error"]);
    expect(lignesJournal.join("\n")).toContain("famille native : requête MCP en échec : Error");
    expect(lignesJournal.join("\n")).not.toContain("panne du serveur natif");
    const autre = await fetch(`${base}/mcp/fs`, { method: "POST", body: "{}" });
    expect([autre.status, await autre.json()]).toEqual([503, { detail: MESSAGE_NON_SERVIE }]);
    expect((await fetch(`${base}/sse/fs`)).status).toBe(404);
    expect(vus.map((v) => v.url)).toEqual(["/mcp/git?x=1", "/mcp/git?rien", "/mcp/git?panne"]);
  });
});
