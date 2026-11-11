// SPDX-License-Identifier: MIT
/** apps/core/test/boucle/flux-llm.test.ts — un appel en flux avec outils : coupures, replis du 500, partiels, reprise, erreurs SSE, payload, annulation. */
import "../moteur-environnement";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { surchargerConfig } from "@elpis/config";

import * as F from "../../src/boucle/flux-llm";
import { installerControleRaisonnement } from "../../src/boucle/ports";
import { RESUME_AFTER_THINK_INSTRUCTION } from "../../src/boucle/reprise-raisonnement";
import { ConnectError, ReadError } from "../../src/llm/client-http";
import { SseStreamResult } from "../../src/llm/fournisseurs/llamacpp";
import { continueFinalCache } from "../../src/llm/parametres";
import { installerDisjoncteur } from "../../src/llm/ports";
import { KIND_CONTEXT_OVERFLOW, LLMFailure } from "../../src/llm/reprises";
import type { Dict } from "../../src/python";
import { data, FauxClient, FauxFlux, reponse } from "./faux-moteur";
import type * as LlamaCapacites from "../../src/llm/fournisseurs/llama-capacites";
import type * as LlamaFlux from "../../src/llm/fournisseurs/llama-flux";
import type * as OpenaiCompat from "../../src/llm/fournisseurs/openai-compat";
import type * as Modeles from "../../src/llm/modeles";
import type * as Parametres from "../../src/llm/parametres";
import type * as Reprises from "../../src/llm/reprises";

