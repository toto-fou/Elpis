// SPDX-License-Identifier: MIT
/** apps/core/test/boucle/dispatch-outils.test.ts — appels d'outils : préparation des lots et enrichissements (vecteurs Python), exécution série/parallèle, annulation, post-traitement. */
import "../moteur-environnement";

import { afterEach, describe, expect, it, vi } from "vitest";

import { pyJsonDumps } from "@elpis/commun";
import type { SousAgent } from "@elpis/securite";

import * as D from "../../src/boucle/dispatch-outils";
import { callStatus, executeToolBatch, exitCode, NON_DEMARRE } from "../../src/boucle/execution-outils";
import { installerJobsBoucle, installerTokenHex, installerVisionBureau } from "../../src/boucle/ports";
import type { PortVisionBureau } from "../../src/boucle/ports";
import { CTX } from "../../src/contexte/config-contexte";
import { QUEUE_MAX_S } from "../../src/images/base";
import { getImageConfig } from "../../src/images/config";
import { ATTENTE_MAX_S, LLAMA_TOOL_PARALLELISM, TASK_CHILD_TIMEOUT_S } from "../../src/llm/constantes";
import type { AppelIntegre } from "../../src/outils/catalogue";
import { toolTimeoutS } from "../../src/outils/delais";
import { DEFINITION_TASK_WAIT } from "../../src/outils/integres/task/definition";
import { RunContext, RunRecord } from "../../src/boucle/run";
import type { ChampsRun, LoopDeps } from "../../src/boucle/run";
import { LiveText } from "../../src/boucle/texte-direct";
import type { Dict } from "../../src/python";
import { lireVecteurs } from "../vecteurs-moteur";

const V = lireVecteurs<{
  fichiers: [unknown, Dict[]][];
  ecritures: [string, unknown, unknown, Dict][];
  desktop: [string, string, boolean, Dict | null][];
  signatures: [string, unknown, string, string][];
  cycles: [string[], boolean[], string[]][];
  coupes: [unknown, unknown, boolean | null][];
  statuts: [Dict, string, string, string, number | null][];
  metas: [boolean, number | null, unknown, boolean, string | number, Dict | null][];
  locaux: [Dict, boolean][];
  rounds: { brut: unknown; prepared: string | null; erreur: string | null; texte: string }[];
}>("boucle-dispatch");

function compteurHex(): (n: number) => string {
  let i = 0;
  return (n) =>
    (++i)
      .toString(16)
      .padStart(2 * n, "0")
      .slice(-2 * n);
}

function contexte(champs: Partial<ChampsRun> = {}): RunContext {
  return new RunContext({
    onEvent: null,
    username: "alice",
    model: "m",
    chatId: "c1",
    userId: 7,
    samplingOverride: null,
    thinkingMode: false,
    isCancelled: null,
    signal: undefined,
    slot: null,
    compressionEnabled: false,
    compactionMaxRounds: null,
    priority: "high",
    liveShell: true,
    startTime: 0,
    modelHasVision: false,
    chatKeySuffix: "c1",
    runLogTok: "tok",
    toolsPayload: [],
    toolCfgMap: new Map(),
    builtinHandlers: new Map(),
    toolsPayloadChars: 0,
    maxIter: 10,
    effectiveIterBudget: 10,
    hardIterCap: 20,
    ...champs,
  });
}

afterEach(() => {
  installerTokenHex(null);
  installerVisionBureau(null);
  installerJobsBoucle(null);
});

