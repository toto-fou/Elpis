// SPDX-License-Identifier: MIT
/** apps/core/test/outils/integres/agent-save.test.ts — outil intégré agent_save : agent personnel enregistré désactivé, refus lisibles (nom, catégories, serveurs MCP, budgets), agent_exists et replace, plafond, jamais offert aux sous-agents ni aux routines. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getUserSettings, mergeUserSettings } from "@elpis/auth";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { OUTILS_JAMAIS_SOUS_AGENT, OUTILS_SANS_RESTAURATION } from "@elpis/securite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ingestTools, reinitialiserRegistre } from "../../../src/outils/categories";
import { buildAgentBuiltinTool, definitionOutilAgent } from "../../../src/outils/integres/agent-save";
import { validateCustomAgents } from "../../../src/outils/integres/task/roster";
import { CUSTOM_AGENTS_MAX } from "../../../src/outils/integres/task/fiche-agent";
import { deniedForRoutine } from "../../../src/routines/planificateur";

type Dict = Record<string, unknown>;

let t: BaseDeTest;
let racine: string;
let uid = 0;

const SERVEURS: Dict[] = [{ id: "mcp-1", name: "Jira", type: "http", url: "http://jira" }];

async function appeler(args: Dict): Promise<Dict> {
  const outils = buildAgentBuiltinTool({
    base: t.base,
    userId: uid,
    serveurs: () => Promise.resolve(SERVEURS),
  });
  return JSON.parse(String(await outils["agent_save"]!.handler(args))) as Dict;
}

async function agents(): Promise<Dict[]> {
  return ((await getUserSettings(t.base, uid))["custom_agents"] ?? []) as Dict[];
}

const BON = {
  name: "revue-sql",
  description: "Reviews SQL migrations before they ship.",
  prompt: "# Role\nYou review SQL migrations.\n\n# Report\nUse the common report format of your rules.",
};

beforeEach(async () => {
  t = ouvrirBaseDeTest("sqlite");
  await initialiserBase(t.base);
  await t.base.run(
    "INSERT INTO users(username, pass_salt, pass_hash, created_at, is_admin) VALUES(?,?,?,?,?)",
    ["bob", "s", "h", 0, 0],
  );
  uid = (await t.base.get<{ id: number }>("SELECT id FROM users WHERE username='bob'"))!.id;
  racine = mkdtempSync(join(tmpdir(), "elpis-agent-outil-"));
  reinitialiserRegistre({ cheminCache: join(racine, "cache.json") });
  const meta = (cat: string): Dict => ({ category: { name: cat } });
  ingestTools([
    { name: "read_file", meta: meta("fs") },
    { name: "execute_shell", meta: meta("shell") },
    { name: "web_search", meta: meta("browser") },
  ]);
});

afterEach(async () => {
  await t.fermer();
  rmSync(racine, { recursive: true, force: true });
});

describe("agent_save", () => {
  it("enregistre l'agent désactivé dans custom_agents et rend la fiche sans la persona", async () => {
    const r = await appeler({
      ...BON,
      name: " Revue-SQL ",
      tool_categories: ["fs", "FS", "shell"],
      mcp_server_ids: ["mcp-1"],
      read_only: true,
      max_iters: 30,
      thinking: "on",
    });
    expect(r).toMatchObject({
      ok: true,
      name: "revue-sql",
      enabled: false,
      tool_categories: ["fs", "shell"],
      mcp_server_ids: ["mcp-1"],
      read_only: true,
      max_iters: 30,
      thinking: "on",
      replaced: false,
      prompt_chars: BON.prompt.length,
    });
    expect(r).not.toHaveProperty("prompt");
    expect(String(r["note"])).toContain("Agents page");
    expect(await agents()).toEqual([
      {
        name: "revue-sql",
        description: BON.description,
        prompt: BON.prompt,
        tool_categories: ["fs", "shell"],
        mcp_server_ids: ["mcp-1"],
        max_iters: 30,
        enabled: false,
        read_only: true,
        thinking: "on",
      },
    ]);
  });

  it("même nom : agent_exists sans replace, remplacé en place avec replace, les autres agents gardés", async () => {
    await mergeUserSettings(t.base, uid, (s) => {
      s["custom_agents"] = [
        { name: "autre", description: "x", prompt: "p", tool_categories: ["fs"], mcp_server_ids: [] },
        {
          name: "revue-sql",
          description: "old",
          prompt: "old",
          tool_categories: ["fs"],
          mcp_server_ids: [],
          enabled: true,
          user_browser_session: true,
        },
      ];
    });
    expect(await appeler(BON)).toMatchObject({ ok: false, error: "agent_exists" });
    expect((await agents())[1]).toMatchObject({ description: "old" });
    const remplace = await appeler({ ...BON, replace: true });
    expect(remplace).toMatchObject({ ok: true, replaced: true });
    expect(String(remplace["note"])).toContain("web session is back to private");
    const apres = await agents();
    expect(apres.map((a) => a["name"])).toEqual(["autre", "revue-sql"]);
    expect(apres[1]).toMatchObject({ description: BON.description, enabled: false });
    expect(apres[1]!["user_browser_session"]).not.toBe(true);
  });

  it("refus lisibles : nom, nom livré ou réservé, persona ou description vide, argument inconnu", async () => {
    const cas: [Dict, string][] = [
      [{ ...BON, name: "-x" }, "invalid name"],
      [{ ...BON, name: "explore" }, "built-in agent name"],
      [{ ...BON, name: "task" }, "built-in agent name"],
      [{ ...BON, prompt: "  " }, "prompt is required"],
      [{ ...BON, description: "" }, "description is required"],
      [{ ...BON, enabled: true }, "unexpected argument(s): enabled"],
      [{ ...BON, max_iters: 0 }, "max_iters must be an integer"],
      [{ ...BON, max_iters: 2.5 }, "max_iters must be an integer"],
      [{ ...BON, thinking: "auto" }, "thinking must be one of off, on, inherit"],
      [{ ...BON, read_only: "yes" }, "read_only must be a boolean"],
    ];
    for (const [args, message] of cas) {
      const r = await appeler(args);
      expect(r, message).toMatchObject({ ok: false, error: "invalid_argument", retryable: true });
      expect(String(r["message"])).toContain(message);
    }
    expect(await agents()).toEqual([]);
  });

  it("catégorie inconnue et serveur MCP hors du compte : refusés en listant les valeurs valides", async () => {
    const cat = await appeler({ ...BON, tool_categories: ["office"] });
    expect(String(cat["message"])).toContain("valid: browser, fs, shell");
    const mcp = await appeler({ ...BON, mcp_server_ids: ["mcp-9"] });
    expect(String(mcp["message"])).toContain("valid: mcp-1 (Jira)");
    expect(await agents()).toEqual([]);
  });

  it("une faute de validation partagée revient en anglais au modèle, en français pour la page Agents", async () => {
    await mergeUserSettings(t.base, uid, (s) => {
      s["custom_agents"] = [{ name: "Mauvais Nom", prompt: "p" }];
    });
    expect(await appeler(BON)).toMatchObject({
      ok: false,
      error: "invalid_argument",
      message:
        'agent 1: invalid name "mauvais nom" (1-32 characters a-z 0-9 - _, must start and end with an alphanumeric).',
    });
    expect(() => validateCustomAgents([{ name: "Mauvais Nom", prompt: "p" }])).toThrow(
      "agent 1 : nom invalide « mauvais nom » (1-32 caractères a-z 0-9 - _, commence et finit par un alphanumérique).",
    );
  });

  it("plafond de la page Agents : agents_limit, rien d'écrit", async () => {
    const pleins = Array.from({ length: CUSTOM_AGENTS_MAX }, (_, i) => ({
      name: `a${i}`,
      description: "x",
      prompt: "p",
      tool_categories: ["fs"],
      mcp_server_ids: [],
    }));
    await mergeUserSettings(t.base, uid, (s) => {
      s["custom_agents"] = pleins;
    });
    const r = await appeler(BON);
    expect(r).toMatchObject({ ok: false, error: "agents_limit" });
    expect(r).not.toHaveProperty("retryable");
    expect(await agents()).toHaveLength(CUSTOM_AGENTS_MAX);
  });

  it("la définition est un function-call OpenAI qui refuse tout champ hors liste", () => {
    const f = definitionOutilAgent()["function"] as Dict;
    expect(f["name"]).toBe("agent_save");
    const p = f["parameters"] as Dict;
    expect(p["additionalProperties"]).toBe(false);
    expect(p["required"]).toEqual(["name", "description", "prompt"]);
    expect(Object.keys(p["properties"] as Dict)).not.toContain("enabled");
  });
});

describe("agent_save hors du chat", () => {
  it("jamais offert à un sous-agent ni à une routine ; sa persona garde les marqueurs inertes", () => {
    expect(OUTILS_JAMAIS_SOUS_AGENT.has("agent_save")).toBe(true);
    expect(deniedForRoutine().has("agent_save")).toBe(true);
    expect(OUTILS_SANS_RESTAURATION.has("agent_save")).toBe(true);
  });
});
