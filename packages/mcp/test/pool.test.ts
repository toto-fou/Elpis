// SPDX-License-Identifier: MIT
/** packages/mcp/test/pool.test.ts — pool unique : réutilisation, concurrence par entrée et par compte, bornes, classement des pannes, reconnexion et rejeu, drainage et nettoyage. */
import "./environnement";

import { afterEach, describe, expect, it } from "vitest";

import {
  CLEANUP_INTERVAL_SEC,
  codeMessageMcp,
  DRAINAGE_S,
  estAnnulation,
  estErreurTransport,
  estSessionPerdue,
  EXCLUSIVITE_NETTOYAGE_S,
  IDLE_TIMEOUT_SEC,
  MCP_HANDSHAKE_TIMEOUT_S,
  McpFileSaturee,
  PoolMcp,
} from "../src";
import type { ClientMcp, OptionsAppelClient, OptionsPool, OutilMcp } from "../src";
import { capturerJournal, lireVecteurs } from "./aides";

type Dict = Record<string, unknown>;
type Comportement = (nom: string, args: Dict, opts: OptionsAppelClient) => Promise<unknown>;

const journal = capturerJournal();
const DELAIS = lireVecteurs<{ delais: Dict }>("mcp-paquet").delais;

/** Erreur du SDK MCP telle que le client la lève (`McpError`). */
function erreurMcp(code: number, message: string): Error {
  const e = new Error(`MCP error ${code}: ${message}`) as Error & { code: number };
  e.name = "McpError";
  e.code = code;
  return e;
}

function erreurHttp(statut: number, texte: string): Error {
  const e = new Error(`Streamable HTTP error: ${texte}`) as Error & { code: number };
  e.name = "StreamableHTTPError";
  e.code = statut;
  return e;
}

function jamais(signal?: AbortSignal): Promise<never> {
  return new Promise((_, reject) =>
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true }),
  );
}

const attendre = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

class FauxClient implements ClientMcp {
  static crees: FauxClient[] = [];
  readonly correle: boolean;
  outils: OutilMcp[] = [{ name: "lire", inputSchema: { type: "object" } }];
  connexions = 0;
  listes = 0;
  fermetures = 0;
  appels: { nom: string; args: Dict; meta: unknown }[] = [];
  enCours = 0;
  maxEnCours = 0;
  comportement: Comportement = async (nom) => ({ ok: nom });
  surConnexion: (signal: AbortSignal) => Promise<void> = async () => undefined;
  surListe: (signal: AbortSignal) => Promise<OutilMcp[]> = async () => this.outils;

  constructor(correle = true) {
    this.correle = correle;
    FauxClient.crees.push(this);
  }

  async connecter(signal: AbortSignal): Promise<void> {
    this.connexions++;
    await this.surConnexion(signal);
  }

  async listerOutils(signal: AbortSignal): Promise<OutilMcp[]> {
    this.listes++;
    return this.surListe(signal);
  }

  async appelerOutil(nom: string, args: Dict, opts: OptionsAppelClient): Promise<unknown> {
    this.appels.push({ nom, args, meta: opts.meta });
    this.enCours++;
    this.maxEnCours = Math.max(this.maxEnCours, this.enCours);
    try {
      return await this.comportement(nom, args, opts);
    } finally {
      this.enCours--;
    }
  }

  async fermer(): Promise<void> {
    this.fermetures++;
  }
}

const pools: PoolMcp[] = [];

function pool(options: Partial<OptionsPool> = {}): PoolMcp {
  const p = new PoolMcp({ rejouable: () => true, parallelisme: () => 4, ttlOutilsS: () => 360, ...options });
  pools.push(p);
  return p;
}

const CFG = { type: "http", url: "http://srv/mcp", name: "srv" };
const INTEGREE = {
  type: "stdio",
  command: "DEFAULT_LOCAL_PYTHON",
  manifest: "elpis-tools",
  name: "elpis-tools",
};

afterEach(async () => {
  for (const p of pools.splice(0)) {
    await p.closeAll();
    await p.attendreFermetures();
  }
  FauxClient.crees = [];
  journal.length = 0;
});