describe("fonctions pures du dispatch (vecteurs Python)", () => {
  it("fichiers modifiés et champs d'écriture du tool_result", () => {
    for (const [r, attendu] of V.fichiers) expect(D.changedFilesOf(r)).toStrictEqual(attendu);
    for (const [outil, args, r, attendu] of V.ecritures)
      expect(
        D.writeEventExtra(outil, args, r === null ? null : pyJsonDumps(r)),
        `${outil} ${JSON.stringify(args)}`,
      ).toStrictEqual(attendu);
  });

  it("extras desktop, signatures et cycles d'action", () => {
    for (const [o, r, w, attendu] of V.desktop) expect(D.desktopEventExtra(o, r, w)).toStrictEqual(attendu);
    for (const [o, a, f, attendu] of V.signatures) expect(D.actionCycleSignature(o, a, f)).toBe(attendu);
    for (const [suite, detections, reste] of V.cycles) {
      const buf: string[] = [];
      expect(suite.map((s) => D.detectActionCycle(buf, s))).toEqual(detections);
      expect(buf).toEqual(reste);
    }
  });

  it("coupe length : fenêtre pleine ou plafond ; statut d'appel et code de sortie", () => {
    for (const [u, c, attendu] of V.coupes) expect(D.lengthCutIsCtxFull(u, c as number)).toBe(attendu);
    for (const [p, r, s, statut, rc] of V.statuts) {
      expect(callStatus(p, r, s)).toBe(statut);
      expect(exitCode(r)).toBe(rc);
    }
  });

  it("meta d'appel et outil local", () => {
    for (const [isLocal, userId, chatId, liveShell, callId, attendu] of V.metas)
      expect(
        D.buildCallMeta({ isLocal, username: "alice", chatId, liveShell, callId, runLogTok: "tok", userId }),
      ).toStrictEqual(attendu);
    for (const [cfg, attendu] of V.locaux) expect(D.isLocalTool(new Map([["t", cfg]]), "t")).toBe(attendu);
  });

  it("préparation des lots natif (arguments, erreurs exactes) et texte (ids legacy, appels synthétiques)", async () => {
    for (const r of V.rounds) {
      installerTokenHex(compteurHex());
      const ctx = contexte({ toolCfgMap: new Map([["t", { command: "DEFAULT_LOCAL_PYTHON" }]]) });
      const appels = [
        { id: "", function: { name: "t", arguments: r.brut } },
        "brut",
        { id: "c9", function: "x" },
        { function: { name: null, arguments: "{}" } },
      ];
      const prep = await D.openNativeRound(ctx, new RunRecord(), [], {
        live: new LiveText(null),
        msg: {},
        toolCalls: appels,
        iterClean: "",
        iteration: 4,
      });
      expect(pyJsonDumps(prep, { ensureAscii: false }), JSON.stringify(r.brut)).toBe(r.prepared);
      const wm: Dict[] = [{ role: "assistant", tool_calls: [{ id: "legacy_4_0" }, { id: null }, "x"] }];
      const prep2 = D.openTextRound(contexte(), new RunRecord(), wm, {
        rawText: "<tool_call>x</tool_call> texte",
        calls: [
          ["t", r.brut],
          ["u", { _chat_id: 1 }],
        ],
        finish: "stop",
        iteration: 4,
      });
      expect(pyJsonDumps({ prepared: prep2, message: wm[wm.length - 1] }, { ensureAscii: false })).toBe(
        r.texte,
      );
    }
  });
});

function deps(): LoopDeps {
  return { stream: async () => ({}), recordMetric: () => undefined, llamaChat: async () => ["", {}] };
}