const etat = vi.hoisted(() => ({
  client: null as unknown,
  pauses: [] as unknown[],
  caps: { resumableStream: false },
  lookup: new Map<unknown, Record<string, unknown>>(),
  reprise: null as unknown,
  arrets: [] as unknown[][],
  finsRaisonnement: [] as unknown[][],
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
vi.mock("../../src/llm/parametres", async (orig) => ({
  ...(await orig<typeof Parametres>()),
  resolveSampling: async () => ({}),
}));
vi.mock("../../src/llm/modeles", async (orig) => ({
  ...(await orig<typeof Modeles>()),
  getModelContextSize: async () => 0,
}));
vi.mock("../../src/llm/reprises", async (orig) => ({
  ...(await orig<typeof Reprises>()),
  retryPause: async (e: unknown) => {
    etat.pauses.push(e);
  },
}));
vi.mock("../../src/llm/fournisseurs/llama-capacites", async (orig) => ({
  ...(await orig<typeof LlamaCapacites>()),
  engineCaps: async () => etat.caps,
}));
vi.mock("../../src/llm/fournisseurs/llama-flux", async (orig) => ({
  ...(await orig<typeof LlamaFlux>()),
  lookupStreams: async () => etat.lookup,
  resumeRequest: async () => etat.reprise,
  cancelStream: async (...a: unknown[]) => {
    etat.arrets.push(a.slice(1, 4));
    return true;
  },
  endReasoning: async (...a: unknown[]) => {
    etat.finsRaisonnement.push(a.slice(1, 4));
    return true;
  },
}));

const outil = (nom: string, parametres: unknown = {}): Dict => ({
  type: "function",
  function: { name: nom, parameters: parametres },
});
const Q = [{ role: "user", content: "écris" }];
const fin = (raison: string, usage: Dict = { prompt_tokens: 10, completion_tokens: 2 }): string =>
  data({ choices: [{ delta: {}, finish_reason: raison }], usage });

function installer(c: FauxClient): FauxClient {
  etat.client = c.enClient();
  return c;
}

let restaurer: () => void = () => undefined;
beforeEach(() => {
  etat.pauses = [];
  etat.caps = { resumableStream: false };
  etat.lookup = new Map();
  etat.reprise = null;
  etat.arrets = [];
  etat.finsRaisonnement = [];
  continueFinalCache.clear();
  restaurer = surchargerConfig({ LLAMA_RETRIES: 2, LLAMA_REASONING_SOFT_BUDGET_TOKENS: 0 });
});
afterEach(() => {
  restaurer();
  installerDisjoncteur(null);
  installerControleRaisonnement(null);
});

const APPEL_PENSEE =
  "Je vais écrire le fichier.\n<tool_call>\n<function=write_file>\n<parameter=path>\na.py\n</parameter>\n<parameter=content>\ndef f(";

describe("flux avec outils : fin et récupération", () => {
  it("coupure silencieuse : l'appel du raisonnement n'est jamais promu (partiel, length)", async () => {
    installer(new FauxClient([[data({ choices: [{ delta: { reasoning_content: APPEL_PENSEE } }] })]]));
    const out = await F.llamaChatWithToolsStream(Q, [outil("write_file")]);
    const ch = (out["choices"] as Dict[])[0]!;
    expect((ch["message"] as Dict)["tool_calls"]).toBeNull();
    expect(ch["finish_reason"]).toBe("length");
    expect(out["partial"]).toBe(true);
  });

  it("fin propre : l'appel fermé dans le raisonnement est récupéré", async () => {
    const ferme = APPEL_PENSEE + "x): pass\n</parameter>\n</function>\n</tool_call>";
    installer(new FauxClient([[data({ choices: [{ delta: { reasoning_content: ferme } }] }), fin("stop")]]));
    const out = await F.llamaChatWithToolsStream(Q, [outil("write_file")]);
    const ch = (out["choices"] as Dict[])[0]!;
    expect(ch["finish_reason"]).toBe("tool_calls");
    expect(((ch["message"] as Dict)["tool_calls"] as Dict[])[0]!["function"]).toMatchObject({
      name: "write_file",
    });
  });

  it("flux vide sans fin : relancé, puis échec typé après toutes les tentatives", async () => {
    const c = installer(new FauxClient([["data: [DONE]"]]));
    await expect(F.llamaChatWithToolsStream(Q, [outil("a")])).rejects.toBeInstanceOf(LLMFailure);
    expect(c.nStream).toBe(3);
    expect(etat.pauses).toHaveLength(2);
  });

  it("usage réel, timings demandés, outils triés et schémas assainis", async () => {
    const c = installer(
      new FauxClient([
        [
          data({ choices: [{ delta: { content: "Hi" } }], timings: { prompt_n: 4242 } }),
          fin("stop", { prompt_tokens: 4242, completion_tokens: 2 }),
        ],
      ]),
    );
    const out = await F.llamaChatWithToolsStream(
      [{ role: "user", content: "hi" }],
      [outil("zebra"), outil("alpha", { type: "object", properties: { x: true } }), outil("mike")],
      { toolChoice: "required" },
    );
    expect(out["usage"]).toEqual({ prompt_tokens: 4242, completion_tokens: 2 });
    const p = c.payloads[0] as Dict;
    expect(p["timings_per_token"]).toBe(true);
    expect((p["tools"] as Dict[]).map((t) => (t["function"] as Dict)["name"])).toEqual([
      "alpha",
      "mike",
      "zebra",
    ]);
    expect(((p["tools"] as Dict[])[0]!["function"] as Dict)["parameters"]).toEqual({
      type: "object",
      properties: { x: {} },
    });
    expect(p["tool_choice"]).toBe("auto");
    expect(out["reasoning_channel_native"]).toBe(false);
  });

  it("outils du run normalisés une fois : mêmes octets d'une requête à l'autre, liste allongée recalculée", async () => {
    const reponse = (): string[] => [data({ choices: [{ delta: { content: "ok" } }] }), fin("stop")];
    const c = installer(new FauxClient([reponse(), reponse(), reponse()]));
    const outils = [outil("zebra"), outil("alpha", { type: "object", properties: { x: true } })];
    await F.llamaChatWithToolsStream([{ role: "user", content: "a" }], outils);
    await F.llamaChatWithToolsStream([{ role: "user", content: "b" }], outils);
    const [p1, p2] = c.payloads as Dict[];
    expect(JSON.stringify(p2!["tools"])).toBe(JSON.stringify(p1!["tools"]));
    expect(p2!["tools"]).not.toBe(p1!["tools"]);
    outils.push(outil("beta"));
    await F.llamaChatWithToolsStream([{ role: "user", content: "c" }], outils);
    const noms = ((c.payloads[2] as Dict)["tools"] as Dict[]).map((t) => (t["function"] as Dict)["name"]);
    expect(noms).toEqual(["alpha", "beta", "zebra"]);
  });

  it("system fusionnés et clés internes retirées au point d'envoi", async () => {
    const c = installer(new FauxClient([[data({ choices: [{ delta: { content: "ok" } }] }), fin("stop")]]));
    await F.llamaChatWithToolsStream(
      [
        { role: "system", content: "socle" },
        { role: "user", content: "q", _ephemeral: true },
        { role: "system", content: "résumé" },
      ],
      [outil("a")],
      { toolChoice: "none" },
    );
    const p = c.payloads[0] as Dict;
    expect((p["messages"] as Dict[]).slice(0, 2)).toEqual([
      { role: "system", content: "socle\n\nrésumé" },
      { role: "user", content: "q" },
    ]);
    expect(p["tool_choice"]).toBe("none");
  });
});

describe("appel unique sans outils (E23) : comme le chemin classique, aucun appel d'outil", () => {
  it("raisonnement balisé en appel : rien n'est récupéré", async () => {
    const ferme = APPEL_PENSEE + "x): pass\n</parameter>\n</function>\n</tool_call>";
    installer(new FauxClient([[data({ choices: [{ delta: { reasoning_content: ferme } }] }), fin("stop")]]));
    const out = await F.llamaChatWithToolsStream(Q, []);
    const ch = (out["choices"] as Dict[])[0]!;
    expect(ch["finish_reason"]).toBe("stop");
    expect((ch["message"] as Dict)["tool_calls"]).toBeNull();
  });

  it("repli d'un 500 : le texte reste le contenu, balisage compris", async () => {
    const texte = "<tool_call>\n<function=f>\n</function>\n</tool_call> Titre";
    installer(
      new FauxClient(
        [new FauxFlux([], { statut: 500 })],
        [reponse(500), reponse(200, { choices: [{ finish_reason: "stop", message: { content: texte } }] })],
      ),
    );
    const out = await F.llamaChatWithToolsStream(Q, []);
    expect((out["choices"] as Dict[])[0]).toEqual({
      finish_reason: "stop",
      message: { role: "assistant", content: texte },
    });
  });
});

describe("replis d'un 500", () => {
  const texte =
    "<tool_call>\n<function=write_file>\n<parameter=path>\na.py\n</parameter>\n<parameter=content>\ndef f(";

  it("sans outils : le vrai motif de fin (length) est gardé", async () => {
    installer(
      new FauxClient(
        [new FauxFlux([], { statut: 500 })],
        [reponse(500), reponse(200, { choices: [{ finish_reason: "length", message: { content: texte } }] })],
      ),
    );
    const out = await F.llamaChatWithToolsStream(Q, [outil("write_file")]);
    const ch = (out["choices"] as Dict[])[0]!;
    expect(ch["finish_reason"]).toBe("length");
    expect(((ch["message"] as Dict)["tool_calls"] as Dict[])[0]).toEqual({
      id: "call_0",
      type: "function",
      function: { name: "write_file", arguments: '{"path": "a.py", "content": "def f("}' },
    });
  });

  it("sans outils : une prose tronquée reste length", async () => {
    installer(
      new FauxClient(
        [new FauxFlux([], { statut: 500 })],
        [
          reponse(500),
          reponse(200, { choices: [{ finish_reason: "length", message: { content: "coup" } }] }),
        ],
      ),
    );
    const out = await F.llamaChatWithToolsStream(Q, [outil("read_file")]);
    expect((out["choices"] as Dict[])[0]).toEqual({
      finish_reason: "length",
      message: { role: "assistant", content: "coup" },
    });
  });

  it("sans flux avec outils : le raisonnement en balises quitte le contenu et part en jetons de 40", async () => {
    const pensee = "r".repeat(85);
    installer(
      new FauxClient(
        [new FauxFlux([], { statut: 500 })],
        [reponse(200, { choices: [{ message: { content: `<think>${pensee}</think>réponse` } }] })],
      ),
    );
    const jetons: string[] = [];
    const out = await F.llamaChatWithToolsStream(Q, [outil("a")], {
      onThinkingToken: (t) => {
        jetons.push(t);
      },
    });
    expect(jetons.map((j) => j.length)).toEqual([40, 40, 5]);
    expect(((out["choices"] as Dict[])[0]!["message"] as Dict)["content"]).toBe("réponse");
  });
});

describe("partiels et reprise d'un flux coupé", () => {
  it("coupure pendant les arguments : pas de retry, deltas non rejoués", async () => {
    const deltas: unknown[] = [];
    const c = installer(
      new FauxClient([
        new FauxFlux(
          [
            data({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "c0",
                        function: { name: "write_file", arguments: '{"path": "a.py", "content": "de' },
                      },
                    ],
                  },
                },
              ],
            }),
          ],
          { coupure: new ReadError("coupure") },
        ),
      ]),
    );
    const out = await F.llamaChatWithToolsStream(Q, [outil("write_file")], {
      onToolCallDelta: (...a) => {
        deltas.push(a);
      },
    });
    expect(c.nStream).toBe(1);
    expect(deltas).toHaveLength(1);
    expect(out["partial"]).toBe(true);
    expect((out["choices"] as Dict[])[0]).toEqual({
      finish_reason: "length",
      message: { role: "assistant", content: null, tool_calls: null },
    });
  });

  it("partiel de transport : la session nommée est arrêtée ; erreur du fournisseur : rien à arrêter", async () => {
    etat.caps = { resumableStream: true };
    installer(
      new FauxClient([
        new FauxFlux([data({ choices: [{ delta: { content: "Bonjour" } }] })], {
          coupure: new ReadError("x"),
        }),
      ]),
    );
    let out = await F.llamaChatWithToolsStream(Q, [outil("a")], { chatId: "c1", userId: "alice" });
    expect(out["partial"]).toBe(true);
    await vi.waitFor(() => expect(etat.arrets).toHaveLength(1));
    etat.arrets = [];
    installer(
      new FauxClient([
        [
          data({ choices: [{ delta: { content: "Bonjour" } }] }),
          data({ error: { code: 500, message: "boom" } }),
        ],
      ]),
    );
    out = await F.llamaChatWithToolsStream(Q, [outil("a")], { chatId: "c1", userId: "alice" });
    expect(out["partial"]).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(etat.arrets).toEqual([]);
  });

  it("reprise réussie depuis le tampon du moteur : rien d'affiché en double, résultat complet", async () => {
    etat.caps = { resumableStream: true };
    const c = installer(
      new FauxClient([
        new FauxFlux([data({ choices: [{ delta: { content: "Bonjour" } }] })], {
          coupure: new ReadError("x"),
        }),
      ]),
    );
    const montre: string[] = [];
    const conv = (await import("../../src/llm/fournisseurs/llama-flux")).conversationId("alice", "c1");
    etat.lookup.set(conv, { total_bytes: 7, is_done: true });
    etat.reprise = new FauxFlux([
      data({ choices: [{ delta: { content: "Bonjour" } }] }),
      data({ choices: [{ delta: { content: " le monde" } }] }),
      fin("stop"),
    ]);
    const out = await F.llamaChatWithToolsStream(Q, [outil("a")], {
      chatId: "c1",
      userId: "alice",
      onContentToken: (t) => {
        montre.push(t);
      },
    });
    expect(c.nStream).toBe(1);
    expect(montre.join("")).toBe("Bonjour le monde");
    expect(((out["choices"] as Dict[])[0]!["message"] as Dict)["content"]).toBe("Bonjour le monde");
    expect(out["partial"]).toBeUndefined();
  });

  it("reprise coupée à son tour : le partiel couvre ce que l'écran a reçu", async () => {
    etat.caps = { resumableStream: true };
    const conv = (await import("../../src/llm/fournisseurs/llama-flux")).conversationId("alice", "c1");
    etat.lookup = new Map([[conv, { total_bytes: 7, is_done: false }]]);
    etat.reprise = new FauxFlux(
      [
        data({ choices: [{ delta: { content: "Bonjour" } }] }),
        data({ choices: [{ delta: { content: " le monde" } }] }),
      ],
      { coupure: new ReadError("seconde coupure") },
    );
    installer(
      new FauxClient([
        new FauxFlux([data({ choices: [{ delta: { content: "Bonjour" } }] })], {
          coupure: new ReadError("x"),
        }),
      ]),
    );
    const montre: string[] = [];
    const out = await F.llamaChatWithToolsStream(Q, [outil("a")], {
      chatId: "c1",
      userId: "alice",
      onContentToken: (t) => {
        montre.push(t);
      },
    });
    expect(montre.join("")).toBe("Bonjour le monde");
    expect(out["partial"]).toBe(true);
    expect(((out["choices"] as Dict[])[0]!["message"] as Dict)["content"]).toBe("Bonjour le monde");
  });

  it("le texte gardé ne raccourcit jamais ; le saut tombe au milieu d'un segment", async () => {
    const prev = new SseStreamResult();
    const neuf = new SseStreamResult();
    prev.contentParts.push("abcdef");
    neuf.contentParts.push("abc");
    F.keepResumedText(prev, neuf);
    expect(prev.content()).toBe("abcdef");
    const vus: string[] = [];
    const cb = F.skipping((s) => {
      vus.push(s);
    }, 3);
    for (const s of ["😀b", "cde", "f"]) await cb!(s);
    expect(vus).toEqual(["de", "f"]);
  });
});

