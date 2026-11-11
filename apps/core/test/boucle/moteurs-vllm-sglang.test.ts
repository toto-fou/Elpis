// SPDX-License-Identifier: MIT
/** apps/core/test/boucle/moteurs-vllm-sglang.test.ts — vLLM 0.31.0 et SGLang 0.5.21 (moteur par défaut et connecteurs) : réflexion lue dans le bon champ ou en balises, `</think>` orphelin reclassé, dialecte de requête, tour complet. */
import "../moteur-environnement";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { surchargerConfig } from "@elpis/config";

import * as F from "../../src/boucle/flux-llm";
import { durationMsFromTimings } from "../../src/boucle/journal-llm";
import { calculateMetrics } from "../../src/boucle/metriques";
import { installerCrochetJournal } from "../../src/journal";
import { LlmTarget, useLlmTarget } from "../../src/llm/cible";
import { finDeFlux, SseStreamResult, timingsMesures } from "../../src/llm/fournisseurs/llamacpp";
import { installerDisjoncteur, installerExecutions } from "../../src/llm/ports";
import { oublierSondes } from "../../src/llm/sonde-moteur";
import type { Dict } from "../../src/python";
import { lignesSse, reponseEntiere } from "../llm/faux-vllm-sglang";
import type { Dialecte, Scenario } from "../llm/faux-vllm-sglang";
import { data, FauxClient, FauxFlux, reponse } from "./faux-moteur";
import { rejouer } from "./harnais-boucle";
import type * as Capacites from "../../src/llm/fournisseurs/llama-capacites";
import type * as Constantes from "../../src/llm/constantes";
import type * as LlamaHttp from "../../src/llm/llama-http";
import type * as Modeles from "../../src/llm/modeles";
import type * as OpenaiCompat from "../../src/llm/fournisseurs/openai-compat";
import type * as Sante from "../../src/llm/sante";

const etat = vi.hoisted(() => ({
  client: null as unknown,
  ctx: 0,
  ratioGele: false,
  comptageFactice: false,
  categories: null as Record<string, string> | null,
}));

vi.mock("../../src/llm/sante", async (orig) => ({
  ...(await orig<typeof Sante>()),
  verifyLlmAvailability: async () => undefined,
}));
vi.mock("../../src/llm/modeles", async (orig) => ({
  ...(await orig<typeof Modeles>()),
  getModelContextSize: async () => etat.ctx,
}));
vi.mock("../../src/llm/constantes", async (orig) => ({
  ...(await orig<typeof Constantes>()),
  resolveSlotIdAsync: async () => -1,
}));
vi.mock("../../src/llm/fournisseurs/llama-capacites", async (orig) => {
  const reel = await orig<typeof Capacites>();
  return { ...reel, engineCaps: async () => reel.UNKNOWN };
});
vi.mock("../../src/llm/llama-http", async (orig) => ({
  ...(await orig<typeof LlamaHttp>()),
  llamaPost: async () => ({ _status: 0, error: "indisponible (test)", error_type: "ConnectError" }),
}));
vi.mock("../../src/llm/fournisseurs/openai-compat", async (orig) => {
  const reel = await orig<typeof OpenaiCompat>();
  return {
    ...reel,
    endpoint: (t: Parameters<typeof reel.endpoint>[0]) => [
      etat.client,
      reel.chatCompletionsUrl(t),
      reel.headers(t),
    ],
  };
});

const DIALECTES: readonly Dialecte[] = ["vllm", "sglang"];
const RAISONNEMENT = "L'utilisateur veut la capitale. Je vérifie : c'est Paris.";
const REPONSE = "La capitale de la France est **Paris**.";
const Q = [{ role: "user", content: "Quelle est la capitale de la France ?" }];
const OUTIL: Dict = {
  type: "function",
  function: { name: "zeta_echo", parameters: { type: "object", properties: { msg: { type: "string" } } } },
};

let restaurer: () => void = () => undefined;
beforeEach(() => {
  restaurer = surchargerConfig({ LLAMA_RETRIES: 0, LLAMA_REASONING_SOFT_BUDGET_TOKENS: 0 });
});
afterEach(() => {
  restaurer();
  installerDisjoncteur(null);
  etat.client = null;
});