describe("exécution d'un lot", () => {
  it("octets d'arguments et de résultat : UTF-8, demi-paire comptée comme « ? »", async () => {
    const vus: Dict[] = [];
    await executeToolBatch(
      ["é", "a\ud800"].map((t, i) => ({ call_id: `c${i}`, tool_name: "read_a", final_args: t })),
      {
        executeSingle: async (_n, args) => String(args),
        recordMetric: (...a: unknown[]) => void vus.push(a[5] as Dict),
        isToolFailure: () => false,
        onEvent: null,
        username: "u",
        chatId: null,
        onCancelSnapshot: async () => undefined,
        iteration: 0,
      },
    );
    expect(vus.map((v) => [v["argsBytes"], v["resultBytes"]]).sort()).toEqual([
      [2, 2],
      [2, 2],
    ]);
  });

  it("série pour les mutants, parallèle borné sinon, résultats dans l'ordre du modèle", async () => {
    const ordre: string[] = [];
    let actifs = 0;
    let max = 0;
    const executeSingle = async (nom: string): Promise<unknown> => {
      ordre.push(`début ${nom}`);
      actifs++;
      max = Math.max(max, actifs);
      await new Promise((r) => setTimeout(r, nom === "read_a" ? 20 : 5));
      actifs--;
      ordre.push(`fin ${nom}`);
      return { ok: true, nom };
    };
    const prepared = ["read_a", "read_b", "write_file", "read_c"].map((n, i) => ({
      call_id: `c${i}`,
      tool_name: n,
      final_args: {},
    }));
    const r = await executeToolBatch(prepared, {
      executeSingle,
      recordMetric: () => undefined,
      isToolFailure: () => false,
      onEvent: null,
      username: "u",
      chatId: null,
      onCancelSnapshot: async () => undefined,
      iteration: 0,
    });
    expect([...r.entries()].sort(([a], [b]) => a - b)).toEqual(
      [0, 1, 2, 3].map((i) => [i, pyJsonDumps({ ok: true, nom: prepared[i]!.tool_name })]),
    );
    expect(ordre.slice(0, 2)).toEqual(["début read_a", "début read_b"]);
    expect(ordre.indexOf("début write_file")).toBeGreaterThan(ordre.indexOf("fin read_a"));
    expect(max).toBe(2);
    expect(prepared.every((p) => typeof (p as Dict)["duration_ms"] === "number")).toBe(true);
  });

  it("panne d'outil et arguments illisibles : erreurs JSON, jamais levées ; todowrite allégé pour le modèle", async () => {
    const evenements: Dict[] = [];
    const r = await executeToolBatch(
      [
        { call_id: "a", tool_name: "x", final_args: {} },
        { call_id: "b", tool_name: "y", final_args: {}, args_error: "arguments é" },
        { call_id: "c", tool_name: "todowrite", final_args: {} },
      ],
      {
        executeSingle: async (nom) => {
          if (nom === "x")
            throw new AggregateError([new Error("champ manquant"), new Error("champ manquant")]);
          return pyJsonDumps({ ok: true, todos: [{ t: 1 }], remaining: 1, checklist: "[ ] 1" });
        },
        recordMetric: () => undefined,
        isToolFailure: () => false,
        onEvent: (e) => void evenements.push(e),
        username: "u",
        chatId: null,
        onCancelSnapshot: async () => undefined,
        iteration: 0,
      },
    );
    expect(r.get(0)).toBe('{"error": "champ manquant"}');
    expect(r.get(1)).toBe('{"ok": false, "error": "arguments \\u00e9"}');
    expect(r.get(2)).toBe('{"ok": true, "remaining": 1, "checklist": "[ ] 1"}');
    expect(evenements).toEqual([{ type: "todo_updated", todos: [{ t: 1 }], remaining: 1 }]);
  });

  it("tool_progress et tool_log portent le call_id de leur appel (lot parallèle d'un même outil)", async () => {
    const evenements: Dict[] = [];
    await executeToolBatch(
      ["a", "b"].map((id) => ({ call_id: id, tool_name: "read_file", final_args: { path: id } })),
      {
        executeSingle: async (_nom, args, o) => {
          await o.onProgress?.({ progress: 1, total: 2, message: String(args["path"]) });
          await o.onLog?.({ level: "info", logger: "l", data: String(args["path"]) });
          return "{}";
        },
        recordMetric: () => undefined,
        isToolFailure: () => false,
        onEvent: (e) => void evenements.push(e),
        username: "u",
        chatId: null,
        onCancelSnapshot: async () => undefined,
        iteration: 0,
      },
    );
    const vus = evenements.map((e) => [e["type"], e["call_id"], e["message"]]).sort();
    expect(vus).toEqual([
      ["tool_log", "a", "a"],
      ["tool_log", "b", "b"],
      ["tool_progress", "a", "a"],
      ["tool_progress", "b", "b"],
    ]);
  });

  it("annulation en plein lot parallèle : frères arrêtés et attendus, un seul instantané, annulation propagée", async () => {
    const ctrl = new AbortController();
    const instantanes: number[] = [];
    const finis: string[] = [];
    const executeSingle = async (nom: string, _a: Dict, o: { signal?: AbortSignal }): Promise<unknown> => {
      if (nom === "read_a") {
        setTimeout(() => ctrl.abort(new DOMException("stop", "AbortError")), 5);
        return "fait";
      }
      await new Promise((ok, ko) => {
        o.signal?.addEventListener("abort", () => ko(o.signal?.reason), { once: true });
      });
      finis.push(nom);
      return "jamais";
    };
    const resultats = new Map<number, string>();
    await expect(
      executeToolBatch(
        ["read_a", "read_b", "read_c"].map((n) => ({ call_id: n, tool_name: n, final_args: {} })),
        {
          executeSingle,
          recordMetric: () => undefined,
          isToolFailure: () => false,
          onEvent: null,
          username: "u",
          chatId: null,
          onCancelSnapshot: async () => void instantanes.push(1),
          iteration: 0,
          signal: ctrl.signal,
          resultsOut: resultats,
        },
      ),
    ).rejects.toThrow("User cancelled");
    expect(instantanes).toEqual([1]);
    expect([...resultats.keys()]).toEqual([0]);
    expect(finis).toEqual([]);
  });

  it("Stop pendant un lot parallèle : l'appel en attente du sémaphore ne démarre jamais", async () => {
    const ctrl = new AbortController();
    const debuts: string[] = [];
    const executeSingle = async (nom: string, _a: Dict, o: { signal?: AbortSignal }): Promise<unknown> => {
      debuts.push(nom);
      if (debuts.length === LLAMA_TOOL_PARALLELISM)
        setTimeout(() => ctrl.abort(new DOMException("stop", "AbortError")), 5);
      return new Promise((_ok, ko) => {
        o.signal?.addEventListener("abort", () => ko(o.signal?.reason), { once: true });
      });
    };
    const instantanes: number[] = [];
    const noms = Array.from({ length: LLAMA_TOOL_PARALLELISM + 1 }, (_, k) => `read_${k}`);
    await expect(
      executeToolBatch(
        noms.map((n) => ({ call_id: n, tool_name: n, final_args: {} })),
        {
          executeSingle,
          recordMetric: () => undefined,
          isToolFailure: () => false,
          onEvent: null,
          username: "u",
          chatId: null,
          onCancelSnapshot: async () => void instantanes.push(1),
          iteration: 0,
          signal: ctrl.signal,
        },
      ),
    ).rejects.toThrow("User cancelled");
    expect(debuts).toEqual(noms.slice(0, LLAMA_TOOL_PARALLELISM));
    expect(instantanes).toEqual([1]);
  });

  it("Stop : le sous-agent qui attend sa place et l'appel suivant d'un lot en série rendent not_started, pas la sentinelle", async () => {
    const lancer = async (noms: string[], options: Partial<Parameters<typeof executeToolBatch>[1]>) => {
      const ctrl = new AbortController();
      const debuts: string[] = [];
      const resultats = new Map<number, string>();
      await expect(
        executeToolBatch(
          noms.map((n, k) => ({ call_id: `c${k}`, tool_name: n, final_args: {} })),
          {
            executeSingle: async (nom, _a, o) => {
              debuts.push(nom);
              setTimeout(() => ctrl.abort(new DOMException("stop", "AbortError")), 5);
              return new Promise((_ok, ko) => {
                o.signal?.addEventListener("abort", () => ko(o.signal?.reason), { once: true });
              });
            },
            recordMetric: () => undefined,
            isToolFailure: () => false,
            onEvent: null,
            username: "u",
            chatId: null,
            onCancelSnapshot: async () => undefined,
            iteration: 0,
            signal: ctrl.signal,
            resultsOut: resultats,
            ...options,
          },
        ),
      ).rejects.toThrow();
      return { debuts, resultats };
    };
    const taches = await lancer(["task", "task"], { bornes: new Map([["task", 1]]) });
    expect(taches.debuts).toEqual(["task"]);
    expect([...taches.resultats]).toEqual([[1, NON_DEMARRE]]);
    expect(JSON.parse(NON_DEMARRE)).toMatchObject({ error: "not_started" });
    const serie = await lancer(["write_file", "edit_file"], {});
    expect(serie.debuts).toEqual(["write_file"]);
    expect([...serie.resultats]).toEqual([[1, NON_DEMARRE]]);
  });

  it("outil intégré : jamais lancé sur un signal déjà abandonné", async () => {
    let appele = false;
    const stop = new AbortController();
    stop.abort(new DOMException("stop", "AbortError"));
    const integres = new Map<string, (a: Dict) => unknown>([["web_search", () => (appele = true)]]);
    await expect(
      D.executeSingleToolCall("web_search", {}, new Map(), integres, { signal: stop.signal }),
    ).rejects.toThrow("stop");
    expect(appele).toBe(false);
  });

  it("task_wait borné au-delà de son attente maximale, pas au défaut global de 300 s", () => {
    const fn = DEFINITION_TASK_WAIT["function"] as Dict;
    const schema = (fn["parameters"] as Dict)["properties"] as Record<string, Dict>;
    expect(schema["timeout_s"]?.["maximum"]).toBe(ATTENTE_MAX_S);
    expect(toolTimeoutS("task_wait")).toBe(ATTENTE_MAX_S + 60);
  });

  it("délais : un seul calcul pour la boucle et la façade OpenAPI (sous-agent, image)", () => {
    expect("toolTimeoutS" in D).toBe(false);
    expect(toolTimeoutS("task")).toBe(TASK_CHILD_TIMEOUT_S + 60);
    expect(toolTimeoutS("generate_image")).toBe(QUEUE_MAX_S + getImageConfig().timeout_sec + 60);
    expect(QUEUE_MAX_S).toBe(3600);
  });

  it("outil intégré abandonné par la boucle (délai de l'outil, Stop) : son signal d'appel est levé", async () => {
    const espion = vi.spyOn(CTX, "toolTimeoutS").mockImplementation((n) => (n === "lent" ? 0.05 : 0));
    try {
      const recus: AbortSignal[] = [];
      const integres = new Map<string, (a: Dict, appel?: AppelIntegre) => unknown>([
        ["lent", (_a, appel) => (recus.push(appel!.signal!), new Promise(() => undefined))],
        ["vite", (_a, appel) => (recus.push(appel!.signal!), Promise.resolve('{"ok": true}'))],
      ]);
      const delai = JSON.parse(String(await D.executeSingleToolCall("lent", {}, new Map(), integres)));
      expect(delai["error"]).toBe("timeout");
      expect(recus[0]?.aborted).toBe(true);
      const stop = new AbortController();
      const arrete = D.executeSingleToolCall("vite", {}, new Map(), integres, { signal: stop.signal });
      expect(await arrete).toBe('{"ok": true}');
      expect(recus[1]?.aborted).toBe(false);
      const enCours = D.executeSingleToolCall("lent", {}, new Map(), integres, { signal: stop.signal });
      stop.abort(new DOMException("stop", "AbortError"));
      await expect(enCours).rejects.toThrow("stop");
      expect(recus[2]?.aborted).toBe(true);
    } finally {
      espion.mockRestore();
    }
  });

  it("appel d'un sous-agent borné par son échéance souple (horloge monotone) : exécuté avant, refusé après, coupé à l'échéance", async () => {
    const sa = (resteMs: number): SousAgent => ({
      type: "web",
      read_only: true,
      deadline_ms: performance.now() + resteMs,
    });
    const integres = new Map<string, (a: Dict) => unknown>([
      ["web_search", () => '{"ok": true}'],
      ["web_fetch", () => new Promise(() => undefined)],
    ]);
    const appel = (nom: string, resteMs: number): Promise<unknown> =>
      D.executeSingleToolCall(nom, {}, new Map(), integres, { sousAgent: sa(resteMs) });
    expect(await appel("web_search", 60_000)).toBe('{"ok": true}');
    expect(JSON.parse(String(await appel("web_search", -1)))["error"]).toBe("time_limit");
    const t0 = performance.now();
    expect(JSON.parse(String(await appel("web_fetch", 20)))["error"]).toBe("timeout");
    expect(performance.now() - t0).toBeGreaterThanOrEqual(D.GRACE_ECHEANCE_S * 1000);
  });

  it("interruption d'un outil sans annulation de l'appelant : erreur d'outil ordinaire", async () => {
    const r = await executeToolBatch([{ call_id: "a", tool_name: "x", final_args: {} }], {
      executeSingle: async () => {
        throw new DOMException("scope", "AbortError");
      },
      recordMetric: () => undefined,
      isToolFailure: () => false,
      onEvent: null,
      username: "u",
      chatId: null,
      onCancelSnapshot: async () => undefined,
      iteration: 0,
    });
    expect(JSON.parse(r.get(0)!)).toEqual({
      error: "tool 'x': MCP transport interrupted (cancel-scope) — retry the call",
    });
  });
});

