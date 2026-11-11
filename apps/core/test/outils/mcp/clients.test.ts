// SPDX-License-Identifier: MIT
/** apps/core/test/outils/mcp/clients.test.ts — clients MCP réels contre un faux serveur du SDK TS : HTTP streamable et SSE, pagination, _meta, progression et logs, erreurs (adresse partagée masquée), session perdue, abandon, délais, secrets. */
import { DOSSIER_MOTEUR } from "../../moteur-environnement";

import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { DelaiDepasse, marquerConfiance, oublierManifeste, PoolMcp } from "@elpis/mcp";
import type { ConfigMcp, OutilMcp } from "@elpis/mcp";

import {
  ClientMcpHttp,
  ClientMcpSse,
  executerOutilMcp,
  friendlyMcpError,
  mcpToolToOpenai,
  resoudreClientMcp,
  serviceJoignable,
  TransportNonPrisEnCharge,
  urlSansSecret,
} from "../../../src/outils/mcp/clients";
import { installerCrochetJournal } from "../../../src/journal";
import { portFerme } from "../../llm/faux-serveur";
import { demarrerFauxServeur } from "./faux-serveur";
import type { FauxServeur } from "./faux-serveur";

type Dict = Record<string, unknown>;

const attendre = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const signalLibre = (): AbortSignal => new AbortController().signal;

let srv: FauxServeur;
const pools: PoolMcp[] = [];
const ouverts: { fermer(): Promise<void> }[] = [];

function pool(): PoolMcp {
  const p = new PoolMcp({ rejouable: (n) => n !== "ecrire", parallelisme: () => 4, ttlOutilsS: () => 360 });
  pools.push(p);
  return p;
}

function http(url: string, headers: Record<string, string> | null = null): ClientMcpHttp {
  const c = new ClientMcpHttp(url, headers);
  ouverts.push(c);
  return c;
}

function texte(res: unknown): string {
  return String(((res as Dict)["content"] as Dict[])[0]?.["text"]);
}

beforeAll(async () => {
  srv = await demarrerFauxServeur();
});

afterEach(async () => {
  for (const c of ouverts.splice(0)) await c.fermer();
  for (const p of pools.splice(0)) {
    await p.closeAll();
    await p.attendreFermetures();
  }
  srv.requetes = [];
  srv.appels = [];
  srv.annulations = 0;
});

afterAll(async () => {
  await srv.fermer();
});

