// SPDX-License-Identifier: MIT
/** apps/core/test/outils/catalogue.test.ts — catalogue d'un tour et exécution d'un appel MCP sur un faux pool (vecteurs Python de tool_catalog et du chemin MCP de tool_dispatch). */
import { DOSSIER_MOTEUR } from "../moteur-environnement";

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { DelaiDepasse, McpFileSaturee, oublierManifeste, PoolMcp } from "@elpis/mcp";
import type { ConfigMcp, OptionsAppel } from "@elpis/mcp";

import { applyMemoryGate, collectMcpTools, expandBuiltinConfigs } from "../../src/outils/catalogue";
import type { OutilIntegre } from "../../src/outils/catalogue";
import { ingestTools, reinitialiserRegistre } from "../../src/outils/categories";
import { executerOutilMcp, masquerAdresse, TOOL_QUEUE_WAIT_S } from "../../src/outils/mcp/clients";
import { delaiEnAnglais } from "../ecart-delai-outil";
import { outilIndisponibleEnAnglais } from "../ecart-outil-indisponible";
import { decoder, lireVecteurs } from "../vecteurs-moteur";

type Dict = Record<string, unknown>;

const V = lireVecteurs<Record<string, unknown>>("outils-mcp");
const MANIFESTES = V["manifestes"] as Record<string, Dict>;
const REPONSES = V["reponses"] as Record<string, Dict>;
const BUILTINS = V["builtins"] as Record<string, Dict>;
const DOSSIER = path.join(DOSSIER_MOTEUR, "catalogue");
mkdirSync(DOSSIER, { recursive: true });
const avantManifeste = process.env["APP_MCP_MANIFEST"];

afterAll(() => {
  if (avantManifeste === undefined) delete process.env["APP_MCP_MANIFEST"];
  else process.env["APP_MCP_MANIFEST"] = avantManifeste;
  oublierManifeste();
  reinitialiserRegistre();
});

let mondes = 0;

/** `_monde` : manifeste écrit et relu, registre des catégories (cache disque neuf) ingéré depuis la liste donnée. */
function monde(manifeste: Dict, registre: unknown[]): void {
  const fichier = path.join(DOSSIER, "mcp.json");
  writeFileSync(fichier, JSON.stringify(manifeste));
  process.env["APP_MCP_MANIFEST"] = fichier;
  oublierManifeste();
  reinitialiserRegistre({ cheminCache: path.join(DOSSIER, `cache-${++mondes}.json`) });
  if (registre.length > 0) ingestTools(registre, "vecteurs");
}

function erreurPy(message: string, nom = "RuntimeError"): Error {
  const e = new Error(message);
  e.name = nom;
  return e;
}

/** Faux pool : connexions servies par nom de config, appels enregistrés et levées à la demande. */
class FauxPool {
  appels: Dict[] = [];
  private readonly resultat: unknown;
  private readonly leve: string | null;

  constructor(resultat: unknown = null, leve: string | null = null) {
    this.resultat = resultat;
    this.leve = leve;
  }

  async getOrConnect(cfg: ConfigMcp): Promise<[unknown, Dict[]]> {
    const r = REPONSES[String(cfg["name"])];
    if (r === undefined) throw erreurPy(`pas de réponse pour ${String(cfg["name"])}`);
    if ("erreur" in r) throw erreurPy(r["erreur"] as string);
    if (r["annule"]) throw new DOMException("annulée", "AbortError");
    return [{}, (r["outils"] as Dict[]).map((t) => ({ ...t }))];
  }

  async callTool(cfg: ConfigMcp, nom: string, args: Dict, o: OptionsAppel): Promise<unknown> {
    this.appels.push({
      cfg,
      outil: nom,
      args,
      meta: o.meta,
      exec_timeout_s: o.execTimeoutS,
      queue_timeout_s: o.queueTimeoutS,
    });
    if (this.leve === "timeout") throw new DelaiDepasse();
    if (this.leve === "sature")
      throw new McpFileSaturee("file d'attente d'outils saturée (> 120s) — l'appel n'a pas été exécuté");
    if (this.leve === "runtime") throw erreurPy("Échec connexion MCP 'x': boum");
    if (this.leve === "mcp") {
      const e = erreurPy("MCP error -32602: Invalid params: champ 'path' manquant", "McpError");
      throw Object.assign(e, { code: -32602 });
    }
    if (this.leve === "groupe")
      throw new AggregateError([erreurPy("champ x invalide", "ValueError"), erreurPy("")], "g");
    return this.resultat;
  }
}

describe("développement de la sentinelle et porte de la mémoire", () => {
  it("_apply_memory_gate", () => {
    const categories: Record<string, string> = { read_file: "fs", memory: "x", notes: "memory", autre: "y" };
    for (const c of V["porte_memoire"] as Dict[])
      expect(
        applyMemoryGate(c["outils"] as unknown[], c["actif"] as boolean, (n) => categories[n] ?? ""),
        JSON.stringify(c),
      ).toEqual(c["out"]);
  });

  it("_expand_builtin_configs : une config par entrée intégrée, dédoublonnées, nom conservé pour une entrée seule", () => {
    for (const c of V["developpes"] as Dict[]) {
      monde(MANIFESTES[c["manifeste"] as string] as Dict, []);
      expect(expandBuiltinConfigs(c["configs"] as unknown[] | null), JSON.stringify(c)).toEqual(c["out"]);
    }
  });
});