describe("erreurs, tentatives et disjoncteur", () => {
  it("dépassement de contexte en cours de flux : une seule tentative, famille remontée", async () => {
    const c = installer(
      new FauxClient([
        [
          data({
            error: {
              code: 400,
              type: "exceed_context_size_error",
              message: "the request exceeds the available context size",
            },
          }),
        ],
      ]),
    );
    const e = await F.llamaChatWithToolsStream(Q, [outil("a")]).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(LLMFailure);
    expect((e as LLMFailure).kind).toBe(KIND_CONTEXT_OVERFLOW);
    expect(c.nStream).toBe(1);
  });

  it("panne de connexion : tentatives, puis disjoncteur nourri et échec actionnable", async () => {
    const pannes: unknown[] = [];
    installerDisjoncteur({ signalerPanneTransport: (_m, model) => void pannes.push(model) });
    const client = new FauxClient([[]]);
    client.stream = () => Promise.reject(new ConnectError("All connection attempts failed"));
    installer(client);
    const e = await F.llamaChatWithToolsStream(Q, [outil("a")], { modelOverride: "m1" }).catch(
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(LLMFailure);
    expect(etat.pauses).toHaveLength(2);
    expect(pannes).toEqual(["m1"]);
  });
});

describe("reprises du raisonnement", () => {
  const STOP = [data({ choices: [{ delta: { content: "ok" } }] }), fin("stop")];

  it("reprise native : continue_final_message, outils gardés", async () => {
    const c = installer(new FauxClient([STOP]));
    const out = await F.llamaChatWithToolsStream([{ role: "user", content: "continue" }], [outil("mytool")], {
      thinkingMode: true,
      resumeThink: "raisonnement acquis",
    });
    const p = c.payloads[0] as Dict;
    expect((p["messages"] as Dict[]).at(-1)).toEqual({
      role: "assistant",
      content: "",
      reasoning_content: "raisonnement acquis",
    });
    expect([p["continue_final_message"], p["add_generation_prompt"]]).toEqual([true, false]);
    expect(p["tools"]).toHaveLength(1);
    expect(out["reasoning_channel_native"]).toBe(false);
  });

  it("repli prefill : bloc de réflexion fermé, consigne de conclusion, réflexion coupée au gabarit", async () => {
    const c = installer(new FauxClient([STOP]));
    await F.llamaChatWithToolsStream([{ role: "user", content: "continue" }], [outil("mytool")], {
      thinkingMode: true,
      resumeThink: "raisonnement acquis",
      resumeNativeOk: false,
    });
    const p = c.payloads[0] as Dict;
    const [a, u] = (p["messages"] as Dict[]).slice(-2);
    expect(String(a!["content"]).startsWith("<think>\n") && String(a!["content"]).endsWith("</think>")).toBe(
      true,
    );
    expect(u).toEqual({ role: "user", content: RESUME_AFTER_THINK_INSTRUCTION });
    expect(p["continue_final_message"]).toBeUndefined();
    expect((p["chat_template_kwargs"] as Dict)["enable_thinking"]).toBe(false);
  });

  it("reprise native refusée (4xx) : non-support mémorisé, même appel rejoué en prefill", async () => {
    const c = installer(new FauxClient([new FauxFlux([], { statut: 400 }), STOP]));
    await F.llamaChatWithToolsStream([{ role: "user", content: "continue" }], [outil("mytool")], {
      thinkingMode: true,
      resumeThink: "raisonnement acquis",
      modelOverride: "m-ancien",
    });
    expect(c.nStream).toBe(2);
    expect((c.payloads[1] as Dict)["continue_final_message"]).toBeUndefined();
    expect([...continueFinalCache.values()]).toContain(false);
  });

  it("reprise de prose refusée : abandon sans repli", async () => {
    const c = installer(new FauxClient([new FauxFlux([], { statut: 400 }), STOP]));
    await expect(
      F.llamaChatWithToolsStream([{ role: "user", content: "q" }], [outil("a")], { resumeContent: "début" }),
    ).rejects.toBeInstanceOf(LLMFailure);
    expect(c.nStream).toBe(1);
  });
});

describe("borne du raisonnement et racine du serveur", () => {
  it("seuil : jamais sans plafond ni budget ; 80 % du plafond ; le budget souple gagne s'il est plus bas", () => {
    expect(F.reasoningCapChars({})).toBe(0);
    expect(F.reasoningCapChars({ max_tokens: 1000 })).toBe(Math.trunc(800 * 3.3));
    const r = surchargerConfig({ LLAMA_REASONING_SOFT_BUDGET_TOKENS: 100 });
    try {
      expect(F.reasoningCapChars({ max_tokens: 1000 })).toBe(Math.trunc(100 * 3.3));
      expect(F.reasoningCapChars({})).toBe(Math.trunc(100 * 3.3));
    } finally {
      r();
    }
  });

  it("E24 : budget de réflexion de l'interface reporté en seuil de fermeture (réflexion seulement), borné", () => {
    const ui = (b: unknown, mt?: number): number | null =>
      F.budgetReflexionInterface(mt === undefined ? {} : { max_tokens: mt }, { thinking_budget_tokens: b });
    expect([
      ui(100),
      ui(2000),
      ui(10 ** 9),
      ui(2000, 1000),
      ui(0),
      ui(-5),
      ui("4096"),
      ui(true),
      ui(1.9e3),
    ]).toEqual([512, 2000, 131072, 1000, null, null, null, 512, 1900]);
    expect(
      F.reasoningCapChars(
        { max_tokens: 100000 },
        { thinkingMode: true, samplingOverride: { thinking_budget_tokens: 2000 } },
      ),
    ).toBe(Math.trunc(2000 * 3.3));
    expect(
      F.reasoningCapChars(
        { max_tokens: 100000 },
        { thinkingMode: false, samplingOverride: { thinking_budget_tokens: 2000 } },
      ),
    ).toBe(Math.trunc(80000 * 3.3));
    expect(F.reasoningCapChars({}, { thinkingMode: true, samplingOverride: {} })).toBe(0);
  });

  it("E24 : jamais de thinking_budget_tokens dans un payload avec outils ; la fermeture part au seuil de l'interface", async () => {
    const c = installer(
      new FauxClient([
        [
          data({ id: "cmpl-2", choices: [{ delta: { reasoning_content: "r".repeat(1700) } }] }),
          data({ id: "cmpl-2", choices: [{ delta: { content: "ok" } }] }),
          fin("stop"),
        ],
      ]),
    );
    await F.llamaChatWithToolsStream(Q, [outil("a")], {
      thinkingMode: true,
      samplingOverride: { thinking_budget_tokens: 512 },
    });
    expect((c.payloads[0] as Dict)["thinking_budget_tokens"]).toBeUndefined();
    await vi.waitFor(() => expect(etat.finsRaisonnement).toHaveLength(1));
  });

  it("fermeture demandée une fois au moteur quand le raisonnement dépasse le seuil", async () => {
    const notes: unknown[] = [];
    installerControleRaisonnement({
      noteCompletion: (...a) => void notes.push(a),
      clearCompletion: () => undefined,
    });
    installer(
      new FauxClient([
        [
          data({ id: "cmpl-1", choices: [{ delta: { reasoning_content: "x".repeat(40) } }] }),
          data({ id: "cmpl-1", choices: [{ delta: { reasoning_content: "y".repeat(40) } }] }),
          data({ id: "cmpl-1", choices: [{ delta: { content: "ok" } }] }),
          fin("stop"),
        ],
      ]),
    );
    const r = surchargerConfig({ LLAMA_REASONING_SOFT_BUDGET_TOKENS: 10 });
    try {
      await F.llamaChatWithToolsStream(Q, [outil("a")], { thinkingMode: true, chatId: "c1" });
    } finally {
      r();
    }
    await vi.waitFor(() => expect(etat.finsRaisonnement).toHaveLength(1));
    expect(etat.finsRaisonnement[0]![1]).toBe("cmpl-1");
  });

  it("racine du serveur depuis l'URL de complétion", () => {
    expect(F.endpointBase("http://h:8080/v1/chat/completions")).toBe("http://h:8080");
    expect(F.endpointBase("http://h/api/v1/")).toBe("http://h/api");
    expect(F.endpointBase("http://h/chat/completions")).toBe("http://h");
    expect(F.endpointBase("http://h/v1/completions")).toBe("http://h");
    expect(F.endpointBase("")).toBe("");
    expect(F.endpointBase("///")).toBe("");
    expect(F.endpointBase(null)).toBe("");
  });

  it("racine du serveur : longue suite de barres au milieu d'une URL en temps linéaire", () => {
    const debut = performance.now();
    const r = F.endpointBase("/".repeat(60_000) + "x");
    expect(performance.now() - debut).toBeLessThan(1000);
    expect(r.length).toBe(60_001);
    expect(F.endpointBase("http://h/v1" + "/".repeat(60_000))).toBe("http://h");
  });
});

describe("annulation", () => {
  it("signal coupé en plein flux : levée, session arrêtée", async () => {
    etat.caps = { resumableStream: true };
    const ctrl = new AbortController();
    installer(
      new FauxClient([
        [
          data({ choices: [{ delta: { content: "a" } }] }),
          data({ choices: [{ delta: { content: "b" } }] }),
          fin("stop"),
        ],
      ]),
    );
    await expect(
      F.llamaChatWithToolsStream(Q, [outil("a")], {
        chatId: "c1",
        signal: ctrl.signal,
        onContentToken: () => ctrl.abort(new DOMException("stop", "AbortError")),
      }),
    ).rejects.toThrow();
    await vi.waitFor(() => expect(etat.arrets).toHaveLength(1));
  });
});