describe("délais", () => {
  it("bornes identiques au Python (inactivité, nettoyage, poignée de main, drainage, exclusivité)", () => {
    expect(IDLE_TIMEOUT_SEC).toBe(DELAIS["IDLE_TIMEOUT_SEC"]);
    expect(CLEANUP_INTERVAL_SEC).toBe(DELAIS["CLEANUP_INTERVAL_SEC"]);
    expect(MCP_HANDSHAKE_TIMEOUT_S).toBe(DELAIS["MCP_HANDSHAKE_TIMEOUT_S"]);
    expect([DRAINAGE_S]).toEqual(DELAIS["drainage"]);
    expect([EXCLUSIVITE_NETTOYAGE_S]).toEqual(DELAIS["exclusivite_nettoyage"]);
    const p = pool();
    expect(p.IDLE_TIMEOUT_SEC).toBe(600);
    expect(p.CLEANUP_INTERVAL_SEC).toBe(120);
  });
});

describe("classement des pannes", () => {
  it("transport : codes réseau, fetch, session perdue, connexion fermée, causes et groupes", () => {
    const reseau = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" });
    expect(estErreurTransport(reseau)).toBe(true);
    expect(estErreurTransport(new TypeError("fetch failed", { cause: reseau }))).toBe(true);
    expect(estErreurTransport(new Error("enveloppe", { cause: reseau }))).toBe(true);
    expect(estErreurTransport(new AggregateError([new Error("x"), reseau]))).toBe(true);
    expect(estErreurTransport(erreurMcp(-32000, "Connection closed"))).toBe(true);
    expect(estErreurTransport(erreurHttp(502, "Error POSTing to endpoint (HTTP 502): Bad Gateway"))).toBe(
      true,
    );
    expect(estErreurTransport(new Error("Not connected"))).toBe(true);
    expect(estErreurTransport(erreurMcp(-32603, "boom"))).toBe(false);
    expect(estErreurTransport(erreurMcp(-32602, "Invalid params"))).toBe(false);
    expect(estErreurTransport(new Error("autre"))).toBe(false);
  });

  it("session perdue : HTTP 404 sur la session ou « session terminated »", () => {
    expect(estSessionPerdue(erreurHttp(404, "Error POSTing to endpoint (HTTP 404): Session not found"))).toBe(
      true,
    );
    expect(estSessionPerdue(erreurMcp(32600, "Session terminated"))).toBe(true);
    expect(estSessionPerdue(erreurHttp(500, "x"))).toBe(false);
    expect(codeMessageMcp(erreurMcp(-32602, "Invalid params: x"))).toEqual([-32602, "Invalid params: x"]);
    expect(codeMessageMcp(new Error("x"))).toEqual([null, ""]);
  });

  it("annulation : seulement si le signal de l'appelant est annulé", () => {
    const ctl = new AbortController();
    const abandon = new DOMException("arrêt", "AbortError");
    expect(estAnnulation(abandon, ctl.signal)).toBe(false);
    ctl.abort(abandon);
    expect(estAnnulation(abandon, ctl.signal)).toBe(true);
    expect(estAnnulation(new Error("x"), ctl.signal)).toBe(false);
  });
});

