// SPDX-License-Identifier: MIT
/** apps/core/test/contexte/compresseur.test.ts — compresseur rejoué sur les scénarios Python (LLM scripté, comptage, endpoint dédié, ports). */
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { surchargerConfig } from "@elpis/config";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import * as C from "../../src/contexte/compresseur";
import type { LlamaChatFn } from "../../src/contexte/compresseur";
import { applyPersistedState, isSummaryCarrier } from "../../src/contexte/etat-compression";
import { installerPortCompresseur } from "../../src/contexte/ports";
import type { Dict } from "../../src/python";
import { lireVecteurs } from "../vecteurs-moteur";

interface Scenario {
  nom: string;
  appel: "compress" | "maybe";
  conversation: number;
  options?: Dict;
  llm?: (string | { erreur: string })[];
  endpoint?: [number, unknown];
  config?: Dict;
  comptage?: "exact" | "estime" | "panne";
  cible_llamacpp?: boolean;
  ctx_resumeur: number | null;
  recents?: number;
  transition?: number;
  sortie: { messages: Dict[]; stats: Dict; journal: Record<string, unknown[]>; recus: unknown[] };
}

// Copie de COMPRESSOR_SYSTEM.md dans les vecteurs mise à jour (note sur le marqueur condensé, H-03) : pas un écart au Python.
const V = lireVecteurs<{ resume: string; config: Dict; conversations: Dict[][]; scenarios: Scenario[] }>(
  "contexte-compresseur",
);
/** Écart voulu au Python (cache de prompt) : après une compaction, le porteur a les octets du rechargement (META, tours couverts). */
for (const sc of V.scenarios) {
  const ns = sc.sortie.stats["new_state"] as Dict | undefined;
  if (sc.appel !== "maybe" || !ns?.["summary_xml"]) continue;
  const i = sc.sortie.messages.findIndex((m) => String(m["content"]).includes("[COMPRESSED_SUMMARY_V1]"));
  const meta = `[COMPRESSION_META v=1 round=${String(ns["round"])} covered_turns=${String(ns["covered_turns"])}]`;
  const note = String(sc.sortie.messages[i]!["content"]).replace(
    `memory of ${String(ns["turns_compressed"])} earlier turns`,
    `memory of ${String(ns["covered_turns"])} earlier turns`,
  );
  sc.sortie.messages[i] = { ...sc.sortie.messages[i], content: `${meta}\n${note}` };
}
const etat: { sc: Scenario | null; comptages: unknown[] } = { sc: null, comptages: [] };

function conversation(sc: Scenario): Dict[] {
  return structuredClone(V.conversations[sc.conversation]!);
}

function compter(messages: readonly unknown[]): number[] {
  return messages.map((m) => {
    const c = typeof m === "object" && m !== null ? (m as Dict)["content"] : undefined;
    return 4 + (typeof c === "string" ? Array.from(c).length : 50);
  });
}

vi.mock("../../src/contexte/tokens", async (importOriginal) => {
  const reel = await importOriginal<typeof Jetons>();
  return {
    ...reel,
    countTokensForMessages: async (
      messages: readonly unknown[],
      modelId: string | null = null,
      o: { timeout?: number } = {},
    ) => {
      etat.comptages.push(["total", modelId, o.timeout ?? null]);
      const mode = etat.sc?.comptage ?? "exact";
      if (mode === "panne") throw new Error("tokenize en panne");
      return mode === "exact" ? compter(messages).reduce((a, b) => a + b, 0) : null;
    },
    countMessagesTokensPerMsg: async (messages: readonly unknown[], modelId: string | null = null) => {
      etat.comptages.push(["par_message", modelId, null]);
      return compter(messages);
    },
  };
});
vi.mock("../../src/llm/modeles", async (importOriginal) => {
  const reel = await importOriginal<typeof Modeles>();
  return {
    ...reel,
    getModelContextSize: async () => {
      if (etat.sc?.ctx_resumeur === null || etat.sc?.ctx_resumeur === undefined)
        throw new Error("ctx inconnu");
      return etat.sc.ctx_resumeur;
    },
  };
});
vi.mock("../../src/llm/cible", async (importOriginal) => {
  const reel = await importOriginal<typeof Cible>();
  const { PROFILS } = await import("../../src/llm/profils");
  // Cible des vecteurs : llama.cpp local, ou distante sans tokenisation exacte (profil générique).
  const cible = (): { isLlamacpp: boolean; profil: unknown } => {
    const llama = etat.sc?.cible_llamacpp ?? true;
    return { isLlamacpp: llama, profil: llama ? PROFILS.llamacpp : PROFILS.generic };
  };
  return { ...reel, currentTarget: cible };
});
vi.mock("@elpis/config", async (importOriginal) => {
  const reel = await importOriginal<typeof Config>();
  return { ...reel, reloadCompressionConfigFromDisk: () => false };
});

