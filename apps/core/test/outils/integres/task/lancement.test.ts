// SPDX-License-Identifier: MIT
/** apps/core/test/outils/integres/task/lancement.test.ts — handler `task` contre une boucle enfant simulée : issues, reprise, annulation, relais, légende, file du moteur, agents du compte. */
import "../../../moteur-environnement";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CancelledError } from "@elpis/commun";

import type { OptionsRun } from "../../../../src/boucle/orchestrateur";
import { installerFileLlm, installerTokenHex } from "../../../../src/boucle/ports";
import type { SortieRun } from "../../../../src/boucle/sortie";
import * as T from "../../../../src/outils/integres/task";
import { installerManifesteMcp } from "../../../../src/outils/ports";
import type { Dict } from "../../../../src/python";

function compteurHex(): (n: number) => string {
  let i = 0;
  return (n) =>
    (++i)
      .toString(16)
      .padStart(2 * n, "0")
      .slice(-2 * n);
}

beforeEach(() => {
  installerManifesteMcp({ defaultOnCategories: () => [] });
  process.env["ELPIS_TASK_RESUME_DIR"] = mkdtempSync(path.join(tmpdir(), "elpis-reprise-"));
});
afterEach(() => {
  installerManifesteMcp(null);
  installerTokenHex(null);
  installerFileLlm(null);
  rmSync(process.env["ELPIS_TASK_RESUME_DIR"]!, { recursive: true, force: true });
  delete process.env["ELPIS_TASK_RESUME_DIR"];
});

type Runner = (o: OptionsRun) => Promise<SortieRun>;

/** La vraie boucle expose ses messages de travail : la doublure rend l'entrée suivie de `suite`. */
function exposer(o: OptionsRun, suite: Dict[]): void {
  o.exposerTravail?.(() => [...(o.messages as Dict[]), ...structuredClone(suite)]);
}

/** Un appel d'outil et son résultat, tels que la boucle les pose dans ses messages de travail. */
const echange = (id: string, nom = "read_file", resultat = "r"): Dict[] => [
  {
    role: "assistant",
    content: null,
    tool_calls: [{ id, type: "function", function: { name: nom, arguments: "{}" } }],
  },
  { role: "tool", tool_call_id: id, content: resultat },
];

/** Résultat `<task …>` lu : en-tête, bloc du harnais, rapport. */
function lireTache(out: string): { entete: string; meta: Dict; rapport: string } {
  const m =
    /^(<task [^>]*>)\n<task_meta>(.*)<\/task_meta>\n<task_result>\n([\s\S]*)\n<\/task_result>\n<\/task>$/u.exec(
      out,
    );
  if (!m) throw new Error(`résultat de task inattendu : ${out.slice(0, 200)}`);
  return { entete: m[1]!, meta: JSON.parse(m[2]!) as Dict, rapport: m[3]! };
}

function construire(runner: Runner, extra: Partial<T.OptionsTache> = {}) {
  const evenements: Dict[] = [];
  const sink: Dict = {};
  const outils = T.buildTaskBuiltinTool({
    username: "alice",
    chatId: "c1",
    model: "m",
    samplingOverride: { temperature: 0.3 },
    isCancelled: null,
    onEvent: (e) => void evenements.push(e),
    usageSink: sink,
    runner,
    ...extra,
  });
  return {
    appeler: (args: Dict) => outils["task"]!.handler(args) as Promise<string>,
    evenements,
    sink,
    outils,
  };
}