describe("connexion et cache d'outils", () => {
  it("une seule poignée de main pour des demandes simultanées, puis réutilisation", async () => {
    const p = pool();
    let crees = 0;
    const resoudre = (): ClientMcp => {
      crees++;
      const c = new FauxClient();
      c.surConnexion = () => attendre(20);
      return c;
    };
    const res = await Promise.all(Array.from({ length: 5 }, () => p.getOrConnect(CFG, resoudre)));
    expect(crees).toBe(1);
    expect(new Set(res.map(([c]) => c)).size).toBe(1);
    expect(res[0]?.[1]).toEqual([{ name: "lire", inputSchema: { type: "object" } }]);
    await p.getOrConnect(CFG, resoudre);
    expect(crees).toBe(1);
    expect(FauxClient.crees[0]?.listes).toBe(1);
  });

  it("outils rafraîchis après le TTL sur la même connexion ; échec du rafraîchissement → reconnexion", async () => {
    let ttl = 360;
    const p = pool({ ttlOutilsS: () => ttl });
    const resoudre = (): ClientMcp => new FauxClient();
    await p.getOrConnect(CFG, resoudre);
    ttl = 0;
    await attendre(5);
    const premier = FauxClient.crees[0] as FauxClient;
    premier.outils = [{ name: "neuf" }];
    const [c, outils] = await p.getOrConnect(CFG, resoudre);
    expect(c).toBe(premier);
    expect(outils).toEqual([{ name: "neuf" }]);
    expect(premier.listes).toBe(2);
    premier.surListe = () => Promise.reject(new Error("liste en panne"));
    await attendre(5);
    const [c2] = await p.getOrConnect(CFG, resoudre);
    expect(c2).not.toBe(premier);
    await p.attendreFermetures();
    expect(premier.fermetures).toBe(1);
    expect(
      journal.some((l) => l.message.includes("Échec rafraîchissement outils 'srv': liste en panne")),
    ).toBe(true);
  });

  it("poignée de main bornée : message Python (raison vide sur délai), client fermé", async () => {
    const p = pool({ delaiPoigneeS: 0.03 });
    const c = new FauxClient();
    c.surConnexion = (s) => jamais(s);
    await expect(p.getOrConnect(CFG, () => c)).rejects.toThrow(/^Échec connexion MCP 'srv': $/);
    expect(c.fermetures).toBe(1);
    expect(p.taille).toBe(0);
    const d = new FauxClient();
    d.surConnexion = () => Promise.reject(new Error("refusé"));
    await expect(p.getOrConnect(CFG, () => d)).rejects.toThrow("Échec connexion MCP 'srv': refusé");
  });

  it("config sans client, pool fermé puis rouvert par reset", async () => {
    const p = pool();
    await expect(p.getOrConnect(CFG, () => null)).rejects.toThrow("Config MCP invalide: srv");
    await expect(p.getOrConnect(CFG, null)).rejects.toThrow(
      "resolve_client_fn requis pour créer une connexion MCP.",
    );
    await p.closeAll();
    await expect(p.getOrConnect(CFG, () => new FauxClient())).rejects.toThrow("MCPConnectionPool est fermé.");
    await p.reset();
    await expect(p.getOrConnect(CFG, () => new FauxClient())).resolves.toHaveLength(2);
  });

  it("annulation pendant la poignée de main : rejet par la raison, rien d'inscrit", async () => {
    const p = pool();
    const c = new FauxClient();
    c.surConnexion = (s) => jamais(s);
    const ctl = new AbortController();
    const appel = p.getOrConnect(CFG, () => c, { signal: ctl.signal });
    ctl.abort(new DOMException("Stop", "AbortError"));
    await expect(appel).rejects.toThrow("Stop");
    expect(p.taille).toBe(0);
  });

  it("service intégré : registre de catégories nourri à la connexion, ses pannes ignorées, entrée persistante", async () => {
    const vus: string[] = [];
    const p = pool({
      surConnexionIntegree: (outils) => {
        vus.push(...outils.map((o) => String(o["name"])));
        throw new Error("registre en panne");
      },
    });
    await p.getOrConnect(INTEGREE, () => new FauxClient());
    await p.getOrConnect(CFG, () => new FauxClient());
    expect(vus).toEqual(["lire"]);
    expect(p.entree(INTEGREE)?.persistent).toBe(true);
    expect(p.entree(CFG)?.persistent).toBe(false);
  });
});

