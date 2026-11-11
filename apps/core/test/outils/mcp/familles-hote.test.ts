// SPDX-License-Identifier: MIT
/** apps/core/test/outils/mcp/familles-hote.test.ts — entrée de l'hôte d'outils à plusieurs familles : une connexion MCP par famille, outils fusionnés comme le tools/list agrégé du Python, identité, progression, battements et abandon par connexion, famille injoignable, muette ou à la session perdue sans effet sur les autres. */
import { DOSSIER_MOTEUR } from "../../moteur-environnement";

import { writeFileSync } from "node:fs";
import path from "node:path";

import { FAMILY_NAMES, oublierManifeste, PoolMcp } from "@elpis/mcp";
import type { ConfigMcp } from "@elpis/mcp";
import { getUsername, Heartbeat } from "@elpis/outils-mcp";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { lireGolden } from "../../../../../packages/outils-mcp/test/familles-test";
import { argumentsRequis, hoteDesGoldens } from "../../../../../packages/outils-mcp/test/hote-goldens";
import type { HoteGoldens } from "../../../../../packages/outils-mcp/test/hote-goldens";
import { installerCrochetJournal } from "../../../src/journal";
import {
  brancherDelaiFamille,
  ClientMcpHttp,
  ClientMcpParFamille,
  delaiFamilleMs,
  executerOutilMcp,
  resoudreClientMcp,
} from "../../../src/outils/mcp/clients";

type Dict = Record<string, unknown>;

const SENTINELLE: ConfigMcp = {
  type: "stdio",
  name: "Outils Locaux",
  command: "DEFAULT_LOCAL_PYTHON",
  manifest: "elpis-tools",
};
/** Contenu structuré de l'appel, enveloppe `result` des sorties emballées par FastMCP retirée. */
const sortie = (r: unknown): unknown => {
  const sc = (r as { structuredContent?: Dict }).structuredContent;
  return sc && "result" in sc ? sc["result"] : sc;
};
const AGREGE = FAMILY_NAMES.flatMap((f) => lireGolden(f).outils);
/** Un outil par famille dont le schéma de sortie admet la réponse d'essai. */
const OUTIL: Record<string, string> = { fs: "code", memory: "memory", git: "git_query" };
const args = (famille: string): Record<string, unknown> =>
  argumentsRequis(lireGolden(famille), OUTIL[famille] ?? "");

let hote: HoteGoldens;
const pools: PoolMcp[] = [];
const fichier = path.join(DOSSIER_MOTEUR, "mcp-familles-hote.json");

function manifeste(entree: Dict): void {
  writeFileSync(fichier, JSON.stringify({ mcpServers: { "elpis-tools": entree } }));
  oublierManifeste();
}

function pool(o: Partial<ConstructorParameters<typeof PoolMcp>[0]> = {}): PoolMcp {
  const p = new PoolMcp({ rejouable: () => true, parallelisme: () => 4, ttlOutilsS: () => 360, ...o });
  pools.push(p);
  return p;
}

beforeAll(async () => {
  hote = await hoteDesGoldens({
    familles: FAMILY_NAMES,
    traiter: async (nom, famille, _args, ctx) => {
      const ms = Number(ctx.meta?.["attente_ms"] ?? 0);
      if (ms > 0) {
        await ctx.reportProgress(1, 2, `${famille} à mi-chemin`);
        await new Heartbeat(ctx, { intervalS: 0.03 }).avec(() => new Promise((fin) => setTimeout(fin, ms)));
      }
      return { ok: true, outil: nom, famille, compte: getUsername(ctx) };
    },
  });
  vi.stubEnv("APP_MCP_MANIFEST", fichier);
});

afterEach(async () => {
  for (const p of pools.splice(0)) {
    await p.closeAll();
    await p.attendreFermetures();
  }
  hote.chemins.length = 0;
  hote.enPanne.clear();
  hote.muettes.clear();
  brancherDelaiFamille(undefined);
  installerCrochetJournal(null);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  oublierManifeste();
  await hote.arreter();
});

