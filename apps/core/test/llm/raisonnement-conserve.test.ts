// SPDX-License-Identifier: MIT
/** apps/core/test/llm/raisonnement-conserve.test.ts — « Raisonnement conservé » avec SGLang : offert si un parseur de réflexion la sépare, éteint par défaut, réflexion rendue au moteur sans balisage et jamais à l'historique. */
import "./environnement-fournisseurs";

import { describe, expect, it } from "vitest";

import { demarrerFauxMoteur } from "../../../../tests/frontend/lib/faux-moteurs.mjs";
import type { Dict } from "../../src/python";
import { moteurFrais } from "./moteur-frais";

async function monter(type: "vllm" | "sglang", parseurReflexion: string | null) {
  const faux = await demarrerFauxMoteur({ type, parseurReflexion });
  const m = await moteurFrais({
    LLAMA_URL: `${faux.url}/v1/chat/completions`,
    LLAMA_PROVIDER_TYPE: type,
    LLAMA_ENGINE: type,
    LLAMA_MODEL: faux.options.modele,
  });
  return {
    m,
    async fermer(): Promise<void> {
      await m.fermer();
      await faux.arreter();
    },
  };
}

describe("effective-params : interrupteur offert par le serveur", () => {
  it("SGLang avec parseur de réflexion : offert, éteint par défaut ; sans parseur : non offert ; vLLM : inchangé", async () => {
    const cas: ["vllm" | "sglang", string | null, Dict][] = [
      ["sglang", "qwen3", { supports_preserve_reasoning: true, preserve_reasoning_default: false }],
      ["sglang", null, { supports_preserve_reasoning: false, preserve_reasoning_default: false }],
      ["vllm", "qwen3", { supports_preserve_reasoning: null }],
    ];
    for (const [type, parseur, attendu] of cas) {
      const t = await monter(type, parseur);
      try {
        const { avecReflexionRenvoyee } = await import("../../src/familles/llm");
        const r = await avecReflexionRenvoyee(t.m.moteurs.builtinEngine(), {
          supports_preserve_reasoning: null,
        });
        expect(r, `${type} ${String(parseur)}`).toEqual(attendu);
      } finally {
        await t.fermer();
      }
    }
  });
});

describe("tour d'outils natif : réflexion rendue au moteur", () => {
  it("désactivé par défaut ; activé, la réflexion sans balisage d'appel accompagne le message de travail, jamais tool_history ; llama.cpp inchangé", async () => {
    const t = await monter("sglang", "qwen3");
    try {
      const D = await import("../../src/boucle/dispatch-outils");
      const { RunContext, RunRecord } = await import("../../src/boucle/run");
      const { LiveText } = await import("../../src/boucle/texte-direct");
      const { EngineRef, useEngine } = t.m.moteurs;
      const pensee = 'je lis le fichier\n<tool_call>\n{"name": "echo", "arguments": {}}\n</tool_call>';
      const ouvrir = (moteur: InstanceType<typeof EngineRef>, surcharge: Dict | null) =>
        useEngine(moteur, async () => {
          const ctx = new RunContext({
            onEvent: null,
            username: "alice",
            model: "m",
            chatId: "c1",
            userId: 7,
            samplingOverride: surcharge,
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
          });
          const rec = new RunRecord();
          const wm: Dict[] = [];
          await D.openNativeRound(ctx, rec, wm, {
            live: new LiveText(null),
            msg: {},
            toolCalls: [{ id: "c1", function: { name: "echo", arguments: "{}" } }],
            iterClean: "",
            iteration: 0,
            iterThinking: pensee,
          });
          return { wm, rec };
        });
      const sglang = t.m.moteurs.builtinEngine();
      expect((await ouvrir(sglang, null)).wm[0]).not.toHaveProperty("reasoning_content");
      expect((await ouvrir(sglang, { preserve_reasoning: false })).wm[0]).not.toHaveProperty(
        "reasoning_content",
      );
      const { wm, rec } = await ouvrir(sglang, { preserve_reasoning: true });
      expect(wm[0]?.["reasoning_content"]).toBe("je lis le fichier");
      expect(rec.runToolHistory[0]).not.toHaveProperty("reasoning_content");
      const llama = new EngineRef({ key: "conn:6", baseRoot: "http://llama", providerType: "llamacpp" });
      expect((await ouvrir(llama, { preserve_reasoning: true })).wm[0]).not.toHaveProperty(
        "reasoning_content",
      );
    } finally {
      await t.fermer();
    }
  });
});

describe("comptage : réflexion rendue au moteur", () => {
  it("comptée dans les caractères, l'estimation et le texte à tokeniser seulement quand le message la porte", async () => {
    const T = await import("../../src/contexte/tokens");
    const sans: Dict = { role: "assistant", content: "ok", tool_calls: [] };
    const avec: Dict = { ...sans, reasoning_content: "x".repeat(400) };
    expect(T.payloadChars([avec])).toBeGreaterThan(T.payloadChars([sans]) + 300);
    expect(T.estTokensMessage(avec)).toBeGreaterThan(T.estTokensMessage(sans));
    expect(T.messageTextForTokenize(avec)).toContain("x".repeat(400));
  });
});