function installer(c: FauxClient): FauxClient {
  etat.client = c.enClient();
  return c;
}

/** Moteur par défaut du type donné, ou connecteur de ce type (`connecteur`). */
function viser<T>(type: string, connecteur: boolean, fn: () => Promise<T>): Promise<T> {
  if (!connecteur) {
    const remettre = surchargerConfig({ LLAMA_PROVIDER_TYPE: type });
    return fn().finally(remettre);
  }
  const cible = new LlmTarget({
    providerType: type,
    baseUrl: "http://gpu.lan:8000/v1",
    apiKey: "",
    model: "Qwen/Qwen3.6-27B",
    connectorId: 7,
    isDefault: false,
  });
  return useLlmTarget(cible, fn);
}

interface Lu {
  pensee: string;
  contenu: string;
  message: Dict;
  sortie: Dict;
  payload: Dict;
}

async function appeler(
  dialecte: string,
  scenario: Scenario | readonly string[],
  o: F.OptionsFlux & { connecteur?: boolean; outils?: Dict[] } = {},
): Promise<Lu> {
  const lignes = Array.isArray(scenario) ? scenario : lignesSse(dialecte as Dialecte, scenario as Scenario);
  const c = installer(new FauxClient([lignes]));
  const pensees: string[] = [];
  const contenus: string[] = [];
  const sortie = await viser(dialecte, o.connecteur ?? false, () =>
    F.llamaChatWithToolsStream(Q, o.outils ?? [], {
      thinkingMode: true,
      ...o,
      onThinkingToken: (t) => void pensees.push(t),
      onContentToken: (t) => void contenus.push(t),
    }),
  );
  const message = ((sortie["choices"] as Dict[])[0]!["message"] ?? {}) as Dict;
  return {
    pensee: pensees.join(""),
    contenu: contenus.join(""),
    message,
    sortie,
    payload: c.payloads[0] as Dict,
  };
}

describe("réflexion en flux : champ du moteur (avec --reasoning-parser)", () => {
  for (const dialecte of DIALECTES)
    for (const connecteur of [false, true])
      it(`${dialecte} ${connecteur ? "connecteur" : "par défaut"} : la réflexion s'affiche, la réponse reste la réponse`, async () => {
        const lu = await appeler(dialecte, { raisonnement: RAISONNEMENT, contenu: REPONSE }, { connecteur });
        expect(lu.pensee).toBe(RAISONNEMENT);
        expect(lu.contenu).toBe(REPONSE);
        expect(lu.message["content"]).toBe(REPONSE);
        expect(lu.sortie["reasoning_channel_native"]).toBe(true);
        expect((lu.sortie["choices"] as Dict[])[0]!["finish_reason"]).toBe("stop");
      });

  it("un serveur qui envoie `reasoning` ET `reasoning_content` : compté une seule fois", async () => {
    const lignes = [
      data({ choices: [{ delta: { reasoning_content: "Je pèse. ", reasoning: "Je pèse. " } }] }),
      data({ choices: [{ delta: { reasoning: "Puis je conclus." } }] }),
      data({ choices: [{ delta: { content: "Fait." }, finish_reason: "stop" }] }),
    ];
    const lu = await appeler("vllm", lignes);
    expect(lu.pensee).toBe("Je pèse. Puis je conclus.");
    expect(lu.contenu).toBe("Fait.");
  });

  it("un `reasoning` qui n'est pas du texte est ignoré", async () => {
    const lignes = [
      data({ choices: [{ delta: { reasoning: { effort: "low" } } }] }),
      data({ choices: [{ delta: { content: "Fait." }, finish_reason: "stop" }] }),
    ];
    const lu = await appeler("vllm", lignes);
    expect(lu.pensee).toBe("");
    expect(lu.contenu).toBe("Fait.");
  });

  for (const dialecte of DIALECTES)
    it(`${dialecte} : appel d'outil émis pendant la réflexion (sans fermante)`, async () => {
      const lu = await appeler(
        dialecte,
        { raisonnement: RAISONNEMENT, appels: [{ nom: "zeta_echo", args: { msg: "ping" } }] },
        { outils: [OUTIL] },
      );
      expect(lu.pensee).toBe(RAISONNEMENT);
      expect(lu.contenu).toBe("");
      expect((lu.sortie["choices"] as Dict[])[0]!["finish_reason"]).toBe("tool_calls");
      expect(lu.message["tool_calls"]).toEqual([
        {
          id: expect.any(String),
          type: "function",
          function: { name: "zeta_echo", arguments: '{"msg":"ping"}' },
        },
      ]);
    });

  for (const dialecte of DIALECTES)
    it(`${dialecte} : réponse vide après la réflexion, outils offerts → observation outils_avales (deux parseurs en cause)`, async () => {
      const avertis: string[] = [];
      installerCrochetJournal((niveau, message) => {
        if (niveau === "WARNING" && message.includes("outils étaient offerts")) avertis.push(message);
      });
      oublierSondes();
      try {
        await appeler(dialecte, { raisonnement: RAISONNEMENT, contenu: REPONSE }, { outils: [OUTIL] });
        await appeler(dialecte, { raisonnement: RAISONNEMENT });
        expect(avertis).toEqual([]);
        const lu = await appeler(dialecte, { raisonnement: RAISONNEMENT }, { outils: [OUTIL] });
        await appeler(dialecte, { raisonnement: RAISONNEMENT }, { outils: [OUTIL] });
        expect(lu.contenu).toBe("");
        expect(lu.message["tool_calls"] ?? []).toEqual([]);
        expect(avertis).toHaveLength(1);
        expect(avertis[0]).toContain(
          "réponse vide après la réflexion alors que des outils étaient offerts : le parseur d'appels d'outils " +
            "ou le parseur de réflexion ne correspond peut-être pas au modèle",
        );
      } finally {
        installerCrochetJournal(null);
        oublierSondes();
      }
    });
});