const toolhost = (familles: readonly string[], url = `${hote.base}/mcp`): Dict => ({
  type: "http",
  url,
  "x-elpis": { role: "toolhost", families: familles },
});

describe("entrée de l'hôte d'outils à plusieurs familles", () => {
  it("une connexion par famille ; outils fusionnés = tools/list agrégé du Python (goldens B3-00 : noms, ordre, définitions) = connexion unique à /mcp", async () => {
    manifeste(toolhost([...FAMILY_NAMES].reverse()));
    const [client, outils] = await pool().getOrConnect(SENTINELLE, resoudreClientMcp);
    expect(client).toBeInstanceOf(ClientMcpParFamille);
    expect(outils).toEqual(AGREGE);
    expect(outils).toHaveLength(89);
    const chemins = new Set(hote.chemins.map((c) => c.split("?")[0]));
    expect([...chemins].sort()).toEqual(FAMILY_NAMES.map((f) => `/mcp/${f}`).sort());

    const unique = new ClientMcpHttp(`${hote.base}/mcp`);
    try {
      await unique.connecter(new AbortController().signal);
      expect(await unique.listerOutils(new AbortController().signal)).toEqual(outils);
    } finally {
      await unique.fermer();
    }
  });

  it("une seule famille, une entrée qui n'est pas une racine de montage, une entrée réseau perso : une seule connexion, à l'URL déclarée", async () => {
    manifeste(toolhost(["fs"]));
    const p = pool();
    const [seule, outils] = await p.getOrConnect(SENTINELLE, resoudreClientMcp);
    expect(seule).toBeInstanceOf(ClientMcpHttp);
    expect(outils).toEqual(AGREGE);
    expect(new Set(hote.chemins.map((c) => c.split("?")[0]))).toEqual(new Set(["/mcp"]));

    manifeste(toolhost(["fs", "todo"], `${hote.base}/mcp/fs`));
    expect(resoudreClientMcp(SENTINELLE)).toBeInstanceOf(ClientMcpHttp);
    manifeste({ ...toolhost(["fs", "todo"]), "x-elpis": { role: "app", families: ["fs", "todo"] } });
    expect(resoudreClientMcp(SENTINELLE)).toBeInstanceOf(ClientMcpHttp);
    expect(resoudreClientMcp({ type: "http", name: "perso", url: `${hote.base}/mcp` })).toBeInstanceOf(
      ClientMcpHttp,
    );
  });

  it("SSE : une connexion par famille sur /sse/<famille>", async () => {
    manifeste({ ...toolhost(["fs", "todo"], `${hote.base}/sse`), type: "sse" });
    const [client, outils] = await pool().getOrConnect(SENTINELLE, resoudreClientMcp);
    expect(client).toBeInstanceOf(ClientMcpParFamille);
    expect(outils).toEqual([...lireGolden("fs").outils, ...lireGolden("todo").outils]);
    expect(hote.chemins.filter((c) => c.startsWith("/sse")).sort()).toEqual(["/sse/fs", "/sse/todo"]);
  });

  it("identité `_meta`, progression et battements rendus à l'appel de chaque connexion ; l'abandon d'un appel laisse l'autre famille finir", async () => {
    manifeste(toolhost(FAMILY_NAMES));
    const p = pool();
    const appel = (famille: string, compte: string, id: string, ms: number, signal?: AbortSignal) => {
      const progres: string[] = [];
      const battements: unknown[] = [];
      const r = p.callTool(SENTINELLE, OUTIL[famille] ?? "", args(famille), {
        resolveClient: resoudreClientMcp,
        meta: { username: compte, call_id: id, attente_ms: ms },
        onProgress: (x) => void progres.push(String(x.message)),
        onLog: (x) => void battements.push((x["data"] as Dict | undefined)?.["extra"]),
        signal,
      });
      return { r, progres, battements };
    };
    const a = appel("fs", "alice", "a", 200);
    const b = appel("memory", "bob", "b", 200);
    expect(sortie(await a.r)).toMatchObject({ famille: "fs", compte: "alice" });
    expect(sortie(await b.r)).toMatchObject({ famille: "memory", compte: "bob" });
    expect(a.progres).toEqual(["fs à mi-chemin"]);
    expect(b.progres).toEqual(["memory à mi-chemin"]);
    expect(a.battements.length).toBeGreaterThan(0);
    expect(a.battements.every((x) => (x as Dict)["call_id"] === "a")).toBe(true);
    expect(b.battements.every((x) => (x as Dict)["call_id"] === "b")).toBe(true);

    const stop = new AbortController();
    const long = appel("fs", "alice", "c", 2000, stop.signal);
    const court = appel("git", "bob", "d", 300);
    setTimeout(() => stop.abort(), 100);
    await expect(long.r).rejects.toThrow();
    expect(sortie(await court.r)).toMatchObject({ famille: "git", compte: "bob" });
    expect(p.entree(SENTINELLE)?.healthy).toBe(true);
  });

  it("une famille injoignable : les autres servies, avertissement au journal, appel refusé lisiblement ; elle revient au rafraîchissement ; toutes injoignables = entrée en panne", async () => {
    manifeste(toolhost(FAMILY_NAMES));
    const lignes: string[] = [];
    installerCrochetJournal((niveau, message) => void lignes.push(`${niveau} ${message}`));
    hote.enPanne.add("desktop");
    const ingestions: number[] = [];
    const p = pool({ relisteIncompletS: 0.05, surConnexionIntegree: (o) => void ingestions.push(o.length) });
    const [client, outils] = await p.getOrConnect(SENTINELLE, resoudreClientMcp);
    expect(outils).toEqual(AGREGE.filter((t) => !String(t["name"]).startsWith("desktop_")));
    expect((client as ClientMcpParFamille).incomplet()).toBe(true);
    expect(
      lignes.filter((l) =>
        l.includes("famille(s) desktop de 'elpis-tools' injoignable(s), outils retirés : HTTP 503"),
      ),
    ).toHaveLength(1);
    const carte = new Map(AGREGE.map((t) => [String(t["name"]), SENTINELLE]));
    const refus = JSON.parse(
      await executerOutilMcp(carte, "desktop_session", {}, { timeoutS: 5, pool: p }),
    ) as Dict;
    expect(refus["error"]).toContain("famille(s) desktop de 'elpis-tools' injoignable(s)");
    expect(
      JSON.parse(
        await executerOutilMcp(carte, OUTIL["git"] ?? "", args("git"), {
          timeoutS: 5,
          pool: p,
          meta: { username: "u" },
        }),
      ),
    ).toMatchObject({ famille: "git", compte: "u" });

    hote.enPanne.clear();
    await new Promise((fin) => setTimeout(fin, 80));
    expect((await p.getOrConnect(SENTINELLE, resoudreClientMcp))[1]).toEqual(AGREGE);
    expect(ingestions).toEqual([78, 89]);
    expect((client as ClientMcpParFamille).incomplet()).toBe(false);
    expect(
      JSON.parse(await executerOutilMcp(carte, "desktop_session", {}, { timeoutS: 5, pool: p })),
    ).toMatchObject({ famille: "desktop" });

    hote.enPanne.add("desktop");
    await client.listerOutils(new AbortController().signal);
    expect(
      lignes.filter((l) => l.includes("famille(s) desktop de 'elpis-tools' injoignable(s)")),
    ).toHaveLength(2);

    for (const f of FAMILY_NAMES) hote.enPanne.add(f);
    await expect(pool().getOrConnect(SENTINELLE, resoudreClientMcp)).rejects.toThrow(
      "Échec connexion MCP 'Outils Locaux'",
    );
  });

  it("borne d'une famille entière quel que soit le délai de poignée de main (AbortSignal.timeout l'exige), sans borne s'il est infini", () => {
    expect([30, 20, 10, 5, 0.5].map(delaiFamilleMs)).toEqual([20000, 13333, 6666, 3333, 333]);
    expect([Infinity, Number.NaN].map(delaiFamilleMs)).toEqual([null, null]);
    for (const s of [10, 20, 7]) expect(() => AbortSignal.timeout(delaiFamilleMs(s) ?? 0)).not.toThrow();
  });

  it("une famille qui ne répond pas est retirée à sa borne, les autres servies", async () => {
    manifeste(toolhost(FAMILY_NAMES));
    const lignes: string[] = [];
    installerCrochetJournal((niveau, message) => void lignes.push(`${niveau} ${message}`));
    brancherDelaiFamille(1000);
    hote.muettes.add("browser");
    const [, outils] = await pool().getOrConnect(SENTINELLE, resoudreClientMcp);
    expect(outils).toEqual(AGREGE.filter((t) => !String(t["name"]).startsWith("pw_")));
    expect(
      lignes.some((l) =>
        l.includes(
          "famille(s) browser de 'elpis-tools' injoignable(s), outils retirés : pas de réponse en 1 s",
        ),
      ),
    ).toBe(true);
  });

  it("session perdue sur une famille : elle seule est rouverte et l'appel rejoué ; l'appel long d'une autre famille finit, l'entrée n'est pas reconnectée", async () => {
    manifeste(toolhost(FAMILY_NAMES));
    const lignes: string[] = [];
    installerCrochetJournal((niveau, message) => void lignes.push(`${niveau} ${message}`));
    const p = pool();
    await p.getOrConnect(SENTINELLE, resoudreClientMcp);
    const entree = p.entree(SENTINELLE);
    const options = (compte: string, ms = 0) => ({
      resolveClient: resoudreClientMcp,
      meta: { username: compte, attente_ms: ms },
    });
    const long = p.callTool(SENTINELLE, "desktop_session", {}, options("bob", 600));
    await new Promise((fin) => setTimeout(fin, 50));
    hote.oublierSessions("fs");
    expect(
      sortie(await p.callTool(SENTINELLE, OUTIL["fs"] ?? "", args("fs"), options("alice"))),
    ).toMatchObject({
      famille: "fs",
      compte: "alice",
    });
    expect(sortie(await long)).toMatchObject({ famille: "desktop", compte: "bob" });
    expect(p.entree(SENTINELLE)).toBe(entree);
    expect(entree?.healthy).toBe(true);
    expect(lignes.some((l) => l.includes("connexion à la famille 'fs' de 'elpis-tools' coupée"))).toBe(true);
  });

  it("famille tombée en cours de route : erreur lisible de cette famille, les autres servies, l'entrée gardée ; un abandon pendant le rafraîchissement ne casse rien", async () => {
    manifeste(toolhost(FAMILY_NAMES));
    const p = pool();
    const [client] = await p.getOrConnect(SENTINELLE, resoudreClientMcp);
    const entree = p.entree(SENTINELLE);
    const carte = new Map(AGREGE.map((t) => [String(t["name"]), SENTINELLE]));
    hote.enPanne.add("git");
    hote.oublierSessions("git");
    const refus = JSON.parse(
      await executerOutilMcp(carte, OUTIL["git"] ?? "", args("git"), { timeoutS: 5, pool: p }),
    ) as Dict;
    expect(refus["error"]).toContain(
      "Tool 'git_query' unavailable: family 'git' of 'elpis-tools' unreachable.",
    );
    expect(
      JSON.parse(
        await executerOutilMcp(carte, OUTIL["memory"] ?? "", args("memory"), { timeoutS: 5, pool: p }),
      ),
    ).toMatchObject({ famille: "memory" });
    expect(p.entree(SENTINELLE)).toBe(entree);

    hote.enPanne.clear();
    const stop = new AbortController();
    const liste = client.listerOutils(stop.signal);
    stop.abort();
    await expect(liste).rejects.toThrow();
    expect(
      JSON.parse(await executerOutilMcp(carte, OUTIL["git"] ?? "", args("git"), { timeoutS: 5, pool: p })),
    ).toMatchObject({ famille: "git" });
    expect(
      JSON.parse(await executerOutilMcp(carte, OUTIL["fs"] ?? "", args("fs"), { timeoutS: 5, pool: p })),
    ).toMatchObject({ famille: "fs" });
  });
});