describe("lot complet et relances", () => {
  it("tool_call puis tool_result dans l'ordre du modèle, résultats appariés dans l'historique", async () => {
    const evenements: Dict[] = [];
    const ctx = contexte({
      onEvent: (e) => void evenements.push(e),
      builtinHandlers: new Map<string, (a: Dict) => unknown>([
        ["echo", (a) => pyJsonDumps({ ok: true, echo: a })],
        ["lent", async () => ({ ok: false, error: "x" })],
      ]),
    });
    const rec = new RunRecord();
    const wm: Dict[] = [];
    const prepared = await D.openNativeRound(ctx, rec, wm, {
      live: new LiveText(null),
      msg: {},
      toolCalls: [
        { id: "c1", function: { name: "echo", arguments: '{"x": 1.0}' } },
        { id: "c2", function: { name: "lent", arguments: "{}" } },
      ],
      iterClean: "je lance",
      iteration: 0,
    });
    const issue = await D.runToolBatch(D.NATIF, ctx, rec, deps(), wm, prepared, {
      iteration: 0,
      cycle: new D.CycleGuard(),
    });
    expect(issue).toEqual({ hadSuccess: true, cycleHardStopped: false });
    expect(evenements.map((e) => [e["type"], e["call_id"]])).toEqual([
      ["tool_call", "c1"],
      ["tool_call", "c2"],
      ["tool_result", "c1"],
      ["tool_result", "c2"],
    ]);
    expect(evenements[2]!["result"]).toBe('{"ok": true, "echo": {"x": 1.0}}');
    expect(wm.map((m) => m["role"])).toEqual(["assistant", "tool", "tool"]);
    expect(rec.runToolHistory).toHaveLength(3);
  });

  it("intégrés : l'id de l'appel est transmis ; task venu d'un sous-agent refusé par le core, même offert", async () => {
    const recus: unknown[] = [];
    const evenements: Dict[] = [];
    const handlers = new Map<string, (a: Dict, appel?: { callId: string | null }) => unknown>([
      ["echo", (_a, appel) => (recus.push(["echo", appel]), '{"ok": true}')],
      ["task", (_a, appel) => (recus.push(["task", appel]), '{"ok": true}')],
    ]);
    const lancer = async (subagent: ChampsRun["subagent"]): Promise<void> => {
      const ctx = contexte({ onEvent: (e) => void evenements.push(e), builtinHandlers: handlers, subagent });
      const rec = new RunRecord();
      const prepared = await D.openNativeRound(ctx, rec, [], {
        live: new LiveText(null),
        msg: {},
        toolCalls: [
          { id: "c1", function: { name: "echo", arguments: "{}" } },
          {
            id: "c2",
            function: { name: "task", arguments: '{"subagent_type": "implement", "prompt": "x"}' },
          },
        ],
        iterClean: "",
        iteration: 0,
      });
      await D.runToolBatch(D.NATIF, ctx, rec, deps(), [], prepared, {
        iteration: 0,
        cycle: new D.CycleGuard(),
      });
    };
    await lancer({ type: "implement", read_only: false });
    expect(recus).toEqual([
      ["echo", { callId: "c1", rendreSiAnnule: expect.any(Function), signal: expect.any(AbortSignal) }],
    ]);
    const refus = evenements.find((e) => e["type"] === "tool_result" && e["call_id"] === "c2")!;
    expect(JSON.parse(String(refus["result"]))).toMatchObject({ ok: false, error: "not_available_here" });
    recus.length = 0;
    await lancer(null);
    expect(recus).toEqual([
      ["echo", { callId: "c1", rendreSiAnnule: expect.any(Function), signal: expect.any(AbortSignal) }],
      [
        "task",
        {
          callId: "c2",
          parent: expect.any(Function),
          rendreSiAnnule: expect.any(Function),
          signal: expect.any(AbortSignal),
        },
      ],
    ]);
  });

  it("JB-07 : événements de jobs en attente suffixés au PROCHAIN résultat d'outil vu par le modèle, persisté tel quel, une seule fois", async () => {
    const prises: [number, string][] = [];
    let attente = true;
    installerJobsBoucle({
      enAttente: (uid, chatId) => attente && uid === 7 && chatId === "c1",
      prendrePourResultat: async (uid, chatId) => {
        prises.push([uid, chatId]);
        attente = false;
        return '<job_event id="j-00000001" label="t" trigger="exit" state="exited" exit_code="0">\n</job_event>';
      },
    });
    const evenements: Dict[] = [];
    const ctx = contexte({
      onEvent: (e) => void evenements.push(e),
      builtinHandlers: new Map<string, (a: Dict) => unknown>([["echo", () => '{"ok": true}']]),
    });
    const rec = new RunRecord();
    const wm: Dict[] = [];
    const prepared = await D.openNativeRound(ctx, rec, wm, {
      live: new LiveText(null),
      msg: {},
      toolCalls: [
        { id: "c1", function: { name: "echo", arguments: "{}" } },
        { id: "c2", function: { name: "echo", arguments: "{}" } },
      ],
      iterClean: "",
      iteration: 0,
    });
    await D.runToolBatch(D.NATIF, ctx, rec, deps(), wm, prepared, {
      iteration: 0,
      cycle: new D.CycleGuard(),
    });
    expect(prises).toEqual([[7, "c1"]]);
    expect(wm.slice(1).map((m) => m["content"])).toEqual([
      '{"ok": true}\n\n<job_event id="j-00000001" label="t" trigger="exit" state="exited" exit_code="0">\n</job_event>',
      '{"ok": true}',
    ]);
    expect(rec.runToolHistory[1]).toBe(wm[1]);
    expect(evenements.filter((e) => e["type"] === "tool_result").map((e) => e["result"])).toEqual([
      '{"ok": true}',
      '{"ok": true}',
    ]);
  });

  it("trame desktop : propriétaire enregistré (attendu) avant l'événement annotation_frame", async () => {
    const ordre: string[] = [];
    const vision = {
      extractDesktopFrame: (nom: string) =>
        nom === "desktop_shot" ? { token: "tok12345", url: "/f/tok12345", session_id: "s", sig: "g" } : null,
      desktopFramePath: (tok: string) => `/absent/${tok}.png`,
      registerDesktopFrameOwner: async (tok: string, u: string) => {
        await new Promise((ok) => setTimeout(ok, 10));
        ordre.push(`proprietaire ${tok} ${u}`);
      },
      extractPwScreenshotUrl: () => null,
      pwVerbOf: () => "",
      trackPwSessionOwnership: async () => undefined,
      getLastScreenshotB64: () => null,
      trackLastScreenshotForVision: async () => undefined,
      clearLastScreenshotFor: () => undefined,
      modelSupportsVision: async () => false,
    } satisfies PortVisionBureau;
    installerVisionBureau(vision);
    const ctx = contexte({
      userId: null,
      onEvent: (e) => void ordre.push(String(e["type"])),
      builtinHandlers: new Map<string, (a: Dict) => unknown>([["desktop_shot", () => '{"ok": true}']]),
    });
    const rec = new RunRecord();
    const wm: Dict[] = [];
    const prepared = await D.openNativeRound(ctx, rec, wm, {
      live: new LiveText(null),
      msg: {},
      toolCalls: [{ id: "c1", function: { name: "desktop_shot", arguments: "{}" } }],
      iterClean: "",
      iteration: 0,
    });
    await D.runToolBatch(D.NATIF, ctx, rec, deps(), wm, prepared, {
      iteration: 0,
      cycle: new D.CycleGuard(),
    });
    expect(ordre).toEqual(["tool_call", "proprietaire tok12345 alice", "annotation_frame", "tool_result"]);
  });

  it("annulation avant le lot : instantané puis annulation", async () => {
    const evenements: Dict[] = [];
    const rec = new RunRecord();
    rec.runToolHistory.push({ role: "assistant", content: "x" });
    const ctx = contexte({ onEvent: (e) => void evenements.push(e), isCancelled: () => true });
    await expect(
      D.runToolBatch(D.TEXTE, ctx, rec, deps(), [], [], { iteration: 0, cycle: new D.CycleGuard() }),
    ).rejects.toThrow("User cancelled");
    expect(evenements.map((e) => e["type"])).toEqual(["tool_history_partial"]);
  });

  it("relances bornées : appel illisible, outil inconnu, appel perdu dans le raisonnement", async () => {
    const ctx = contexte({ builtinHandlers: new Map([["lire", () => "ok"]]) });
    const live = new LiveText(null);
    const illisible = D.classifyTextReply(ctx, live, '<tool_call>{"name": "lire", oops}</tool_call>', 1);
    const wm: Dict[] = [];
    const rec = new RunRecord();
    let [relance, n] = await D.relaunchUnparsedCall(rec, wm, illisible, {
      live,
      iterThinking: "",
      iteration: 1,
      malformedRetry: 0,
    });
    expect([relance, n]).toEqual([true, 1]);
    expect(String(wm[wm.length - 1]!["content"])).toContain("could not be parsed");
    live.parts.push('{"name": "inconnu", "arguments": {}}');
    const inconnu = D.classifyTextReply(ctx, live, '{"name": "inconnu", "arguments": {}}', 2);
    expect([inconnu.rawText, inconnu.unknownNames, live.parts]).toEqual(["", ["inconnu"], []]);
    [relance, n] = await D.relaunchUnparsedCall(rec, wm, inconnu, {
      live,
      iterThinking: "",
      iteration: 2,
      malformedRetry: n,
    });
    expect([relance, n]).toEqual([true, 2]);
    const perdu = D.classifyTextReply(ctx, live, "", 3);
    [relance, n] = await D.relaunchUnparsedCall(rec, wm, perdu, {
      live,
      iterThinking: "</parameter></function>",
      iteration: 3,
      malformedRetry: n,
    });
    expect([relance, n]).toEqual([false, 2]);
    [relance] = await D.relaunchUnparsedCall(rec, wm, perdu, {
      live,
      iterThinking: "</tool_call>",
      iteration: 3,
      malformedRetry: 0,
    });
    expect(relance).toBe(true);
  });

  it("coupes d'appels : relance compacte, sortie à la troisième (fenêtre pleine ou plafond)", async () => {
    const evenements: Dict[] = [];
    const ctx = contexte({ onEvent: (e) => void evenements.push(e) });
    const rec = new RunRecord();
    rec.ctxSize = 1000;
    const g = new D.TruncationGuard();
    const wm: Dict[] = [];
    const sorties: boolean[] = [];
    for (const pt of [100, 990, 100])
      sorties.push(
        await g.cut("natif", ctx, rec, wm, {
          usage: { prompt_tokens: pt, completion_tokens: 0 },
          iterClean: "texte",
          iteration: 1,
        }),
      );
    expect(sorties).toEqual([false, false, true]);
    expect(g.stop).toBe("ctx_saturated");
    expect(evenements.map((e) => e["text"] ?? e["message"])).toEqual([
      "L'appel d'outil a été coupé (plafond de génération atteint) — nouvelle tentative avec un appel plus compact.",
      "L'appel d'outil a été coupé (fenêtre de contexte pleine) — nouvelle tentative avec un appel plus compact.",
      "L'appel d'outil a été coupé (plafond de génération atteint) — nouvelle tentative avec un appel plus compact.",
      "contexte saturé — arrêt des appels d'outils",
    ]);
    expect(wm.filter((m) => m["role"] === "assistant")).toHaveLength(3);
    expect(rec.runToolHistory).toHaveLength(3);
  });
});
