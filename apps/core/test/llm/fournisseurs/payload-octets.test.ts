// SPDX-License-Identifier: MIT
/** apps/core/test/llm/fournisseurs/payload-octets.test.ts — corps llama.cpp envoyé octet pour octet comme httpx (`json=`), sondes simulées des deux côtés. */
import "../environnement-fournisseurs";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type * as ModuleConstantes from "../../../src/llm/constantes";
import type * as ModuleCapacites from "../../../src/llm/fournisseurs/llama-capacites";
import type * as ModuleModeles from "../../../src/llm/modeles";
import type * as ModuleParametres from "../../../src/llm/parametres";
import { corpsSansPlafondExplicite } from "../../ecart-longueur-explicite";
import { lireVecteurs } from "../../vecteurs-moteur";
import { moteurFrais } from "../moteur-frais";
import type { Moteur } from "../moteur-frais";

vi.mock("../../../src/llm/fournisseurs/llama-capacites", async (importOriginal) => {
  const o = await importOriginal<typeof ModuleCapacites>();
  return { ...o, engineCaps: vi.fn(o.engineCaps) };
});
vi.mock("../../../src/llm/modeles", async (importOriginal) => {
  const o = await importOriginal<typeof ModuleModeles>();
  return { ...o, getModelContextSize: vi.fn(o.getModelContextSize) };
});
vi.mock("../../../src/llm/parametres", async (importOriginal) => {
  const o = await importOriginal<typeof ModuleParametres>();
  return {
    ...o,
    getReasoningEffortValues: vi.fn(o.getReasoningEffortValues),
    getPreserveReasoningSupport: vi.fn(o.getPreserveReasoningSupport),
  };
});
vi.mock("../../../src/llm/constantes", async (importOriginal) => {
  const o = await importOriginal<typeof ModuleConstantes>();
  return { ...o, resolveSlotIdAsync: vi.fn(o.resolveSlotIdAsync) };
});

interface CasPayload {
  nom: string;
  natif: boolean;
  local: boolean;
  pense: boolean;
  caps: { known: boolean; build: number; is_router: boolean } | null;
  ctx: number;
  slot: number;
  slot_evite: number;
  efforts: string[];
  conserve: boolean;
  effort: string | null;
  conserve_demande: boolean | null;
  evite: boolean;
  chat: string | null;
  modele: string;
  user: unknown;
  sampling: Record<string, unknown>;
  messages: unknown[];
  octets: string;
}

const V = lireVecteurs<{ payloads: CasPayload[] }>("moteur-fournisseurs");
let m: Moteur;

beforeAll(async () => {
  m = await moteurFrais();
});

afterAll(async () => {
  await m.fermer();
});

const ECARTS_LONGUEUR = new Set(["build_ancien_plafond_explicite"]);

describe("corps de requête llama.cpp (vecteurs Python : octets de httpx)", () => {
  it("ordre des champs, flottants Python, UTF-8 brut, kwargs de gabarit, budget, slot : octets identiques", async () => {
    expect(V.payloads.length).toBeGreaterThanOrEqual(7);
    for (const c of V.payloads) {
      const caps =
        c.caps === null
          ? m.caps.UNKNOWN
          : new m.caps.EngineCaps({ known: c.caps.known, build: c.caps.build, isRouter: c.caps.is_router });
      vi.mocked(m.caps.engineCaps).mockResolvedValue(caps);
      vi.mocked(m.modeles.getModelContextSize).mockResolvedValue(c.ctx);
      vi.mocked(m.parametres.getReasoningEffortValues).mockResolvedValue([...c.efforts]);
      vi.mocked(m.parametres.getPreserveReasoningSupport).mockResolvedValue(c.conserve);
      vi.mocked(m.constantes.resolveSlotIdAsync).mockImplementation((_chat, o) =>
        Promise.resolve(o?.avoidOwn ? c.slot_evite : c.slot),
      );
      const p = await m.llamacpp.buildLlamaPayload(structuredClone(c.messages), {
        targetModel: c.modele,
        userId: c.user,
        samplingParams: structuredClone(c.sampling),
        llamaNative: c.natif,
        localLlamacpp: c.local,
        thinkingMode: c.pense,
        chatId: c.chat,
        reasoningEffort: c.effort,
        preserveReasoning: c.conserve_demande,
        slotAvoidOwn: c.evite,
      });
      const python = Buffer.from(c.octets, "base64").toString("utf-8");
      let attendu = python;
      if (ECARTS_LONGUEUR.has(c.nom)) {
        attendu = corpsSansPlafondExplicite(python, c.sampling);
        expect(attendu, `${c.nom} : l'écart admis existe encore`).not.toBe(python);
      }
      expect(m.client.corpsJson(p).toString("utf-8"), c.nom).toBe(attendu);
    }
  });
});
