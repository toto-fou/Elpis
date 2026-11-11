// SPDX-License-Identifier: MIT
/** apps/core/test/boucle/tour-llm.test.ts — tour LLM : aplatissement, ids uniques, relance « hoquet » (vecteurs Python) ; issues du tour contre un flux simulé. */
import "../moteur-environnement";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { surchargerConfig } from "@elpis/config";

import { installerDormir, installerTokenHex } from "../../src/boucle/ports";
import { ResumeState } from "../../src/boucle/reprise";
import { RunContext, RunRecord } from "../../src/boucle/run";
import type { ChampsRun, FluxFn, LoopDeps } from "../../src/boucle/run";
import * as T from "../../src/boucle/tour-llm";
import { AUTO } from "../../src/contexte/porte-compaction";
import { LlmTarget, useLlmTarget } from "../../src/llm/cible";
import { ConnectError } from "../../src/llm/client-http";
import { installerConnecteurs } from "../../src/llm/ports";
import { LLMFailure, providerHttpError } from "../../src/llm/reprises";
import type { Dict } from "../../src/python";
import { lireVecteurs } from "../vecteurs-moteur";
import type * as Modeles from "../../src/llm/modeles";
import { deplier } from "./aides";

vi.mock("../../src/llm/modeles", async (orig) => ({
  ...(await orig<typeof Modeles>()),
  getModelContextSize: async () => 0,
}));

const V = deplier(lireVecteurs<unknown>("boucle-tour")) as {
  aplatis: { messages: unknown[]; sortie: Dict[] }[];
  ids: { appels: unknown[]; historique: unknown[]; sortie: unknown[] }[];
  hoquets: [string, string, boolean, boolean][];
};

function compteurHex(): (n: number) => string {
  let i = 0;
  return (n) =>
    (++i)
      .toString(16)
      .padStart(2 * n, "0")
      .slice(-2 * n);
}

describe("fonctions pures du tour (vecteurs Python)", () => {
  afterEach(() => installerTokenHex(null));

  it("aplatissement de l'historique d'outils", () => {
    for (const a of V.aplatis)
      expect(T.flattenToolMessages(structuredClone(a.messages))).toStrictEqual(a.sortie);
  });

  it("ids d'appel uniques sur tout l'historique", () => {
    for (const c of V.ids) {
      installerTokenHex(compteurHex());
      expect(T.uniqueToolCallIds(structuredClone(c.appels), c.historique)).toStrictEqual(c.sortie);
    }
  });

  it("relance « hoquet » selon la famille de panne", () => {
    for (const [kind, corps, enAttente, attendu] of V.hoquets)
      expect(T.llmErrorHiccupOk(kind, providerHttpError(429, corps), { flattenPending: enAttente })).toBe(
        attendu,
      );
  });
});