describe("HTTP streamable", () => {
  it("connexion, pages suivies (nextCursor), schémas booléens acceptés puis normalisés pour la grammaire", async () => {
    const c = http(`${srv.base}/mcp`);
    await c.connecter(signalLibre());
    const outils = await c.listerOutils(signalLibre());
    expect(outils.map((o) => o["name"])).toEqual([
      "echo",
      "lent",
      "erreur",
      "en_erreur",
      "structure",
      "bool",
      "ecrire",
      "structure07",
      "structure04",
      "schema_casse",
    ]);
    const bool = outils.find((o) => o["name"] === "bool") as OutilMcp;
    expect((bool["inputSchema"] as Dict)["properties"]).toEqual({ a: true, b: false, c: { type: "string" } });
    expect(mcpToolToOpenai(bool)["function"]).toMatchObject({
      name: "bool",
      parameters: {
        type: "object",
        properties: { a: {}, b: {}, c: { type: "string" } },
        additionalProperties: false,
      },
    });
    expect(
      srv.requetes.filter((r) => (r.corps as Dict | undefined)?.["method"] === "tools/list"),
    ).toHaveLength(4);
  });

  it("_meta transmis tel quel (compte, chat, profil réseau), absent quand vide", async () => {
    const c = http(`${srv.base}/mcp`);
    await c.connecter(signalLibre());
    const meta = { username: "alice", user_id: 7, chat_id: "c1", network_profile_id: "lan-2" };
    const r1 = await c.appelerOutil("echo", { x: 1 }, { meta, signal: signalLibre() });
    expect(JSON.parse(texte(r1))).toEqual({ args: { x: 1 }, meta });
    await c.appelerOutil("echo", {}, { meta: {}, signal: signalLibre() });
    await c.appelerOutil("echo", {}, { meta: null, signal: signalLibre() });
    expect(srv.appels.map((a) => a.meta)).toEqual([meta, undefined, undefined]);
  });

  it("progression et logs rendus à l'appel qui les a produits", async () => {
    const c = http(`${srv.base}/mcp`);
    await c.connecter(signalLibre());
    const progres: unknown[] = [];
    const logs: unknown[] = [];
    const res = await c.appelerOutil(
      "lent",
      { ms: 1, etapes: 2 },
      {
        meta: { username: "alice", call_id: "k1" },
        onProgress: (p) => {
          progres.push(p);
        },
        onLog: (p) => {
          logs.push(p);
        },
        signal: signalLibre(),
      },
    );
    expect(texte(res)).toBe("fini");
    expect(progres).toEqual([
      { progress: 1, total: 2, message: "étape 1" },
      { progress: 2, total: 2, message: "étape 2" },
    ]);
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatchObject({ level: "info", logger: "lent", data: { msg: "ligne 1" } });
    const metaRecu = srv.appels[0]?.meta as Dict;
    expect(metaRecu["username"]).toBe("alice");
    expect(metaRecu).toHaveProperty("progressToken");
  });

  it("sortie structurée validée comme le SDK Python", async () => {
    const c = http(`${srv.base}/mcp`);
    await c.connecter(signalLibre());
    await c.listerOutils(signalLibre());
    expect(await c.appelerOutil("structure", { n: 3 }, { signal: signalLibre() })).toMatchObject({
      structuredContent: { n: 3 },
    });
    await expect(c.appelerOutil("structure", { n: "x" }, { signal: signalLibre() })).rejects.toThrow(
      "Invalid structured content returned by tool structure: 'x' is not of type 'integer'",
    );
    await expect(c.appelerOutil("structure", { sans: true }, { signal: signalLibre() })).rejects.toThrow(
      "Tool structure has an output schema but did not return structured content",
    );
  });

  it("sortie structurée : brouillon pris dans $schema (draft-07), draft-04 non validé, schéma invalide signalé à l'appel", async () => {
    const c = http(`${srv.base}/mcp`);
    await c.connecter(signalLibre());
    await c.listerOutils(signalLibre());
    expect(await c.appelerOutil("structure07", { n: 4 }, { signal: signalLibre() })).toMatchObject({
      structuredContent: { n: 4 },
    });
    await expect(c.appelerOutil("structure07", { n: "y" }, { signal: signalLibre() })).rejects.toThrow(
      "Invalid structured content returned by tool structure07: 'y' is not of type 'integer'",
    );
    expect(await c.appelerOutil("structure04", { n: "pas validé" }, { signal: signalLibre() })).toMatchObject(
      {
        structuredContent: { n: "pas validé" },
      },
    );
    await expect(c.appelerOutil("schema_casse", { n: 1 }, { signal: signalLibre() })).rejects.toThrow(
      /^Invalid schema for tool schema_casse: /,
    );
  });

  it("fermeture : la session est terminée côté serveur (DELETE)", async () => {
    const c = new ClientMcpHttp(`${srv.base}/mcp`);
    await c.connecter(signalLibre());
    await c.fermer();
    expect(srv.requetes.some((r) => r.methode === "DELETE" && r.chemin === "/mcp")).toBe(true);
  });
});

