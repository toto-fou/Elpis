// SPDX-License-Identifier: MIT
/** apps/toolhost/test/config.test.ts — configuration de l'hôte au-delà des vecteurs : schéma (Ajv) en avertissements, amont MCP obsolète signalé, environnement propagé, bind. */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { config } from "@elpis/config";
import { FAMILY_NAMES, oublierManifeste } from "@elpis/mcp";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  appliquerEnvironnement,
  bindAutorise,
  chargerConfig,
  configParDefaut,
  erreursDuSchema,
} from "../src/config";
import { dossierTemporaire } from "./aides";

afterEach(() => {
  vi.unstubAllEnvs();
  oublierManifeste();
});

describe("configuration", () => {
  it("toolhost.example.json valide pour le schéma ; erreurs de schéma rendues en avertissements, jamais bloquantes", () => {
    const exemple = JSON.parse(
      readFileSync(path.join(config.PROJECT_ROOT, "deploy", "toolhost", "toolhost.example.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(erreursDuSchema(exemple)).toEqual([]);
    const [d, nettoyer] = dossierTemporaire("elpis-toolhost-config-");
    try {
      const p = path.join(d, "toolhost.json");
      writeFileSync(p, JSON.stringify({ bind: { port: 0, inconnu: 1 }, families: ["fs", "pirate"] }));
      const tc = chargerConfig(p, {});
      expect(tc.source).toBe("file");
      expect(tc.warnings.filter((w) => w.startsWith("schéma : "))).toHaveLength(3);
      expect(tc.warnings).toContain("famille inconnue ignorée : 'pirate'");
    } finally {
      nettoyer();
    }
  });

  it("mcp_upstream et mcp_upstream_sse (fichier ou env) : elpis-tools retiré, signalés puis ignorés ; vides : rien à dire", () => {
    const [d, nettoyer] = dossierTemporaire("elpis-toolhost-config-");
    try {
      const p = path.join(d, "toolhost.json");
      const obsoletes = (tc: { warnings: string[] }): string[] =>
        tc.warnings.filter((w) => w.includes("elpis-tools n'existe plus"));
      writeFileSync(p, JSON.stringify({ mcp_upstream: " http://127.0.0.1:8766/ ", mcp_upstream_sse: "" }));
      const tc = chargerConfig(p, {});
      expect(obsoletes(tc)).toEqual([
        "mcp_upstream ignoré : elpis-tools n'existe plus, les familles sont servies par l'hôte",
      ]);
      expect(tc).not.toHaveProperty("mcp_upstream");
      expect(tc).not.toHaveProperty("mcp_upstream_sse");
      expect(
        obsoletes(
          chargerConfig(p, { TOOLHOST_MCP_UPSTREAM: "", TOOLHOST_MCP_UPSTREAM_SSE: "http://b:1/sse" }),
        ),
      ).toEqual([
        "mcp_upstream ignoré : elpis-tools n'existe plus, les familles sont servies par l'hôte",
        "mcp_upstream_sse ignoré : elpis-tools n'existe plus, les familles sont servies par l'hôte",
      ]);
      writeFileSync(p, JSON.stringify({ mcp_upstream: "", mcp_upstream_sse: null }));
      expect(obsoletes(chargerConfig(p, {}))).toEqual([]);
    } finally {
      nettoyer();
    }
  });

  it("durcissements propres à l'hôte TS : écart d'horloge non fini, jeton non ASCII", () => {
    const [d, nettoyer] = dossierTemporaire("elpis-toolhost-config-");
    try {
      const p = path.join(d, "toolhost.json");
      for (const [skew, attendu] of [
        ["nan", 60],
        ["inf", 60],
        [0.5, 60],
        [-5, 60],
        [2, 2],
      ] as const) {
        writeFileSync(p, JSON.stringify({ identity_max_skew_s: skew }));
        expect(chargerConfig(p, {}).identity_max_skew_s, String(skew)).toBe(attendu);
      }
      expect(chargerConfig(p, { LOCAL_MCP_TOKEN: "jéton" }).warnings).toContain(
        "jeton de service non ASCII : aucune requête ne peut le présenter, API fermée",
      );
    } finally {
      nettoyer();
    }
  });

  it("apply_environment : clés que lisent les modules partagés (plus de LOCAL_MCP_TOOL_FAMILIES, MCP_SANDBOX_ROOT ni ELPIS_TOOLHOST pour elpis-tools)", () => {
    const env: NodeJS.ProcessEnv = {};
    appliquerEnvironnement(
      {
        ...configParDefaut(),
        sandbox_dir: "/sb",
        db_path: "/th.db",
        token: "t",
        app_url: "http://c",
        families: [],
      },
      env,
    );
    expect(env).toEqual({
      APP_SANDBOX_DIR: "/sb",
      APP_DB_PATH: "/th.db",
      APP_DB_BACKEND: "sqlite",
      LOCAL_MCP_TOKEN: "t",
      TOOLHOST_APP_URL: "http://c",
      LOCAL_MCP_TRANSPORT: "streamable-http",
      LOCAL_MCP_HOST: "127.0.0.1",
      LOCAL_MCP_PORT: "8765",
    });
  });

  it("sans toolhost.json : familles des seules entrées toolhost du manifeste (jamais celles du compte, en processus ou réseau) ; à défaut, familles du bac ; toutes celles portées en TS servies par l'hôte (office compris)", () => {
    const [d, nettoyer] = dossierTemporaire("elpis-toolhost-familles-");
    try {
      const exemple = JSON.parse(
        readFileSync(path.join(config.PROJECT_ROOT, "mcp.example.json"), "utf-8"),
      ) as {
        mcpServers: Record<string, { "x-elpis"?: { role?: string } }>;
      };
      const familles = (manifeste: unknown): { servies: string[]; natives: string[] } => {
        const p = path.join(d, "mcp.json");
        if (manifeste === undefined) writeFileSync(p, "{ illisible");
        else writeFileSync(p, JSON.stringify(manifeste));
        vi.stubEnv("APP_MCP_MANIFEST", p);
        oublierManifeste();
        const tc = chargerConfig(path.join(d, "absent", "toolhost.json"), {});
        return { servies: tc.families, natives: tc.familles_natives };
      };
      const hote = ["fs", "shell", "git", "office", "skill_run", "browser", "desktop"].sort(
        (a, b) => FAMILY_NAMES.indexOf(a) - FAMILY_NAMES.indexOf(b),
      );
      expect(familles(exemple)).toEqual({ servies: hote, natives: hote });
      const reseau = structuredClone(exemple);
      for (const [nom, e] of Object.entries(reseau.mcpServers))
        if (e["x-elpis"]?.role === "app")
          Object.assign(e, { type: "http", url: `http://127.0.0.1:8768/mcp/${nom.slice("elpis-".length)}` });
      expect(familles(reseau).servies).toEqual(hote);
      const sansHote = {
        version: 1,
        mcpServers: Object.fromEntries(
          Object.entries(exemple.mcpServers).filter(([, e]) => e["x-elpis"]?.role === "app"),
        ),
      };
      expect(familles(sansHote)).toEqual({ servies: hote, natives: hote });
      // Manifeste illisible : entrée toolhost héritée (LOCAL_MCP_TOOL_FAMILIES, « all »), comme le routage du core.
      expect(familles(undefined)).toEqual({ servies: [...FAMILY_NAMES], natives: hote });
      const ancien = structuredClone(exemple);
      delete ancien.mcpServers["elpis-office"];
      // mcp.json d'avant office (04/10) : office absent — l'étape --migrer-mcp de configure l'ajoute.
      const sansOffice = hote.filter((f) => f !== "office");
      expect(familles(ancien)).toEqual({ servies: sansOffice, natives: sansOffice });
    } finally {
      nettoyer();
    }
  });

  it("bind_allowed : hors boucle locale, un jeton est exigé", () => {
    expect(bindAutorise("127.0.0.1", false)).toBe(true);
    expect(bindAutorise(" LOCALHOST ", false)).toBe(true);
    expect(bindAutorise("::1", false)).toBe(true);
    expect(bindAutorise("0.0.0.0", false)).toBe(false);
    expect(bindAutorise("0.0.0.0", true)).toBe(true);
  });
});