function contexte(champs: Partial<ChampsRun> = {}): RunContext {
  return new RunContext({
    onEvent: null,
    username: "golden",
    model: "golden-model",
    chatId: "c1",
    userId: null,
    samplingOverride: null,
    thinkingMode: false,
    isCancelled: null,
    signal: undefined,
    slot: null,
    compressionEnabled: false,
    compactionMaxRounds: null,
    priority: "high",
    liveShell: false,
    startTime: 0,
    modelHasVision: false,
    chatKeySuffix: "",
    runLogTok: "",
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

function deps(stream: FluxFn): LoopDeps {
  return { stream, recordMetric: () => undefined, llamaChat: async () => ["", {}] };
}

const reponse = (
  message: Dict,
  finish = "stop",
  usage: Dict = { prompt_tokens: 120, completion_tokens: 5 },
): Dict => ({
  choices: [{ finish_reason: finish, message }],
  usage,
});

describe("issues d'un tour", () => {
  let evenements: Dict[];
  let restaurer: () => void;
  beforeEach(() => {
    evenements = [];
    installerDormir(async () => undefined);
    restaurer = surchargerConfig({ PRUNE_EVERY_ITERS: 0 });
  });
  afterEach(() => {
    installerDormir(null);
    restaurer();
  });
  const ctxEv = (champs: Partial<ChampsRun> = {}): RunContext =>
    contexte({ onEvent: (e) => void evenements.push(e), ...champs });
  const etat = (): T.LLMTurnState => new T.LLMTurnState(2, AUTO);
  const W: Dict[] = [{ role: "user", content: "q" }];

  it("réponse décodée : raisonnement en balises extrait, ids rendus uniques", async () => {
    installerTokenHex(compteurHex());
    const rec = new RunRecord();
    const t = await T.callLlm(
      ctxEv(),
      rec,
      etat(),
      new ResumeState(),
      deps(async () =>
        reponse({
          content: "<think>je pense</think> Réponse ",
          tool_calls: [{ id: "", function: { name: "f" } }],
        }),
      ),
      [...W],
      { iteration: 0, effectiveIter: 0 },
    );
    expect(t.outcome).toBe("ok");
    expect([t.iterThinking, t.iterClean, t.rawContentExact]).toEqual([
      "je pense",
      "Réponse",
      "<think>je pense</think> Réponse ",
    ]);
    expect((t.toolCalls[0] as Dict)["id"]).toBe("call_000000000001");
    expect(evenements).toEqual([{ type: "thinking_content", text: "je pense" }]);
    expect([rec.cumulIn, rec.cumulOut, rec.allThinking]).toEqual([120, 5, ["je pense"]]);
    installerTokenHex(null);
  });

  it("hoquet : relance tant que rien n'est émis, puis issue fatale après la série", async () => {
    const st = etat();
    const rec = new RunRecord();
    const panne: FluxFn = async () => {
      throw new LLMFailure(new ConnectError("refusé"));
    };
    const issues: string[] = [];
    for (let i = 0; i < 4; i++)
      issues.push(
        (
          await T.callLlm(ctxEv(), rec, st, new ResumeState(), deps(panne), [...W], {
            iteration: 1,
            effectiveIter: 1,
          })
        ).outcome,
      );
    expect(issues).toEqual(["retry", "retry", "retry", "fatal"]);
    expect(evenements.filter((e) => e["type"] === "info")).toHaveLength(3);
  });

  it("refus de requête à l'itération 0 : aplatissement une fois puis relance", async () => {
    const st = etat();
    const refus: FluxFn = async () => {
      throw new LLMFailure(providerHttpError(400, "bad template"));
    };
    const t = await T.callLlm(
      ctxEv(),
      new RunRecord(),
      st,
      new ResumeState(),
      deps(refus),
      [
        { role: "assistant", content: null, tool_calls: [{ function: { name: "f" } }] },
        { role: "tool", content: "r" },
      ],
      { iteration: 0, effectiveIter: 0 },
    );
    expect(t.outcome).toBe("retry");
    expect(st.flattenRetryDone).toBe(true);
    expect(t.messages).toEqual(
      T.flattenToolMessages([
        { role: "assistant", content: null, tool_calls: [{ function: { name: "f" } }] },
        { role: "tool", content: "r" },
      ]),
    );
  });

  it("réponse sans choices : relances comptées, la demande de reprise est restituée, puis arrêt", async () => {
    const st = etat();
    const resume = new ResumeState();
    resume.pendingContent = "début";
    const vide: FluxFn = async (_m, _t, o) => {
      expect(o.resumeContent).toBe("début");
      return { choices: [] };
    };
    const issues: string[] = [];
    for (let i = 0; i < 4; i++)
      issues.push(
        (
          await T.callLlm(ctxEv(), new RunRecord(), st, resume, deps(vide), [...W], {
            iteration: 1,
            effectiveIter: 1,
          })
        ).outcome,
      );
    expect(issues).toEqual(["retry_counted", "retry_counted", "retry_counted", "stop_empty"]);
  });

  it("jauge de contexte sur l'usage réel ; reprise de rédaction recollée et comptée comme émise", async () => {
    const rec = new RunRecord();
    rec.ctxSize = 1000;
    rec.gaugeCtxTotal = 1000;
    const resume = new ResumeState();
    resume.pendingContent = "Début ";
    const t = await T.callLlm(
      ctxEv(),
      rec,
      etat(),
      resume,
      deps(async (_m, _t, o) => {
        await o.onContentToken!("suite.");
        return reponse({ content: "suite." }, "stop", { prompt_tokens: 125, completion_tokens: 3 });
      }),
      [...W],
      { iteration: 2, effectiveIter: 2 },
    );
    expect(t.iterClean).toBe("Début suite.");
    expect(t.live.parts).toEqual(["Début ", "suite."]);
    expect(t.live.n).toBe(6);
    expect(evenements).toContainEqual({ type: "kv_cache", used: 125, total: 1000, pct: 12 });
  });

  it("prompt réel au-delà de la fenêtre : avis une fois par run si elle est lue ou déclarée, journal seul si devinée", async () => {
    const appel = (cible: LlmTarget, st: T.LLMTurnState): Promise<unknown> => {
      const rec = new RunRecord();
      rec.ctxSize = 1000;
      rec.gaugeCtxTotal = 1000;
      const flux: FluxFn = async () =>
        reponse({ content: "ok" }, "stop", { prompt_tokens: 1500, completion_tokens: 3 });
      return useLlmTarget(cible, () =>
        T.callLlm(ctxEv(), rec, st, new ResumeState(), deps(flux), [...W], {
          iteration: 1,
          effectiveIter: 1,
        }),
      );
    };
    const avis = (): Dict[] => evenements.filter((e) => e["type"] === "notice");
    const sglang = new LlmTarget({ providerType: "sglang", isDefault: false, connectorId: 41 });
    const st = etat();
    await appel(sglang, st);
    await appel(sglang, st);
    expect(evenements).toContainEqual({ type: "kv_cache", used: 1500, total: 1000, pct: 100 });
    expect(avis()).toHaveLength(1);
    expect(avis()[0]).toMatchObject({ level: "warn" });
    expect(String(avis()[0]!["message"])).toContain("1500");
    expect(String(avis()[0]!["message"])).toContain("(--context-length)");
    installerConnecteurs({
      getSecretForUser: async () => null,
      bumpLastUsed: async () => undefined,
      getMeta: async (cid) => (cid === 43 ? { context_window: 1000 } : {}),
      allowedProviderTypes: () => [],
    });
    try {
      evenements.length = 0;
      await appel(new LlmTarget({ providerType: "openai", isDefault: false, connectorId: 42 }), etat());
      expect(evenements).toContainEqual({ type: "kv_cache", used: 1500, total: 1000, pct: 100 });
      expect(avis()).toEqual([]);
      await appel(new LlmTarget({ providerType: "openai", isDefault: false, connectorId: 43 }), etat());
      expect(avis()).toHaveLength(1);
    } finally {
      installerConnecteurs(null);
    }
  });

  it("annulation pendant l'appel : instantané de l'historique d'outils puis propagation", async () => {
    const ctrl = new AbortController();
    const rec = new RunRecord();
    rec.runToolHistory = [{ role: "assistant", content: "x" }];
    const raison = new DOMException("stop", "AbortError");
    await expect(
      T.callLlm(
        ctxEv({ signal: ctrl.signal }),
        rec,
        etat(),
        new ResumeState(),
        deps(async () => {
          ctrl.abort(raison);
          throw raison;
        }),
        [...W],
        { iteration: 3, effectiveIter: 3 },
      ),
    ).rejects.toBe(raison);
    expect(evenements.map((e) => e["type"])).toEqual(["tool_history_partial"]);
  });
});