describe("pool et exécution sur un vrai transport", () => {
  const cfg = (): ConfigMcp => marquerConfiance({ type: "http", name: "faux", url: `${srv.base}/mcp` });

  it("succès, erreur de protocole (connexion gardée), erreur d'outil : rendus en JSON comme le Python", async () => {
    const p = pool();
    const carte = new Map([
      ["echo", cfg()],
      ["erreur", cfg()],
      ["en_erreur", cfg()],
    ]);
    expect(await executerOutilMcp(carte, "echo", { x: "é" }, { timeoutS: 5, pool: p })).toBe(
      '{"args": {"x": "é"}, "meta": null}',
    );
    expect(await executerOutilMcp(carte, "erreur", {}, { timeoutS: 5, pool: p })).toBe(
      '{"error": "Invalid params: x manquant"}',
    );
    expect(await executerOutilMcp(carte, "en_erreur", {}, { timeoutS: 5, pool: p })).toBe(
      '{"ok": false, "error": "refus"}',
    );
    expect(srv.initialisations).toBeGreaterThan(0);
    expect(p.entree(cfg())?.healthy).toBe(true);
    expect(
      srv.requetes.filter((r) => (r.corps as Dict | undefined)?.["method"] === "initialize"),
    ).toHaveLength(1);
  });

  it("session perdue (redémarrage du serveur) : reconnexion et rejeu, même d'un outil mutant", async () => {
    const p = pool();
    await p.callTool(cfg(), "echo", {}, { resolveClient: resoudreClientMcp });
    srv.oublierSessions();
    const res = await p.callTool(cfg(), "ecrire", { v: 1 }, { resolveClient: resoudreClientMcp });
    expect(JSON.parse(texte(res))).toEqual({ args: { v: 1 }, meta: null });
    expect(
      srv.requetes.filter((r) => (r.corps as Dict | undefined)?.["method"] === "initialize"),
    ).toHaveLength(2);
    expect(srv.appels.filter((a) => a.nom === "ecrire")).toHaveLength(1);
  });

  it("serveur arrêté puis relancé sur le même port : erreur de transport, puis reconnexion au tour suivant", async () => {
    const autre = await demarrerFauxServeur();
    const c = marquerConfiance({ type: "http", name: "autre", url: `${autre.base}/mcp` });
    const p = pool();
    await p.callTool(c, "echo", {}, { resolveClient: resoudreClientMcp });
    await autre.fermer();
    await expect(p.callTool(c, "ecrire", {}, { resolveClient: resoudreClientMcp })).rejects.toThrow(
      /Échec connexion MCP 'autre'/,
    );
    const relance = await demarrerFauxServeur({ port: autre.port });
    try {
      const res = await p.callTool(c, "echo", { y: 2 }, { resolveClient: resoudreClientMcp });
      expect(JSON.parse(texte(res))["args"]).toEqual({ y: 2 });
    } finally {
      await p.closeAll();
      await relance.fermer();
    }
  });

  it("Stop : l'attente est abandonnée sans notification d'annulation au serveur (comme le Python)", async () => {
    const p = pool();
    const ctl = new AbortController();
    const appel = p.callTool(
      cfg(),
      "lent",
      { ms: 400 },
      { resolveClient: resoudreClientMcp, signal: ctl.signal },
    );
    await attendre(80);
    const t0 = performance.now();
    ctl.abort(new DOMException("Stop", "AbortError"));
    await expect(appel).rejects.toThrow("Stop");
    expect(performance.now() - t0).toBeLessThan(100);
    await attendre(50);
    expect(srv.annulations).toBe(0);
    expect(p.entree(cfg())?.healthy).toBe(true);
  });

  it("serveur partagé injoignable : adresse masquée dans l'erreur vue par le modèle et le compte, message entier au journal ; serveur perso inchangé", async () => {
    const port = await portFerme();
    const url = `http://127.0.0.1:${port}/mcp`;
    const lignes: string[] = [];
    installerCrochetJournal((niveau, message) => void lignes.push(`${niveau} ${message}`));
    try {
      const p = pool();
      const appel = async (c: ConfigMcp): Promise<unknown> =>
        JSON.parse(await executerOutilMcp(new Map([["echo", c]]), "echo", {}, { timeoutS: 5, pool: p }));
      const complet = `Échec connexion MCP 'Intranet': MCP HTTP ${url} — ConnectError: connect ECONNREFUSED 127.0.0.1:${port}`;
      expect(await appel(marquerConfiance({ id: "shared:7", type: "http", name: "Intranet", url }))).toEqual({
        error:
          "Échec connexion MCP 'Intranet': MCP HTTP (adresse masquée) — ConnectError: connect ECONNREFUSED (adresse masquée)",
      });
      expect(lignes).toEqual([
        `WARNING [tools] 'echo' sur le serveur partagé 'Intranet' en échec : ${complet}`,
      ]);
      expect(await appel(marquerConfiance({ id: "p1", type: "http", name: "Intranet", url }))).toEqual({
        error: complet,
      });
      expect(lignes).toHaveLength(1);
    } finally {
      installerCrochetJournal(null);
    }
  });

  it("délai d'exécution : enveloppe timeout, l'outil continue côté serveur, connexion gardée", async () => {
    const p = pool();
    const carte = new Map([["lent", cfg()]]);
    const json = await executerOutilMcp(carte, "lent", { ms: 300 }, { timeoutS: 0.1, pool: p });
    expect(JSON.parse(json)).toMatchObject({ ok: false, error: "timeout" });
    expect(JSON.parse(json)["message"]).toContain("it may still be running on the server");
    await attendre(30);
    expect(srv.annulations).toBe(0);
    expect(p.entree(cfg())?.healthy).toBe(true);
    await expect(
      p.callTool(cfg(), "lent", { ms: 300 }, { resolveClient: resoudreClientMcp, execTimeoutS: 0.05 }),
    ).rejects.toBeInstanceOf(DelaiDepasse);
  });
});