describe("collecte des outils d'un tour", () => {
  for (const sc of V["collectes"] as Dict[]) {
    it(sc["nom"] as string, async () => {
      monde(
        MANIFESTES[sc["manifeste"] === "seul" ? "seul" : "plusieurs"] as Dict,
        sc["registre_vide"] ? [] : (V["registre"] as unknown[]),
      );
      const evenements: unknown[] = [];
      const integres: Record<string, OutilIntegre> | null = sc["builtins"]
        ? Object.fromEntries(
            Object.entries(BUILTINS).map(([k, v]) => [
              k,
              { definition: v["definition"] as Dict, handler: (a: Dict) => a },
            ]),
          )
        : null;
      let obtenu: Dict;
      try {
        const cat = await collectMcpTools(sc["configs"] as unknown[], integres, (e) => evenements.push(e), {
          memoryEnabled: (sc["memory_enabled"] as boolean | undefined) ?? true,
          denyToolNames: sc["deny"] ? (sc["deny"] as string[]) : null,
          allowedToolNames: sc["allowed"] ? new Set(sc["allowed"] as string[]) : null,
          readOnly: (sc["read_only"] as boolean | undefined) ?? false,
          pool: new FauxPool() as unknown as PoolMcp,
        });
        obtenu = {
          valeur: {
            tool_cfg_map: Object.fromEntries(cat.toolCfgMap),
            payload: cat.toolsPayload,
            builtins: [...cat.builtinHandlers.keys()],
            connectes: cat.connectedServerNames,
          },
        };
      } catch (e) {
        obtenu = { erreur: "RuntimeError", message: e instanceof Error ? e.message : String(e) };
      }
      expect(obtenu).toEqual(decoder(sc["out"]));
      expect(evenements).toEqual(sc["evenements"]);
    });
  }

  it("serveur stdio d'un compte : refus explicite rendu à l'utilisateur, jamais un abandon silencieux", async () => {
    monde(MANIFESTES["plusieurs"] as Dict, V["registre"] as unknown[]);
    const pool = new PoolMcp({ rejouable: () => true, parallelisme: () => 4, ttlOutilsS: () => 360 });
    const evenements: Dict[] = [];
    const perso = { type: "stdio", name: "perso", command: "npx mon-serveur" };
    await expect(collectMcpTools([perso], null, (e) => evenements.push(e), { pool })).rejects.toThrow(
      "Impossible de se connecter aux serveurs MCP : perso. Vérifiez la configuration dans Paramètres → MCP.",
    );
    expect(evenements).toEqual([
      {
        type: "warning",
        text:
          "Serveur d'outils « perso » injoignable — ses outils sont absents de ce tour. Serveur MCP « perso » de type stdio " +
          "(commande lancée sur le serveur) : non pris en charge par le core (plus aucun sous-processus) — publiez-le en " +
          "HTTP streamable ou SSE.",
      },
    ]);
    const integres = {
      rag_search: {
        definition: { type: "function", function: { name: "rag_search" } },
        handler: (a: Dict) => a,
      },
    };
    const cat = await collectMcpTools([perso], integres, (e) => evenements.push(e), { pool });
    expect([...cat.builtinHandlers.keys()]).toEqual(["rag_search"]);
    expect(evenements).toHaveLength(2);
    await pool.closeAll();
  });

  it("serveur partagé injoignable : son adresse masquée dans l'avertissement (le journal la garde) ; un serveur perso la montre", async () => {
    monde(MANIFESTES["plusieurs"] as Dict, V["registre"] as unknown[]);
    const pool = {
      getOrConnect: (cfg: ConfigMcp) =>
        Promise.reject(
          erreurPy(
            `Échec connexion MCP '${String(cfg["name"])}': MCP HTTP ${String(cfg["url"])} (intra.lan:9000, intra.lan)`,
          ),
        ),
    } as unknown as PoolMcp;
    const evenements: Dict[] = [];
    const partage = {
      id: "shared:3",
      name: "Intranet",
      type: "http",
      url: "http://jeton@intra.lan:9000/mcp?cle=1",
    };
    const perso = { id: "p1", name: "Perso", type: "http", url: "http://intra.lan:9000/mcp" };
    await expect(
      collectMcpTools([partage, perso], null, (e) => evenements.push(e), { pool }),
    ).rejects.toThrow("Impossible de se connecter aux serveurs MCP : Intranet, Perso.");
    const absents = "injoignable — ses outils sont absents de ce tour.";
    expect(evenements).toEqual([
      {
        type: "warning",
        text:
          `Serveur d'outils « Intranet » ${absents} Échec connexion MCP 'Intranet': MCP HTTP (adresse masquée) ` +
          "((adresse masquée), (adresse masquée))",
      },
      {
        type: "warning",
        text:
          `Serveur d'outils « Perso » ${absents} Échec connexion MCP 'Perso': MCP HTTP http://intra.lan:9000/mcp ` +
          "(intra.lan:9000, intra.lan)",
      },
    ]);
  });

  it("masquerAdresse : URL (avec ou sans identifiants), hôte:port, hôte borné ; rien sans URL", () => {
    const url = "https://u:mdp@Intra.LAN:8443/mcp?token=abc";
    expect(
      masquerAdresse(
        `a ${url} b https://intra.lan:8443/mcp?… c Intra.LAN:8443 d intra.lan. e intra.lanx f sous.intra.lan g`,
        url,
      ),
    ).toBe(
      "a (adresse masquée) b (adresse masquée) c (adresse masquée) d (adresse masquée). e intra.lanx f sous.intra.lan g",
    );
    expect(masquerAdresse("connect ECONNREFUSED 10.1.2.3:9000 ; 10.1.2.34", "http://10.1.2.3:9000/mcp")).toBe(
      "connect ECONNREFUSED (adresse masquée) ; 10.1.2.34",
    );
    expect(masquerAdresse("connect ECONNREFUSED ::1:9000", "http://[::1]:9000/mcp")).toBe(
      "connect ECONNREFUSED (adresse masquée):9000",
    );
    expect(masquerAdresse("rien à voir", "")).toBe("rien à voir");
    expect(masquerAdresse("rien à voir", null)).toBe("rien à voir");
    expect(masquerAdresse("", "http://x/mcp")).toBe("");
  });

  it("Stop du tour pendant les connexions : l'annulation traverse", async () => {
    monde(MANIFESTES["plusieurs"] as Dict, V["registre"] as unknown[]);
    const ctl = new AbortController();
    const pool = {
      getOrConnect: (_c: ConfigMcp, _r: unknown, o: { signal?: AbortSignal }) =>
        new Promise((_, rej) => o.signal?.addEventListener("abort", () => rej(o.signal?.reason))),
    } as unknown as PoolMcp;
    const p = collectMcpTools([{ name: "ext", type: "http", url: "u" }], null, null, {
      pool,
      signal: ctl.signal,
    });
    ctl.abort(new DOMException("Stop", "AbortError"));
    await expect(p).rejects.toThrow("Stop");
  });
});

