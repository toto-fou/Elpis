// SPDX-License-Identifier: MIT
/** apps/core/test/boucle/requetes-cache.test.ts — boucle réelle : le tour enregistre ses requêtes dont le moteur rapporte le cache (cached_tokens, timings.cache_n) et celles servies en partie par lui. */
import "../moteur-environnement";

import { pyJsonDumps } from "@elpis/commun";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runChatMultiMcp } from "../../src/boucle/orchestrateur";
import { installerDormir, installerRegistreUsage, installerTokenHex } from "../../src/boucle/ports";
import type { UsageTour } from "../../src/boucle/ports";
import {
  installerPortCompresseur,
  installerProfilReseau,
  installerPromptsCapacites,
} from "../../src/contexte/ports";
import { EngineRef, useEngine } from "../../src/llm/moteurs";
import { oublierSondes } from "../../src/llm/sonde-moteur";
import type { OutilIntegre } from "../../src/outils/catalogue";
import type { Dict } from "../../src/python";
import { data, FauxClient } from "./faux-moteur";
import type * as Config from "@elpis/config";
import type * as Constantes from "../../src/llm/constantes";
import type * as Capacites from "../../src/llm/fournisseurs/llama-capacites";
import type * as OpenaiCompat from "../../src/llm/fournisseurs/openai-compat";
import type * as LlamaHttp from "../../src/llm/llama-http";
import type * as Modeles from "../../src/llm/modeles";
import type * as Parametres from "../../src/llm/parametres";
import type * as Sante from "../../src/llm/sante";

const etat = vi.hoisted(() => ({ client: null as unknown }));

vi.mock("../../src/llm/sante", async (orig) => ({
  ...(await orig<typeof Sante>()),
  verifyLlmAvailability: async () => undefined,
}));
vi.mock("../../src/llm/modeles", async (orig) => ({
  ...(await orig<typeof Modeles>()),
  getModelContextSize: async () => 0,
}));
vi.mock("../../src/llm/parametres", async (orig) => ({
  ...(await orig<typeof Parametres>()),
  resolveSampling: async () => ({}),
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
vi.mock("@elpis/config", async (orig) => ({
  ...(await orig<typeof Config>()),
  reloadCompressionConfigFromDisk: () => false,
}));

const APPEL = '{"name": "zeta_shell", "arguments": {"command": "ls"}}';

/** Une réponse du moteur : texte puis usage ; le cache dans `prompt_tokens_details`, dans les `timings` de llama.cpp, ou absent (`null`). */
const repond = (
  texte: string,
  entree: number,
  cache: number | null,
  ou: "details" | "timings" = "details",
): string[] => [
  data({ choices: [{ delta: { content: texte } }] }),
  data({
    choices: [{ delta: {}, finish_reason: "stop" }],
    usage: {
      prompt_tokens: entree,
      completion_tokens: 10,
      ...(cache !== null && ou === "details" ? { prompt_tokens_details: { cached_tokens: cache } } : {}),
    },
    ...(cache !== null && ou === "timings" ? { timings: { cache_n: cache, prompt_n: entree - cache } } : {}),
  }),
  "data: [DONE]",
];

const zetaShell: OutilIntegre = {
  definition: {
    type: "function",
    function: {
      name: "zeta_shell",
      description: "Outil de test.",
      parameters: { type: "object", properties: { command: { type: "string" } } },
    },
  },
  handler: async () => pyJsonDumps({ ok: true }),
};

let recus: UsageTour[] = [];

beforeEach(() => {
  recus = [];
  oublierSondes();
  let i = 0;
  installerTokenHex((n) =>
    (++i)
      .toString(16)
      .padStart(2 * n, "0")
      .slice(-2 * n),
  );
  installerDormir(async () => undefined);
  installerRegistreUsage((u) => void recus.push(u));
  installerProfilReseau({ profilReseau: () => ({ id: "isolated", mode: "none" }) });
  installerPromptsCapacites({ capabilityWantsRuntimeContext: () => false, buildCapabilityBlock: () => null });
  installerPortCompresseur({
    userIdParNom: async () => null,
    sessionIndexMessages: async (rows) => rows.length,
    recordTurnUsage: () => undefined,
  });
});

afterEach(() => {
  installerTokenHex(null);
  installerDormir(null);
  installerRegistreUsage(null);
  installerProfilReseau(null);
  installerPromptsCapacites(null);
  installerPortCompresseur(null);
  etat.client = null;
  oublierSondes();
});

async function tour(scripts: readonly (readonly string[])[]): Promise<string> {
  etat.client = new FauxClient(scripts);
  const moteur = new EngineRef({ key: "conn:8", baseRoot: "http://127.0.0.1:1", providerType: "llamacpp" });
  const [final] = await useEngine(moteur, () =>
    runChatMultiMcp({
      messages: [
        { role: "system", content: "Tête de test." },
        { role: "user", content: "Liste le dossier." },
      ],
      mcpConfigs: [],
      builtinTools: { zeta_shell: zetaShell },
      username: "alice",
      chatId: "c1",
      model: "m",
      memoryEnabled: false,
      compressionEnabled: false,
      onEvent: () => undefined,
      deps: { recordMetric: () => undefined },
    }),
  );
  return final;
}

describe("requêtes du tour", () => {
  it("trois requêtes mesurées, deux servies en partie par le cache : une seule ligne qui les compte", async () => {
    const final = await tour([
      repond(APPEL, 1000, 0),
      repond(APPEL, 1100, 1000),
      repond("Fait.", 1200, 1100),
    ]);
    expect(final).toBe("Fait.");
    expect(recus).toHaveLength(1);
    const u = recus[0] as UsageTour & { usage: Dict };
    expect([u.inputTokens, u.usage["cache_read_input_tokens"]]).toEqual([3300, 2100]);
    expect([u.cacheReportedCalls, u.cacheHitCalls]).toEqual([3, 2]);
  });

  it("llama.cpp : cache lu dans les timings (cache_n), même nul", async () => {
    await tour([repond(APPEL, 1000, 0, "timings"), repond("Fait.", 1100, 1000, "timings")]);
    const u = recus[0] as UsageTour & { usage: Dict };
    expect([u.usage["cache_read_input_tokens"], u.cacheReportedCalls, u.cacheHitCalls]).toEqual([1000, 2, 1]);
  });

  it("moteur qui ne rapporte pas le cache (vLLM sans l'option) : aucune requête mesurée, pas de faux 0 %", async () => {
    await tour([repond(APPEL, 1000, null), repond("Fait.", 1100, null)]);
    expect([recus[0]?.cacheReportedCalls, recus[0]?.cacheHitCalls]).toEqual([0, 0]);
  });
});