describe("SSE historique", () => {
  it("connexion, outils, appel avec _meta", async () => {
    const c = new ClientMcpSse(`${srv.base}/sse`);
    ouverts.push(c);
    await c.connecter(signalLibre());
    expect((await c.listerOutils(signalLibre())).length).toBe(10);
    const res = await c.appelerOutil("echo", { s: 1 }, { meta: { username: "bob" }, signal: signalLibre() });
    expect(JSON.parse(texte(res))).toEqual({ args: { s: 1 }, meta: { username: "bob" } });
  });

  it("flux SSE coupé (redémarrage) : l'appel en vol échoue aussitôt en panne de transport, reconnexion et rejeu", async () => {
    const p = pool();
    const c = marquerConfiance({ type: "sse", name: "sse-redemarre", url: `${srv.base}/sse` });
    await p.callTool(c, "echo", {}, { resolveClient: resoudreClientMcp });
    const t0 = performance.now();
    const enVol = p.callTool(c, "lent", { ms: 300 }, { resolveClient: resoudreClientMcp, execTimeoutS: 8 });
    await attendre(60);
    srv.fermerFluxSse();
    expect(texte(await enVol)).toBe("fini");
    expect(performance.now() - t0).toBeLessThan(3000);
    const res = await p.callTool(c, "ecrire", { v: 2 }, { resolveClient: resoudreClientMcp });
    expect(JSON.parse(texte(res))).toEqual({ args: { v: 2 }, meta: null });
    expect(srv.appels.filter((a) => a.nom === "ecrire")).toHaveLength(1);
  });

  it("POST SSE sur une session inconnue (HTTP 404) : session perdue, rejeu même d'un outil mutant", async () => {
    const p = pool();
    const c = marquerConfiance({ type: "sse", name: "sse-404", url: `${srv.base}/sse` });
    await p.callTool(c, "echo", {}, { resolveClient: resoudreClientMcp });
    const entree = p.entree(c);
    srv.oublierSessionsSse();
    const res = await p.callTool(c, "ecrire", { v: 3 }, { resolveClient: resoudreClientMcp });
    expect(JSON.parse(texte(res))).toEqual({ args: { v: 3 }, meta: null });
    expect(p.entree(c)).not.toBe(entree);
    expect(srv.appels.filter((a) => a.nom === "ecrire")).toHaveLength(1);
    expect(srv.requetes.some((r) => r.chemin === "/messages" && r.methode === "POST")).toBe(true);
  });

  it("par le pool (type sse)", async () => {
    const p = pool();
    const res = await p.callTool(
      marquerConfiance({ type: "sse", name: "faux-sse", url: `${srv.base}/sse` }),
      "echo",
      {},
      { resolveClient: resoudreClientMcp },
    );
    expect(JSON.parse(texte(res))).toEqual({ args: {}, meta: null });
  });
});