describe("réflexion en flux sans parseur (balises dans le contenu)", () => {
  for (const dialecte of DIALECTES) {
    it(`${dialecte} : <think> ouvert par le modèle (Qwen3) → découpé en flux`, async () => {
      const lu = await appeler(dialecte, { raisonnement: RAISONNEMENT, contenu: REPONSE, parseur: false });
      expect(lu.pensee.trim()).toBe(RAISONNEMENT);
      expect(lu.contenu.trim()).toBe(REPONSE);
      expect(lu.sortie["reasoning_channel_native"]).toBe(false);
    });

    it(`${dialecte} : <think> ouvert par le gabarit (Qwen3.5+) → seule la fermante sort, reclassée en fin de tour`, async () => {
      const lu = await appeler(dialecte, {
        raisonnement: RAISONNEMENT,
        contenu: REPONSE,
        parseur: false,
        ouvertureParGabarit: true,
      });
      expect(lu.pensee).toBe("");
      expect(lu.message["content"]).toBe(`${RAISONNEMENT}\n</think>\n\n${REPONSE}`);
    });
  }
});

describe("réponse entière (repli d'un 500 en flux)", () => {
  for (const dialecte of DIALECTES)
    it(`${dialecte} : la réflexion du message part en jetons et dans reasoning_content`, async () => {
      const s: Scenario = { raisonnement: RAISONNEMENT, contenu: REPONSE };
      installer(
        new FauxClient([new FauxFlux([], { statut: 500 })], [reponse(200, reponseEntiere(dialecte, s))]),
      );
      const pensees: string[] = [];
      const sortie = await viser(dialecte, false, () =>
        F.llamaChatWithToolsStream(Q, [OUTIL], {
          thinkingMode: true,
          onThinkingToken: (t) => void pensees.push(t),
        }),
      );
      const message = (sortie["choices"] as Dict[])[0]!["message"] as Dict;
      expect(pensees.join("")).toBe(RAISONNEMENT);
      expect(message["reasoning_content"]).toBe(RAISONNEMENT);
      expect(message["content"]).toBe(REPONSE);
    });
});