describe("exécution d'un appel MCP rendue en JSON", () => {
  const cfg = { type: "stdio", name: "elpis-fs", command: "DEFAULT_LOCAL_PYTHON", manifest: "elpis-fs" };
  const carte = new Map<string, ConfigMcp>([
    ["read_file", cfg],
    ["write_file", cfg],
    ["execute_shell", cfg],
    ["vide", {}],
  ]);
  const meta = { username: "alice", user_id: "7", chat_id: "c1", call_id: "k", log_token: "r:k" };

  it("borne de file identique au Python", () => {
    expect(TOOL_QUEUE_WAIT_S).toBe(120);
  });

  for (const sc of V["executions"] as Dict[]) {
    it(sc["nom"] as string, async () => {
      const pool = new FauxPool(sc["resultat"] ?? null, (sc["leve"] as string | undefined) ?? null);
      const json = await executerOutilMcp(
        carte,
        sc["outil"] as string,
        { p: "é" },
        {
          meta,
          timeoutS: sc["delai"] as number,
          pool: pool as unknown as PoolMcp,
        },
      );
      expect(json).toBe(outilIndisponibleEnAnglais(delaiEnAnglais(sc["json"] as string)));
      expect(pool.appels).toEqual(sc["appels"]);
      expect(sc["file"]).toBe(TOOL_QUEUE_WAIT_S);
    });
  }

  it("seule l'annulation de l'appelant traverse (jamais rendue en erreur d'outil)", async () => {
    const ctl = new AbortController();
    const raison = new DOMException("Stop", "AbortError");
    const pool = {
      callTool: () => {
        ctl.abort(raison);
        return Promise.reject(raison);
      },
    } as unknown as PoolMcp;
    await expect(
      executerOutilMcp(carte, "read_file", {}, { timeoutS: 1, pool, signal: ctl.signal }),
    ).rejects.toBe(raison);
    const interne = {
      callTool: () => Promise.reject(new DOMException("interne", "AbortError")),
    } as unknown as PoolMcp;
    expect(await executerOutilMcp(carte, "read_file", {}, { timeoutS: 1, pool: interne })).toBe(
      '{"error": "interne"}',
    );
  });

  it("outil absent du manifeste (inconnu, désactivé ou jamais offert à un sous-agent) : refus anglais avec la marche à suivre", async () => {
    const r = JSON.parse(await executerOutilMcp(new Map(), "git_submit", {}, { timeoutS: 1 })) as Dict;
    expect(r).toMatchObject({ ok: false, error: "tool_not_available" });
    expect(String(r["message"])).toContain("git_submit is not available in this run");
    expect(String(r["fix"])).toContain("'Left open'");
  });
});
