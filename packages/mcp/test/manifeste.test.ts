// SPDX-License-Identifier: MIT
/** packages/mcp/test/manifeste.test.ts — mcp.json : substitutions, entrées, schéma et scénarios complets rejoués sur les vecteurs Python. */
import "./environnement";

import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ErreurPython } from "@elpis/commun";
import { surchargerConfig } from "@elpis/config";
import type { Reglages } from "@elpis/config";

import {
  builtinClientCfg,
  APP_FAMILIES,
  builtinClientCfgs,
  exportServers,
  normalizeEntry,
  opencodeFamilies,
  oublierManifeste,
  parseFamilies,
  reglerEnvironnementManifeste,
  reload,
  resolveExternalCfg,
  serviceUpstream,
  stripMcpPath,
  substitute,
  validateRaw,
} from "../src";
import type { Manifest, ServerEntry } from "../src";
import { capturerJournal, lireVecteurs } from "./aides";

type Dict = Record<string, unknown>;
type Issue = { valeur: unknown } | { erreur: string };

const NODE = "/usr/bin/node-elpis";

/** Écart voulu (elpis-tools retiré) : manifeste synthétisé, repli stdio sur `main.mjs --stdio` de l'hôte et familles du compte signalées. */
function sansElpisTools(v: unknown, familles: readonly string[]): unknown {
  if (Array.isArray(v)) return v.map((x) => sansElpisTools(x, familles));
  if (typeof v !== "object" || v === null) return v;
  const d = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sansElpisTools(x, familles)])) as Dict;
  const args = d["args"];
  if (Array.isArray(args) && args.length === 1 && args[0] === "<RACINE>/server/local_mcp_server.py")
    return {
      ...d,
      command: NODE,
      args: ["<RACINE>/apps/toolhost/dist/main.mjs", "--stdio", "--families", familles.join(",")],
    };
  const compte = familles.filter((f) => (APP_FAMILIES as readonly string[]).includes(f));
  if (d["source"] === "synthesized" && Array.isArray(d["warnings"]) && compte.length > 0)
    return {
      ...d,
      warnings: [
        ...(d["warnings"] as unknown[]),
        `sans mcp.json, l'hôte d'outils ne sert plus les familles du compte (${compte.join(", ")}) : ./elpis configure écrit mcp.json, qui les fait servir par main`,
      ],
    };
  return d;
}
/** Écart B2-06 : repli stdio dérivé = `main.mjs --stdio` de l'hôte TS, plus `python -m toolhost --stdio`. */
function replisDeLHote(v: unknown, python: unknown): unknown {
  if (Array.isArray(v)) return v.map((x) => replisDeLHote(x, python));
  if (typeof v !== "object" || v === null) return v;
  const d = v as Dict;
  const a = d["args"];
  if (d["command"] === python && Array.isArray(a) && a.slice(0, 3).join(" ") === "-m toolhost --stdio")
    return { ...d, command: NODE, args: ["<RACINE>/apps/toolhost/dist/main.mjs", ...a.slice(2)] };
  const out: Dict = {};
  for (const [k, x] of Object.entries(d))
    Object.defineProperty(out, k, { value: replisDeLHote(x, python), enumerable: true, writable: true });
  return out;
}
const BRUT = lireVecteurs<Dict>("mcp-manifeste");
const V = replisDeLHote(BRUT, BRUT["python"]) as Dict;
const SCHEMA = new URL("../../../migration-kit/vecteurs/mcp_manifeste_schema.json", import.meta.url);
const ENV_MCP = [
  "LOCAL_MCP_URL",
  "LOCAL_MCP_TOKEN",
  "LOCAL_MCP_TOOL_FAMILIES",
  "LOCAL_MCP_OPENCODE_FAMILIES",
  "LOCAL_MCP_OPENCODE_EXCLUDE_FAMILIES",
  "APP_MCP_MANIFEST",
  "VEC_JETON",
  "VEC_VIDE",
];
const FAMILLES = [
  "fs",
  "shell",
  "git",
  "chart",
  "office",
  "memory",
  "skill",
  "skill_run",
  "todo",
  "browser",
  "desktop",
  "inconnue",
  "",
  " GIT ",
];
const journal = capturerJournal();