describe("débits mesurés par Elpis (vLLM et SGLang ne rendent pas de `timings`)", () => {
  const AVEC_CACHE: Dict = {
    prompt_tokens: 5000,
    completion_tokens: 100,
    prompt_tokens_details: { cached_tokens: 4000 },
  };
  const SANS_CACHE: Dict = { prompt_tokens: 5000, completion_tokens: 100 };
  const mesure = (usage: Dict): SseStreamResult => {
    const r = new SseStreamResult();
    r.usage = structuredClone(usage);
    r.debutMs = 1000;
    r.premierMs = 1250;
    r.finMs = 2250;
    return r;
  };

  it("timingsMesures : prefill hors cache si l'usage rapporte le cache, génération seule sinon, usage vide → null", () => {
    expect(timingsMesures(mesure({ ...AVEC_CACHE, cache_read_input_tokens: 4000 }))).toEqual({
      prompt_n: 1000,
      prompt_ms: 250,
      predicted_n: 100,
      predicted_ms: 1000,
      cache_n: 4000,
      source: "elpis",
    });
    for (const usage of [SANS_CACHE, { ...SANS_CACHE, prompt_tokens_details: null }])
      expect(timingsMesures(mesure(usage))).toEqual({
        predicted_n: 100,
        predicted_ms: 1000,
        source: "elpis",
      });
    expect(timingsMesures(mesure({}))).toBeNull();
    expect(timingsMesures(mesure({ ...SANS_CACHE, completion_tokens: 0 }))).toBeNull();
    const sansPremier = mesure(SANS_CACHE);
    sansPremier.premierMs = null;
    expect(timingsMesures(sansPremier)).toBeNull();
  });

  for (const type of ["vllm", "sglang", "llamacpp"] as const)
    it(`finDeFlux ${type} : timings versés à l'exécution, bulle sans débit de lecture si le cache n'est pas rapporté`, async () => {
      const vus: unknown[] = [];
      installerExecutions({ ajouterAppelLlm: (t) => void vus.push(t) });
      try {
        const [avec, sans, natif] = await viser(type, false, async () => {
          const r = [mesure(AVEC_CACHE), mesure(SANS_CACHE), mesure(SANS_CACHE)];
          r[2]!.timings = { prompt_n: 7, prompt_ms: 70, predicted_n: 3, predicted_ms: 30 };
          for (const x of r) finDeFlux(x);
          return r.map((x) => x.timings);
        });
        expect(vus).toEqual([avec, sans, natif]);
        expect(natif).toEqual({ prompt_n: 7, prompt_ms: 70, predicted_n: 3, predicted_ms: 30 });
        if (type === "llamacpp") {
          expect([avec, sans]).toEqual([{}, {}]);
          return;
        }
        expect(avec).toMatchObject({ prompt_n: 1000, prompt_ms: 250, cache_n: 4000, source: "elpis" });
        expect(sans).toEqual({ predicted_n: 100, predicted_ms: 1000, source: "elpis" });
        const bulle = (t: Dict | undefined) => calculateMetrics({ timings: t, usage: SANS_CACHE }, 3);
        expect(bulle(avec)).toMatchObject({ read_tps: 4000, write_tps: 100 });
        expect(bulle(sans)).toMatchObject({ read_tps: 0, write_tps: 100 });
        expect(durationMsFromTimings(sans)).toBe(1000);
      } finally {
        installerExecutions(null);
      }
    });

  for (const dialecte of DIALECTES)
    it(`${dialecte} : flux complet, envoi et premier delta posés par l'appel (prompt_n seulement avec le cache rapporté)`, async () => {
      const lignes = (usage: Dict): string[] => [
        ...lignesSse(dialecte, { raisonnement: RAISONNEMENT, contenu: REPONSE }).slice(0, -2),
        data({ choices: [], usage }),
        "data: [DONE]",
      ];
      const avec = (await appeler(dialecte, lignes(AVEC_CACHE))).sortie["timings"];
      const sans = (await appeler(dialecte, lignes(SANS_CACHE))).sortie["timings"];
      expect(avec).toEqual({
        prompt_n: 1000,
        prompt_ms: expect.any(Number),
        predicted_n: 100,
        predicted_ms: expect.any(Number),
        cache_n: 4000,
        source: "elpis",
      });
      expect(sans).toEqual({ predicted_n: 100, predicted_ms: expect.any(Number), source: "elpis" });
    });
});