import type * as Cible from "../../src/llm/cible";
import type * as Jetons from "../../src/contexte/tokens";
import type * as Modeles from "../../src/llm/modeles";
import type * as Config from "@elpis/config";

let serveur: Server;
let url = "";
let recus: unknown[] = [];

beforeAll(async () => {
  serveur = createServer((req, rep) => {
    const morceaux: Buffer[] = [];
    req.on("data", (m: Buffer) => morceaux.push(m));
    req.on("end", () => {
      recus.push(JSON.parse(Buffer.concat(morceaux).toString("utf8")));
      const [statut, corps] = etat.sc?.endpoint ?? [200, {}];
      const donnees = JSON.stringify(corps);
      rep.writeHead(statut, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(donnees),
      });
      rep.end(donnees);
    });
  });
  await new Promise<void>((ok) => serveur.listen(0, "127.0.0.1", ok));
  url = `http://127.0.0.1:${(serveur.address() as AddressInfo).port}/v1/chat/completions`;
});

afterAll(async () => {
  await C.closeEndpointClient();
  await new Promise<void>((ok) => serveur.close(() => ok()));
});

afterEach(() => {
  vi.restoreAllMocks();
  installerPortCompresseur(null);
  etat.sc = null;
});

function camel(cle: string): string {
  return cle.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
}

function avecUrl(v: unknown): unknown {
  return v === "{URL}" ? url : v;
}

async function jouer(
  sc: Scenario,
): Promise<{ messages: unknown; stats: Dict; journal: Record<string, unknown[]>; recus: unknown[] }> {
  etat.sc = sc;
  recus = [];
  vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
  etat.comptages = [];
  const journal: Record<string, unknown[]> = {
    llm: [],
    usage: [],
    fts: [],
    evenements: [],
    comptages: etat.comptages,
  };
  installerPortCompresseur({
    userIdParNom: async (nom) => (nom === "alice" ? 7 : null),
    sessionIndexMessages: async (rows) => {
      for (const { ts: _ts, ...reste } of rows) journal["fts"]!.push(reste);
      return rows.length;
    },
    recordTurnUsage: (usage, o) => {
      journal["usage"]!.push({ usage, model: o.model, path: o.path, iterations: o.iterations });
    },
  });
  const reponses = [...(sc.llm ?? [V.resume])];
  const llamaChat: LlamaChatFn = async (messages, o) => {
    journal["llm"]!.push({
      messages: structuredClone(messages),
      user_id: o.userId,
      model_override: o.modelOverride,
      sampling_override: o.samplingOverride,
    });
    const r = reponses.length > 1 ? reponses.shift()! : reponses[0]!;
    if (typeof r === "object") throw new Error(r.erreur);
    return [r, { model: "modele-resume" }];
  };
  const reglages = Object.fromEntries(
    Object.entries({ ...V.config, ...(sc.config ?? {}) }).map(([k, v]) => [k, avecUrl(v)]),
  );
  const restaurer = surchargerConfig(reglages as Parameters<typeof surchargerConfig>[0]);
  try {
    const options = Object.fromEntries(
      Object.entries(sc.options ?? {}).map(([k, v]) => [camel(k), avecUrl(v)]),
    );
    let messages: unknown;
    let stats: Dict;
    if (sc.appel === "compress") {
      const comp = new C.ConversationCompressor(llamaChat, {
        keepRecentTurns: sc.recents ?? 2,
        keepBridgeTurns: sc.transition ?? 1,
      });
      [messages, stats] = await comp.compress(conversation(sc), options);
    } else {
      [messages, stats] = await C.maybeCompressConversation(conversation(sc), {
        ...(options as Partial<C.OptionsMaybeCompress>),
        llamaChatFn: llamaChat,
        onEvent: (ev) => {
          journal["evenements"]!.push(structuredClone(ev));
        },
      });
    }
    const statsTexte = JSON.stringify(stats).replaceAll(url, "{URL}");
    return { messages, stats: JSON.parse(statsTexte) as Dict, journal, recus };
  } finally {
    restaurer();
  }
}