describe("authentification et messages", () => {
  let protege: FauxServeur;
  beforeAll(async () => {
    protege = await demarrerFauxServeur({ jeton: "s3cr3t-jeton" });
  });
  afterAll(async () => {
    await protege.fermer();
  });

  it("en-têtes d'auth envoyés ; jeton refusé → message HTTP 401 du Python, jamais le jeton dans les journaux", async () => {
    const ecrits: string[] = [];
    const espion = vi.spyOn(process.stderr, "write").mockImplementation((t: string | Uint8Array) => {
      ecrits.push(String(t));
      return true;
    });
    try {
      const p = pool();
      const bon = marquerConfiance({
        type: "http",
        name: "protege",
        url: `${protege.base}/mcp`,
        headers: { Authorization: "Bearer s3cr3t-jeton" },
      });
      expect(texte(await p.callTool(bon, "echo", {}, { resolveClient: resoudreClientMcp }))).toContain(
        '"args":{}',
      );
      expect(protege.requetes.every((r) => r.autorisation === "Bearer s3cr3t-jeton")).toBe(true);
      const mauvais = marquerConfiance({
        type: "http",
        name: "refuse",
        url: `${protege.base}/mcp`,
        authorization: "Bearer faux-jeton-xyz",
      });
      const e = await p.getOrConnect(mauvais, resoudreClientMcp).catch((x: unknown) => x);
      expect(String((e as Error).message)).toBe(
        `Échec connexion MCP 'refuse': MCP HTTP ${protege.base}/mcp — HTTP 401 : jeton d'authentification refusé ou absent`,
      );
      expect(friendlyMcpError(e)).toBe(
        `Échec connexion MCP 'refuse': MCP HTTP ${protege.base}/mcp — HTTP 401 : jeton d'authentification refusé ou absent`,
      );
      expect(friendlyMcpError((e as Error).cause)).toBe(
        "HTTP 401 : jeton d'authentification refusé ou absent",
      );
    } finally {
      espion.mockRestore();
    }
    const journal = ecrits.join("");
    expect(journal).not.toContain("s3cr3t-jeton");
    expect(journal).not.toContain("faux-jeton-xyz");
  });

  it("serveur injoignable : message lisible ; identifiants et requête retirés des URL affichées", async () => {
    const libre = await demarrerFauxServeur();
    const url = `${libre.base}/mcp`;
    await libre.fermer();
    const c = new ClientMcpHttp(url);
    const e = await c.connecter(signalLibre()).catch((x: unknown) => x);
    expect(String((e as Error).message)).toMatch(
      new RegExp(`^MCP HTTP ${url.replaceAll(".", "\\.")} — ConnectError: `),
    );
    expect(friendlyMcpError(e)).toBe("Connexion impossible : serveur injoignable à cette adresse.");
    expect(await serviceJoignable(url, 200)).toBe(false);
    expect(await serviceJoignable(`${srv.base}/mcp`, 200)).toBe(true);
    expect(urlSansSecret("https://u:motdepasse@h:8443/mcp?token=abc#f")).toBe("https://h:8443/mcp?…");
    const avecSecret = new ClientMcpHttp(`http://u:motdepasse@127.0.0.1:${libre.port}/mcp?token=abc`);
    const e2 = await avecSecret.connecter(signalLibre()).catch((x: unknown) => x);
    expect(String((e2 as Error).message)).not.toContain("motdepasse");
    expect(String((e2 as Error).message)).not.toContain("token=abc");
  });
});