describe("handler task", () => {
  it("étape finale : une annulation levée par le relais traverse (except Exception du Python), une autre erreur est tue", async () => {
    for (const [erreur, leve] of [
      [new CancelledError("stop"), true],
      [new Error("relais cassé"), false],
    ] as const) {
      const outils = T.buildTaskBuiltinTool({
        username: "alice",
        chatId: "c1",
        model: "m",
        samplingOverride: null,
        isCancelled: null,
        onEvent: (e) => {
          if (e["status"] === "final") throw erreur;
        },
        usageSink: {},
        runner: async () => ["fini", [], {}],
      });
      const r = outils["task"]!.handler({ subagent_type: "explore", prompt: "x" }) as Promise<string>;
      if (leve) await expect(r).rejects.toThrow("stop");
      else expect(await r).toContain("fini");
    }
  });

  it("rapport coupé par la limite de sortie du moteur : mot inachevé retiré, note du harnais à la fin", async () => {
    const { appeler } = construire(async () => [
      "Status: done\n## Answer\nLe module est relu, il res",
      [],
      { truncated: true },
    ]);
    const { rapport } = lireTache(await appeler({ subagent_type: "explore", prompt: "x" }));
    expect(rapport).toContain(
      "Le module est relu, il …\n\n[report cut by the engine's output limit (max_tokens)]",
    );
  });

  it("consommation réelle : chaque requête de l'enfant met à jour la ligne, l'étape finale et le run la portent", async () => {
    const runner: Runner = async (o) => {
      o.surUsage!({ entree: 4000, sortie: 200, cache: 3500, reflexion: 50 });
      await o.onEvent!({ type: "tool_call", name: "read_file", args: { path: "a" }, call_id: "k1" });
      await o.onEvent!({ type: "tool_result", name: "read_file", result: '{"ok": true}', call_id: "k1" });
      o.surUsage!({ entree: 9000, sortie: 400, cache: 8000, reflexion: 80 });
      return ["Rapport", [], { input_tokens: 8000, output_tokens: 380, thinking_tokens: 90 }];
    };
    const { appeler, evenements, sink } = construire(runner);
    await appeler({ subagent_type: "explore", prompt: "Trouve X" });
    expect(evenements.map((e) => e["status"])).toEqual([
      "spawned",
      "tick",
      "tick",
      "running",
      "done",
      "final",
    ]);
    expect(evenements[1]).toMatchObject({ started: true, tokens: 0, input_tokens: 0, output_tokens: 0 });
    expect(evenements[2]).toMatchObject({
      tokens: 0,
      input_tokens: 4000,
      output_tokens: 200,
      cache_tokens: 3500,
      think_tokens: 50,
    });
    expect(evenements[2]).not.toHaveProperty("tokens_estimated");
    const attendu = {
      input_tokens: 9000,
      output_tokens: 400,
      cache_tokens: 8000,
      think_tokens: 90,
    };
    expect(evenements[5]).toMatchObject(attendu);
    expect((sink["runs"] as Dict[])[0]).toMatchObject(attendu);
    expect(sink).toMatchObject({ input_tokens: 9000, output_tokens: 400 });
  });

  it("enfant arrêté par l'arrêt du tour : la consommation déjà rapportée n'est pas perdue", async () => {
    const runner: Runner = async (o) => {
      o.surUsage!({ entree: 1200, sortie: 30, cache: 0, reflexion: 0 });
      await o.onEvent!({ type: "iteration", n: 2, max: 60 });
      throw new CancelledError("User cancelled");
    };
    const { appeler, evenements, sink } = construire(runner);
    await expect(appeler({ subagent_type: "explore", prompt: "Trouve X" })).rejects.toThrow("User cancelled");
    expect(evenements.at(-1)).toMatchObject({
      status: "final",
      state: "cancelled",
      input_tokens: 1200,
      output_tokens: 30,
    });
    expect(sink).toMatchObject({ input_tokens: 1200, output_tokens: 30 });
  });

  it("arguments manquants ou inconnus : enveloppes d'erreur ASCII", async () => {
    const { appeler } = construire(async () => ["", [], {}]);
    expect(JSON.parse(await appeler({ subagent_type: "explore", prompt: "  " }))).toMatchObject({
      ok: false,
      error: "empty_prompt",
    });
    expect(JSON.parse(await appeler({ subagent_type: "nope", prompt: "x" }))).toMatchObject({
      error: "unknown_agent",
      valid_choices: ["explore", "implement", "verify", "web", "pr"],
    });
    expect(
      JSON.parse(await appeler({ subagent_type: "explore", prompt: "x", task_id: "t9-zz" })),
    ).toMatchObject({ error: "unknown_task_id" });
    expect(await appeler({ subagent_type: "é", prompt: "x" })).toContain("\\u00e9");
  });

  it("mission aboutie : boucle enfant isolée, task_step relayés, enveloppe, record, reprise par task_id", async () => {
    installerTokenHex(compteurHex());
    const recus: OptionsRun[] = [];
    const runner: Runner = async (o) => {
      recus.push(o);
      exposer(o, echange("k1", "read_file", '{"ok": true}'));
      await o.onEvent!({ type: "iteration", n: 1, max: 60, context_tokens: 10 });
      await o.onEvent!({ type: "content_token", text: "je lis" });
      await o.onEvent!({ type: "tool_call", name: "read_file", args: { path: "a" }, call_id: "k1" });
      await o.onEvent!({ type: "kv_cache", used: 321, total: 1000, pct: 32 });
      await o.onEvent!({
        type: "tool_result",
        name: "read_file",
        result: '{"ok": true}',
        call_id: "k1",
        files: [{ path: "a" }],
      });
      await o.onEvent!({ type: "content_token", text: "Rapport final" });
      return ["Rapport final", [], { input_tokens: 5, output_tokens: 3 }];
    };
    const { appeler, evenements, sink } = construire(runner);
    const out = await appeler({ subagent_type: "explore", prompt: "Trouve X", description: "chercher" });
    const { meta, rapport, entete } = lireTache(out);
    expect(entete).toBe('<task id="t1-000001" state="completed">');
    expect(rapport).toBe("Rapport final");
    expect(meta).toMatchObject({
      status: "unknown",
      tool_calls: 1,
      tool_calls_total: 1,
      iterations: 1,
      resumed: false,
      files_changed: [],
      errors: 0,
      read_only: true,
      report_chars: 13,
    });
    const o = recus[0]!;
    expect(o).toMatchObject({
      chatId: "c1#task-t1-000001",
      thinkingMode: false,
      memoryEnabled: false,
      model: "m",
    });
    expect(o.samplingOverride).toEqual({ temperature: 0.3, max_tool_iterations: 60 });
    expect([...(o.denyToolNames as Set<string>)].sort()).toEqual([
      "agent_save",
      "ask_user",
      "routine_save",
      "task",
      "task_send",
      "task_status",
      "task_wait",
      "todowrite",
    ]);
    expect(o.subagent).toEqual({
      type: "explore",
      read_only: true,
      id: "t1-000001",
      browser_session: "isolated",
      deadline_ms: expect.any(Number),
    });
    expect(o.wrapupSuffix).toContain("## Left open");
    const [systeme = "", premier = ""] = (o.messages as Dict[]).map((m) => String(m["content"]));
    expect(systeme).toContain("You are a sub-agent launched by a parent agent");
    expect(systeme).toContain("timeout_sec up to 300");
    expect(systeme).not.toMatch(/Budget:|Mode: READ-ONLY|Date:/u);
    expect(premier).toMatch(/^<task_context>\nDate: \d{4}-\d{2}-\d{2}\nBudget: 60 tool iterations/u);
    expect(premier).toContain("Mode: READ-ONLY for this run");
    expect(premier.endsWith("</task_context>\n\nTrouve X")).toBe(true);
    expect(o.mcpConfigs).toEqual([
      {
        type: "stdio",
        name: "task-explore",
        command: "DEFAULT_LOCAL_PYTHON",
        filter_categories: ["fs", "git"],
      },
    ]);
    expect(evenements.map((e) => e["status"])).toEqual([
      "spawned",
      "tick",
      "tick",
      "text",
      "running",
      "tick",
      "done",
      "final",
    ]);
    expect(evenements[6]).toMatchObject({
      step: 1,
      max_steps: 60,
      calls: 1,
      tool: "read_file",
      tokens: 321,
      files: [{ path: "a" }],
    });
    expect(evenements[7]).toMatchObject({
      state: "completed",
      result: "Rapport final",
      context_tokens: 321,
      input_tokens: 5,
      harness: { status: "unknown", tool_calls: 1 },
    });
    expect(sink).toMatchObject({ tasks: 1, input_tokens: 5, output_tokens: 3 });
    const run = (sink["runs"] as Dict[])[0]!;
    expect(run).toMatchObject({
      id: "t1-000001",
      agent: "explore",
      label: "chercher",
      state: "completed",
      steps_total: 1,
      resumed: false,
      harness: { status: "unknown" },
    });
    expect(run["transcript"]).toEqual([
      { text: "je lis" },
      {
        tool: "read_file",
        call_id: "k1",
        args_preview: '{"path":"a"}',
        status: "done",
        result_preview: '{"ok": true}',
      },
    ]);
    const suite = await appeler({ subagent_type: "explore", prompt: "Et Y ?", task_id: "t1-000001" });
    expect(suite).toContain('<task id="t1-000001"');
    expect(lireTache(suite).meta).toMatchObject({
      resumed: true,
      tool_calls: 1,
      tool_calls_total: 2,
    });
    const reprise = recus[1]!.messages as Dict[];
    expect(reprise.map((m) => m["role"])).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "assistant",
      "user",
    ]);
    expect(reprise.slice(0, 2)).toEqual((recus[0]!.messages as Dict[]).slice(0, 2));
    expect(reprise[3]).toEqual({ role: "tool", tool_call_id: "k1", content: '{"ok": true}' });
    expect(reprise[4]).toEqual({ role: "assistant", content: "Rapport final" });
    expect(reprise[5]!["role"]).toBe("user");
    expect(reprise[5]!["content"]).toMatch(
      /^\[harness\] Budget for this run: 60 tool iterations, up to .+ wall-clock, counted from this message; the budget given earlier \(task_context, harness_status\) no longer applies\.\n\nEt Y \?$/u,
    );
  });

  it("légende du bloc du harnais : au premier bloc de la conversation seulement, ni dans la définition, ni à la ligne, ni au run gardé", async () => {
    let sortie: SortieRun = ["partiel", [], { tool_limit_reached: true, tool_limit_stop_reason: "steps" }];
    const { appeler, outils, evenements, sink } = construire(async (o) => {
      exposer(o, echange("k1"));
      return sortie;
    });
    const premier = JSON.parse(await appeler({ subagent_type: "verify", prompt: "x" })) as Dict;
    expect(Object.keys(premier["harness"] as Dict)[0]).toBe("legend");
    expect((premier["harness"] as Dict)["legend"]).toBe(T.LEGENDE_TASK_META);
    sortie = ["Status: done", [], {}];
    expect(lireTache(await appeler({ subagent_type: "verify", prompt: "y" })).meta).not.toHaveProperty(
      "legend",
    );
    for (const e of evenements.filter((e) => e["status"] === "final"))
      expect(e["harness"]).not.toHaveProperty("legend");
    for (const r of sink["runs"] as Dict[]) expect(r["harness"]).not.toHaveProperty("legend");
    expect(String(((outils["task"]!.definition as Dict)["function"] as Dict)["description"])).not.toContain(
      "<task_meta>",
    );
    const { outils: autreTour } = construire(async (o) => {
      exposer(o, echange("k1"));
      return ["Status: done", [], {}];
    });
    const lancer = (contenu: string): Promise<string> =>
      autreTour["task"]!.handler(
        { subagent_type: "explore", prompt: "z" },
        { callId: "c9", parent: () => ({ envoye: [{ role: "tool", content: contenu }] }) as never },
      ) as Promise<string>;
    expect(
      lireTache(await lancer(`<task_meta>{"legend": "${T.LEGENDE_TASK_META}"}`)).meta,
    ).not.toHaveProperty("legend");
    const { outils: neuf } = construire(async (o) => {
      exposer(o, echange("k1"));
      return ["Status: done", [], {}];
    });
    const sansLegende = (await neuf["task"]!.handler(
      { subagent_type: "explore", prompt: "z" },
      { callId: "c9", parent: () => ({ envoye: [{ role: "tool", content: "autre chose" }] }) as never },
    )) as string;
    expect(lireTache(sansLegende).meta).toHaveProperty("legend", T.LEGENDE_TASK_META);
    const { outils: horsOutil } = construire(async (o) => {
      exposer(o, echange("k1"));
      return ["Status: done", [], {}];
    });
    const envoye = [
      { role: "user", content: T.LEGENDE_TASK_META },
      { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
      { role: "tool", content: [{ type: "text", text: T.LEGENDE_TASK_META }] },
    ];
    const ailleurs = (await horsOutil["task"]!.handler(
      { subagent_type: "explore", prompt: "z" },
      { callId: "c9", parent: () => ({ envoye }) as never },
    )) as string;
    expect(lireTache(ailleurs).meta).toHaveProperty("legend", T.LEGENDE_TASK_META);
  });

  it("issues : erreur du modèle, borne du harnais, panne de la boucle", async () => {
    let sortie: SortieRun = ["", [], { ended_with_error: true }];
    const { appeler } = construire(async (o) => {
      exposer(o, echange("k1"));
      return sortie;
    });
    expect(JSON.parse(await appeler({ subagent_type: "verify", prompt: "x" }))).toMatchObject({
      error: "task_failed",
      retryable: true,
    });
    sortie = ["partiel", [], { tool_limit_reached: true, tool_limit_stop_reason: "wallclock" }];
    const inc = JSON.parse(await appeler({ subagent_type: "verify", prompt: "x" })) as Dict;
    expect(inc).toMatchObject({
      error: "task_incomplete",
      stop_reason: "wallclock",
      partial_report: "partiel",
    });
    expect(String(inc["task_id"]).startsWith("t2-")).toBe(true);
    const { appeler: casse } = construire(async () => {
      throw new Error("boom");
    });
    expect(JSON.parse(await casse({ subagent_type: "verify", prompt: "x" }))).toMatchObject({
      error: "task_failed",
      message: "boom",
    });
  });

  it("✕ sur un enfant : enveloppe task_cancelled, le tour parent survit ; Stop parent : propagé avec bilan", async () => {
    installerTokenHex(compteurHex());
    const runner: Runner = async (o) => {
      exposer(o, echange("k1"));
      await o.onEvent!({ type: "tool_call", name: "read_file", args: {}, call_id: "k1" });
      await o.onEvent!({ type: "tool_result", name: "read_file", result: "r", call_id: "k1" });
      await new Promise((_ok, ko) =>
        o.signal!.addEventListener("abort", () => ko(o.signal!.reason), { once: true }),
      );
      return ["", [], {}];
    };
    const { appeler, evenements } = construire(runner);
    const p = appeler({ subagent_type: "explore", prompt: "x" });
    await new Promise((r) => setTimeout(r, 10));
    expect(T.cancelChild("alice", "t1-000001")).toBe(true);
    const out = JSON.parse(await p) as Dict;
    expect(out).toMatchObject({ error: "task_cancelled", task_id: "t1-000001" });
    expect(T.cancelChild("alice", "t1-000001")).toBe(false);
    expect(evenements.at(-1)).toMatchObject({ status: "final", state: "cancelled" });

    const parent = new AbortController();
    const { appeler: appeler2, sink } = construire(runner, { signal: parent.signal });
    const p2 = appeler2({ subagent_type: "explore", prompt: "y" });
    await new Promise((r) => setTimeout(r, 10));
    parent.abort(new DOMException("stop", "AbortError"));
    await expect(p2).rejects.toThrow("stop");
    expect((sink["runs"] as Dict[])[0]).toMatchObject({ state: "cancelled" });
    const repris = T.resumeLookup("alice", (sink["runs"] as Dict[])[0]!["id"] as string);
    expect((repris?.["messages"] as Dict[]).map((m) => m["role"])).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
    ]);
  });

  it("deux reprises simultanées du même task_id : la seconde rend task_busy, le ✕ arrête la première", async () => {
    installerTokenHex(compteurHex());
    let bloquer = false;
    const runner: Runner = async (o) => {
      if (!bloquer) return ["Rapport", [], {}];
      await new Promise((_ok, ko) =>
        o.signal!.addEventListener("abort", () => ko(o.signal!.reason), { once: true }),
      );
      return ["", [], {}];
    };
    const parent = new AbortController();
    const { appeler, evenements } = construire(runner, { signal: parent.signal });
    expect(await appeler({ subagent_type: "explore", prompt: "x" })).toContain('<task id="t1-000001"');
    bloquer = true;
    const reprendre = (prompt: string) => appeler({ subagent_type: "explore", prompt, task_id: "t1-000001" });
    const a = reprendre("suite A");
    const b = reprendre("suite B");
    try {
      const second = await Promise.race([b, new Promise((ok) => setTimeout(() => ok("en cours"), 50))]);
      expect(second, "la seconde reprise tourne encore").not.toBe("en cours");
      expect(JSON.parse(String(second))).toMatchObject({ ok: false, error: "task_busy" });
      expect(evenements.filter((e) => e["status"] === "spawned" && e["resumed"] === true)).toHaveLength(1);
      expect(T.cancelChild("alice", "t1-000001")).toBe(true);
      expect(JSON.parse(await a)).toMatchObject({ error: "task_cancelled", task_id: "t1-000001" });
    } finally {
      parent.abort(new DOMException("fin du test", "AbortError"));
      await Promise.allSettled([a, b]);
    }
  });

  it("boucle enfant dans la file LLM (priorité du parent, appel outillé) ; profondeur 2 : l'enfant reçoit task", async () => {
    const admissions: unknown[][] = [];
    installerFileLlm({
      withLLM: async (model, priority, _signal, fn, options) => {
        admissions.push([model, priority, options]);
        return fn({ appelLLM: (f: () => Promise<unknown>) => f() } as never);
      },
    });
    let recu: OptionsRun | null = null;
    const { appeler } = construire(
      async (o) => {
        recu = o;
        return ["ok", [], {}];
      },
      { priority: "low" },
    );
    await appeler({ subagent_type: "pr", prompt: "x" });
    expect(admissions).toEqual([["m", "low", { outils: true }]]);
    expect(recu!.slot).not.toBeNull();
    expect(recu!.priority).toBe("low");
  });

  it("agents du compte : surcharge d'un intégré, agent personnalisé, banque vide = pas d'outil", async () => {
    const { outils } = construire(async () => ["", [], {}], {
      customAgents: [
        { name: "explore", description: "lecture", max_iters: 5 },
        { name: "revue", prompt: "Relis.", tool_categories: ["git"] },
        { name: "web", enabled: false },
      ],
    });
    const def = outils["task"]!.definition as Dict;
    const props = ((def["function"] as Dict)["parameters"] as Dict)["properties"] as Dict;
    expect((props["subagent_type"] as Dict)["enum"]).toEqual([
      "explore",
      "implement",
      "verify",
      "pr",
      "revue",
    ]);
    expect(String((def["function"] as Dict)["description"])).toContain("- explore: lecture\n");
    expect(
      construire(async () => ["", [], {}], {
        customAgents: ["explore", "implement", "verify", "web", "pr"].map((name) => ({
          name,
          enabled: false,
        })),
      }).outils,
    ).toEqual({});
  });
});