describe("appels d'outils", () => {
  it("le _meta n'est transmis que s'il est non vide ; le résultat du serveur est rendu tel quel", async () => {
    const p = pool();
    const c = new FauxClient();
    expect(await p.callTool(CFG, "lire", { a: 1 }, { resolveClient: () => c, meta: {} })).toEqual({
      ok: "lire",
    });
    await p.callTool(CFG, "lire", {}, { resolveClient: () => c, meta: { username: "alice", chat_id: "c1" } });
    expect(c.appels.map((a) => a.meta)).toEqual([undefined, { username: "alice", chat_id: "c1" }]);
    expect(c.appels[0]?.args).toEqual({ a: 1 });
  });

  it("erreur côté serveur : remontée telle quelle, connexion gardée, aucun rejeu", async () => {
    const p = pool();
    let crees = 0;
    const c = new FauxClient();
    c.comportement = () => Promise.reject(erreurMcp(-32603, "boom"));
    const resoudre = (): ClientMcp => {
      crees++;
      return c;
    };
    await expect(p.callTool(CFG, "lire", {}, { resolveClient: resoudre })).rejects.toThrow(
      "MCP error -32603: boom",
    );
    expect(crees).toBe(1);
    expect(c.appels).toHaveLength(1);
    expect(p.entree(CFG)?.healthy).toBe(true);
    expect(
      journal.some((l) => l.message.includes("a échoué côté SERVEUR (McpError: MCP error -32603: boom)")),
    ).toBe(true);
  });

  it("rupture de tuyau : reconnexion puis rejeu d'un outil rejouable", async () => {
    const p = pool();
    const resoudre = (): ClientMcp => {
      const c = new FauxClient();
      if (FauxClient.crees.length === 1)
        c.comportement = () =>
          Promise.reject(new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }));
      return c;
    };
    expect(await p.callTool(CFG, "lire", { x: 1 }, { resolveClient: resoudre })).toEqual({ ok: "lire" });
    const [a, b] = FauxClient.crees as [FauxClient, FauxClient];
    expect(a.appels).toHaveLength(1);
    expect(b.appels).toHaveLength(1);
    await p.attendreFermetures();
    expect(a.fermetures).toBe(1);
    expect(journal.some((l) => l.niveau === "warn" && l.message.includes("Tentative de reconnexion"))).toBe(
      true,
    );
  });

  it("outil mutant : reconnexion mais jamais de rejeu après une rupture", async () => {
    const p = pool({ rejouable: (nom) => nom !== "ecrire" });
    const resoudre = (): ClientMcp => {
      const c = new FauxClient();
      if (FauxClient.crees.length === 1)
        c.comportement = () => Promise.reject(erreurMcp(-32000, "Connection closed"));
      return c;
    };
    await expect(p.callTool(CFG, "ecrire", {}, { resolveClient: resoudre })).rejects.toThrow(
      "Connection closed",
    );
    expect(FauxClient.crees).toHaveLength(2);
    expect(FauxClient.crees[1]?.appels).toHaveLength(0);
    expect(p.entree(CFG)?.client).toBe(FauxClient.crees[1]);
    expect(journal.some((l) => l.message.includes("'ecrire' NON rejoué après reconnexion"))).toBe(true);
  });

  it("session perdue (HTTP 404) : la requête n'a pas été exécutée, rejouée même pour un outil mutant", async () => {
    const p = pool({ rejouable: () => false });
    const resoudre = (): ClientMcp => {
      const c = new FauxClient();
      if (FauxClient.crees.length === 1)
        c.comportement = () =>
          Promise.reject(erreurHttp(404, "Error POSTing to endpoint (HTTP 404): Session not found"));
      return c;
    };
    expect(await p.callTool(CFG, "ecrire", {}, { resolveClient: resoudre })).toEqual({ ok: "ecrire" });
    expect(FauxClient.crees[1]?.appels).toHaveLength(1);
  });

  it("« Not connected » (client déjà fermé) : la requête n'est jamais partie, rejouée même pour un outil mutant", async () => {
    const p = pool({ rejouable: () => false });
    const resoudre = (): ClientMcp => {
      const c = new FauxClient();
      if (FauxClient.crees.length === 1) c.comportement = () => Promise.reject(new Error("Not connected"));
      return c;
    };
    expect(await p.callTool(CFG, "ecrire", {}, { resolveClient: resoudre })).toEqual({ ok: "ecrire" });
    expect(FauxClient.crees[1]?.appels).toHaveLength(1);
  });

  it("délai d'exécution démesuré ou infini : l'appel aboutit (pas de délai immédiat)", async () => {
    const p = pool();
    const c = new FauxClient();
    c.comportement = () => attendre(20).then(() => "fini");
    expect(await p.callTool(CFG, "lire", {}, { resolveClient: () => c, execTimeoutS: 3e6 })).toBe("fini");
    expect(await p.callTool(CFG, "lire", {}, { resolveClient: () => c, execTimeoutS: Infinity })).toBe(
      "fini",
    );
  });

  it("reconnexion déjà faite par un appel concurrent : rattachement à l'entrée saine", async () => {
    const p = pool();
    let crees = 0;
    let liberer: () => void = () => undefined;
    const porte = new Promise<void>((r) => (liberer = r));
    const resoudre = (): ClientMcp => {
      crees++;
      const c = new FauxClient();
      if (crees === 1)
        c.comportement = async () => {
          await porte;
          throw new TypeError("fetch failed");
        };
      return c;
    };
    await p.getOrConnect(CFG, resoudre);
    const appels = [1, 2].map(() => p.callTool(CFG, "lire", {}, { resolveClient: resoudre }));
    await attendre(5);
    liberer();
    expect(await Promise.all(appels)).toEqual([{ ok: "lire" }, { ok: "lire" }]);
    expect(crees).toBe(2);
    expect(journal.some((l) => l.message.includes("a déjà été reconnecté par un autre appel"))).toBe(true);
  });

  it("délai d'exécution : TimeoutError sans rejeu ; entrée corrélée gardée, transport sériel déclaré malsain", async () => {
    const p = pool();
    const c = new FauxClient();
    c.comportement = (_n, _a, o) => jamais(o.signal);
    const t0 = performance.now();
    await expect(
      p.callTool(CFG, "lire", {}, { resolveClient: () => c, execTimeoutS: 0.05 }),
    ).rejects.toMatchObject({
      name: "TimeoutError",
      message: "",
    });
    expect(performance.now() - t0).toBeGreaterThanOrEqual(45);
    expect(c.appels).toHaveLength(1);
    expect(p.entree(CFG)?.healthy).toBe(true);
    const seriel = new FauxClient(false);
    seriel.comportement = (_n, _a, o) => jamais(o.signal);
    const cfg2 = { ...CFG, url: "http://serie/mcp" };
    await expect(
      p.callTool(cfg2, "lire", {}, { resolveClient: () => seriel, execTimeoutS: 0.02 }),
    ).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(p.entree(cfg2)?.healthy).toBe(false);
  });

  it("annulation (Stop) : rejet par la raison de l'appelant, pas de reconnexion", async () => {
    const p = pool();
    const c = new FauxClient();
    c.comportement = (_n, _a, o) => jamais(o.signal);
    const ctl = new AbortController();
    const appel = p.callTool(CFG, "lire", {}, { resolveClient: () => c, signal: ctl.signal });
    await attendre(5);
    const raison = new DOMException("Stop", "AbortError");
    ctl.abort(raison);
    await expect(appel).rejects.toBe(raison);
    expect(FauxClient.crees).toHaveLength(1);
    expect(p.entree(CFG)?.healthy).toBe(true);
  });

  it("file saturée : McpFileSaturee (l'appel n'a pas été exécuté) quand la place ne se libère pas à temps", async () => {
    const p = pool({ parallelisme: () => 1 });
    const c = new FauxClient();
    let liberer: () => void = () => undefined;
    const porte = new Promise<void>((r) => (liberer = r));
    c.comportement = () => porte.then(() => "fini");
    const premier = p.callTool(CFG, "lire", {}, { resolveClient: () => c });
    await attendre(5);
    const second = p.callTool(CFG, "lire", {}, { resolveClient: () => c, queueTimeoutS: 0.03 });
    await expect(second).rejects.toBeInstanceOf(McpFileSaturee);
    await expect(second).rejects.toThrow(
      "file d'attente d'outils saturée (> 0s) — l'appel n'a pas été exécuté",
    );
    expect(c.appels).toHaveLength(1);
    liberer();
    expect(await premier).toBe("fini");
  });

  it("(re)connexion trop longue dans la borne de file : McpFileSaturee, rien d'exécuté", async () => {
    const p = pool({ delaiPoigneeS: 5 });
    const c = new FauxClient();
    c.surConnexion = (s) => jamais(s);
    await expect(
      p.callTool(CFG, "lire", {}, { resolveClient: () => c, queueTimeoutS: 0.03 }),
    ).rejects.toThrow("(re)connexion à 'srv' trop longue (> 0s) — l'appel n'a pas été exécuté");
    expect(c.appels).toHaveLength(0);
  });

  it("part d'un compte : la moitié des places d'une entrée partagée, les autres comptes passent", async () => {
    const p = pool({ parallelisme: () => 4 });
    const c = new FauxClient();
    let liberer: () => void = () => undefined;
    const porte = new Promise<void>((r) => (liberer = r));
    c.comportement = async (_n, args) => {
      await porte;
      return args["i"];
    };
    await p.getOrConnect(CFG, () => c);
    const alice = [1, 2, 3].map((i) =>
      p.callTool(CFG, "lire", { i }, { resolveClient: () => c, meta: { username: "alice" } }),
    );
    await attendre(5);
    expect(c.enCours).toBe(2);
    const bob = p.callTool(CFG, "lire", { i: 9 }, { resolveClient: () => c, meta: { username: "bob" } });
    await attendre(5);
    expect(c.enCours).toBe(3);
    liberer();
    expect(await Promise.all([...alice, bob])).toEqual([1, 2, 3, 9]);
    expect(c.maxEnCours).toBe(3);
  });

  it("transport sériel : un appel à la fois", async () => {
    const p = pool({ parallelisme: () => 8 });
    const c = new FauxClient(false);
    c.comportement = async () => {
      await attendre(5);
      return 1;
    };
    await Promise.all([1, 2, 3].map(() => p.callTool(CFG, "lire", {}, { resolveClient: () => c })));
    expect(c.maxEnCours).toBe(1);
    expect(p.entree(CFG)?.maxConcurrency).toBe(1);
  });
});

