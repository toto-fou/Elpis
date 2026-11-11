// SPDX-License-Identifier: MIT
/** apps/toolhost/test/vecteurs.test.ts — vecteurs du vrai Python (migration-kit/vecteurs/toolhost.py) : configuration, jeton Bearer, arguments du lanceur, auto-description. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { surchargerConfig } from "@elpis/config";
import { oublierManifeste } from "@elpis/mcp";
import { afterEach, describe, expect, it } from "vitest";

import { chargerConfig, publicDict } from "../src/config";
import { parseFamiliesArgv } from "../src/lanceur";
import { endpointsView, exportMcpServers } from "../src/manifeste";
import { bearerMatches } from "../src/porte";

interface CasConfig {
  nom: string;
  entree: {
    fichier?: unknown;
    fichier_a?: string;
    env?: Record<string, string>;
    cfg?: Record<string, unknown>;
    mcp?: unknown;
    jeton?: string;
    jeton_maison?: string;
  };
  sortie: Record<string, unknown>;
}

const V = JSON.parse(readFileSync(new URL("./vecteurs/toolhost.json", import.meta.url), "utf-8")) as {
  config: CasConfig[];
  bearer: { entete: string; jeton: string; attendu: boolean }[];
  argv: { argv: string[]; attendu: string | null }[];
  manifeste: {
    entree: {
      host: string;
      port: number;
      transports: string[];
      familles: string[];
      base_url: string;
      transport: string;
    };
    endpoints: unknown;
    export: unknown;
  }[];
};

const CFG = {
  LOCAL_MCP_HOST: "127.0.0.1",
  LOCAL_MCP_PORT: 8765,
  LOCAL_MCP_TOKEN: "",
  LOCAL_MCP_TOKEN_FILE: "{racine}/user_db/.local_mcp_token",
  SANDBOX_DIR: "{racine}/user_sandboxes",
};
const ENV_LUES = [
  "LOCAL_MCP_HOST",
  "LOCAL_MCP_PORT",
  "LOCAL_MCP_TRANSPORT",
  "TOOLHOST_TRANSPORTS",
  "LOCAL_MCP_TOKEN",
  "LOCAL_MCP_TOOL_FAMILIES",
  "APP_SANDBOX_DIR",
  "TOOLHOST_APP_URL",
  "PLAYWRIGHT_API_URL",
  "PW_SCREENS_DIR",
  "DESKTOP_SCREENS_DIR",
  "TOOLHOST_CONFIG",
  "APP_MCP_MANIFEST",
  "HOME",
  "TOOLHOST_MCP_UPSTREAM",
  "TOOLHOST_MCP_UPSTREAM_SSE",
];

function ecrire(p: string, contenu: unknown): void {
  mkdirSync(path.dirname(p), { recursive: true });
  if (typeof contenu === "string" && contenu.startsWith("<<") && contenu.endsWith(">>"))
    writeFileSync(p, contenu.slice(2, -2), "utf-8");
  else if (typeof contenu === "string" && contenu.startsWith("!!"))
    writeFileSync(p, Buffer.from(contenu.slice(2), "hex"));
  else writeFileSync(p, JSON.stringify(contenu), "utf-8");
}

function normaliser(v: unknown, racine: string, tmp: string): unknown {
  if (typeof v === "string") return v.replaceAll(racine, "{racine}").replaceAll(tmp, "{tmp}");
  if (Array.isArray(v)) return v.map((x) => normaliser(x, racine, tmp));
  if (v !== null && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normaliser(x, racine, tmp)]));
  return v;
}

const sauvegarde = new Map<string, string | undefined>();
const restaurations: (() => void)[] = [];

afterEach(() => {
  for (const [k, v] of sauvegarde) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  sauvegarde.clear();
  for (const r of restaurations.splice(0)) r();
  oublierManifeste();
});

function rejouer(cas: CasConfig): Record<string, unknown> {
  const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "elpis-vec-toolhost-")));
  const racine = path.join(tmp, "depot");
  mkdirSync(racine);
  const remplacer = (v: unknown): unknown =>
    typeof v === "string" ? v.replaceAll("{racine}", racine).replaceAll("{tmp}", tmp) : v;
  try {
    for (const k of ENV_LUES) {
      sauvegarde.set(k, process.env[k]);
      delete process.env[k];
    }
    process.env["APP_MCP_MANIFEST"] = path.join(tmp, "mcp.json");
    const cfg = Object.fromEntries(
      Object.entries({ ...CFG, ...(cas.entree.cfg ?? {}) }).map(([k, v]) => [k, remplacer(v)]),
    );
    restaurations.push(surchargerConfig({ ...cfg, PROJECT_ROOT: racine }));
    for (const [k, v] of Object.entries(cas.entree.env ?? {})) process.env[k] = remplacer(v) as string;
    if (cas.entree.mcp !== undefined) ecrire(path.join(tmp, "mcp.json"), cas.entree.mcp);
    if (cas.entree.fichier !== undefined)
      ecrire(path.join(racine, cas.entree.fichier_a ?? "toolhost.json"), cas.entree.fichier);
    if (cas.entree.jeton !== undefined)
      ecrire(path.join(racine, "user_db", ".local_mcp_token"), `<<${cas.entree.jeton}>>`);
    if (cas.entree.jeton_maison !== undefined)
      ecrire(path.join(tmp, "maison", "jeton"), `<<${cas.entree.jeton_maison}>>`);
    oublierManifeste();
    let tc;
    try {
      tc = chargerConfig();
    } catch (e) {
      return { erreur: (e as { type?: string }).type ?? (e as Error).name };
    }
    const pub = publicDict(tc);
    pub["warnings"] = (pub["warnings"] as string[]).filter((w) => !w.startsWith("schéma : "));
    // Propre au TS (familles natives effectives, toutes les portées par défaut) : absent du Python.
    delete pub["familles_natives"];
    return normaliser(
      {
        public: pub,
        token: tc.token,
        token_file: tc.token_file,
        pw_dir: tc.pw_dir,
        desktop_dir: tc.desktop_dir,
        skew: tc.identity_max_skew_s,
        reseau: ["streamable-http", "http", "sse"].includes(tc.transport),
      },
      racine,
      tmp,
    ) as Record<string, unknown>;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe("vecteurs de toolhost/config.py", () => {
  for (const cas of V.config) {
    it(cas.nom, () => {
      expect(rejouer(cas)).toEqual(cas.sortie);
    });
  }
});

describe("vecteurs de toolhost/auth.py et __main__.py", () => {
  it("bearer_matches", () => {
    for (const b of V.bearer) expect(bearerMatches(b.entete || undefined, b.jeton), b.entete).toBe(b.attendu);
  });

  it("_parse_families", () => {
    for (const a of V.argv) expect(parseFamiliesArgv(a.argv), a.argv.join(" ")).toBe(a.attendu);
  });
});

describe("vecteurs de endpoints_view et export_mcp_servers", () => {
  for (const m of V.manifeste) {
    it(`${m.entree.familles.join(",") || "(aucune)"} / ${m.entree.transport}`, () => {
      const vue = {
        host: m.entree.host,
        port: m.entree.port,
        transports: m.entree.transports,
        familles: m.entree.familles,
        stdio: (f: string) => ({
          command: "/usr/bin/python-elpis",
          args: ["-m", "toolhost", "--stdio", "--families", f],
        }),
      };
      expect(endpointsView(vue, m.entree.base_url)).toEqual(m.endpoints);
      expect(exportMcpServers(vue, m.entree.transport, m.entree.base_url)).toEqual(m.export);
    });
  }
});