describe("dialecte de requête", () => {
  const SURCHARGE: Dict = {
    temperature: 0.6,
    top_p: 0.95,
    top_k: 20,
    min_p: 0,
    repeat_penalty: 1.05,
    thinking_budget_tokens: 8192,
    reasoning_effort: "high",
  };
  const LLAMA_SEUL = ["cache_prompt", "id_slot", "timings_per_token", "return_progress", "n_predict"];

  for (const type of ["vllm", "sglang"])
    for (const connecteur of [false, true])
      it(`${type} ${connecteur ? "connecteur" : "par défaut"} : réflexion activée ou coupée, échantillonnage étendu, rien de llama.cpp`, async () => {
        const ok = { raisonnement: "r", contenu: "c" };
        for (const thinkingMode of [true, false]) {
          const lu = await appeler(type, ok, { connecteur, thinkingMode, samplingOverride: SURCHARGE });
          expect(lu.payload["chat_template_kwargs"]).toEqual({ enable_thinking: thinkingMode });
          expect(lu.payload).toMatchObject({
            temperature: 0.6,
            top_p: 0.95,
            top_k: 20,
            min_p: 0,
            repetition_penalty: 1.05,
            reasoning_effort: "high",
          });
          for (const k of [...LLAMA_SEUL, "repeat_penalty", "thinking_budget_tokens", "separate_reasoning"])
            expect(lu.payload, k).not.toHaveProperty(k);
        }
      });

  it("top_k nul (désactivé chez llama.cpp) devient -1, seule valeur « désactivé » acceptée par SGLang", async () => {
    const lu = await appeler("sglang", { contenu: "c" }, { samplingOverride: { top_k: 0 } });
    expect(lu.payload["top_k"]).toBe(-1);
  });

  it("sans surcharge : ni échantillonnage ni effort inventés (le moteur garde ses défauts)", async () => {
    const lu = await appeler("vllm", { contenu: "c" }, { thinkingMode: false });
    for (const k of ["temperature", "top_p", "top_k", "min_p", "repetition_penalty", "reasoning_effort"])
      expect(lu.payload, k).not.toHaveProperty(k);
    expect(lu.payload["chat_template_kwargs"]).toEqual({ enable_thinking: false });
  });

  it("effort propre à Claude (`max`) jamais envoyé à vLLM ou SGLang", async () => {
    for (const type of ["vllm", "sglang"]) {
      const lu = await appeler(type, { contenu: "c" }, { samplingOverride: { reasoning_effort: "max" } });
      expect(lu.payload, type).not.toHaveProperty("reasoning_effort");
    }
  });

  for (const type of ["openai", "mistral", "generic"])
    it(`${type} : assainissement inchangé (standard seul)`, async () => {
      const lu = await appeler(type, { contenu: "c" }, { connecteur: true, samplingOverride: SURCHARGE });
      for (const k of ["chat_template_kwargs", "top_k", "min_p", "repetition_penalty", "reasoning_effort"])
        expect(lu.payload, k).not.toHaveProperty(k);
      expect(lu.payload).toMatchObject({ temperature: 0.6, top_p: 0.95 });
    });
});

/** Tour complet (boucle réelle, flux réel) contre un faux vLLM ou SGLang : ce que voit l'interface et ce qui s'enregistre. */
async function tour(dialecte: Dialecte, appels: Scenario[], avecOutil = false): Promise<Dict> {
  const remettre = surchargerConfig({ LLAMA_PROVIDER_TYPE: dialecte });
  try {
    return await rejouer(
      {
        messages: [{ role: "user", content: Q[0]!.content }],
        appels: appels.map((s) => lignesSse(dialecte, s)),
        outils: avecOutil ? [{ comportement: "echo", definition: OUTIL }] : [],
        options: { reflexion: true },
      },
      etat as never,
      F.llamaChatWithToolsStream,
    );
  } finally {
    remettre();
  }
}

function types(fige: Dict): string[] {
  return (fige["evenements"] as Dict[]).map((e) => String(e["type"]));
}

function texte(fige: Dict, type: string): string {
  return (fige["evenements"] as Dict[])
    .filter((e) => e["type"] === type)
    .map((e) => String(e["text"] ?? ""))
    .join("");
}

