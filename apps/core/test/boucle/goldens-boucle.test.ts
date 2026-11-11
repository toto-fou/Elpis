// SPDX-License-Identifier: MIT
/** apps/core/test/boucle/goldens-boucle.test.ts — rejeu des goldens boucle_*, payload_* et events_* (chemin outillé ; payload_classic hors E23) contre le faux moteur. */
import "../moteur-environnement";

import { readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { llamaChatWithToolsStream } from "../../src/boucle/flux-llm";
import type * as Tokens from "../../src/contexte/tokens";
import type * as Categories from "../../src/outils/categories";
import type * as Config from "@elpis/config";
import type * as Constantes from "../../src/llm/constantes";
import type * as Capacites from "../../src/llm/fournisseurs/llama-capacites";
import type * as OpenaiCompat from "../../src/llm/fournisseurs/openai-compat";
import type * as Modeles from "../../src/llm/modeles";
import type * as Parametres from "../../src/llm/parametres";
import type * as Sante from "../../src/llm/sante";
import type * as LlamaHttp from "../../src/llm/llama-http";
import type { Dict } from "../../src/python";
import { lireGolden, normaliser, RACINE_GOLDENS, rejouer } from "./harnais-boucle";
import type { EtatHarnais } from "./harnais-boucle";

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
  llamaPost: async () => ({ _status: 0, error: "indisponible (goldens)", error_type: "ConnectError" }),
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
vi.mock("../../src/contexte/tokens", async (orig) => {
  const reel = await orig<typeof Tokens>();
  return {
    ...reel,
    noteRealUsage: (...a: Parameters<typeof reel.noteRealUsage>) =>
      etat.ratioGele ? undefined : reel.noteRealUsage(...a),
    countTokensForMessages: async (messages: readonly unknown[], ...reste: unknown[]) => {
      if (!etat.comptageFactice) return reel.countTokensForMessages(messages, ...(reste as [null]));
      let total = 0;
      for (const m of messages) {
        const c = (m as Dict)["content"];
        if (typeof c === "string") total += Array.from(c).length;
      }
      return Math.max(1, Math.floor(total / 3));
    },
  };
});
vi.mock("../../src/outils/categories", async (orig) => {
  const reel = await orig<typeof Categories>();
  return {
    ...reel,
    categorize: (n: string | null | undefined) =>
      etat.categories ? (etat.categories[n ?? ""] ?? "other") : reel.categorize(n),
  };
});
vi.mock("@elpis/config", async (orig) => ({
  ...(await orig<typeof Config>()),
  reloadCompressionConfigFromDisk: () => false,
}));

/** Goldens du chemin classique (E23) : non rejoués en TS. */
const NON_REJOUES = new Set(["payload_classic"]);
// Écart voulu au Python (H-03) : boucle_echelle_elagage_en_cours, sorties élaguées en condensé (taille, empreinte, tool_input_tokens).
// boucle_echelle_{depassement,porte}_compaction : copie de COMPRESSOR_SYSTEM.md à jour (note sur le condensé), pas un écart ;
// écart voulu au Python (cache de prompt) : porteur du résumé posé en cours de run aux octets du rechargement (ligne META).

const NOMS = readdirSync(RACINE_GOLDENS)
  .filter((f) => /^(boucle|payload|events)_.*\.json$/u.test(f))
  .map((f) => f.slice(0, -5))
  .filter((n) => !NON_REJOUES.has(n))
  .sort();

describe("goldens du harnais boucle", () => {
  // écart voulu au Python (harnais SH-09) : payload_fold_fs porte le runtime_context corrigé, phrase du rootfs seule modifiée
  it("aucun golden ne dit encore le rootfs du bac en lecture seule", () => {
    for (const nom of NOMS)
      expect([nom, JSON.stringify(lireGolden(nom)).includes("rootfs is READ-ONLY")]).toEqual([nom, false]);
  });

  // écart voulu au Python (harnais B-21) : payload_fold_fs porte le bloc PATHS corrigé (absolu sous /work accepté), seul ce bloc modifié
  it("aucun golden ne dit encore que tout chemin est relatif ni ne refuse ~/file", () => {
    for (const nom of NOMS) {
      const texte = JSON.stringify(lireGolden(nom));
      expect([nom, texte.includes("PATHS — all relative"), texte.includes('path=\\"~/file\\"')]).toEqual([
        nom,
        false,
        false,
      ]);
    }
  });

  it.each(NOMS)(
    "%s",
    async (nom) => {
      const golden = lireGolden(nom);
      const { entrees, ...attendu } = golden;
      const obtenu = await rejouer(
        structuredClone(entrees) as Dict,
        etat as EtatHarnais,
        llamaChatWithToolsStream,
      );
      const n = normaliser(obtenu);
      const dossier = process.env["GOLDEN_DIFF"];
      if (dossier) writeFileSync(path.join(dossier, `golden-ts-${nom}.json`), JSON.stringify(n, null, 2));
      expect(n).toStrictEqual(attendu);
    },
    30_000,
  );
});