describe("identifiants dans l'URL et en-têtes invalides", () => {
  let basic: FauxServeur;
  beforeAll(async () => {
    basic = await demarrerFauxServeur({ basic: "bob:p@ss é" });
  });
  afterAll(async () => {
    await basic.fermer();
  });

  it("userinfo de l'URL → Basic (prioritaire sur un Authorization configuré, comme httpx), jamais transmis dans l'URL", async () => {
    const p = pool();
    const hote = basic.base.replace("http://", "");
    for (const [type, chemin] of [
      ["http", "/mcp"],
      ["sse", "/sse"],
    ] as const) {
      const c = marquerConfiance({
        type,
        name: `basic-${type}`,
        url: `http://bob:p%40ss%20%C3%A9@${hote}${chemin}`,
        authorization: "Bearer autre",
      });
      const res = await p.callTool(c, "echo", { t: type }, { resolveClient: resoudreClientMcp });
      expect(JSON.parse(texte(res))["args"]).toEqual({ t: type });
    }
    const attendu = `Basic ${Buffer.from("bob:p@ss é", "utf8").toString("base64")}`;
    expect(basic.requetes.length).toBeGreaterThan(0);
    expect(basic.requetes.every((r) => r.autorisation === attendu)).toBe(true);
  });

  it("serveur injoignable avec identifiants : ni le mot de passe ni la requête dans les messages (HTTP et SSE)", async () => {
    const libre = await demarrerFauxServeur();
    const hote = libre.base.replace("http://", "");
    await libre.fermer();
    const p = pool();
    for (const type of ["http", "sse"]) {
      const c = marquerConfiance({
        type,
        name: `ferme-${type}`,
        url: `http://bob:secret-xyz@${hote}/${type === "sse" ? "sse" : "mcp"}?token=jeton-abc`,
      });
      const e = await p.getOrConnect(c, resoudreClientMcp).catch((x: unknown) => x);
      const msg = `${String((e as Error).message)} ${friendlyMcpError(e)}`;
      expect(msg).not.toContain("secret-xyz");
      expect(msg).not.toContain("jeton-abc");
      expect(friendlyMcpError(e)).toBe((e as Error).message);
      expect(friendlyMcpError((e as Error).cause)).toBe(
        "Connexion impossible : serveur injoignable à cette adresse.",
      );
    }
  });

  it("valeur d'en-tête non transmissible (retour à la ligne) : refus explicite qui ne cite jamais la valeur", () => {
    const essai = (): unknown =>
      resoudreClientMcp({
        type: "sse",
        name: "casse",
        url: `${srv.base}/sse`,
        headers: { "X-K": "a\nsecret-123" },
      });
    expect(essai).toThrow(
      "En-tête « X-K » du serveur MCP « casse » invalide (nom ou valeur non transmissible).",
    );
    expect(() =>
      resoudreClientMcp({
        type: "http",
        name: "casse",
        url: `${srv.base}/mcp`,
        headers: { "mauvais nom": "v" },
      }),
    ).toThrow("En-tête « mauvais nom » du serveur MCP « casse » invalide");
    const e = (() => {
      try {
        essai();
      } catch (x) {
        return x as Error;
      }
      return null;
    })();
    expect(String(e?.message)).not.toContain("secret-123");
  });
});

describe("tolérance du protocole (comme pydantic)", () => {
  it("nextCursor: null et structuredContent: null acceptés", async () => {
    const http = createServer((req, res) => {
      void (async () => {
        const morceaux: Buffer[] = [];
        for await (const m of req) morceaux.push(m as Buffer);
        if (req.method !== "POST") {
          res.writeHead(405).end();
          return;
        }
        const msg = JSON.parse(Buffer.concat(morceaux).toString("utf8")) as Dict;
        if (msg["id"] === undefined) {
          res.writeHead(202).end();
          return;
        }
        const params = (msg["params"] ?? {}) as Dict;
        const resultat =
          msg["method"] === "initialize"
            ? {
                protocolVersion: params["protocolVersion"],
                capabilities: { tools: {} },
                serverInfo: { name: "brut", version: "1" },
              }
            : msg["method"] === "tools/list"
              ? { tools: [{ name: "t", inputSchema: { type: "object" } }], nextCursor: null }
              : { content: [{ type: "text", text: "ok" }], structuredContent: null };
        res
          .writeHead(200, { "content-type": "application/json", "mcp-session-id": "s1" })
          .end(JSON.stringify({ jsonrpc: "2.0", id: msg["id"], result: resultat }));
      })();
    });
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
    const c = http.address() as AddressInfo;
    const client = new ClientMcpHttp(`http://127.0.0.1:${c.port}/mcp`);
    try {
      await client.connecter(signalLibre());
      expect((await client.listerOutils(signalLibre())).map((o) => o["name"])).toEqual(["t"]);
      expect(texte(await client.appelerOutil("t", {}, { signal: signalLibre() }))).toBe("ok");
    } finally {
      await client.fermer();
      http.closeAllConnections();
      await new Promise<void>((r) => http.close(() => r()));
    }
  });
});

