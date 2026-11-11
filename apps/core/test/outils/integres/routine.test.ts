// SPDX-License-Identifier: MIT
/** apps/core/test/outils/integres/routine.test.ts — outil intégré routine_save : création en pause au nom du compte du tour, forçages, erreurs relayées, catégories filtrées, repli de refus. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { reinitialiserCaches, surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { BUILTIN_SENTINEL } from "@elpis/mcp";
import { OUTILS_JAMAIS_SOUS_AGENT, outilPermisSousAgent } from "@elpis/securite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installerPortsSkills } from "../../../src/composition";
import { ingestTools, reinitialiserRegistre, toolsDeniedFor } from "../../../src/outils/categories";
import { setPolicy } from "../../../src/llm/acces-moteurs";
import { deniedForRoutine } from "../../../src/routines/planificateur";
import {
  buildRoutineBuiltinTool,
  categoriesRoutine,
  corpsForce,
  definitionOutilRoutine,
} from "../../../src/outils/integres/routine";
import { getRoutine } from "../../../src/routines/magasin";
import { invalidateSkillsScanCache } from "../../../src/skills/bibliotheque";
import { ecrireArbre, poserEnv } from "../../skills/arbre";

type Dict = Record<string, unknown>;

let t: BaseDeTest;
let racine: string;
const remises: (() => void)[] = [];

async function appeler(utilisateur: string, args: Dict): Promise<Dict> {
  const uid =
    (await t.base.get<{ id: number }>("SELECT id FROM users WHERE username=?", [utilisateur]))?.id ?? 0;
  const outils = buildRoutineBuiltinTool({ base: t.base, userId: uid });
  return JSON.parse(String(await outils["routine_save"]!.handler(args))) as Dict;
}

const BON = { name: "Veille", task_prompt: "Résume les nouvelles.", cron_expr: "0 8 * * 1" };

beforeEach(async () => {
  t = ouvrirBaseDeTest("sqlite");
  await initialiserBase(t.base);
  await t.base.run(
    "INSERT INTO users(username, pass_salt, pass_hash, created_at, is_admin) VALUES(?,?,?,?,?)",
    ["bob", "s", "h", 0, 0],
  );
  racine = mkdtempSync(join(tmpdir(), "elpis-routine-outil-"));
  await ecrireArbre(join(racine, "global"), {
    "deploy.md": "---\nname: deploy\ndescription: Déployer\n---\nLivrer\n",
  });
  remises.push(
    poserEnv({ APP_SKILLS_DIR: join(racine, "global"), SKILLS_LOCK_PATH: join(racine, ".skills.lock") }),
    surchargerConfig({ USER_SKILLS_DIR: join(racine, "user_skills"), SANDBOX_DIR: join(racine, "sb") }),
  );
  reinitialiserCaches();
  invalidateSkillsScanCache();
  installerPortsSkills(t.base);
  reinitialiserRegistre({ cheminCache: join(racine, "cache.json") });
  const meta = (cat: string): Dict => ({ category: { name: cat } });
  ingestTools([
    { name: "read_file", meta: meta("fs") },
    { name: "web_search", meta: meta("browser") },
    { name: "secret_tool", meta: { category: { name: "shell", hidden: true } } },
  ]);
});

afterEach(async () => {
  for (const r of remises.splice(0).reverse()) r();
  invalidateSkillsScanCache();
  await t.fermer();
  rmSync(racine, { recursive: true, force: true });
});

describe("routine_save", () => {
  it("crée la routine en pause au nom de l'appelant, sans connecteur ni modèle", async () => {
    const r = await appeler("bob", {
      ...BON,
      skills: ["deploy"],
      tool_categories: ["browser", "BROWSER", "fs"],
      notify_on: "error",
    });
    expect(r).toMatchObject({
      ok: true,
      name: "Veille",
      enabled: false,
      cron_expr: "0 8 * * 1",
      tool_categories: ["browser", "fs"],
    });
    const uid = (await t.base.get<{ id: number }>("SELECT id FROM users WHERE username='bob'"))!.id;
    const ligne = (await getRoutine(t.base, r["id"] as number, uid))!;
    expect(ligne).toMatchObject({
      enabled: false,
      model: null,
      connector_id: null,
      agents_enabled: false,
      notify_on: "error",
    });
    expect(ligne["trigger_after_id"]).toBeNull();
    expect(ligne["skills"]).toEqual(["deploy"]);
    expect(ligne["mcp_snapshot"] ?? ligne["mcp_servers"]).toEqual([
      {
        type: "stdio",
        name: "Outils Locaux",
        command: BUILTIN_SENTINEL,
        filter_categories: ["browser", "fs"],
      },
    ]);
  });

  it("sans catégorie : aucun serveur MCP", async () => {
    const r = await appeler("bob", BON);
    const uid = (await t.base.get<{ id: number }>("SELECT id FROM users WHERE username='bob'"))!.id;
    const ligne = (await getRoutine(t.base, r["id"] as number, uid))!;
    expect(ligne["mcp_snapshot"] ?? ligne["mcp_servers"]).toEqual([]);
  });

  it("relaye les erreurs de validation au modèle", async () => {
    expect(await appeler("bob", { ...BON, cron_expr: "pas un cron" })).toMatchObject({
      ok: false,
      error: "invalid_argument",
    });
    expect(await appeler("bob", { ...BON, skills: ["inconnu"] })).toMatchObject({
      ok: false,
      message: "Skill not found: inconnu",
    });
    const treize = Array.from({ length: 13 }, (_, i) => `s${i}`);
    expect(await appeler("bob", { ...BON, skills: treize })).toMatchObject({
      ok: false,
      message: "skills: at most 12 skills per routine",
    });
    expect(await appeler("bob", { ...BON, name: " " })).toMatchObject({
      ok: false,
      message: "Name required",
    });
    expect(await appeler("bob", { ...BON, cron_expr: "61 * * * *" })).toMatchObject({
      ok: false,
      message: 'Cron field "minute" out of range [0-59]: 61',
    });
    expect(await appeler("bob", { ...BON, cron_expr: "* * *" })).toMatchObject({
      ok: false,
      message: "Invalid cron expression (5 fields required: minute hour day-of-month month day-of-week)",
    });
    expect(await appeler("bob", { ...BON, task_prompt: "" })).toMatchObject({ ok: false });
    expect(await appeler("bob", { ...BON, notify_on: "jamais" })).toMatchObject({ ok: false });
  });

  it("refuse une catégorie inconnue ou cachée, en listant les valides", async () => {
    for (const c of ["inconnue", "shell", "routine", "web"]) {
      const r = await appeler("bob", { ...BON, tool_categories: [c] });
      expect(r["ok"]).toBe(false);
      expect(String(r["message"])).toContain("valid values: browser, fs");
    }
  });

  it("la définition est un function-call OpenAI qui refuse tout champ hors liste", () => {
    const f = (definitionOutilRoutine()["function"] as Dict) ?? {};
    expect(f["name"]).toBe("routine_save");
    const p = f["parameters"] as Dict;
    expect(p["additionalProperties"]).toBe(false);
    expect(p["required"]).toEqual(["name", "task_prompt", "cron_expr"]);
    expect(Object.keys(p["properties"] as Dict).sort()).toEqual(
      [
        "cron_expr",
        "name",
        "notify_on",
        "skills",
        "system_prompt",
        "task_prompt",
        "thinking_mode",
        "tool_categories",
      ].sort(),
    );
  });

  it("refuse les arguments hostiles : aucune routine active ne naît", async () => {
    const hostiles: Dict = {
      enabled: true,
      connector_id: 5,
      trigger_after_id: 1,
      mcp_servers: [{ type: "stdio", name: "x", command: "rm" }],
      model: "gros-modele",
      agents_enabled: true,
    };
    for (const [k, v] of Object.entries(hostiles)) {
      const r = await appeler("bob", { ...BON, [k]: v });
      expect(r).toMatchObject({ ok: false, error: "invalid_argument" });
      expect(String(r["message"])).toContain(k);
    }
    expect(await t.base.get("SELECT id FROM editor_routines")).toBeFalsy();
  });

  it("les champs optionnels à null sont ignorés", async () => {
    const r = await appeler("bob", { ...BON, skills: null, tool_categories: null, notify_on: null });
    expect(r).toMatchObject({ ok: true, enabled: false, tool_categories: [] });
  });

  it("note : moteur intégré inaccessible au compte, la note dit de choisir un serveur", async () => {
    const normal = await appeler("bob", BON);
    expect(String(normal["note"])).not.toContain("built-in engine");
    const uid = (await t.base.get<{ id: number }>("SELECT id FROM users WHERE username='bob'"))!.id;
    await setPolicy(t.base, "user", uid, { engine_keys: [], can_manage_models: null });
    const r = await appeler("bob", BON);
    expect(r["ok"]).toBe(true);
    expect(String(r["note"])).toContain("choose a server in the Routines page");
  });
});

describe("typage des arguments", () => {
  it("tool_categories hors liste, thinking_mode non booléen, skills et notify_on mal typés sont refusés", async () => {
    const mauvais: Dict[] = [
      { tool_categories: "fs" },
      { tool_categories: { fs: true } },
      { thinking_mode: "false" },
      { thinking_mode: 0 },
      { skills: "deploy" },
      { notify_on: ["all"] },
    ];
    for (const m of mauvais)
      expect(await appeler("bob", { ...BON, ...m }), JSON.stringify(m)).toMatchObject({ ok: false });
    expect(String((await appeler("bob", { ...BON, tool_categories: "fs" }))["message"])).toContain(
      "must be a list",
    );
    expect(await t.base.get("SELECT id FROM editor_routines")).toBeFalsy();
    expect(await appeler("bob", { ...BON, thinking_mode: true, skills: ["deploy"] })).toMatchObject({
      ok: true,
    });
  });

  it("une catégorie sans aucun outil (restée dans le cache disque) n'est pas offerte", () => {
    const cache = join(racine, "perime.json");
    const d = (nom: string, tools: string[]): Dict => ({ name: nom, label: nom, tools });
    writeFileSync(
      cache,
      JSON.stringify({
        descriptors: { fs: d("fs", ["read_file"]), routine: d("routine", []) },
        tool_to_category: { read_file: "fs" },
        source: "live",
      }),
    );
    reinitialiserRegistre({ cheminCache: cache });
    expect(categoriesRoutine()).toEqual(["fs"]);
  });
});

describe("seconde barrière : corps forcé", () => {
  it("jamais de routine active ni de champs réservés, sans passer par la liste CHAMPS", () => {
    const corps = corpsForce(
      {
        ...BON,
        enabled: true,
        connector_id: 5,
        trigger_after_id: 1,
        mcp_servers: [{ type: "stdio", name: "x", command: "rm" }],
        model: "gros-modele",
        agents_enabled: true,
      },
      [],
    );
    expect(corps["enabled"]).toBe(false);
    expect(corps["mcp_servers"]).toEqual([]);
    for (const k of ["connector_id", "trigger_after_id", "model", "agents_enabled"])
      expect(corps, k).not.toHaveProperty(k);
  });
});

describe("refus en dur, registre alimenté de politiques (production)", () => {
  it("routine et sous-agent refusent ask_user et routine_save même sans politique qui les cite", () => {
    ingestTools([
      { name: "todowrite", meta: { category: { name: "todo" }, policy: { deny_for: ["routine"] } } },
    ]);
    const routine = deniedForRoutine();
    expect(routine.has("todowrite")).toBe(true);
    expect(routine.has("ask_user")).toBe(true);
    expect(routine.has("routine_save")).toBe(true);
    expect(toolsDeniedFor("subagent", ["task"]).has("ask_user")).toBe(false);
    for (const nom of ["ask_user", "routine_save"]) {
      expect(OUTILS_JAMAIS_SOUS_AGENT.has(nom)).toBe(true);
      expect(outilPermisSousAgent({ type: "implement", read_only: false }, nom, false)).toBe(false);
    }
  });

  it("registre vide : repli identique", () => {
    reinitialiserRegistre({ cheminCache: join(racine, "vide.json") });
    expect(deniedForRoutine().has("routine_save")).toBe(true);
    expect(deniedForRoutine().has("ask_user")).toBe(true);
  });
});