/** Racine temporaire : schéma sous `docs/schemas/`, puis les fichiers donnés. */
function racineTemporaire(fichiers: Record<string, string>): string {
  const racine = mkdtempSync(path.join(tmpdir(), "elpis-vec-mcp-"));
  mkdirSync(path.join(racine, "docs", "schemas"), { recursive: true });
  copyFileSync(SCHEMA, path.join(racine, "docs", "schemas", "mcp.schema.json"));
  for (const [rel, contenu] of Object.entries(fichiers)) {
    const p = path.join(racine, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, contenu, "utf-8");
  }
  return racine;
}

/** Valeurs (pas les clés) où la racine temporaire devient `<RACINE>`, comme `_json(v, racine)`. */
function sansRacine(v: unknown, racine: string): unknown {
  if (typeof v === "string") return v.replaceAll(racine, "<RACINE>");
  if (Array.isArray(v)) return v.map((x) => sansRacine(x, racine));
  if (v instanceof Set) return [...(v as Set<unknown>)].map((x) => sansRacine(x, racine)).sort();
  if (typeof v === "object" && v !== null) {
    const out: Dict = {};
    for (const [k, x] of Object.entries(v))
      Object.defineProperty(out, k, {
        value: sansRacine(x, racine),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    return out;
  }
  return v;
}

/** Classe Python de l'erreur : `RangeError` d'`urlsplit` = `ValueError` (convention de @elpis/commun). */
function classePy(e: unknown): string {
  if (e instanceof ErreurPython) return e.type;
  if (e instanceof RangeError) return "ValueError";
  return e instanceof Error ? e.name : typeof e;
}

function appel(racine: string, f: () => unknown): Issue {
  try {
    return { valeur: sansRacine(f(), racine) };
  } catch (e) {
    return { erreur: classePy(e) };
  }
}

function vueEntree(e: ServerEntry | null, racine: string): unknown {
  if (e === null) return null;
  const champs = [
    "name",
    "type",
    "url",
    "headers",
    "command",
    "args",
    "env",
    "description",
    "enabled",
    "role",
    "identity",
    "families",
    "default_on",
    "default_on_self",
    "opencode_families",
    "opencode_prefix",
    "opencode_publish",
    "sandbox",
    "host",
    "fallback",
    "serve",
    "prompt_fragments",
  ] as const;
  const out: Dict = {};
  for (const c of champs) out[c] = e[c];
  return sansRacine({ ...out, is_builtin: e.isBuiltin, is_network: e.isNetwork, token: e.token }, racine);
}

/** Clé JSON d'un dict Python : `None` sérialisé en `"null"`. */
function cle(k: string): string | null {
  return k === "null" ? null : k;
}

function scenario(m: Manifest, racine: string, attendu: Dict): Dict {
  const noms = [...m.servers.keys()];
  const pub = m.toPublicDict();
  pub["loaded_at"] = 0;
  const parNom = <T>(f: (e: ServerEntry) => T): Dict =>
    Object.fromEntries(noms.map((n) => [n, f(m.servers.get(n) as ServerEntry)]));
  const base = appel(racine, () => m.hostBaseUrl());
  const exports: Dict[] = [];
  for (const portee of ["toolhost", "all"])
    for (const transport of ["http", "sse", "stdio", "streamable-http", " REMOTE ", "", "foo"])
      for (const [jeton, prefixe] of [
        ["", ""],
        ["tk", "elpis-"],
      ] as const)
        exports.push({
          portee,
          transport,
          jeton,
          prefixe,
          out: appel(racine, () =>
            exportServers(portee === "all" ? m.builtins() : m.toolhosts(), {
              baseUrl: portee === "toolhost" && "valeur" in base ? (base.valeur as string) : "",
              transport,
              token: jeton,
              prefix: prefixe,
            }),
          ),
        });
  return {
    public: sansRacine(pub, racine),
    entrees: parNom((e) => vueEntree(e, racine)),
    client_cfg: parNom((e) => sansRacine([e.clientCfg(null), e.clientCfg(["fs"])], racine)),
    endpoints: parNom((e) => [
      appel(racine, () => e.endpoints()),
      appel(racine, () => e.endpoints("http://b:1/")),
    ]),
    opencode_entry: parNom((e) => sansRacine(e.opencodeEntry(), racine)),
    toolhost: m.toolhost()?.name ?? null,
    toolhosts: m.toolhosts(false).map((e) => e.name),
    toolhosts_actifs: m.toolhosts().map((e) => e.name),
    apps: m.apps().map((e) => e.name),
    builtins: m.builtins(false).map((e) => e.name),
    externals: m.externals(false).map((e) => e.name),
    families: m.families(),
    toolhost_families: m.toolhostFamilies(),
    default_on_categories: [...m.defaultOnCategories()].sort(),
    default_on_externals: m.defaultOnExternals(),
    opencode_families: m.opencodeFamilies(),
    opencode_prefix: m.opencodePrefix(),
    hotes: Object.fromEntries(
      Object.keys(attendu["hotes"] as Dict).map((k) => [
        k,
        {
          host: sansRacine(m.host(cle(k)), racine),
          base: appel(racine, () => m.hostBaseUrl(cle(k))),
          mcp: appel(racine, () => m.mcpBaseUrl(cle(k))),
          jeton: m.hostToken(cle(k)),
        },
      ]),
    ),
    entry_for_family: Object.fromEntries(FAMILLES.map((f) => [f, m.entryForFamily(f)?.name ?? null])),
    get: Object.fromEntries(Object.keys(attendu["get"] as Dict).map((k) => [k, m.get(cle(k))?.name ?? null])),
    builtin_client_cfg: sansRacine(
      [builtinClientCfg(null), builtinClientCfg(["fs", "git"], "Outils Locaux")],
      racine,
    ),
    builtin_client_cfgs: sansRacine([builtinClientCfgs(null), builtinClientCfgs(["git"])], racine),
    resolve_external_cfg: Object.fromEntries(
      [...noms, "absent"].map((n) => [n, sansRacine(resolveExternalCfg(n), racine)]),
    ),
    service_upstream: appel(racine, () => serviceUpstream()),
    opencode_famille_module: opencodeFamilies(),
    export: exports,
  };
}

let restaurerRacine: () => void = () => undefined;
afterAll(() => restaurerRacine());

describe("fonctions isolées", () => {
  let racine = "";
  beforeAll(() => {
    racine = racineTemporaire(V["fichiers_subst"] as Record<string, string>);
    writeFileSync(path.join(racine, "latin1.txt"), Buffer.from("café", "latin1"));
    restaurerRacine = reglerEnvironnementManifeste({ racine, python: V["python"] as string, node: NODE });
    process.env["VEC_JETON"] = "jeton-env";
    process.env["VEC_VIDE"] = "";
    delete process.env["VEC_ABSENTE"];
  });
  afterAll(() => {
    delete process.env["VEC_JETON"];
    delete process.env["VEC_VIDE"];
    rmSync(racine, { recursive: true, force: true });
  });

  it("substitutions ${env|file|python|root} et avertissements", () => {
    const cas = V["substitutions"] as Dict[];
    expect(cas.length).toBe(29);
    for (const c of cas) {
      const avert: string[] = [];
      const out = substitute(c["valeur"], { root: racine, warnings: avert });
      expect(sansRacine(out, racine), JSON.stringify(c["valeur"])).toEqual(c["out"]);
      expect(avert, JSON.stringify(c["valeur"])).toEqual(c["warnings"]);
    }
  });

  it("_strip_mcp_path", () => {
    for (const c of V["strip_mcp_path"] as Dict[])
      expect(
        appel(racine, () => stripMcpPath(c["url"] as string | null)),
        String(c["url"]),
      ).toEqual(c["out"]);
  });

  it("normalize_entry : entrée, rôle, familles, repli et avertissements", () => {
    const cas = V["entrees"] as Dict[];
    expect(cas.length).toBe(39);
    for (const c of cas) {
      const avert: string[] = [];
      const out = appel(racine, () => vueEntree(normalizeEntry(c["nom"] as string, c["raw"], avert), racine));
      expect(out, c["nom"] as string).toEqual(c["out"]);
      expect(avert, c["nom"] as string).toEqual(c["warnings"]);
    }
  });

  it("validate_raw : messages de jsonschema, ordre compris", () => {
    for (const c of V["schemas"] as Dict[]) {
      oublierManifeste();
      expect(validateRaw(c["raw"]), JSON.stringify(c["raw"])).toEqual(c["erreurs"]);
    }
  });
});

describe("scénarios complets", () => {
  for (const sc of V["scenarios"] as Dict[]) {
    it(sc["nom"] as string, () => {
      const racine = racineTemporaire(sc["fichiers"] as Record<string, string>);
      const avantEnv = Object.fromEntries(ENV_MCP.map((k) => [k, process.env[k]]));
      for (const k of ENV_MCP) delete process.env[k];
      Object.assign(process.env, sc["env"] as Dict);
      process.env["APP_MCP_MANIFEST"] = path.join(racine, "mcp.json");
      const restaurerConfig = surchargerConfig(sc["reglages"] as Partial<Reglages>);
      const restaurer = reglerEnvironnementManifeste({ racine, python: V["python"] as string, node: NODE });
      oublierManifeste();
      journal.length = 0;
      try {
        const brut = String((sc["reglages"] as Dict | null)?.["LOCAL_MCP_TOOL_FAMILIES"] ?? "") || "all";
        const attendu = sansElpisTools(
          sc["out"],
          parseFamilies(brut, () => undefined),
        ) as Issue;
        let obtenu: Issue;
        try {
          obtenu = {
            valeur: scenario(reload(), racine, "valeur" in attendu ? (attendu.valeur as Dict) : {}),
          };
        } catch (e) {
          obtenu = { erreur: classePy(e) };
        }
        if (sc["nom"] === "fichier_json_casse" && "valeur" in obtenu && "valeur" in attendu) {
          const pub = (obtenu.valeur as Dict)["public"] as Dict;
          const errAttendues = ((attendu.valeur as Dict)["public"] as Dict)["errors"] as string[];
          expect((pub["errors"] as string[]).map((e) => e.split(" : ")[0])).toEqual(
            errAttendues.map((e) => e.split(" : ")[0]),
          );
          pub["errors"] = errAttendues;
        }
        expect(obtenu).toEqual(attendu);
      } finally {
        restaurer();
        restaurerConfig();
        for (const k of ENV_MCP) delete process.env[k];
        for (const [k, v] of Object.entries(avantEnv)) if (v !== undefined) process.env[k] = v;
        oublierManifeste();
        rmSync(racine, { recursive: true, force: true });
      }
    });
  }

  it("une entrée app sans URL est signalée au chargement comme servie en processus", () => {
    const racine = racineTemporaire({
      "mcp.json": JSON.stringify({
        mcpServers: { memoire: { "x-elpis": { role: "app", families: ["memory"] } } },
      }),
    });
    process.env["APP_MCP_MANIFEST"] = path.join(racine, "mcp.json");
    const restaurer = reglerEnvironnementManifeste({ racine });
    journal.length = 0;
    try {
      reload();
      expect(journal.filter((l) => l.niveau === "info").map((l) => l.message)).toContainEqual(
        "memoire : entrée role=app sans url — familles memory servies en processus par le core",
      );
    } finally {
      restaurer();
      delete process.env["APP_MCP_MANIFEST"];
      oublierManifeste();
      rmSync(racine, { recursive: true, force: true });
    }
  });
});