describe("tour complet : réflexion affichée en direct puis enregistrée", () => {
  for (const dialecte of DIALECTES) {
    it(`${dialecte} avec parseur : jetons de réflexion en direct, réponse et réflexion enregistrées`, async () => {
      const fige = await tour(dialecte, [{ raisonnement: RAISONNEMENT, contenu: REPONSE }]);
      expect(fige["final"]).toBe(REPONSE);
      expect((fige["metrics"] as Dict)["thinking"]).toBe(RAISONNEMENT);
      expect(texte(fige, "thinking_token")).toBe(RAISONNEMENT);
      expect(texte(fige, "content_token")).toBe(REPONSE);
      expect(types(fige)).not.toContain("content_replace");
      expect((fige["payloads"] as Dict[])[0]!["chat_template_kwargs"]).toEqual({ enable_thinking: true });
    });

    it(`${dialecte} sans parseur, </think> orphelin : la bulle est reclassée en fin de tour, rien ne fuit`, async () => {
      const fige = await tour(dialecte, [
        { raisonnement: RAISONNEMENT, contenu: REPONSE, parseur: false, ouvertureParGabarit: true },
      ]);
      expect(fige["final"]).toBe(REPONSE);
      expect((fige["metrics"] as Dict)["thinking"]).toBe(RAISONNEMENT);
      const evts = fige["evenements"] as Dict[];
      const iReflexion = evts.findIndex(
        (e) => e["type"] === "thinking_content" && e["text"] === RAISONNEMENT,
      );
      const iRemplace = evts.findIndex((e) => e["type"] === "content_replace");
      expect(iReflexion).toBeGreaterThanOrEqual(0);
      expect(iRemplace).toBeGreaterThan(iReflexion);
      const apres = evts
        .slice(iRemplace)
        .filter((e) => e["type"] === "content_token" || e["type"] === "content_replace")
        .map((e) => String(e["text"] ?? ""))
        .join("");
      expect(apres).toBe(REPONSE);
      expect(apres).not.toContain("</think>");
    });

    it(`${dialecte} sans parseur, outil appelé après une réflexion à fermante orpheline : la narration ne garde pas la réflexion`, async () => {
      const fige = await tour(
        dialecte,
        [
          {
            raisonnement: RAISONNEMENT,
            parseur: false,
            ouvertureParGabarit: true,
            appels: [{ nom: "zeta_echo", args: { msg: "ping" } }],
          },
          {
            raisonnement: "Le résultat confirme.",
            contenu: REPONSE,
            parseur: false,
            ouvertureParGabarit: true,
          },
        ],
        true,
      );
      expect(fige["final"]).toBe(REPONSE);
      expect((fige["metrics"] as Dict)["thinking"]).toBe(`${RAISONNEMENT}\n\nLe résultat confirme.`);
      const evts = fige["evenements"] as Dict[];
      const iOutil = evts.findIndex((e) => e["type"] === "tool_call");
      let visible = "";
      for (const e of evts.slice(0, iOutil)) {
        if (e["type"] === "content_replace") visible = String(e["text"] ?? "");
        if (e["type"] === "content_token") visible += String(e["text"] ?? "");
      }
      expect(visible.trim()).toBe("");
      const historique = (fige["metrics"] as Dict)["tool_history"] as Dict[];
      const tourOutil = historique.find((m) => m["role"] === "assistant" && m["tool_calls"]);
      expect(String(tourOutil?.["content"] ?? "")).not.toContain("</think>");
    });

    it(`${dialecte} avec parseur, outil appelé pendant la réflexion puis réponse`, async () => {
      const fige = await tour(
        dialecte,
        [
          { raisonnement: RAISONNEMENT, appels: [{ nom: "zeta_echo", args: { msg: "ping" } }] },
          { raisonnement: "Le résultat confirme.", contenu: REPONSE },
        ],
        true,
      );
      expect(fige["final"]).toBe(REPONSE);
      expect(texte(fige, "thinking_token")).toBe(`${RAISONNEMENT}Le résultat confirme.`);
      expect((fige["metrics"] as Dict)["thinking"]).toBe(`${RAISONNEMENT}\n\nLe résultat confirme.`);
      expect(types(fige)).toContain("tool_result");
    });
  }
});