describe("compresseur de conversation", () => {
  it.each(V.scenarios.map((s) => [s.nom, s] as const))("%s", async (_nom, sc) => {
    const vu = await jouer(sc);
    expect(vu.stats).toStrictEqual(sc.sortie.stats);
    expect(vu.messages).toStrictEqual(sc.sortie.messages);
    expect(vu.journal["llm"]).toStrictEqual(sc.sortie.journal["llm"]);
    expect(vu.journal["evenements"]).toStrictEqual(
      JSON.parse(JSON.stringify(sc.sortie.journal["evenements"]).replaceAll("{URL}", url)),
    );
    expect(vu.journal["fts"]).toStrictEqual(sc.sortie.journal["fts"]);
    expect(vu.journal["usage"]).toStrictEqual(sc.sortie.journal["usage"]);
    expect(vu.recus).toStrictEqual(sc.sortie.recus);
    expect(vu.journal["comptages"]).toStrictEqual(sc.sortie.journal["comptages"]);
  });

  it("tentative réelle ou simple pré-contrôle", () => {
    expect(C.compressionWasAttempted({ compressed: true })).toBe(true);
    for (const r of [
      "llm_error: x",
      "summary_too_short",
      "no_token_gain",
      "exception: y",
      "summary_invalid_format",
    ]) {
      expect(C.compressionWasAttempted({ compressed: false, reason: r })).toBe(true);
    }
    for (const r of [
      "threshold_not_reached",
      "nothing_to_compress",
      "disabled",
      "gain_too_small",
      undefined,
    ]) {
      expect(C.compressionWasAttempted({ compressed: false, reason: r })).toBe(false);
    }
  });

  it("annulation : propagée, jamais transformée en échec de compression", async () => {
    const sc = V.scenarios.find((s) => s.nom === "complet_force")!;
    etat.sc = sc;
    const ctrl = new AbortController();
    const llama: LlamaChatFn = async () => {
      ctrl.abort();
      throw new DOMException("arrêt", "AbortError");
    };
    const comp = new C.ConversationCompressor(llama, { keepRecentTurns: 2, keepBridgeTurns: 1 });
    await expect(comp.compress(conversation(sc), { force: true, signal: ctrl.signal })).rejects.toThrow(
      "arrêt",
    );
    await expect(
      C.maybeCompressConversation(conversation(sc), {
        llamaChatFn: llama,
        manual: true,
        signal: ctrl.signal,
      }),
    ).rejects.toThrow("aborted");
  });

  it("porteur posé par la compaction (round 2) = porteur rebâti au tour suivant, octet pour octet", async () => {
    const sc = V.scenarios.find((s) => s.nom === "debordement")!;
    const vu = await jouer(sc);
    const ns = vu.stats["new_state"] as Dict;
    expect([ns["round"], ns["covered_turns"], ns["turns_compressed"]]).toEqual([2, 20, 16]);
    const [recharge] = applyPersistedState(conversation(sc), ns);
    const porteur = (ms: unknown): unknown => (ms as unknown[]).find(isSummaryCarrier);
    expect(porteur(recharge)).toBeDefined();
    expect(porteur(vu.messages)).toStrictEqual(porteur(recharge));
  });

  it("panne LLM rendue sans lever : rien n'est résumé", async () => {
    const sc = V.scenarios.find((s) => s.nom === "complet_force")!;
    etat.sc = sc;
    const panne: LlamaChatFn = async () => [
      "⚠ Erreur LLM: Le serveur du modèle est injoignable. Vérifiez qu'il est démarré.",
      { usage: {}, timings: {}, error: true },
    ];
    const avant = conversation(sc);
    const [messages, stats] = await C.maybeCompressConversation(conversation(sc), {
      llamaChatFn: panne,
      manual: true,
    });
    expect(stats["compressed"]).toBe(false);
    expect(String(stats["reason"])).toMatch(/^llm_error: ⚠ Erreur LLM/);
    expect(messages).toStrictEqual(avant);
  });
});

describe("annulation à chaque attente", () => {
  const sc = (): Scenario => V.scenarios.find((s) => s.nom === "complet_force")!;
  const bon: LlamaChatFn = async () => [V.resume, { model: "m" }];

  it("pendant l'appel LLM qui rend normalement : rien n'est appliqué", async () => {
    etat.sc = sc();
    const ctrl = new AbortController();
    const llama: LlamaChatFn = async () => {
      ctrl.abort(new DOMException("arrêt", "AbortError"));
      return [V.resume, { model: "m" }];
    };
    const evenements: unknown[] = [];
    await expect(
      C.maybeCompressConversation(conversation(sc()), {
        llamaChatFn: llama,
        manual: true,
        signal: ctrl.signal,
        onEvent: (e) => {
          evenements.push(e);
        },
      }),
    ).rejects.toThrow("arrêt");
    expect(evenements.map((e) => (e as Dict)["type"])).toEqual(["compression_start"]);
  });

  it("pendant un événement de la boucle", async () => {
    etat.sc = sc();
    const ctrl = new AbortController();
    await expect(
      C.maybeCompressConversation(conversation(sc()), {
        llamaChatFn: bon,
        manual: true,
        signal: ctrl.signal,
        onEvent: () => {
          ctrl.abort(new DOMException("stop", "AbortError"));
        },
      }),
    ).rejects.toThrow("stop");
  });

  it("déjà annulé avant le comptage", async () => {
    etat.sc = sc();
    const ctrl = new AbortController();
    ctrl.abort(new DOMException("tôt", "AbortError"));
    const comp = new C.ConversationCompressor(bon, { keepRecentTurns: 2, keepBridgeTurns: 1 });
    await expect(comp.compress(conversation(sc()), { force: true, signal: ctrl.signal })).rejects.toThrow(
      "tôt",
    );
  });
});