describe("résolution d'une config en client", () => {
  it("stdio des comptes et MCP en processus : refus explicite et journalisé, jamais un abandon silencieux", () => {
    const ecrits: string[] = [];
    const espion = vi.spyOn(process.stderr, "write").mockImplementation((t: string | Uint8Array) => {
      ecrits.push(String(t));
      return true;
    });
    try {
      expect(() => resoudreClientMcp({ type: "stdio", name: "perso", command: "npx srv" })).toThrow(
        TransportNonPrisEnCharge,
      );
      expect(() => resoudreClientMcp({ type: "stdio", name: "perso", command: "npx srv" })).toThrow(
        "Serveur MCP « perso » de type stdio (commande lancée sur le serveur) : non pris en charge par le core",
      );
      expect(() => resoudreClientMcp({ type: "inprocess", name: "elpis-memory" })).toThrow(
        "Entrée MCP « elpis-memory » servie en processus : aucun serveur MCP dans ce process",
      );
    } finally {
      espion.mockRestore();
    }
    expect(ecrits.filter((l) => l.includes("WARNING [mcp]"))).toHaveLength(3);
    expect(resoudreClientMcp({ type: "http", name: "x" })).toBeNull();
    expect(resoudreClientMcp({ type: "ws", url: "ws://x" })).toBeNull();
    expect(resoudreClientMcp({ url: `${srv.base}/sse` })).toBeInstanceOf(ClientMcpSse);
    expect(resoudreClientMcp({ type: "streamable-http", url: `${srv.base}/mcp` })).toBeInstanceOf(
      ClientMcpHttp,
    );
  });

  it("sentinelle des outils intégrés : entrée du manifeste (toolhost ou app réseau) jointe en HTTP avec son jeton", async () => {
    const protege = await demarrerFauxServeur({ jeton: "jeton-service" });
    const fichier = path.join(DOSSIER_MOTEUR, "mcp-sentinelle.json");
    writeFileSync(
      fichier,
      JSON.stringify({
        mcpServers: {
          "elpis-tools": {
            type: "http",
            url: `${protege.base}/mcp`,
            headers: { Authorization: "Bearer jeton-service" },
            "x-elpis": { role: "toolhost", families: ["fs"] },
          },
        },
      }),
    );
    const avant = process.env["APP_MCP_MANIFEST"];
    process.env["APP_MCP_MANIFEST"] = fichier;
    oublierManifeste();
    try {
      const p = pool();
      const sentinelle = {
        type: "stdio",
        name: "Outils Locaux",
        command: "DEFAULT_LOCAL_PYTHON",
        manifest: "elpis-tools",
      };
      const res = await p.callTool(
        sentinelle,
        "echo",
        {},
        { resolveClient: resoudreClientMcp, meta: { username: "alice" } },
      );
      expect(JSON.parse(texte(res))["meta"]).toEqual({ username: "alice" });
      expect(p.entree(sentinelle)?.persistent).toBe(true);
      const ctl = new AbortController();
      const lent = p.callTool(
        sentinelle,
        "lent",
        { ms: 400 },
        { resolveClient: resoudreClientMcp, signal: ctl.signal },
      );
      await attendre(80);
      ctl.abort(new DOMException("Stop", "AbortError"));
      await expect(lent).rejects.toThrow();
      await attendre(50);
      // Stop vers l'hôte d'outils intégré : annulation transmise (une attente détachée s'arrête).
      expect(protege.annulations).toBe(1);
    } finally {
      if (avant === undefined) delete process.env["APP_MCP_MANIFEST"];
      else process.env["APP_MCP_MANIFEST"] = avant;
      oublierManifeste();
      await protege.fermer();
    }
  });
});