describe("fermeture, drainage et nettoyage", () => {
  it("invalidate draine l'appel en vol avant de fermer", async () => {
    const p = pool();
    const c = new FauxClient();
    c.comportement = async () => {
      await attendre(30);
      return "fini";
    };
    const appel = p.callTool(CFG, "lire", {}, { resolveClient: () => c });
    await attendre(5);
    await p.invalidate(CFG);
    expect(c.fermetures).toBe(1);
    expect(await appel).toBe("fini");
    expect(p.taille).toBe(0);
  });

  it("fermeture forcée après la borne de drainage si un appel reste bloqué", async () => {
    const p = pool({ drainageS: 0.03 });
    const c = new FauxClient();
    c.comportement = () => new Promise(() => undefined);
    void p.callTool(CFG, "lire", {}, { resolveClient: () => c }).catch(() => undefined);
    await attendre(5);
    const t0 = performance.now();
    await p.invalidate(CFG);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(25);
    expect(c.fermetures).toBe(1);
    expect(journal.some((l) => l.niveau === "warn" && l.message.includes("Fermeture forcée"))).toBe(true);
  });

  it("une annulation de l'appelant n'interrompt pas la fermeture détachée", async () => {
    let ttl = 360;
    const p = pool({ ttlOutilsS: () => ttl });
    const c = new FauxClient();
    c.comportement = () => attendre(30).then(() => "ok");
    await p.getOrConnect(CFG, () => c);
    const appel = p.callTool(CFG, "lire", {}, { resolveClient: () => c });
    await attendre(2);
    ttl = 0;
    c.surListe = () => Promise.reject(new Error("liste en panne"));
    const ctl = new AbortController();
    let crees = 0;
    const reconnexion = p.getOrConnect(CFG, () => (crees++, new FauxClient()), { signal: ctl.signal });
    await attendre(5);
    ctl.abort(new DOMException("Stop", "AbortError"));
    await expect(reconnexion).rejects.toThrow("Stop");
    expect(c.fermetures).toBe(0);
    expect(await appel).toBe("ok");
    await p.attendreFermetures();
    expect(c.fermetures).toBe(1);
    expect(crees).toBe(0);
    expect(p.entree(CFG)).toBeUndefined();
  });

  it("nettoyage : connexion inactive fermée, occupée épargnée, persistante jamais", async () => {
    const p = pool({ inactiviteS: 0.01 });
    const inactive = new FauxClient();
    const occupee = new FauxClient();
    let liberer: () => void = () => undefined;
    occupee.comportement = () => new Promise((r) => (liberer = () => r("ok")));
    const cfgOccupee = { ...CFG, url: "http://occupe/mcp" };
    await p.getOrConnect(CFG, () => inactive);
    await p.getOrConnect(INTEGREE, () => new FauxClient());
    const appel = p.callTool(cfgOccupee, "lire", {}, { resolveClient: () => occupee });
    await attendre(30);
    await p.passeNettoyage();
    expect(p.entree(CFG)).toBeUndefined();
    expect(inactive.fermetures).toBe(1);
    expect(p.entree(INTEGREE)).toBeDefined();
    expect(p.entree(cfgOccupee)).toBeDefined();
    liberer();
    await appel;
  });

  it("reset garde les services intégrés par défaut ; keepPersistent=false recycle tout", async () => {
    const p = pool();
    await p.getOrConnect(CFG, () => new FauxClient());
    await p.getOrConnect(INTEGREE, () => new FauxClient());
    await p.reset();
    expect(p.entree(CFG)).toBeUndefined();
    expect(p.entree(INTEGREE)).toBeDefined();
    await p.reset({ keepPersistent: false });
    expect(p.taille).toBe(0);
    expect(FauxClient.crees.every((c) => c.fermetures === 1)).toBe(true);
  });
});
